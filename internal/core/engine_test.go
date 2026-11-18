package core

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/store"
)

type fakeHost struct {
	copied string
	opened []string
	hidden int
}

func (h *fakeHost) OpenTarget(t string) error   { h.opened = append(h.opened, t); return nil }
func (h *fakeHost) Reveal(string)               {}
func (h *fakeHost) CopyText(t string)           { h.copied = t }
func (h *fakeHost) CopyImageFile(string) error  { return nil }
func (h *fakeHost) CopyFiles([]string) error    { return nil }
func (h *fakeHost) ReadClipboardText() string   { return "" }
func (h *fakeHost) PasteToFront() error         { return nil }
func (h *fakeHost) TypeToFront(string) error    { return nil }
func (h *fakeHost) Notify(string, string)       {}
func (h *fakeHost) HidePanel()                  { h.hidden++ }
func (h *fakeHost) EditFile(string) error       { return nil }
func (h *fakeHost) OpenSettings(string, string) {}

type fakeProvider struct {
	id    string
	async bool
	items []string
	ep    string
}

func (p *fakeProvider) Info() Info { return Info{ID: p.id, Title: p.id, Async: p.async} }
func (p *fakeProvider) Search(_ context.Context, req *Request) []Item {
	var out []Item
	for _, t := range p.items {
		r := match.Prepare(t).Match(req.Query)
		if r.OK && r.Score > 0 {
			out = append(out, Item{ID: p.id + ":" + t, Title: t, Source: p.id, Score: r.Score, Highlights: r.Positions,
				Actions: []Action{{Type: ActionOpen, Target: t}}})
		}
	}
	return out
}

func newEngine(t *testing.T, ps ...Provider) (*Engine, *fakeHost, *store.ConfigStore) {
	t.Helper()
	dir := t.TempDir()
	cfg := store.NewConfigStore(filepath.Join(dir, "config.json"))
	if err := cfg.Update(func(c *store.Config) {
		c.Modules = map[string]store.Module{}
		for _, p := range ps {
			c.Modules[p.Info().ID] = store.Module{Enabled: true, Global: true, Weight: 1}
		}
		c.Modules["pfx"] = store.Module{Enabled: true, Weight: 1, Prefix: "f"}
		c.Modules["sym"] = store.Module{Enabled: true, Weight: 1, Prefix: "="}
	}); err != nil {
		t.Fatal(err)
	}
	h := &fakeHost{}
	return NewEngine(h, cfg, store.NewUsage(filepath.Join(dir, "usage.json")), ps...), h, cfg
}

func titles(e *Engine, t *testing.T, q QueryRequest) []string {
	t.Helper()
	var last Batch
	if err := e.Query(context.Background(), q, func(b Batch) error { last = b; return nil }); err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, it := range last.Items {
		out = append(out, it.Title)
	}
	return out
}

// 黄金测试：输入 → 期望的前几名。
func TestRankingGolden(t *testing.T) {
	apps := &fakeProvider{id: "apps", items: []string{"Google Chrome", "Calculator", "Visual Studio Code", "微信", "网易云音乐", "系统设置", "Code Runner"}}
	e, _, _ := newEngine(t, apps)
	cases := []struct {
		q    string
		want []string
	}{
		{"wx", []string{"微信"}},
		{"weixin", []string{"微信"}},
		{"vsc", []string{"Visual Studio Code"}},
		{"chrome", []string{"Google Chrome"}},
		{"code", []string{"Code Runner", "Visual Studio Code"}},
		{"sz", []string{"系统设置"}},
		{"yyy", []string{"网易云音乐"}},
	}
	for _, c := range cases {
		got := titles(e, t, QueryRequest{Text: c.q})
		if len(got) < len(c.want) || !slices.Equal(got[:len(c.want)], c.want) {
			t.Errorf("%q: 得到 %v，期望开头是 %v", c.q, got, c.want)
		}
	}
}

// 按前缀记录：选过几次之后，同样的输入应该把它排到第一。
func TestUsageMovesItemToTop(t *testing.T) {
	apps := &fakeProvider{id: "apps", items: []string{"Calculator", "Calendar", "Chrome"}}
	e, _, _ := newEngine(t, apps)
	if got := titles(e, t, QueryRequest{Text: "c"}); got[0] != "Chrome" {
		t.Fatalf("初始顺序不符合预期：%v", got)
	}
	for range 3 {
		if err := e.Execute(context.Background(), ExecRequest{Item: "apps:Calculator", Query: "c"}, func(ExecEvent) {}); err != nil {
			t.Fatal(err)
		}
	}
	if got := titles(e, t, QueryRequest{Text: "c"}); got[0] != "Calculator" {
		t.Errorf("选过三次后应排第一：%v", got)
	}
}

func TestPrefixRouting(t *testing.T) {
	apps := &fakeProvider{id: "apps", items: []string{"report"}}
	pfx := &fakeProvider{id: "pfx", items: []string{"report.pdf"}}
	sym := &fakeProvider{id: "sym", items: []string{"12"}}
	e, _, cfg := newEngine(t, apps, pfx, sym)
	_ = cfg
	if got := titles(e, t, QueryRequest{Text: "f report"}); !slices.Equal(got, []string{"report.pdf"}) {
		t.Errorf("字母前缀 + 空格应只走对应模块：%v", got)
	}
	if got := titles(e, t, QueryRequest{Text: "=12"}); !slices.Equal(got, []string{"12"}) {
		t.Errorf("符号前缀不需要空格：%v", got)
	}
	if got := titles(e, t, QueryRequest{Text: "report"}); !slices.Equal(got, []string{"report"}) {
		t.Errorf("无前缀时只走全局模块：%v", got)
	}
}

func TestAsyncResultsArriveLater(t *testing.T) {
	local := &fakeProvider{id: "apps", items: []string{"alpha"}}
	remote := &fakeProvider{id: "files", async: true, items: []string{"alpha.txt"}}
	e, _, _ := newEngine(t, local, remote)
	var batches []Batch
	_ = e.Query(context.Background(), QueryRequest{Text: "alpha"}, func(b Batch) error {
		batches = append(batches, b)
		return nil
	})
	if len(batches) < 2 {
		t.Fatalf("应至少两批：%d", len(batches))
	}
	if len(batches[0].Items) != 1 || batches[0].Done {
		t.Errorf("第一批只应有本地结果：%+v", batches[0])
	}
	last := batches[len(batches)-1]
	if len(last.Items) != 2 || !last.Done {
		t.Errorf("最后一批应合并全部结果：%+v", last)
	}
}

func TestConfirmGate(t *testing.T) {
	ran := false
	p := &resolverProvider{item: Item{ID: "x:y", Title: "danger", Source: "x", Actions: []Action{{
		Type: ActionFunc, Confirm: "确定？", Fn: func(context.Context, *Run) error { ran = true; return nil },
	}}}}
	e, _, _ := newEngine(t, p)
	var events []ExecEvent
	emit := func(ev ExecEvent) { events = append(events, ev) }
	if err := e.Execute(context.Background(), ExecRequest{Item: "x:y"}, emit); err != nil {
		t.Fatal(err)
	}
	if ran || len(events) != 1 || events[0].Kind != "confirm" {
		t.Fatalf("未确认前不应执行：ran=%v events=%+v", ran, events)
	}
	if err := e.Execute(context.Background(), ExecRequest{Item: "x:y", Confirmed: true}, emit); err != nil {
		t.Fatal(err)
	}
	if !ran {
		t.Errorf("确认后应执行")
	}
}

type resolverProvider struct{ item Item }

func (p *resolverProvider) Info() Info                              { return Info{ID: "x", Title: "x"} }
func (p *resolverProvider) Search(context.Context, *Request) []Item { return nil }
func (p *resolverProvider) Resolve(id string) (Item, bool) {
	if id == p.item.ID {
		return p.item, true
	}
	return Item{}, false
}

func TestDisabledHidden(t *testing.T) {
	apps := &fakeProvider{id: "apps", items: []string{"alpha", "alpine"}}
	e, _, cfg := newEngine(t, apps)
	if err := cfg.Update(func(c *store.Config) { c.Disabled = []string{"apps:alpha"} }); err != nil {
		t.Fatal(err)
	}
	if got := titles(e, t, QueryRequest{Text: "alp"}); !slices.Equal(got, []string{"alpine"}) {
		t.Errorf("被隐藏的项不应出现：%v", got)
	}
}

type bottomProvider struct{}

func (bottomProvider) Info() Info { return Info{ID: "web", Title: "web"} }
func (bottomProvider) Search(context.Context, *Request) []Item {
	return []Item{{ID: "web:x", Title: "search", Source: "web", Bottom: true, Score: 1, Ephem: true,
		Actions: []Action{{Type: ActionOpen, Target: "x"}}}}
}

// 兜底项总在最后，并且界面要能认出它（有了真正的结果时，选中项不能停在兜底项上）。
func TestFallbackIsLastAndMarked(t *testing.T) {
	apps := &fakeProvider{id: "apps", items: []string{"alpha"}}
	e, _, _ := newEngine(t, bottomProvider{}, apps)
	var last Batch
	if err := e.Query(context.Background(), QueryRequest{Text: "alpha"}, func(b Batch) error { last = b; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(last.Items) != 2 || last.Items[0].Title != "alpha" || !last.Items[1].Bottom {
		t.Errorf("顺序或标记不对：%+v", last.Items)
	}
}

// 发给界面的结果不带动作的内容，完整内容留在后端。
func TestForUIStripsActionContent(t *testing.T) {
	p := &resolverProvider{item: Item{ID: "x:y", Title: "t", Source: "x", Preview: &Preview{Type: "text", Text: strings.Repeat("字", maxPreviewText+10)}, Actions: []Action{
		{Type: ActionCopy, Title: "复制", Text: "秘密内容"},
	}}}
	e, h, _ := newEngine(t, p)
	it, _ := e.Resolve("x:y")
	ui := e.forUI([]Item{it})[0]
	if ui.Actions[0].Text != "" {
		t.Errorf("动作内容不应发给界面：%+v", ui.Actions[0])
	}
	if n := len([]rune(ui.Preview.Text)); n != maxPreviewText+1 {
		t.Errorf("预览应被截断：%d", n)
	}
	e.register([]Item{it})
	if err := e.Execute(context.Background(), ExecRequest{Item: "x:y"}, func(ExecEvent) {}); err != nil {
		t.Fatal(err)
	}
	if h.copied != "秘密内容" {
		t.Errorf("执行时应使用后端保留的完整内容：%q", h.copied)
	}
}

type payloadProvider struct{ fakeProvider }

func (p *payloadProvider) SearchPayload(_ context.Context, req *Request, pl *Payload) []Item {
	var out []Item
	for _, name := range []string{"翻译", "文本处理"} {
		it := Item{ID: "features:" + name, Title: name, Source: p.id, Score: 0.8, Actions: []Action{{Type: ActionCopy, Text: pl.Text}}}
		if name == "文本处理" {
			it.Score = 0.7
		}
		if req.Text != "" {
			r := match.Prepare(name).Match(req.Query)
			if !r.OK || r.Score <= 0 {
				continue
			}
			it.Score = r.Score
		}
		out = append(out, it)
	}
	return out
}

// 带入一个文件名：照常能搜到这个文件，后面跟着能处理这段文字的功能，网页搜索在最后。
func TestPayloadQueryKeepsRecognition(t *testing.T) {
	files := &fakeProvider{id: "files", async: true, items: []string{"report.pdf"}}
	feats := &payloadProvider{fakeProvider{id: "features"}}
	e, h, _ := newEngine(t, bottomProvider{}, files, feats)
	p := &Payload{Kind: PayloadText, Text: "report.pdf"}
	var last Batch
	if err := e.Query(context.Background(), QueryRequest{Payload: p}, func(b Batch) error { last = b; return nil }); err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, it := range last.Items {
		got = append(got, it.Title)
	}
	if strings.Join(got, "|") != "report.pdf|翻译|文本处理|search" {
		t.Fatalf("顺序：%v", got)
	}
	if last.Mode != "results" || !last.Done {
		t.Errorf("批次：%+v", last)
	}

	// 块后面输入功能名：只列出能处理它的功能，执行时用的是带入的文字。
	if err := e.Query(context.Background(), QueryRequest{Text: "wbcl", Payload: p}, func(b Batch) error { last = b; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(last.Items) != 1 || last.Items[0].Title != "文本处理" {
		t.Fatalf("按功能名过滤：%+v", last.Items)
	}
	if err := e.Execute(context.Background(), ExecRequest{Item: last.Items[0].ID}, func(ExecEvent) {}); err != nil {
		t.Fatal(err)
	}
	if h.copied != "report.pdf" {
		t.Errorf("功能应拿到带入的文字：%q", h.copied)
	}
}

// 长文字、多行文字不拿去匹配应用和文件，只给功能和网页搜索。
func TestPayloadLongTextSkipsRecognition(t *testing.T) {
	apps := &fakeProvider{id: "apps", items: []string{"第一行"}}
	feats := &payloadProvider{fakeProvider{id: "features"}}
	e, _, cfg := newEngine(t, apps, feats)
	_ = cfg
	var last Batch
	_ = e.Query(context.Background(), QueryRequest{Payload: &Payload{Kind: PayloadText, Text: "第一行\n第二行"}}, func(b Batch) error { last = b; return nil })
	for _, it := range last.Items {
		if it.Title == "第一行" {
			t.Errorf("多行文字不应匹配应用")
		}
	}
	if len(last.Items) != 2 {
		t.Errorf("应只有两个功能：%+v", last.Items)
	}
}

// 名字同样对得上时，应用排在命令前面；但只是沾边的应用不该压过完全匹配的命令。
func TestAppsBeforeCommands(t *testing.T) {
	cfg := store.DefaultConfig()
	e := &Engine{usage: store.NewUsage(filepath.Join(t.TempDir(), "usage.json"))}
	req := newRequest("weixin", "", false, Context{})
	out := e.rank(cfg, req, []Item{
		{ID: "system:a", Title: "命令", Source: "system", Score: 0.98, Actions: []Action{{}}},
		{ID: "features:b", Title: "功能", Source: "features", Score: 0.97, Actions: []Action{{}}},
		{ID: "apps:wx", Title: "微信", Source: "apps", Score: 0.98, Actions: []Action{{}}},
	})
	if out[0].ID != "apps:wx" {
		t.Fatalf("同样匹配时应用应该在最前，得到 %s", out[0].ID)
	}
	out = e.rank(cfg, req, []Item{
		{ID: "system:a", Title: "命令", Source: "system", Score: 0.98, Actions: []Action{{}}},
		{ID: "apps:x", Title: "只是前缀", Source: "apps", Score: 0.90, Actions: []Action{{}}},
	})
	if out[0].ID != "system:a" {
		t.Fatalf("完全匹配的命令应该排在只是前缀匹配的应用前面，得到 %s", out[0].ID)
	}
}

// 一个模块可以配多个前缀；几个都对得上时取最长的。
func TestMultiplePrefixes(t *testing.T) {
	apps := &fakeProvider{id: "apps", items: []string{"report"}}
	pfx := &fakeProvider{id: "pfx", items: []string{"report.pdf"}}
	sym := &fakeProvider{id: "sym", items: []string{"12"}}
	long := &fakeProvider{id: "long", items: []string{"12 long"}}
	e, _, cfg := newEngine(t, apps, pfx, sym, long)
	if err := cfg.Update(func(c *store.Config) {
		c.Modules["pfx"] = store.Module{Enabled: true, Weight: 1, Prefix: "f file，文件"}
		c.Modules["sym"] = store.Module{Enabled: true, Weight: 1, Prefix: "= calc"}
		c.Modules["long"] = store.Module{Enabled: true, Weight: 1, Prefix: "=="}
	}); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"f report", "file report", "文件 report"} {
		if got := titles(e, t, QueryRequest{Text: q}); !slices.Equal(got, []string{"report.pdf"}) {
			t.Errorf("%q 应该走文件模块：%v", q, got)
		}
	}
	if got := titles(e, t, QueryRequest{Text: "calc 12"}); !slices.Equal(got, []string{"12"}) {
		t.Errorf("第二个前缀也要生效：%v", got)
	}
	if got := titles(e, t, QueryRequest{Text: "==12"}); !slices.Equal(got, []string{"12 long"}) {
		t.Errorf("== 和 = 都对得上时取长的：%v", got)
	}
	if got := titles(e, t, QueryRequest{Text: "filereport"}); slices.Equal(got, []string{"report.pdf"}) {
		t.Errorf("字母前缀后面没有空格时不算前缀：%v", got)
	}
}
