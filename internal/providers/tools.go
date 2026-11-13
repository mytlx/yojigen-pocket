package providers

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"bytes"

	"yojigen-pocket/internal/core"
)

type tool struct {
	panel    string            // 对应的功能页
	args     map[string]string // 打开功能页时带的参数
	key      string
	title    string
	keywords []string
	noInput  bool
	fn       func(input string) (string, error)
}

// Tools 是开发小工具：Base64、URL、JSON、哈希、UUID、时间戳……
// 用法是「关键词 + 内容」；不写内容时用剪贴板。
type Tools struct {
	list []*tool
}

// NewTools 创建小工具集合。
func NewTools() *Tools {
	t := &Tools{list: []*tool{
		{panel: "codec", args: map[string]string{"mode": "base64"}, key: "b64", title: "Base64 编码", keywords: []string{"base64"}, fn: func(s string) (string, error) {
			return base64.StdEncoding.EncodeToString([]byte(s)), nil
		}},
		{panel: "codec", args: map[string]string{"mode": "base64", "dir": "decode"}, key: "b64d", title: "Base64 解码", keywords: []string{"base64decode"}, fn: func(s string) (string, error) {
			s = strings.TrimSpace(s)
			if b, err := base64.StdEncoding.DecodeString(s); err == nil {
				return string(b), nil
			}
			b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
			if err != nil {
				return "", errors.New("不是合法的 Base64")
			}
			return string(b), nil
		}},
		{panel: "codec", args: map[string]string{"mode": "url"}, key: "url", title: "URL 编码", keywords: []string{"urlencode"}, fn: func(s string) (string, error) {
			return url.QueryEscape(s), nil
		}},
		{panel: "codec", args: map[string]string{"mode": "url", "dir": "decode"}, key: "urld", title: "URL 解码", keywords: []string{"urldecode"}, fn: url.QueryUnescape},
		{panel: "json", args: nil, key: "json", title: "JSON 格式化", keywords: []string{"format", "pretty"}, fn: func(s string) (string, error) {
			var out bytes.Buffer
			if err := json.Indent(&out, []byte(s), "", "  "); err != nil {
				return "", fmt.Errorf("不是合法的 JSON：%v", err)
			}
			return out.String(), nil
		}},
		{panel: "json", args: map[string]string{"action": "minify"}, key: "jsonm", title: "JSON 压缩", keywords: []string{"minify"}, fn: func(s string) (string, error) {
			var out bytes.Buffer
			if err := json.Compact(&out, []byte(s)); err != nil {
				return "", fmt.Errorf("不是合法的 JSON：%v", err)
			}
			return out.String(), nil
		}},
		{panel: "hash", args: map[string]string{"algo": "md5"}, key: "md5", title: "MD5", keywords: []string{"hash"}, fn: func(s string) (string, error) {
			h := md5.Sum([]byte(s))
			return hex.EncodeToString(h[:]), nil
		}},
		{panel: "hash", args: map[string]string{"algo": "sha1"}, key: "sha1", title: "SHA-1", keywords: []string{"hash"}, fn: func(s string) (string, error) {
			h := sha1.Sum([]byte(s))
			return hex.EncodeToString(h[:]), nil
		}},
		{panel: "hash", args: map[string]string{"algo": "sha256"}, key: "sha256", title: "SHA-256", keywords: []string{"hash"}, fn: func(s string) (string, error) {
			h := sha256.Sum256([]byte(s))
			return hex.EncodeToString(h[:]), nil
		}},
		{panel: "random", args: map[string]string{"tab": "uuid"}, key: "uuid", title: "生成 UUID", keywords: []string{"guid"}, noInput: true, fn: func(string) (string, error) {
			return NewUUID(), nil
		}},
		{panel: "timestamp", args: nil, key: "ts", title: "时间戳转换", keywords: []string{"timestamp", "date", "时间"}, noInput: true, fn: Timestamp},
		{panel: "text", args: map[string]string{"op": "upper"}, key: "upper", title: "转大写", keywords: []string{"uppercase"}, fn: func(s string) (string, error) { return strings.ToUpper(s), nil }},
		{panel: "text", args: map[string]string{"op": "lower"}, key: "lower", title: "转小写", keywords: []string{"lowercase"}, fn: func(s string) (string, error) { return strings.ToLower(s), nil }},
		{panel: "text", args: map[string]string{"op": "count"}, key: "count", title: "字数统计", keywords: []string{"wc", "length"}, fn: func(s string) (string, error) {
			return fmt.Sprintf("%d 字符 · %d 词 · %d 行 · %d 字节", utf8.RuneCountInString(s), len(strings.Fields(s)), strings.Count(s, "\n")+1, len(s)), nil
		}},
	}}
	return t
}

// NewUUID 生成 v4 UUID。
func NewUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// Timestamp 在时间戳和日期之间互转；没有输入时给出当前时间戳。
func Timestamp(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return strconv.FormatInt(time.Now().Unix(), 10), nil
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		switch {
		case n > 1e17: // 纳秒
			return time.Unix(0, n).Format("2006-01-02 15:04:05"), nil
		case n > 1e14: // 微秒
			return time.UnixMicro(n).Format("2006-01-02 15:04:05"), nil
		case n > 1e11: // 毫秒
			return time.UnixMilli(n).Format("2006-01-02 15:04:05.000"), nil
		}
		return time.Unix(n, 0).Format("2006-01-02 15:04:05"), nil
	}
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02", "2006/01/02 15:04:05", "2006/01/02", time.RFC3339} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return strconv.FormatInt(t.Unix(), 10), nil
		}
	}
	return "", errors.New("无法识别的时间格式")
}

// Info 实现 core.Provider。
func (t *Tools) Info() core.Info {
	return core.Info{ID: "tools", Title: "小工具", Icon: "svg:wrench"}
}

// Search 实现 core.Provider。
func (t *Tools) Search(_ context.Context, req *core.Request) []core.Item {
	var out []core.Item
	first := strings.ToLower(req.First)
	for _, x := range t.list {
		// 关键词完全命中：直接算出结果。
		if first == x.key {
			out = append(out, t.resultItem(x, req))
			continue
		}
	}
	return out
}

// panelAction 是「在面板中打开」：带着输入进入对应的功能页（Ctrl+回车）。
func panelAction(x *tool, input string) core.Action {
	def := ""
	for _, d := range FeatureDefs() {
		if d.ID == x.panel {
			def = d.Title
			v := FeatureView(d, input, x.args)
			return core.Action{Type: core.ActionView, Title: "在「" + def + "」面板中打开", Shortcut: "mod+enter", View: v}
		}
	}
	return core.Action{Type: core.ActionFunc, Title: "继续输入", KeepOpen: true, Fn: func(context.Context, *core.Run) error { return nil }}
}

func (t *Tools) resultItem(x *tool, req *core.Request) core.Item {
	input := req.Rest
	from := ""
	if input == "" && !x.noInput {
		input, from = req.Context.Clipboard, "（来自剪贴板）"
	}
	base := core.Item{
		ID: "tools:result:" + x.key, Icon: "svg:wrench", Source: "tools", Ephem: true, Exact: true, Score: 1,
	}
	// 只输入关键词（没写内容）时，回车应打开功能页，这条用剪贴板算出的结果排在后面。
	if req.Rest == "" {
		base.Exact, base.Score = false, 0.9
	}
	if input == "" && !x.noInput {
		base.Title = x.title
		base.Subtitle = "输入内容，或先复制一段文字"
		base.Actions = []core.Action{panelAction(x, "")}
		return base
	}
	output, err := x.fn(input)
	if err != nil {
		base.Title = x.title
		base.Subtitle = err.Error()
		base.Error = true
		base.Actions = []core.Action{panelAction(x, input)}
		return base
	}
	line, _, multi := strings.Cut(output, "\n")
	base.Title = truncate(line, 120)
	base.Subtitle = x.title + from
	if multi || utf8.RuneCountInString(output) > 80 {
		base.Preview = &core.Preview{Type: "code", Text: truncate(output, 20000)}
	}
	base.Actions = []core.Action{
		{Type: core.ActionCopy, Title: "复制结果", Text: output},
		panelAction(x, input), // Ctrl+回车：进入对应的功能页
		{Type: core.ActionPaste, Title: "粘贴结果", Text: output},
	}
	return base
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}
