package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
)

// 扩展（plugins/<id>/）：一个文件夹加一份 plugin.json。界面是普通网页，跑在隔离的 iframe 里，
// 通过 window.pocket 使用宿主的能力；也可以带一个本地程序做后端。
//
// 一个扩展可以提供多个工具（tools），它们一起构建、共用依赖。老的写法（只有 title / main）仍然有效，
// 相当于只有一个工具。

// APIVersion 是当前的扩展接口版本。清单里写的 api 比它大时，这个扩展不会被加载。
const APIVersion = 1

// Manifest 是 plugin.json。
type Manifest struct {
	// 扩展自身
	ID          string `json:"id,omitempty"` // 可以不写，默认是文件夹名
	Name        string `json:"name,omitempty"`
	Version     string `json:"version,omitempty"`
	Author      string `json:"author,omitempty"`
	API         int    `json:"api,omitempty"`
	Description string `json:"description,omitempty"`
	Icon        string `json:"icon,omitempty"`

	// 只有一个工具时可以直接写在最外层（也是老的写法）。
	Title    string      `json:"title,omitempty"`
	Keywords []string    `json:"keywords,omitempty"`
	Main     string      `json:"main,omitempty"`
	Height   int         `json:"height,omitempty"`
	Width    int         `json:"width,omitempty"`
	Window   string      `json:"window,omitempty"`
	Matches  []MatchRule `json:"matches,omitempty"`

	Tools       []ToolDef   `json:"tools,omitempty"`
	Permissions Permissions `json:"permissions,omitempty"`
	Backend     *BackendDef `json:"backend,omitempty"`
}

// ToolDef 是扩展里的一个工具：搜索框里的一项，打开后是一个页面。
type ToolDef struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	Icon        string   `json:"icon,omitempty"`
	Category    string   `json:"category,omitempty"` // 道具库里归到哪一类；默认“扩展”
	Keywords    []string `json:"keywords,omitempty"`
	Entry       string   `json:"entry,omitempty"` // 页面地址，相对扩展目录；默认用 main
	// Window 决定在哪儿打开：panel 嵌在主窗口里（默认，可以再分离）| window 直接开独立窗口 |
	// float 桌面悬浮窗（无边框、透明、置顶，不进任务栏）。
	Window  string      `json:"window,omitempty"`
	Width   int         `json:"width,omitempty"`
	Height  int         `json:"height,omitempty"`
	Matches []MatchRule `json:"matches,omitempty"`
}

// MatchRule 让工具出现在“带入内容”的候选里：选中文字、复制的文件或图片符合规则时，可以直接交给它处理。
type MatchRule struct {
	Type  string   `json:"type"`            // text | files | image
	Regex string   `json:"regex,omitempty"` // text：整段文字要匹配的正则
	Min   int      `json:"min,omitempty"`   // text：最少几个字
	Max   int      `json:"max,omitempty"`   // text：最多几个字
	Exts  []string `json:"exts,omitempty"`  // files：扩展名（带点）；空表示任何文件
	Label string   `json:"label,omitempty"` // 候选项的副标题，例如“用 Markdown 笔记记下来”

	re *regexp.Regexp
}

// Permissions 声明扩展要用哪些宿主能力。没声明的调用会被拒绝；安装时会列给用户看。
type Permissions struct {
	// Dirs 是用户目录下的几个文件夹名（例如 notes），扩展可以读写里面的文件。自己的私有目录不用声明。
	Dirs []string `json:"dirs,omitempty"`
	// Fetch 是允许通过宿主发请求的域名；"*" 表示任意公网地址。本机和内网地址必须写明才行。
	Fetch []string `json:"fetch,omitempty"`
	// Runner 允许运行和格式化代码（用本机装着的解释器）。
	Runner bool `json:"runner,omitempty"`
	// Files 允许弹出系统的“打开 / 另存为”对话框，读写用户选的那个文件。
	Files bool `json:"files,omitempty"`
}

// BackendDef 是扩展自带的后端程序。
type BackendDef struct {
	// Command 是启动命令，相对扩展目录；可以按系统分开写（darwin / windows / linux）。
	Command  []string            `json:"command,omitempty"`
	Commands map[string][]string `json:"commands,omitempty"`
	// Mode：oneshot 每次调用起一个进程、跑完就退 | on-demand 第一次用到时拉起，闲置一阵自动关。
	Mode string `json:"mode,omitempty"`
	// Idle 是 on-demand 闲置多少秒后关掉，默认 300。
	Idle int `json:"idle,omitempty"`
}

// Tool 是加载好的一个工具。
type Tool struct {
	ToolDef
	Plugin string
	target *match.Target
}

// ItemID 是这个工具在搜索、快捷键、停用列表里的 ID。扩展只有一个同名工具时就是 plugins:<扩展>。
func (t *Tool) ItemID() string {
	if t.ID == t.Plugin {
		return "plugins:" + t.Plugin
	}
	return "plugins:" + t.Plugin + "/" + t.ID
}

type plugin struct {
	Manifest
	id       string
	dir      string
	problem  string
	disabled bool
	tools    []*Tool
}

// PluginInfo 是道具库和设置页显示的扩展信息。
type PluginInfo struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Description string      `json:"description,omitempty"`
	Version     string      `json:"version,omitempty"`
	Author      string      `json:"author,omitempty"`
	Icon        string      `json:"icon,omitempty"`
	Dir         string      `json:"dir"`
	Problem     string      `json:"problem,omitempty"`
	Enabled     bool        `json:"enabled"`
	Tools       []string    `json:"tools"` // 各个工具的标题
	Permissions Permissions `json:"permissions"`
	Backend     bool        `json:"backend"` // 带本地程序：等同于安装了一个程序，不受上面权限的约束
}

// Plugins 是扩展的数据源。
type Plugins struct {
	Dir string
	URL func(id, path string) string
	// Disabled 报告一个扩展是不是被停用了。
	Disabled func(id string) bool
	// OpenFloat 打开（或收起）悬浮窗工具；Detach 直接以独立窗口打开。
	OpenFloat func(plugin, tool string) error
	Detach    func(v *core.View) error
	// Custom 查用户自己定的关键词（设置里可以改）。
	Custom CustomKeywords
	kws    keywordSet

	mu   sync.RWMutex
	list []*plugin
}

// Info 实现 core.Provider。
func (p *Plugins) Info() core.Info {
	return core.Info{ID: "plugins", Title: "扩展", Icon: "svg:puzzle"}
}

var pluginIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// ValidPluginID 报告一个名字能不能当扩展或工具的 ID。
func ValidPluginID(id string) bool { return pluginIDRe.MatchString(id) && len(id) <= 64 }

// ReadManifest 读一个扩展目录里的清单，并补上默认值。dirName 是文件夹名。
func ReadManifest(dir, dirName string) (*Manifest, []*Tool, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "plugin.json"))
	if err != nil {
		return nil, nil, fmt.Errorf("没有 plugin.json")
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, nil, fmt.Errorf("plugin.json 不是合法的 JSON：%v", err)
	}
	if m.ID == "" {
		m.ID = strings.ToLower(dirName)
	}
	if !ValidPluginID(m.ID) {
		return &m, nil, fmt.Errorf("扩展的 ID 只能包含小写字母、数字和连字符")
	}
	if m.API > APIVersion {
		return &m, nil, fmt.Errorf("这个扩展需要更新版本的 Yojigen Pocket（接口版本 %d，当前是 %d）", m.API, APIVersion)
	}
	if m.Main == "" {
		m.Main = "index.html"
	}
	if m.Name == "" {
		m.Name = m.Title
	}
	defs := m.Tools
	if len(defs) == 0 {
		title := m.Title
		if title == "" {
			title = m.Name
		}
		if title == "" {
			title = dirName
		}
		defs = []ToolDef{{ID: m.ID, Title: title, Description: m.Description, Icon: m.Icon, Keywords: m.Keywords, Entry: m.Main, Window: m.Window, Width: m.Width, Height: m.Height, Matches: m.Matches}}
	}
	if m.Name == "" {
		m.Name = defs[0].Title
	}
	seen := map[string]bool{}
	var tools []*Tool
	for _, d := range defs {
		if !ValidPluginID(d.ID) || seen[d.ID] {
			return &m, nil, fmt.Errorf("工具的 ID「%s」不合法或者重复了", d.ID)
		}
		seen[d.ID] = true
		if d.Title == "" {
			d.Title = d.ID
		}
		if d.Entry == "" {
			d.Entry = m.Main
		}
		if d.Icon == "" {
			d.Icon = m.Icon
		}
		switch d.Window {
		case "", "panel", "window", "float":
		default:
			return &m, nil, fmt.Errorf("工具「%s」的 window 只能是 panel、window 或 float", d.ID)
		}
		for i := range d.Matches {
			r := &d.Matches[i]
			if r.Type != "text" && r.Type != "files" && r.Type != "image" {
				return &m, nil, fmt.Errorf("工具「%s」的匹配规则类型只能是 text、files 或 image", d.ID)
			}
			if r.Regex != "" {
				re, err := regexp.Compile(r.Regex)
				if err != nil {
					return &m, nil, fmt.Errorf("工具「%s」的正则写错了：%v", d.ID, err)
				}
				r.re = re
			}
		}
		tools = append(tools, &Tool{ToolDef: d, Plugin: m.ID, target: match.Prepare(d.Title)})
	}
	for _, d := range m.Permissions.Dirs {
		if !ValidUserDir(d) {
			return &m, nil, fmt.Errorf("permissions.dirs 里的「%s」不能用", d)
		}
	}
	if b := m.Backend; b != nil {
		if b.Mode == "" {
			b.Mode = "on-demand"
		}
		if b.Mode != "oneshot" && b.Mode != "on-demand" {
			return &m, nil, fmt.Errorf("backend.mode 只能是 oneshot 或 on-demand")
		}
	}
	return &m, tools, nil
}

// 用户目录下这些名字是应用自己用的，扩展不能要。
var reservedDirs = map[string]bool{"commands": true, "plugins": true, "snippets": true, "ui": true, "data": true, "cache": true, "logs": true}

// ValidUserDir 报告扩展能不能申请用户目录下的这个文件夹。
func ValidUserDir(name string) bool {
	return ValidPluginID(name) && !reservedDirs[name]
}

// Reload 重新扫描扩展目录。
func (p *Plugins) Reload() {
	entries, err := os.ReadDir(p.Dir)
	if err != nil {
		p.mu.Lock()
		p.list = nil
		p.mu.Unlock()
		return
	}
	var list []*plugin
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		dir := filepath.Join(p.Dir, e.Name())
		if _, err := os.Stat(filepath.Join(dir, "plugin.json")); err != nil {
			continue
		}
		x := &plugin{id: strings.ToLower(e.Name()), dir: dir}
		m, tools, err := ReadManifest(dir, e.Name())
		if m != nil {
			x.Manifest = *m
		}
		switch {
		case err != nil:
			x.problem = err.Error()
		case m.ID != x.id:
			x.problem = "文件夹名要和 plugin.json 里的 id 一致（" + m.ID + "）"
		default:
			x.tools = tools
		}
		if x.Name == "" {
			x.Name = e.Name()
		}
		x.disabled = p.Disabled != nil && p.Disabled(x.id)
		list = append(list, x)
	}
	slices.SortFunc(list, func(a, b *plugin) int { return strings.Compare(a.id, b.id) })
	p.mu.Lock()
	p.list = list
	p.mu.Unlock()
}

// List 返回全部扩展。
func (p *Plugins) List() []PluginInfo {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]PluginInfo, 0, len(p.list))
	for _, x := range p.list {
		info := PluginInfo{
			ID: x.id, Title: x.Name, Description: x.Description, Version: x.Version, Author: x.Author, Icon: p.icon(x, x.Icon), Dir: x.dir,
			Problem: x.problem, Enabled: !x.disabled, Tools: []string{}, Permissions: x.Permissions, Backend: x.Backend != nil,
		}
		for _, t := range x.tools {
			info.Tools = append(info.Tools, t.Title)
		}
		out = append(out, info)
	}
	return out
}

func (p *Plugins) find(id string) *plugin {
	for _, x := range p.list {
		if x.id == id {
			return x
		}
	}
	return nil
}

// DirOf 返回扩展的文件夹（协议处理器用）。有问题或被停用的不返回。
func (p *Plugins) DirOf(id string) (string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if x := p.find(id); x != nil && x.problem == "" && !x.disabled {
		return x.dir, true
	}
	return "", false
}

// ManifestOf 返回一个可用扩展的清单和目录。
func (p *Plugins) ManifestOf(id string) (Manifest, string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if x := p.find(id); x != nil && x.problem == "" && !x.disabled {
		return x.Manifest, x.dir, true
	}
	return Manifest{}, "", false
}

// ToolOf 返回扩展里的一个工具；tool 为空时取第一个。
func (p *Plugins) ToolOf(id, tool string) (*Tool, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	x := p.find(id)
	if x == nil || x.problem != "" || x.disabled {
		return nil, false
	}
	for _, t := range x.tools {
		if tool == "" || t.ID == tool {
			return t, true
		}
	}
	return nil, false
}

func (p *Plugins) icon(x *plugin, icon string) string {
	if icon == "" {
		return "svg:puzzle"
	}
	if strings.ContainsAny(icon, `/\.`) && !strings.HasPrefix(icon, "http") && !strings.HasPrefix(icon, "data:") {
		return "image:" + filepath.Join(x.dir, icon)
	}
	return icon
}

// View 构造打开一个工具的视图。
func (p *Plugins) View(x *plugin, t *Tool, input string, args map[string]string) *core.View {
	merged := map[string]string{"tool": t.ID}
	for k, v := range args {
		merged[k] = v
	}
	return &core.View{Type: "panel", Title: t.Title, Icon: p.icon(x, t.Icon), URL: p.URL(x.id, t.Entry), Height: t.Height, Width: t.Width, Plugin: x.id, Input: input, Args: merged}
}

// ViewOf 按 ID 构造视图（悬浮窗、快捷键用）。
func (p *Plugins) ViewOf(id, tool string) (*core.View, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	x := p.find(id)
	if x == nil || x.problem != "" || x.disabled {
		return nil, false
	}
	for _, t := range x.tools {
		if tool == "" || t.ID == tool {
			return p.View(x, t, "", nil), true
		}
	}
	return nil, false
}

func (p *Plugins) item(x *plugin, t *Tool, input string, args map[string]string) core.Item {
	sub := t.Description
	if sub == "" {
		sub = x.Description
	}
	if sub == "" {
		sub = "扩展"
	}
	label := t.Category
	if label == "" {
		label = "扩展"
	}
	it := core.Item{
		ID: t.ItemID(), Title: t.Title, Subtitle: sub, Icon: p.icon(x, t.Icon), Source: "plugins", SourceLabel: label,
		Path: filepath.Join(x.dir, "plugin.json"),
	}
	view := p.View(x, t, input, args)
	plug, tool := x.id, t.ID
	reveal := core.Action{Type: core.ActionReveal, Title: "在文件夹中显示", Target: x.dir}
	switch t.Window {
	case "float":
		it.Actions = []core.Action{{Type: core.ActionFunc, Title: "显示 / 收起", Fn: func(_ context.Context, r *core.Run) error {
			r.Hide()
			return p.OpenFloat(plug, tool)
		}}, reveal}
	case "window":
		it.Actions = []core.Action{
			{Type: core.ActionFunc, Title: "打开", Fn: func(context.Context, *core.Run) error { return p.Detach(view) }},
			{Type: core.ActionView, Title: "在主窗口里打开", View: view},
			reveal,
		}
	default:
		it.Actions = []core.Action{
			{Type: core.ActionView, Title: "打开", View: view},
			{Type: core.ActionFunc, Title: "在独立窗口打开", Shortcut: "mod+d", Fn: func(context.Context, *core.Run) error { return p.Detach(view) }},
			reveal,
		}
	}
	return it
}

func problemItem(x *plugin) core.Item {
	return core.Item{
		ID: "plugins:" + x.id, Title: x.Name, Subtitle: x.problem, Icon: "svg:alert", Source: "plugins", Error: true,
		Path:    filepath.Join(x.dir, "plugin.json"),
		Actions: []core.Action{{Type: core.ActionReveal, Title: "在文件夹中显示", Target: x.dir}},
	}
}

// Search 实现 core.Provider。
func (p *Plugins) Search(_ context.Context, req *core.Request) []core.Item {
	p.mu.RLock()
	defer p.mu.RUnlock()
	var out []core.Item
	first := strings.ToLower(req.First)
	for _, x := range p.list {
		if x.disabled {
			continue
		}
		if x.problem != "" {
			if r := match.Prepare(x.Name).Match(req.Query); r.OK && r.Score > 0 {
				it := problemItem(x)
				it.Score = r.Score
				out = append(out, it)
			}
			continue
		}
		for _, t := range x.tools {
			words := effective(p.Custom, t.ItemID(), t.Keywords)
			hit := hasKeyword(words, first)
			// 关键词完全命中、后面还有内容：把内容带进去（md 今天的会议）。
			if req.Rest != "" && hit && t.Window != "float" {
				it := p.item(x, t, req.Rest, nil)
				it.Exact, it.Score = true, 1
				it.Subtitle = "带入：" + truncate(req.Rest, 60)
				out = append(out, it)
				continue
			}
			if hit && req.Rest == "" {
				it := p.item(x, t, "", nil)
				it.Exact, it.Score = true, 1
				out = append(out, it)
				continue
			}
			if r := match.Best(req.Query, t.target, p.kws.targets(words)...); r.OK && r.Score > 0 {
				it := p.item(x, t, "", nil)
				it.Score, it.Highlights = r.Score, r.Positions
				out = append(out, it)
			}
		}
	}
	return out
}

// accepts 报告规则是不是接受这份带入的内容。
func (r *MatchRule) accepts(pl *core.Payload) bool {
	switch r.Type {
	case "text":
		if pl.Kind != core.PayloadText {
			return false
		}
		n := utf8.RuneCountInString(pl.Text)
		if (r.Min > 0 && n < r.Min) || (r.Max > 0 && n > r.Max) {
			return false
		}
		return r.re == nil || r.re.MatchString(pl.Text)
	case "image":
		return pl.Kind == core.PayloadImage
	case "files":
		if pl.Kind != core.PayloadFiles || len(pl.Files) == 0 {
			return false
		}
		if len(r.Exts) == 0 {
			return true
		}
		for _, f := range pl.Files {
			if !slices.Contains(r.Exts, strings.ToLower(filepath.Ext(f))) {
				return false
			}
		}
		return true
	}
	return false
}

// SearchPayload 实现 core.PayloadProvider：带入的内容符合工具声明的规则时，把工具列进候选。
func (p *Plugins) SearchPayload(_ context.Context, req *core.Request, pl *core.Payload) []core.Item {
	p.mu.RLock()
	defer p.mu.RUnlock()
	typed := strings.TrimSpace(req.Text)
	var out []core.Item
	for _, x := range p.list {
		if x.disabled || x.problem != "" {
			continue
		}
		for _, t := range x.tools {
			if t.Window == "float" {
				continue
			}
			for i := range t.Matches {
				rule := &t.Matches[i]
				if !rule.accepts(pl) {
					continue
				}
				args := map[string]string{"payload": pl.Kind}
				input := ""
				switch pl.Kind {
				case core.PayloadText:
					input = pl.Text
				case core.PayloadImage:
					args["image"] = pl.Image
				case core.PayloadFiles:
					raw, _ := json.Marshal(pl.Files)
					args["files"] = string(raw)
				}
				it := p.item(x, t, input, args)
				if rule.Label != "" {
					it.Subtitle = rule.Label
				}
				if typed == "" {
					it.Score = 0.6
				} else if r := match.Best(req.Query, t.target, p.kws.targets(effective(p.Custom, t.ItemID(), t.Keywords))...); r.OK && r.Score > 0 {
					it.Score, it.Highlights = r.Score, r.Positions
				} else {
					break
				}
				out = append(out, it)
				break
			}
		}
	}
	return out
}

// Resolve 实现 core.Resolver。
func (p *Plugins) Resolve(id string) (core.Item, bool) {
	rest, ok := strings.CutPrefix(id, "plugins:")
	if !ok {
		return core.Item{}, false
	}
	plug, tool, _ := strings.Cut(rest, "/")
	p.mu.RLock()
	defer p.mu.RUnlock()
	x := p.find(plug)
	if x == nil || x.disabled {
		return core.Item{}, false
	}
	if x.problem != "" {
		return problemItem(x), true
	}
	for _, t := range x.tools {
		if (tool == "" && t.ID == x.id) || t.ID == tool || (tool == "" && len(x.tools) == 1) {
			return p.item(x, t, "", nil), true
		}
	}
	return core.Item{}, false
}

// CatalogItems 实现 core.Lister。
func (p *Plugins) CatalogItems() []core.Item {
	p.mu.RLock()
	defer p.mu.RUnlock()
	var out []core.Item
	for _, x := range p.list {
		if x.disabled {
			continue
		}
		if x.problem != "" {
			out = append(out, problemItem(x))
			continue
		}
		for _, t := range x.tools {
			out = append(out, p.item(x, t, "", nil))
		}
	}
	return out
}

// KeywordsOf 返回一个工具实际生效的关键词。
func (p *Plugins) KeywordsOf(id string) []string {
	return effective(p.Custom, id, p.DefaultKeywordsOf(id))
}

// DefaultKeywordsOf 返回一个工具在清单里写的关键词（用户没改过时用的）。
func (p *Plugins) DefaultKeywordsOf(id string) []string {
	rest := strings.TrimPrefix(id, "plugins:")
	plug, tool, _ := strings.Cut(rest, "/")
	if t, ok := p.ToolOf(plug, tool); ok {
		return t.Keywords
	}
	return nil
}

// Floats 返回全部悬浮窗工具（启动时恢复上次开着的）。
func (p *Plugins) Floats() [][2]string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	var out [][2]string
	for _, x := range p.list {
		if x.disabled || x.problem != "" {
			continue
		}
		for _, t := range x.tools {
			if t.Window == "float" {
				out = append(out, [2]string{x.id, t.ID})
			}
		}
	}
	return out
}
