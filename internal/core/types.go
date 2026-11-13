// Package core 定义引擎的核心概念：Item、Action、View、Provider，以及查询和执行的流程。
// 内置功能和用户脚本用的是同一套结构。
package core

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"yojigen-pocket/internal/match"
)

// ActionType 是动作类型。
type ActionType string

// 动作类型。
const (
	ActionOpen   ActionType = "open"   // 用默认程序打开文件、文件夹或网址
	ActionReveal ActionType = "reveal" // 在文件管理器中定位
	ActionCopy   ActionType = "copy"   // 复制到剪贴板
	ActionPaste  ActionType = "paste"  // 复制并粘贴回唤出前的窗口
	ActionTyping ActionType = "type"   // 模拟键入
	ActionRun    ActionType = "run"    // 执行另一个命令
	ActionShell  ActionType = "shell"  // 执行一行命令
	ActionView   ActionType = "view"   // 推入一个视图
	ActionNotify ActionType = "notify" // 弹通知
	ActionScope  ActionType = "scope"  // 进入作用域
	ActionFunc   ActionType = "func"   // 内置逻辑
)

// Action 是对结果项能做的一件事。
type Action struct {
	Type     ActionType `json:"type"`
	Title    string     `json:"title,omitempty"`
	Target   string     `json:"target,omitempty"`   // open / reveal
	Text     string     `json:"text,omitempty"`     // copy / paste / type / notify 的正文
	Files    []string   `json:"files,omitempty"`    // copy 文件
	Image    string     `json:"image,omitempty"`    // copy 图片：文件路径
	Command  string     `json:"command,omitempty"`  // run：命令 ID；shell：命令行
	Cwd      string     `json:"cwd,omitempty"`      // shell
	Confirm  string     `json:"confirm,omitempty"`  // 执行前二次确认的提示语
	KeepOpen bool       `json:"keepOpen,omitempty"` // 执行后不隐藏窗口
	Shortcut string     `json:"shortcut,omitempty"` // 动作面板里显示的快捷键提示
	View     *View      `json:"view,omitempty"`     // view
	Scope    *Scope     `json:"scope,omitempty"`    // scope

	// Fn 是内置动作的实现，只存在于后端。
	Fn func(ctx context.Context, r *Run) error `json:"-"`
}

// Preview 是选中项右侧的预览内容。
type Preview struct {
	Type string `json:"type"` // text | code | image
	Text string `json:"text,omitempty"`
	URL  string `json:"url,omitempty"`
	Info string `json:"info,omitempty"`
}

// Scope 是作用域：进入后输入只发给对应的数据源。
type Scope struct {
	ID          string `json:"id"` // <providerID> 或 <providerID>:<子标识>
	Title       string `json:"title"`
	Icon        string `json:"icon,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
}

// Item 是列表中的一行。除 Title 外都可选。
type Item struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Subtitle    string   `json:"subtitle,omitempty"`
	Icon        string   `json:"icon,omitempty"`
	Source      string   `json:"source"`
	SourceLabel string   `json:"sourceLabel,omitempty"`
	Actions     []Action `json:"actions"`
	Highlights  []int    `json:"highlights,omitempty"`
	Preview     *Preview `json:"preview,omitempty"`
	Pinned      bool     `json:"pinned,omitempty"`
	Hotkey      string   `json:"hotkey,omitempty"`
	Scope       *Scope   `json:"scope,omitempty"`    // Tab 进入的作用域
	Complete    string   `json:"complete,omitempty"` // Tab 补全成的输入
	Error       bool     `json:"error,omitempty"`    // 错误态
	Path        string   `json:"path,omitempty"`     // 源文件，Ctrl+E 打开

	Score  float64 `json:"-"`                  // 匹配分 0-1，由数据源给出
	Exact  bool    `json:"-"`                  // 关键词完全命中：排在最前
	Dedup  string  `json:"-"`                  // 去重键，例如文件路径
	Ephem  bool    `json:"-"`                  // 临时结果：不记录使用，不能置顶
	Bottom bool    `json:"fallback,omitempty"` // 兜底结果：总在最后
}

// View 是结果的展示方式。
type View struct {
	Type    string `json:"type"` // text | markdown | panel | form | feature
	Title   string `json:"title,omitempty"`
	Icon    string `json:"icon,omitempty"`
	Content string `json:"content,omitempty"`
	HTML    string `json:"html,omitempty"` // panel：内联 HTML
	URL     string `json:"url,omitempty"`  // panel：页面地址
	Height  int    `json:"height,omitempty"`
	Stream  bool   `json:"stream,omitempty"`  // 后续还有内容
	Plugin  string `json:"plugin,omitempty"`  // panel：插件 ID，用于受限的 window.pocket 调用
	Feature string `json:"feature,omitempty"` // feature：内置功能页的 ID
	Input   string `json:"input,omitempty"`   // feature：带进功能页的内容
	// Args 是功能页的额外参数，例如哈希页先选中哪种算法、截图识别的图片路径。
	Args   map[string]string `json:"args,omitempty"`
	Fields []Field           `json:"fields,omitempty"` // form
	Item   string            `json:"item,omitempty"`   // form：提交时执行的项
}

// Field 是表单的一个字段。
type Field struct {
	Name        string   `json:"name"`
	Label       string   `json:"label,omitempty"`
	Type        string   `json:"type"` // text | dropdown | file | password
	Placeholder string   `json:"placeholder,omitempty"`
	Options     []string `json:"options,omitempty"`
	Optional    bool     `json:"optional,omitempty"`
	Default     string   `json:"default,omitempty"`
}

// 带入内容的种类。
const (
	PayloadText  = "text"
	PayloadImage = "image"
	PayloadFiles = "files"
)

// Payload 是带进搜索框的一块内容：选中的文字、刚复制或粘贴的文字、图片、文件。
// 它和输入的文字分开：块后面输入的是「用哪个功能处理它」。
type Payload struct {
	ID     string
	Kind   string
	Text   string
	Image  string // 图片文件的路径
	Files  []string
	Source string // selection | clipboard | paste
}

// QueryText 返回用来做普通搜索的文字：第一行，截到 200 个字。
func (p *Payload) QueryText() string {
	if p == nil || p.Kind != PayloadText {
		return ""
	}
	line, _, _ := strings.Cut(strings.TrimSpace(p.Text), "\n")
	r := []rune(strings.TrimSpace(line))
	if len(r) > 200 {
		r = r[:200]
	}
	return string(r)
}

// Short 判断文字是否短到值得当作普通搜索词去匹配应用、文件等。
func (p *Payload) Short() bool {
	if p == nil || p.Kind != PayloadText {
		return false
	}
	t := strings.TrimSpace(p.Text)
	return t != "" && !strings.Contains(t, "\n") && len([]rune(t)) <= 80
}

// ImagePath 返回可以当图片处理的文件：图片块本身，或只带了一个图片文件。
func (p *Payload) ImagePath() string {
	if p == nil {
		return ""
	}
	if p.Kind == PayloadImage {
		return p.Image
	}
	if p.Kind == PayloadFiles && len(p.Files) == 1 {
		switch strings.ToLower(filepath.Ext(p.Files[0])) {
		case ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".heic":
			return p.Files[0]
		}
	}
	return ""
}

// PayloadProvider 是能处理带入内容的数据源。req.Text 是块后面输入的文字，可能为空。
type PayloadProvider interface {
	SearchPayload(ctx context.Context, req *Request, p *Payload) []Item
}

// Context 是唤出时抓取的环境信息。
type Context struct {
	Selection string `json:"selection,omitempty"`
	Clipboard string `json:"clipboard,omitempty"`
	FgProcess string `json:"fgProcess,omitempty"`
	FgTitle   string `json:"fgTitle,omitempty"`
}

// Request 是发给数据源的查询。
type Request struct {
	Text    string // 去掉前缀后的完整输入
	Query   match.Query
	First   string // 第一个词
	Rest    string // 第一个词之后的内容
	Scope   string // 作用域 ID（如有）
	Scoped  bool   // 由前缀或作用域限定，只有这一个数据源参与
	Context Context
}

// Info 描述一个数据源。
type Info struct {
	ID    string
	Title string
	Icon  string
	Async bool          // 外部数据源：结果晚到，不阻塞首屏
	Delay time.Duration // 外部数据源的防抖
}

// Provider 是数据源：收到输入，返回一组结果。
type Provider interface {
	Info() Info
	Search(ctx context.Context, req *Request) []Item
}

// Lister 列出数据源的全部条目，供「道具库」汇总展示。
type Lister interface {
	CatalogItems() []Item
}

// Resolver 让数据源能按 ID 重新构造结果项，供置顶、首页和直达热键使用。
type Resolver interface {
	Resolve(id string) (Item, bool)
}

// Entrance 是作用域型数据源（剪贴板等）在全局搜索里的入口。
type Entrance interface {
	Entrance() Scope
}

// AsyncScoper 表示某个作用域下的查询要走外部数据源的流程（例如过滤模式的脚本）。
type AsyncScoper interface {
	ScopeDelay(scope string) (time.Duration, bool)
}

// Host 是引擎需要的系统能力，由应用层实现，测试时可替换。
type Host interface {
	OpenTarget(target string) error
	Reveal(path string)
	CopyText(text string)
	CopyImageFile(path string) error
	CopyFiles(paths []string) error
	ReadClipboardText() string
	PasteToFront() error
	TypeToFront(text string) error
	Notify(title, body string)
	HidePanel()
	EditFile(path string) error
	OpenSettings(section, arg string)
}

// Run 是一次动作执行的上下文。内置动作通过它向界面回传结果。
type Run struct {
	Item   Item
	Action Action
	Query  string            // 执行时的输入
	Args   map[string]string // 表单参数
	Host   Host
	Engine *Engine

	emit     func(ExecEvent)
	keepOpen bool
	handled  bool
}

// ExecEvent 是执行过程中发给界面的事件。
type ExecEvent struct {
	Kind    string `json:"kind"` // hide | view | append | toast | error | scope | input | confirm | refresh | done
	View    *View  `json:"view,omitempty"`
	Text    string `json:"text,omitempty"`
	Scope   *Scope `json:"scope,omitempty"`
	Replace bool   `json:"replace,omitempty"`
}

// Hide 隐藏主窗口。
func (r *Run) Hide() { r.Host.HidePanel(); r.emit(ExecEvent{Kind: "hide"}) }

// Stay 声明执行后不要隐藏窗口。
func (r *Run) Stay() { r.keepOpen = true }

// Show 推入一个视图。
func (r *Run) Show(v *View) {
	r.keepOpen = true
	shown := *v
	shown.Icon = r.Engine.NormalizeIcon(v.Icon)
	r.emit(ExecEvent{Kind: "view", View: &shown})
}

// Append 向当前文本视图追加内容。
func (r *Run) Append(text string) { r.emit(ExecEvent{Kind: "append", Text: text}) }

// SetContent 替换当前文本视图的内容。
func (r *Run) SetContent(text string) { r.emit(ExecEvent{Kind: "append", Text: text, Replace: true}) }

// Toast 在窗口内显示一条提示，不隐藏窗口。
func (r *Run) Toast(text string) { r.keepOpen = true; r.emit(ExecEvent{Kind: "toast", Text: text}) }

// Fail 显示错误。
func (r *Run) Fail(text string) { r.keepOpen = true; r.emit(ExecEvent{Kind: "error", Text: text}) }

// EnterScope 进入作用域。
func (r *Run) EnterScope(s *Scope) {
	r.keepOpen = true
	scope := *s
	scope.Icon = r.Engine.NormalizeIcon(s.Icon)
	r.emit(ExecEvent{Kind: "scope", Scope: &scope})
}

// SetInput 修改输入框内容。
func (r *Run) SetInput(text string) { r.keepOpen = true; r.emit(ExecEvent{Kind: "input", Text: text}) }

// Refresh 让界面重新查询。
func (r *Run) Refresh() { r.keepOpen = true; r.emit(ExecEvent{Kind: "refresh"}) }

// Emit 发送任意事件（脚本等长任务用）。
func (r *Run) Emit(e ExecEvent) { r.emit(e) }
