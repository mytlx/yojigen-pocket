package providers

import (
	"context"
	"net/url"
	"regexp"
	"strings"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/store"
)

// Web 是网页搜索和网址别名，条目来自配置。
type Web struct {
	Config func() *store.Config
}

// Info 实现 core.Provider。
func (w *Web) Info() core.Info { return core.Info{ID: "web", Title: "网页", Icon: "svg:globe"} }

var urlLike = regexp.MustCompile(`^(https?://\S+|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.(com|cn|net|org|io|dev|app|ai|co|me|tv|edu|gov)(/\S*)?)$`)

func expandURL(tpl, q string) string {
	return strings.ReplaceAll(tpl, "{q}", url.QueryEscape(q))
}

// Search 实现 core.Provider。
func (w *Web) Search(_ context.Context, req *core.Request) []core.Item {
	cfg := w.Config()
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return nil
	}
	var out []core.Item
	if urlLike.MatchString(text) {
		target := text
		if !strings.Contains(target, "://") {
			target = "https://" + target
		}
		out = append(out, core.Item{
			ID: "web:open", Title: "打开 " + target, Subtitle: "在浏览器中打开", Icon: "svg:globe",
			Source: "web", Ephem: true, Score: 1.6,
			Actions: []core.Action{{Type: core.ActionOpen, Title: "打开", Target: target}},
		})
	}
	first := strings.ToLower(req.First)
	exactKey := false
	for _, e := range cfg.Web {
		if strings.ToLower(e.Key) == first && e.Key != "" {
			exactKey = true
			if req.Rest != "" || !strings.Contains(e.URL, "{q}") {
				out = append(out, w.searchItem(e, req.Rest, true))
			} else {
				out = append(out, w.promptItem(e, 1.5))
			}
		}
	}
	if exactKey {
		return out
	}
	q := req.Query
	for _, e := range cfg.Web {
		r := match.Best(q, match.Prepare(e.Title), match.Prepare(e.Key))
		if r.OK && r.Score >= 0.7 {
			item := w.promptItem(e, r.Score)
			item.Highlights = r.Positions
			out = append(out, item)
		}
	}
	// 兜底：总在列表最后。
	n := 0
	for _, e := range cfg.Web {
		if !e.Fallback && !req.Scoped {
			continue
		}
		if !strings.Contains(e.URL, "{q}") {
			continue
		}
		item := w.searchItem(e, text, false)
		item.Bottom = !req.Scoped
		item.Score = 1 - float64(n)*0.01
		n++
		out = append(out, item)
	}
	return out
}

func (w *Web) searchItem(e store.WebEntry, q string, exact bool) core.Item {
	target := expandURL(e.URL, q)
	title := "在 " + e.Title + " 搜索“" + q + "”"
	if !strings.Contains(e.URL, "{q}") {
		title = "打开 " + e.Title
	}
	return core.Item{
		ID:       "web:" + e.Key + ":" + q,
		Title:    title,
		Subtitle: target,
		Icon:     iconOr(e.Icon, "svg:globe"),
		Source:   "web",
		Exact:    exact,
		Score:    1,
		Ephem:    true,
		Actions: []core.Action{
			{Type: core.ActionOpen, Title: "打开", Target: target},
			{Type: core.ActionCopy, Title: "复制链接", Text: target, KeepOpen: true},
		},
	}
}

func (w *Web) promptItem(e store.WebEntry, score float64) core.Item {
	key := e.Key
	return core.Item{
		ID:       "web:entry:" + e.Key,
		Title:    e.Title,
		Subtitle: "输入 " + e.Key + " 加空格搜索",
		Icon:     iconOr(e.Icon, "svg:globe"),
		Source:   "web",
		Score:    score,
		Complete: key + " ",
		Actions: []core.Action{{Type: core.ActionFunc, Title: "使用", KeepOpen: true, Fn: func(_ context.Context, r *core.Run) error {
			r.SetInput(key + " ")
			return nil
		}}},
	}
}

// Resolve 实现 core.Resolver。
func (w *Web) Resolve(id string) (core.Item, bool) {
	key, ok := strings.CutPrefix(id, "web:entry:")
	if !ok {
		return core.Item{}, false
	}
	for _, e := range w.Config().Web {
		if e.Key == key {
			return w.promptItem(e, 1), true
		}
	}
	return core.Item{}, false
}

func iconOr(icon, fallback string) string {
	if icon == "" {
		return fallback
	}
	return icon
}

// CatalogItems 实现 core.Lister。
func (w *Web) CatalogItems() []core.Item {
	var out []core.Item
	for _, e := range w.Config().Web {
		it := w.promptItem(e, 1)
		it.Subtitle = "关键词 " + e.Key + " · " + e.URL
		out = append(out, it)
	}
	return out
}
