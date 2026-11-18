package providers

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
)

// PayloadCommand 是针对带入内容的一条命令，例如「保存图片到文件」「以图搜图」。
type PayloadCommand struct {
	ID       string
	Title    string
	Desc     string
	Icon     string
	Keywords []string
	Score    float64 // 没有输入功能名时的默认排序
	KeepOpen bool
	Accept   func(p *core.Payload) bool
	Run      func(ctx context.Context, r *core.Run, p *core.Payload) error

	target *match.Target
	kw     []*match.Target
}

// 不接收文字的功能页。
var noTextFeatures = map[string]bool{"ocr": true, "reader": true, "random": true}

var (
	reTimestamp = regexp.MustCompile(`^\d{10}(\d{3})?$|^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$`)
	reJWT       = regexp.MustCompile(`^(Bearer\s+)?eyJ[\w-]+\.[\w-]+\.[\w-]*$`)
	reColor     = regexp.MustCompile(`(?i)^(#([0-9a-f]{3}|[0-9a-f]{6})|rgba?\(.+\)|hsla?\(.+\))$`)
	reURL       = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://\S+$`)
)

// suggestText 根据文字的样子，决定没有输入功能名时列出哪些功能、排在哪里。
// 看起来是 JSON、时间戳、JWT、颜色、网址的，对应的功能排最前；其余给一组通用的。
func suggestText(id, text string) (float64, bool) {
	t := strings.TrimSpace(text)
	switch id {
	case "json":
		if len(t) > 1 && (t[0] == '{' || t[0] == '[') && json.Valid([]byte(t)) {
			return 0.96, true
		}
		return 0, false
	case "timestamp":
		return 0.95, reTimestamp.MatchString(t)
	case "jwt":
		return 0.95, reJWT.MatchString(t)
	case "color":
		return 0.95, reColor.MatchString(t)
	case "urlparse":
		return 0.92, reURL.MatchString(t)
	case "translate":
		return 0.80, true
	case "text":
		return 0.70, true
	case "codec":
		return 0.60, true
	case "hash":
		return 0.50, true
	case "regex":
		return 0.45, true
	case "diff":
		return 0.40, true
	}
	return 0, false
}

// SearchPayload 实现 core.PayloadProvider：列出能处理这块内容的功能页和命令。
func (f *Features) SearchPayload(ctx context.Context, req *core.Request, p *core.Payload) []core.Item {
	typed := strings.TrimSpace(req.Text)
	first := strings.ToLower(req.First)
	var out []core.Item

	add := func(d *FeatureDef, input string, args map[string]string, fallbackScore float64) {
		it := f.item(d, input, args)
		it.Subtitle = d.Desc
		if typed == "" {
			it.Score = fallbackScore
			out = append(out, it)
			return
		}
		words := f.words(d.ID, d.Keywords)
		if hit, alias := keywordOf(d, words, first); hit {
			if args == nil {
				it = f.item(d, input, alias)
				it.Subtitle = d.Desc
			}
			if d.QuickTool && p.Kind == core.PayloadText {
				// 小工具已经直接算出了结果（回车复制），功能页排在它后面。
				it.Score = 0.97
				out = append(out, it)
				return
			}
			it.Exact, it.Score = true, 1
			out = append(out, it)
			return
		}
		if r := match.Best(req.Query, d.target, f.kws.targets(words)...); r.OK && r.Score > 0 {
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
		}
	}

	switch {
	case p.Kind == core.PayloadText:
		for _, d := range f.Defs {
			if noTextFeatures[d.ID] {
				continue
			}
			score, suggested := suggestText(d.ID, p.Text)
			if typed == "" && !suggested {
				continue
			}
			add(d, p.Text, nil, score)
		}
	case p.ImagePath() != "":
		if d := f.Def("ocr"); d != nil {
			before := len(out)
			add(d, "", map[string]string{"image": p.ImagePath()}, 0.95)
			if len(out) > before {
				out[before].Title = "识别图片里的文字"
			}
		}
	}
	if p.Kind == core.PayloadFiles && len(p.Files) == 1 {
		if d := f.Def("hash"); d != nil {
			add(d, "", map[string]string{"file": p.Files[0]}, 0.50)
		}
	}

	for _, c := range f.PayloadCommands {
		if c.Accept != nil && !c.Accept(p) {
			continue
		}
		cmd := c
		it := core.Item{
			ID: "features:payload-" + c.ID, Title: c.Title, Subtitle: c.Desc, Icon: c.Icon, Source: "features", Ephem: true,
			Actions: []core.Action{{Type: core.ActionFunc, Title: "执行", KeepOpen: c.KeepOpen, Fn: func(ctx context.Context, r *core.Run) error {
				return cmd.Run(ctx, r, p)
			}}},
		}
		if typed == "" {
			it.Score = c.Score
			out = append(out, it)
			continue
		}
		if c.target == nil {
			c.target = match.Prepare(c.Title)
			for _, k := range c.Keywords {
				c.kw = append(c.kw, match.Prepare(k))
			}
		}
		if r := match.Best(req.Query, c.target, c.kw...); r.OK && r.Score > 0 {
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
		}
	}
	if img := p.ImagePath(); img != "" {
		for i := range out {
			out[i].Preview = &core.Preview{Type: "image", URL: "image:" + img}
		}
	}
	return out
}

// SearchPayload 实现 core.PayloadProvider：块后面输入小工具的关键词（md5、b64……），直接算出结果。
func (t *Tools) SearchPayload(_ context.Context, req *core.Request, p *core.Payload) []core.Item {
	if p.Kind != core.PayloadText || req.Text == "" {
		return nil
	}
	first := strings.ToLower(req.First)
	for _, x := range t.list {
		if first == x.key {
			return []core.Item{t.resultItem(x, &core.Request{First: x.key, Rest: p.Text})}
		}
	}
	return nil
}

// SearchPayload 实现 core.PayloadProvider：块后面输入搜索引擎的关键词或名字，用带入的文字去搜。
func (w *Web) SearchPayload(_ context.Context, req *core.Request, p *core.Payload) []core.Item {
	q := p.QueryText()
	if q == "" || strings.TrimSpace(req.Text) == "" {
		return nil // 没有输入时，网页搜索由普通查询作为兜底给出
	}
	first := strings.ToLower(req.First)
	var out []core.Item
	for _, e := range w.Config().Web {
		if !strings.Contains(e.URL, "{q}") {
			continue
		}
		if e.Key != "" && strings.ToLower(e.Key) == first {
			out = append(out, w.searchItem(e, q, true))
			continue
		}
		if r := match.Best(req.Query, match.Prepare(e.Title), match.Prepare(e.Key)); r.OK && r.Score >= 0.6 {
			it := w.searchItem(e, q, false)
			it.Score = r.Score
			out = append(out, it)
		}
	}
	return out
}

// SearchPayload 实现 core.PayloadProvider：块后面输入脚本的名字，把带入的内容作为第一个参数运行。
// 文字块传文字，图片和文件传路径。
func (s *Scripts) SearchPayload(_ context.Context, req *core.Request, p *core.Payload) []core.Item {
	if strings.TrimSpace(req.Text) == "" {
		return nil
	}
	arg := p.Text
	switch p.Kind {
	case core.PayloadImage:
		arg = p.Image
	case core.PayloadFiles:
		arg = strings.Join(p.Files, "\n")
	}
	if arg == "" {
		return nil
	}
	s.mu.RLock()
	list := s.list
	s.mu.RUnlock()
	first := strings.ToLower(req.First)
	var out []core.Item
	for _, c := range list {
		if !whenMatches(c, req.Context.FgProcess) {
			continue
		}
		it := s.item(c, arg)
		it.Subtitle = iconOr(c.Desc, "把带入的内容作为参数运行")
		if keywordHit(c, first) {
			it.Exact, it.Score = true, 1
			out = append(out, it)
			continue
		}
		if r := match.Best(req.Query, c.target, c.keywords...); r.OK && r.Score > 0 {
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
		}
	}
	return out
}
