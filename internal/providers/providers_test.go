package providers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"slices"
	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/store"
)

func req(text string) *core.Request {
	first, rest, _ := strings.Cut(text, " ")
	return &core.Request{Text: text, Query: match.NewQuery(text), First: first, Rest: rest}
}

func TestToolsExactKeyword(t *testing.T) {
	items := NewTools().Search(context.Background(), req("b64 hello"))
	var got *core.Item
	for i := range items {
		if items[i].Exact {
			got = &items[i]
		}
	}
	if got == nil || got.Title != "aGVsbG8=" {
		t.Fatalf("结果：%+v", items)
	}
	if got.Actions[0].Type != core.ActionCopy || got.Actions[0].Text != "aGVsbG8=" {
		t.Errorf("默认动作应复制结果：%+v", got.Actions[0])
	}
}

func TestToolsUsesClipboard(t *testing.T) {
	r := req("md5")
	r.Context.Clipboard = "hello"
	items := NewTools().Search(context.Background(), r)
	if len(items) == 0 || items[0].Title != "5d41402abc4b2a76b9719d911017c592" {
		t.Fatalf("没写内容时应使用剪贴板：%+v", items)
	}
}

func TestToolsBadInput(t *testing.T) {
	items := NewTools().Search(context.Background(), req("json {bad"))
	if len(items) == 0 || !items[0].Error {
		t.Errorf("错误输入应显示错误态：%+v", items)
	}
}

func TestTimestamp(t *testing.T) {
	loc := time.Local
	want := time.Date(2026, 1, 2, 3, 4, 5, 0, loc)
	got, err := Timestamp(strings.TrimSpace(want.Format("2006-01-02 15:04:05")))
	if err != nil {
		t.Fatal(err)
	}
	back, err := Timestamp(got)
	if err != nil || back != "2026-01-02 03:04:05" {
		t.Errorf("互转不一致：%s %v", back, err)
	}
	if ms, _ := Timestamp("1767323045000"); !strings.Contains(ms, ".000") {
		t.Errorf("毫秒时间戳：%s", ms)
	}
}

func TestWebSearch(t *testing.T) {
	cfg := store.DefaultConfig()
	w := &Web{Config: func() *store.Config { return cfg }}
	items := w.Search(context.Background(), req("gh yojigen pocket"))
	if len(items) != 1 || !items[0].Exact || !strings.Contains(items[0].Actions[0].Target, "q=yojigen+pocket") {
		t.Errorf("关键词 + 内容：%+v", items)
	}
	items = w.Search(context.Background(), req("随便搜点什么"))
	bottoms := 0
	for _, it := range items {
		if it.Bottom {
			bottoms++
		}
	}
	if bottoms != 2 {
		t.Errorf("默认应有两个兜底引擎，实际 %d", bottoms)
	}
	items = w.Search(context.Background(), req("github.com/egoist/mygo"))
	if len(items) == 0 || items[0].Actions[0].Target != "https://github.com/egoist/mygo" {
		t.Errorf("网址应直接打开：%+v", items)
	}
}

func TestPathsListing(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"alpha.txt", "alps.md", "beta.txt", ".hidden"} {
		if err := os.WriteFile(filepath.Join(dir, n), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "alpine"), 0o755); err != nil {
		t.Fatal(err)
	}
	all := ListPath(dir + string(filepath.Separator))
	if len(all) != 4 {
		t.Errorf("应隐藏点文件：%d", len(all))
	}
	if all[0].Title != "alpine" || !strings.HasSuffix(all[0].Complete, string(filepath.Separator)) {
		t.Errorf("文件夹排前面，补全带分隔符：%+v", all[0])
	}
	if got := ListPath(filepath.Join(dir, "alp")); len(got) != 3 {
		t.Errorf("前缀过滤：%d", len(got))
	}
	if got := ListPath(filepath.Join(dir, ".hid")); len(got) != 1 {
		t.Errorf("明确输入点开头时应显示隐藏文件：%d", len(got))
	}
}

func TestSnippetsCRUD(t *testing.T) {
	s := &Snippets{Dir: t.TempDir()}
	if err := s.Save("", "邮件签名", "你好\n{date}"); err != nil {
		t.Fatal(err)
	}
	if err := s.Save("", "邮件签名", "x"); err != nil {
		// 同名且 oldName 为空：视为冲突
		if !strings.Contains(err.Error(), "同名") {
			t.Errorf("错误信息：%v", err)
		}
	} else {
		t.Errorf("同名应报错")
	}
	if err := s.Save("邮件签名", "签名", "你好"); err != nil {
		t.Fatal(err)
	}
	list := s.List()
	if len(list) != 1 || list[0].Name != "签名" {
		t.Errorf("改名后：%+v", list)
	}
	if err := s.Save("", "../evil", "x"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(s.Dir), "evil.md")); err == nil {
		t.Errorf("名字里的路径不能逃出目录")
	}
	items := s.Search(context.Background(), req("qm"))
	if len(items) != 1 || items[0].Title != "签名" {
		t.Errorf("拼音首字母搜索：%+v", items)
	}
	if err := s.Delete("签名"); err != nil {
		t.Fatal(err)
	}
}

func TestExpandTemplate(t *testing.T) {
	got := ExpandTemplate("{clipboard}-{cursor}-{date}", "剪贴板")
	if !strings.HasPrefix(got, "剪贴板--") || strings.Contains(got, "{") {
		t.Errorf("展开：%q", got)
	}
}

type fakeClip struct {
	text  string
	image []byte
	files []string
}

func (f *fakeClip) ReadText() string             { return f.text }
func (f *fakeClip) ReadImage() []byte            { return f.image }
func (f *fakeClip) ReadFiles() ([]string, error) { return f.files, nil }
func (f *fakeClip) HasImage() bool               { return len(f.image) > 0 }

func TestClipboardHistory(t *testing.T) {
	cfg := store.DefaultConfig()
	cfg.Clipboard.IgnoreApps = nil
	cfg.Clipboard.MaxItems = 3
	src := &fakeClip{}
	c := &Clipboard{Config: func() *store.Config { return cfg }, Source: src, Dir: t.TempDir()}
	c.Load()
	for _, s := range []string{"第一条", "第二条", "第三条", "第二条"} {
		src.text = s
		c.capture()
	}
	items := c.Search(context.Background(), &core.Request{Query: match.NewQuery("")})
	if len(items) != 3 || items[0].Title != "第二条" {
		t.Fatalf("相同内容应提到最前且不重复：%+v", items)
	}
	src.text = "第四条"
	c.capture()
	items = c.Search(context.Background(), &core.Request{Query: match.NewQuery("")})
	if len(items) != 3 {
		t.Errorf("应淘汰超出数量的：%d", len(items))
	}
	found := c.Search(context.Background(), req("disi"))
	if len(found) != 1 || found[0].Title != "第四条" {
		t.Errorf("应支持拼音搜索：%+v", found)
	}
	if err := c.Flush(); err != nil {
		t.Fatal(err)
	}
	d := &Clipboard{Config: c.Config, Source: src, Dir: c.Dir}
	d.Load()
	if got := d.Search(context.Background(), &core.Request{Query: match.NewQuery("")}); len(got) != 3 {
		t.Errorf("重启后应保留：%d", len(got))
	}
}

func TestClipboardPinSurvivesPruneAndClear(t *testing.T) {
	cfg := store.DefaultConfig()
	cfg.Clipboard.IgnoreApps = nil
	cfg.Clipboard.MaxItems = 2
	src := &fakeClip{}
	c := &Clipboard{Config: func() *store.Config { return cfg }, Source: src, Dir: t.TempDir()}
	c.Load()
	src.text = "要固定的"
	c.capture()
	c.togglePin(c.entries[0].ID)
	for _, s := range []string{"a", "b", "c"} {
		src.text = s
		c.capture()
	}
	titles := func() string {
		var out []string
		for _, it := range c.Search(context.Background(), &core.Request{Query: match.NewQuery("")}) {
			out = append(out, it.Title)
		}
		return strings.Join(out, ",")
	}
	if !strings.Contains(titles(), "要固定的") {
		t.Errorf("固定的不应被淘汰：%s", titles())
	}
	if !strings.HasPrefix(titles(), "要固定的") {
		t.Errorf("固定的应排最前：%s", titles())
	}
	c.Clear()
	if titles() != "要固定的" {
		t.Errorf("清空后应只剩固定的：%s", titles())
	}
}

func TestPluginsScan(t *testing.T) {
	dir := t.TempDir()
	write := func(p, s string) {
		full := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("color-tool/plugin.json", `{"title":"颜色工具","keywords":["color"],"icon":"🎨"}`)
	write("broken/plugin.json", `{bad`)
	write("Bad_Name/plugin.json", `{"title":"x"}`)
	write("not-a-plugin/readme.txt", ``)
	p := &Plugins{Dir: dir, URL: func(id, path string) string { return "pocketplugin://" + id + "/" + path }}
	p.Reload()
	list := p.List()
	if len(list) != 3 {
		t.Fatalf("应扫描到 3 个：%+v", list)
	}
	items := p.Search(context.Background(), req("ys"))
	if len(items) == 0 || items[0].Actions[0].View == nil || items[0].Actions[0].View.URL != "pocketplugin://color-tool/index.html" {
		t.Errorf("拼音搜索插件：%+v", items)
	}
	if _, ok := p.DirOf("broken"); ok {
		t.Errorf("有问题的插件不应被服务")
	}
	if _, ok := p.DirOf("../etc"); ok {
		t.Errorf("非法 ID 不应被服务")
	}
}

func TestScriptsScanAndExact(t *testing.T) {
	dir := t.TempDir()
	body := "#!/bin/sh\n# @pocket.title 翻译\n# @pocket.keywords tr\n# @pocket.mode text\necho hi\n"
	if err := os.WriteFile(filepath.Join(dir, "translate.sh"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.txt"), []byte("not a command"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Scripts{Dir: dir}
	s.Reload()
	if n := len(s.Commands()); n != 1 {
		t.Fatalf("应只识别脚本：%d", n)
	}
	items := s.Search(context.Background(), req("fy"))
	if len(items) != 1 || items[0].Title != "翻译" {
		t.Errorf("拼音匹配：%+v", items)
	}
	items = s.Search(context.Background(), req("tr hello"))
	if len(items) != 1 || !items[0].Exact || !strings.Contains(items[0].Subtitle, "hello") {
		t.Errorf("关键词 + 参数：%+v", items)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s.Reload()
	if n := len(s.Commands()); n != 2 {
		t.Errorf("新文件应在重载后出现：%d", n)
	}
}

func TestCreateCommandTemplates(t *testing.T) {
	s := &Scripts{Dir: t.TempDir()}
	for _, lang := range []string{"bash", "python", "node", "powershell"} {
		path, err := s.CreateCommand(lang, "我的 "+lang)
		if err != nil {
			t.Fatalf("%s: %v", lang, err)
		}
		raw, _ := os.ReadFile(path)
		if strings.Contains(string(raw), "%!") {
			t.Errorf("%s 模板格式错误：%s", lang, raw)
		}
	}
	if len(s.Commands()) != 4 {
		t.Errorf("%+v", s.Commands())
	}
	if _, err := s.CreateCommand("bash", "我的 bash"); err == nil {
		t.Errorf("同名应报错")
	}
}

func TestFeaturesKeywordAndQuickTool(t *testing.T) {
	f := NewFeatures(nil, func(*core.View) error { return nil })
	tools := NewTools()

	// 只输入 md5：回车打开哈希功能页，并选中 MD5。
	items := f.Search(context.Background(), req("md5"))
	if len(items) == 0 || !items[0].Exact || items[0].Actions[0].View.Feature != "hash" || items[0].Actions[0].View.Args["algo"] != "md5" {
		t.Fatalf("md5 应打开哈希页：%+v", items)
	}
	r := req("md5")
	r.Context.Clipboard = "hi"
	if ti := tools.Search(context.Background(), r); len(ti) == 0 || ti[0].Exact {
		t.Errorf("只输入关键词时，小工具的结果不应抢第一：%+v", ti)
	}

	// md5 + 内容：小工具结果回车复制，第二个动作（Ctrl+回车）带着内容打开功能页。
	ti := tools.Search(context.Background(), req("md5 hello"))
	if len(ti) == 0 || !ti[0].Exact || ti[0].Actions[0].Type != core.ActionCopy {
		t.Fatalf("md5 hello 应回车复制：%+v", ti)
	}
	if a := ti[0].Actions[1]; a.Type != core.ActionView || a.View.Feature != "hash" || a.View.Input != "hello" || a.Shortcut != "mod+enter" {
		t.Errorf("Ctrl+回车应打开哈希页：%+v", a)
	}
	fi := f.Search(context.Background(), req("md5 hello"))
	if len(fi) == 0 || fi[0].Exact {
		t.Errorf("有小工具结果时，功能页不应标记为完全命中：%+v", fi)
	}

	// 翻译没有小工具：fy + 内容直接进翻译页。
	tr := f.Search(context.Background(), req("fy hello"))
	if len(tr) == 0 || !tr[0].Exact || tr[0].Actions[0].View.Input != "hello" {
		t.Errorf("fy hello：%+v", tr)
	}
	// 拼音找功能页。
	if got := f.Search(context.Background(), req("myyd")); len(got) == 0 || got[0].Title != "摸鱼阅读" {
		t.Errorf("拼音首字母：%+v", got)
	}
	if _, ok := f.Resolve("features:regex"); !ok {
		t.Errorf("功能页应能按 ID 找回（置顶、热键）")
	}
}

func TestWindowsProvider(t *testing.T) {
	focused := 0
	w := &Windows{List: func() []WindowEntry { return []WindowEntry{{ID: 3, Title: "哈希计算"}, {ID: 4, Title: "翻译"}} }, Focus: func(id int) { focused = id }}
	items := w.Search(context.Background(), req("hx"))
	if len(items) != 1 || items[0].Title != "哈希计算" {
		t.Fatalf("按标题找窗口：%+v", items)
	}
	if got := w.Search(context.Background(), req("窗口")); len(got) != 2 {
		t.Errorf("输入「窗口」列出全部：%d", len(got))
	}
	_ = focused
}

func payloadReq(typed string) *core.Request {
	first, rest, _ := strings.Cut(typed, " ")
	return &core.Request{Text: typed, Query: match.NewQuery(typed), First: first, Rest: rest}
}

func titlesOf(items []core.Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Title
	}
	return out
}

func TestFeaturesSearchPayloadText(t *testing.T) {
	f := NewFeatures(nil, func(*core.View) error { return nil })
	text := &core.Payload{Kind: core.PayloadText, Text: "report-final.pdf"}

	// 没有输入功能名：给一组通用的功能，翻译在前，都带着这段文字。
	items := f.SearchPayload(context.Background(), payloadReq(""), text)
	if len(items) < 4 || items[0].Title != "翻译" {
		t.Fatalf("默认建议：%v", titlesOf(items))
	}
	for _, it := range items {
		if it.Actions[0].View.Input != text.Text {
			t.Errorf("%s 没有带上文字", it.Title)
		}
		if it.Title == "JSON 工具" || it.Title == "图片文字识别" || it.Title == "摸鱼阅读" {
			t.Errorf("不相关的功能不应出现：%s", it.Title)
		}
	}
	// 输入功能名（拼音首字母也行）：进入文本处理，文字自动带进去。
	got := f.SearchPayload(context.Background(), payloadReq("wbcl"), text)
	if len(got) != 1 || got[0].Title != "文本处理" || got[0].Actions[0].View.Input != text.Text {
		t.Errorf("wbcl：%v", titlesOf(got))
	}
	// 输入 md5：哈希页排在小工具的直接结果后面，打开时选中 MD5。
	got = f.SearchPayload(context.Background(), payloadReq("md5"), text)
	if len(got) != 1 || got[0].Actions[0].View.Args["algo"] != "md5" || got[0].Exact {
		t.Errorf("md5：%+v", got)
	}
}

func TestSuggestByContent(t *testing.T) {
	f := NewFeatures(nil, func(*core.View) error { return nil })
	cases := map[string]string{
		`{"a":1}`:             "JSON 工具",
		"1700000000":          "时间戳转换",
		"#ff8800":             "颜色转换",
		"https://a.com/p?x=1": "URL 解析",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig": "JWT 解析",
	}
	for text, want := range cases {
		items := f.SearchPayload(context.Background(), payloadReq(""), &core.Payload{Kind: core.PayloadText, Text: text})
		best := items[0]
		for _, it := range items {
			if it.Score > best.Score {
				best = it
			}
		}
		if best.Title != want {
			t.Errorf("%q 应首推 %s，得到 %s", text, want, best.Title)
		}
	}
}

func TestFeaturesSearchPayloadImage(t *testing.T) {
	ran := ""
	f := NewFeatures(nil, func(*core.View) error { return nil })
	f.PayloadCommands = []*PayloadCommand{
		{ID: "image-save", Title: "保存图片到文件", Keywords: []string{"save", "bc"}, Score: 0.7,
			Accept: func(p *core.Payload) bool { return p.ImagePath() != "" },
			Run:    func(_ context.Context, _ *core.Run, p *core.Payload) error { ran = p.ImagePath(); return nil }},
		{ID: "text-copy", Title: "复制这段文字", Score: 0.2, Accept: func(p *core.Payload) bool { return p.Kind == core.PayloadText }},
	}
	img := &core.Payload{Kind: core.PayloadImage, Image: "/tmp/a.png"}
	items := f.SearchPayload(context.Background(), payloadReq(""), img)
	if got := strings.Join(titlesOf(items), "|"); got != "识别图片里的文字|保存图片到文件" {
		t.Fatalf("图片的操作：%s", got)
	}
	if items[0].Actions[0].View.Args["image"] != "/tmp/a.png" || items[0].Preview == nil {
		t.Errorf("识别要带上图片路径和预览：%+v", items[0])
	}
	if err := items[1].Actions[0].Fn(context.Background(), nil); err != nil || ran != "/tmp/a.png" {
		t.Errorf("命令应拿到图片：%q %v", ran, err)
	}
	if got := f.SearchPayload(context.Background(), payloadReq("save"), img); len(got) != 1 || got[0].Title != "保存图片到文件" {
		t.Errorf("按关键词过滤：%v", titlesOf(got))
	}
	// 只带了一个图片文件，也当图片处理；另外可以算文件哈希。
	file := &core.Payload{Kind: core.PayloadFiles, Files: []string{"/tmp/b.JPG"}}
	if got := strings.Join(titlesOf(f.SearchPayload(context.Background(), payloadReq(""), file)), "|"); got != "识别图片里的文字|哈希计算|保存图片到文件" {
		t.Errorf("图片文件：%s", got)
	}
}

func TestToolsWebScriptsPayload(t *testing.T) {
	text := &core.Payload{Kind: core.PayloadText, Text: "hello"}
	tools := NewTools().SearchPayload(context.Background(), payloadReq("md5"), text)
	if len(tools) != 1 || tools[0].Title != "5d41402abc4b2a76b9719d911017c592" {
		t.Errorf("块后输入 md5 应直接算出结果：%+v", tools)
	}
	cfg := store.DefaultConfig()
	w := &Web{Config: func() *store.Config { return cfg }}
	web := w.SearchPayload(context.Background(), payloadReq("gh"), text)
	if len(web) != 1 || !strings.Contains(web[0].Actions[0].Target, "github.com/search?q=hello") {
		t.Errorf("块后输入搜索引擎关键词：%+v", web)
	}
	if got := w.SearchPayload(context.Background(), payloadReq(""), text); got != nil {
		t.Errorf("没有输入时不重复给网页搜索")
	}

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "translate.sh"), []byte("#!/bin/sh\n# @pocket.title 翻译脚本\n# @pocket.keywords trs\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Scripts{Dir: dir}
	s.Reload()
	sc := s.SearchPayload(context.Background(), payloadReq("trs"), text)
	if len(sc) != 1 || !sc[0].Exact {
		t.Errorf("块后输入脚本关键词：%+v", sc)
	}
}

func TestClipboardRecentAndSuppress(t *testing.T) {
	cfg := store.DefaultConfig()
	cfg.Clipboard.IgnoreApps = nil
	src := &fakeClip{text: "刚复制的"}
	c := &Clipboard{Config: func() *store.Config { return cfg }, Source: src, Dir: t.TempDir()}
	c.Load()
	if c.Recent(time.Minute) != nil {
		t.Errorf("启动前的内容不算刚复制")
	}
	c.capture()
	e := c.Recent(time.Minute)
	if e == nil || e.Text != "刚复制的" {
		t.Fatalf("应返回刚复制的内容：%+v", e)
	}
	if c.Recent(time.Minute) != nil {
		t.Errorf("同一次复制只带入一次")
	}
	c.capture()
	if c.Recent(0) != nil {
		t.Errorf("超过时间的不带入")
	}
}

// 命令行打开了全局搜索时，不能给任何输入都配一条满分的“执行这条命令”。
func TestShellInGlobalSearch(t *testing.T) {
	global := func(text string) []core.Item {
		first, _, _ := strings.Cut(text, " ")
		return Shell{}.Search(context.Background(), &core.Request{Text: text, First: first})
	}
	if got := global("idea-这不是一个程序"); len(got) != 0 {
		t.Fatalf("不是程序的输入不该出现“执行命令”：%+v", got)
	}
	if got := global(""); len(got) != 0 {
		t.Fatalf("没有输入时不该出现：%+v", got)
	}
	got := global("go version")
	if len(got) != 1 || got[0].Score >= 0.7 || got[0].Title != "go version" {
		t.Fatalf("是程序时给出一条，但分数要低：%+v", got)
	}
	// 用前缀进来（> xxx）时照旧：输入什么都当命令，分数最高。
	scoped := Shell{}.Search(context.Background(), &core.Request{Text: "随便什么", First: "随便什么", Scoped: true})
	if len(scoped) != 1 || scoped[0].Score != 1 {
		t.Fatalf("前缀模式下应该照旧：%+v", scoped)
	}
}

// 关键词可以由用户改：改了之后新词生效，原来的词不再是“完全命中”。
func TestFeaturesCustomKeywords(t *testing.T) {
	f := NewFeatures(nil, func(*core.View) error { return nil })
	custom := map[string][]string{"features:json": {"jj", "格式化"}, "features:regex": {}}
	f.Custom = func(id string) ([]string, bool) { w, ok := custom[id]; return w, ok }

	exact := func(q string) string {
		for _, it := range f.Search(context.Background(), req(q)) {
			if it.Exact {
				return it.Actions[0].View.Feature
			}
		}
		return ""
	}
	if got := exact("jj"); got != "json" {
		t.Errorf("自定义的关键词 jj 应该打开 JSON 工具，得到 %q", got)
	}
	if got := exact("格式化"); got != "json" {
		t.Errorf("可以配多个关键词，得到 %q", got)
	}
	if got := exact("json"); got == "json" {
		t.Errorf("改掉之后，原来的关键词 json 不应再是完全命中")
	}
	if got := exact("regex"); got != "" {
		t.Errorf("关键词清空之后不应再有完全命中，得到 %q", got)
	}
	if got := f.KeywordsOf("features:json"); !slices.Equal(got, []string{"jj", "格式化"}) {
		t.Errorf("KeywordsOf 应返回生效的关键词：%v", got)
	}
	if got := f.DefaultKeywordsOf("features:json"); !slices.Contains(got, "json") {
		t.Errorf("DefaultKeywordsOf 应返回自带的：%v", got)
	}
	// 没改过的照旧。
	if got := exact("md5"); got != "hash" {
		t.Errorf("没改过的关键词照旧，得到 %q", got)
	}
	// 清空关键词之后仍然能按名字找到。
	found := false
	for _, it := range f.Search(context.Background(), req("正则")) {
		found = found || it.ID == "features:regex"
	}
	if !found {
		t.Errorf("没有关键词的功能仍然应该能按名字搜到")
	}
}
