package providers

import (
	"context"
	"runtime"
	"strings"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
)

// FeatureDef 是一个内置功能页。
type FeatureDef struct {
	ID       string
	Title    string
	Icon     string
	Category string // 效率工具 | 开发工具
	Desc     string
	Keywords []string
	// Aliases 是「关键词 → 打开时带的参数」，例如 md5 打开哈希页并选中 MD5。
	Aliases map[string]map[string]string
	// QuickTool 表示小工具对「关键词 + 内容」已经给出了直接结果（回车复制），
	// 这时功能页排在它后面，用 Ctrl+回车 打开。
	QuickTool bool
	// Scope 是这个功能在搜索框里的行内形式（Tab 进入）：例如剪贴板历史既能开页面，也能在搜索框里直接搜。
	Scope *core.Scope
	// OS 不为空时只在这个系统上出现（windows | darwin）。
	OS     string
	target *match.Target
	kw     []*match.Target
}

// FeatureCommand 是功能下的一条命令，例如「截图识别并复制」。
type FeatureCommand struct {
	ID       string
	Title    string
	Icon     string
	Category string
	Desc     string
	Keywords []string
	Run      func(ctx context.Context, r *core.Run) error
	target   *match.Target
	kw       []*match.Target
}

// FeatureDefs 是全部内置功能页。界面上的实现在 src/features。
func FeatureDefs() []*FeatureDef {
	return []*FeatureDef{
		{ID: "translate", Title: "翻译", Icon: "svg:languages", Category: "效率工具", Desc: "接入大模型、有道或百度翻译，可以发音",
			Keywords: []string{"fy", "fanyi", "translate", "tr", "翻译"}},
		{ID: "ocr", Title: "图片文字识别", Icon: "svg:scan-text", Category: "效率工具", Desc: "识别截图、剪贴板或图片文件里的文字",
			Keywords: []string{"ocr", "sbwz", "识别", "图片识别"}},
		{ID: "reader", Title: "摸鱼阅读", Icon: "svg:book-open", Category: "效率工具", Desc: "导入 txt / epub 小说，可以分离成不起眼的小窗",
			Keywords: []string{"my", "moyu", "read", "xs", "xiaoshuo", "阅读", "小说"}},
		{ID: "calc", Title: "计算器", Icon: "svg:calculator", Category: "效率工具", Desc: "多行计算、变量、单位和进制换算，带历史",
			Keywords: []string{"calc", "jsq", "jisuanqi", "calculator", "计算器", "计算"}},
		{ID: "clipboard", Title: "剪贴板历史", Icon: "svg:clipboard", Category: "效率工具", Desc: "翻找复制过的文字、图片和文件，可以固定",
			Keywords: []string{"cb", "clip", "clipboard", "jtb", "jianqieban", "剪贴板"},
			Scope:    &core.Scope{ID: "clipboard", Title: "剪贴板历史", Icon: "svg:clipboard", Placeholder: "搜索剪贴板历史…"}},
		{ID: "find", Title: "高级搜索", Icon: "svg:search", Category: "效率工具", Desc: "按类型筛选文件，预览内容和属性；装了 Everything 时用它搜全盘",
			Keywords: []string{"find", "search", "gjss", "wjss", "everything", "本地搜索", "文件搜索", "高级搜索", "搜索"}},
		{ID: "wintools", Title: "Windows 工具", Icon: "svg:wrench", Category: "效率工具", Desc: "常用的控制面板项和管理工具（.cpl / .msc），按名字或说明搜索", OS: "windows",
			Keywords: []string{"wt", "wintools", "cpl", "msc", "控制面板", "管理工具", "系统工具"}},
		{ID: "notes", Title: "Markdown 笔记", Icon: "svg:notebook", Category: "效率工具", Desc: "随手记：文件夹和文件管理，所见即所得或源码编辑",
			Keywords: []string{"md", "note", "notes", "markdown", "bj", "biji", "笔记", "记事"}},
		{ID: "scratch", Title: "代码草稿", Icon: "svg:code", Category: "开发工具", Desc: "临时写一段代码：高亮、格式化，装了对应环境的可以直接运行",
			Keywords: []string{"scratch", "code", "run", "cg", "caogao", "草稿", "代码", "运行"}},
		{ID: "json", Title: "JSON 工具", Icon: "svg:braces", Category: "开发工具", Desc: "格式化、压缩、校验、转义、排序键",
			Keywords: []string{"json", "jsonm", "format"}, QuickTool: true,
			Aliases: map[string]map[string]string{"jsonm": {"action": "minify"}}},
		{ID: "codec", Title: "编码转换", Icon: "svg:binary", Category: "开发工具", Desc: "Base64、URL、Unicode、HTML 实体、十六进制",
			Keywords: []string{"base64", "b64", "b64d", "url", "urld", "unicode", "html", "hex", "encode", "decode", "编码", "解码"}, QuickTool: true,
			Aliases: map[string]map[string]string{
				"base64": {"mode": "base64"}, "b64": {"mode": "base64"}, "b64d": {"mode": "base64", "dir": "decode"},
				"url": {"mode": "url"}, "urld": {"mode": "url", "dir": "decode"}, "unicode": {"mode": "unicode"},
				"html": {"mode": "html"}, "hex": {"mode": "hex"},
			}},
		{ID: "hash", Title: "哈希计算", Icon: "svg:fingerprint", Category: "开发工具", Desc: "MD5、SHA-1、SHA-256、SHA-512，支持文件",
			Keywords: []string{"md5", "sha1", "sha256", "sha512", "hash", "哈希"}, QuickTool: true,
			Aliases: map[string]map[string]string{"md5": {"algo": "md5"}, "sha1": {"algo": "sha1"}, "sha256": {"algo": "sha256"}, "sha512": {"algo": "sha512"}}},
		{ID: "timestamp", Title: "时间戳转换", Icon: "svg:clock", Category: "开发工具", Desc: "时间戳和日期互转，秒、毫秒、时区",
			Keywords: []string{"ts", "timestamp", "time", "date", "时间戳"}, QuickTool: true},
		{ID: "regex", Title: "正则测试", Icon: "svg:regex", Category: "开发工具", Desc: "实时高亮匹配和分组，附常用正则",
			Keywords: []string{"re", "regex", "regexp", "正则"}},
		{ID: "jwt", Title: "JWT 解析", Icon: "svg:key-round", Category: "开发工具", Desc: "解出头部和载荷，看过期时间",
			Keywords: []string{"jwt", "token"}},
		{ID: "diff", Title: "文本对比", Icon: "svg:diff", Category: "开发工具", Desc: "两边直接编辑、实时高亮差异，按语言高亮和格式化",
			Keywords: []string{"diff", "compare", "对比", "比较"}},
		{ID: "random", Title: "UUID 与密码", Icon: "svg:dices", Category: "开发工具", Desc: "批量生成 UUID、随机密码",
			Keywords: []string{"uuid", "guid", "password", "pwd", "random", "随机", "密码"}, QuickTool: true,
			Aliases: map[string]map[string]string{"uuid": {"tab": "uuid"}, "guid": {"tab": "uuid"}, "password": {"tab": "password"}, "pwd": {"tab": "password"}}},
		{ID: "color", Title: "颜色转换", Icon: "svg:palette", Category: "开发工具", Desc: "HEX、RGB、HSL 互转，取色",
			Keywords: []string{"color", "rgb", "hsl", "颜色", "取色"}},
		{ID: "urlparse", Title: "URL 解析", Icon: "svg:link", Category: "开发工具", Desc: "拆出协议、主机、路径和查询参数",
			Keywords: []string{"urlp", "query", "params", "网址解析"}},
		{ID: "text", Title: "文本处理", Icon: "svg:case-sensitive", Category: "开发工具", Desc: "大小写、命名风格、去重排序、字数统计",
			Keywords: []string{"upper", "lower", "count", "case", "文本", "统计", "大小写"}, QuickTool: true,
			Aliases: map[string]map[string]string{"upper": {"op": "upper"}, "lower": {"op": "lower"}, "count": {"op": "count"}}},
	}
}

// ForceFeatures 里的功能页不受系统限制（测试时用）。
var ForceFeatures = map[string]bool{}

// Available 报告这个功能页在当前系统上是否可用。
func (d *FeatureDef) Available() bool {
	return d.OS == "" || d.OS == runtime.GOOS || ForceFeatures[d.ID]
}

// Features 是内置功能页和相关命令。
type Features struct {
	Defs     []*FeatureDef
	Commands []*FeatureCommand
	// PayloadCommands 是针对带入内容（文字块、图片、文件）的命令。
	PayloadCommands []*PayloadCommand
	// Detach 把功能页直接以独立窗口打开。
	Detach func(v *core.View) error
}

// NewFeatures 创建功能页数据源。
func NewFeatures(commands []*FeatureCommand, detach func(v *core.View) error) *Features {
	f := &Features{Commands: commands, Detach: detach}
	for _, d := range FeatureDefs() {
		if d.Available() {
			f.Defs = append(f.Defs, d)
		}
	}
	for _, d := range f.Defs {
		d.target = match.Prepare(d.Title)
		for _, k := range d.Keywords {
			d.kw = append(d.kw, match.Prepare(k))
		}
	}
	for _, c := range f.Commands {
		c.target = match.Prepare(c.Title)
		for _, k := range c.Keywords {
			c.kw = append(c.kw, match.Prepare(k))
		}
	}
	return f
}

// Info 实现 core.Provider。
func (f *Features) Info() core.Info {
	return core.Info{ID: "features", Title: "功能", Icon: "svg:sparkles"}
}

// Def 按 ID 查找功能页。
func (f *Features) Def(id string) *FeatureDef {
	for _, d := range f.Defs {
		if d.ID == id {
			return d
		}
	}
	return nil
}

// FeatureView 构造打开功能页的视图。
func FeatureView(d *FeatureDef, input string, args map[string]string) *core.View {
	return &core.View{Type: "feature", Feature: d.ID, Title: d.Title, Icon: d.Icon, Input: input, Args: args}
}

func (f *Features) item(d *FeatureDef, input string, args map[string]string) core.Item {
	view := FeatureView(d, input, args)
	id := "features:" + d.ID
	sub := d.Desc
	if input != "" {
		sub = "带入：" + truncate(input, 60)
	}
	it := core.Item{
		ID: id, Title: d.Title, Subtitle: sub, Icon: d.Icon, Source: "features",
		Actions: []core.Action{
			{Type: core.ActionView, Title: "打开", View: view},
			{Type: core.ActionFunc, Title: "在独立窗口打开", Shortcut: "mod+d", Fn: func(context.Context, *core.Run) error {
				return f.Detach(view)
			}},
		},
	}
	if d.Scope != nil {
		sc := *d.Scope
		it.Scope = &sc
		it.Dedup = "scope:" + sc.ID // 和模块自己的入口是同一样东西，只留一条
		it.Actions = append(it.Actions, core.Action{Type: core.ActionScope, Title: "在搜索框里搜索", Scope: &sc})
	}
	return it
}

func (f *Features) commandItem(c *FeatureCommand) core.Item {
	return core.Item{
		ID: "features:" + c.ID, Title: c.Title, Subtitle: c.Desc, Icon: c.Icon, Source: "features",
		Actions: []core.Action{{Type: core.ActionFunc, Title: "执行", Fn: c.Run}},
	}
}

// Search 实现 core.Provider。
func (f *Features) Search(_ context.Context, req *core.Request) []core.Item {
	var out []core.Item
	first := strings.ToLower(req.First)
	for _, d := range f.Defs {
		if hit, args := keywordOf(d, first); hit {
			it := f.item(d, req.Rest, args)
			switch {
			case req.Rest == "":
				it.Exact, it.Score = true, 1 // 只输入关键词：回车打开功能页
			case d.QuickTool:
				it.Score = 0.97 // 小工具已经给出了结果，功能页排在后面（Ctrl+回车）
			default:
				it.Exact, it.Score = true, 1
			}
			out = append(out, it)
			continue
		}
		if r := match.Best(req.Query, d.target, d.kw...); r.OK && r.Score > 0 {
			it := f.item(d, "", nil)
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
		}
	}
	for _, c := range f.Commands {
		if r := match.Best(req.Query, c.target, c.kw...); r.OK && r.Score > 0 {
			it := f.commandItem(c)
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
		}
	}
	return out
}

func keywordOf(d *FeatureDef, first string) (bool, map[string]string) {
	if first == "" {
		return false, nil
	}
	for _, k := range d.Keywords {
		if strings.EqualFold(k, first) {
			return true, d.Aliases[strings.ToLower(k)]
		}
	}
	return false, nil
}

// Resolve 实现 core.Resolver。
func (f *Features) Resolve(id string) (core.Item, bool) {
	name, ok := strings.CutPrefix(id, "features:")
	if !ok {
		return core.Item{}, false
	}
	if d := f.Def(name); d != nil {
		return f.item(d, "", nil), true
	}
	for _, c := range f.Commands {
		if c.ID == name {
			return f.commandItem(c), true
		}
	}
	return core.Item{}, false
}

// CatalogItems 实现 core.Lister。
func (f *Features) CatalogItems() []core.Item {
	var out []core.Item
	for _, d := range f.Defs {
		it := f.item(d, "", nil)
		it.SourceLabel = d.Category
		out = append(out, it)
	}
	for _, c := range f.Commands {
		it := f.commandItem(c)
		it.SourceLabel = c.Category
		out = append(out, it)
	}
	return out
}

// KeywordsOf 返回功能页或命令的触发词（道具库展示用）。
func (f *Features) KeywordsOf(id string) []string {
	name := strings.TrimPrefix(id, "features:")
	if d := f.Def(name); d != nil {
		return d.Keywords
	}
	for _, c := range f.Commands {
		if c.ID == name {
			return c.Keywords
		}
	}
	return nil
}
