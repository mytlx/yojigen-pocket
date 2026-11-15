package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/store"
)

func ctxBackground() context.Context { return context.Background() }

// 后端发给页面的事件。
var (
	// PanelShown 在主窗口显示时发送。
	PanelShown = mygo.NewEvent[PanelShownEvent]("panel:shown")
	// ConfigChanged 在配置变化后发送给所有窗口。
	ConfigChanged = mygo.NewEvent[ConfigView]("config:changed")
	// ThemeChanged 在系统深浅色变化时发送。
	ThemeChanged = mygo.NewEvent[bool]("theme:changed")
	// ResultsChanged 告诉界面数据源有变化，当前查询要重新跑。
	ResultsChanged = mygo.NewEvent[struct{}]("results:changed")
	// UserAssetsChanged 在 ui 目录的文件变化后发送。
	UserAssetsChanged = mygo.NewEvent[UserAssets]("assets:changed")
	// SettingsNavigate 让已打开的设置窗口跳到某个分区。
	SettingsNavigate = mygo.NewEvent[SettingsTarget]("settings:navigate")
	// ExternalEvent 是直达热键等非界面入口产生的执行事件。
	ExternalEvent = mygo.NewEvent[core.ExecEvent]("exec:external")
	// WindowsChanged 在独立窗口打开、关闭、显示、隐藏后发送。
	WindowsChanged = mygo.NewEvent[[]WindowInfo]("windows:changed")
	// FeatureInput 让已打开的独立窗口换上新的输入。
	FeatureInput = mygo.NewEvent[FeatureInputEvent]("feature:input")
	// ReaderCommand 是发给阅读器的命令：prev、next、autopage。
	ReaderCommand = mygo.NewEvent[string]("reader:command")
	// PayloadArrived 在主窗口已经显示之后补上带入的内容（选中的文字读得慢时）。
	PayloadArrived = mygo.NewEvent[PayloadInfo]("panel:payload")
	// ClipboardChanged 在剪贴板历史有变化时发送（剪贴板页据此刷新）。
	ClipboardChanged = mygo.NewEvent[struct{}]("clipboard:changed")
	// HotkeyCaptured 在系统保留按键（如 Windows 的 Alt+Space）被窗口快捷键录制拦截时发送。
	HotkeyCaptured = mygo.NewEvent[string]("hotkey:captured")
)

// PanelShownEvent 描述这次唤出。
type PanelShownEvent struct {
	View    *core.View   `json:"view,omitempty"`    // 直接进入的页面
	Payload *PayloadInfo `json:"payload,omitempty"` // 带入的内容：选中的文字、刚复制的文字、图片或文件
	Query   string       `json:"query,omitempty"`   // 外部指定的输入
	Keep    bool         `json:"keep,omitempty"`    // 保留上次的输入
	Resume  bool         `json:"resume,omitempty"`  // 原样显示回来，页面什么都不用改
}

// SettingsTarget 是设置窗口要跳转的位置。
type SettingsTarget struct {
	Section string `json:"section"`
	Arg     string `json:"arg,omitempty"`
}

// UserAssets 是用户的主题和界面钩子文件内容。
type UserAssets struct {
	ThemeCSS string `json:"themeCss"`
	UserCSS  string `json:"userCss"`
	UserJS   string `json:"userJs"`
}

// AppInfo 是页面启动时需要的信息。
type AppInfo struct {
	E2E            bool        `json:"e2e,omitempty"` // 测试构建：允许端到端测试查看扩展页面内部
	Platform       string      `json:"platform"`      // darwin | windows | linux
	Version        string      `json:"version"`
	GlassSupported bool        `json:"glassSupported"`
	Dark           bool        `json:"dark"`
	Paths          store.Paths `json:"paths"`
}

// ConfigView 是配置和它的错误状态。
type ConfigView struct {
	Config       store.Config      `json:"config"`
	LoadError    string            `json:"loadError,omitempty"`
	HotkeyErrors map[string]string `json:"hotkeyErrors,omitempty"`
	OpenAtLogin  bool              `json:"openAtLogin"`
	SystemAccent string            `json:"systemAccent,omitempty"`
}

func (a *App) configView() ConfigView {
	a.hotkeyMu.Lock()
	errs := a.hotkeyErrors
	a.hotkeyMu.Unlock()
	v := ConfigView{
		Config:       *a.config.Get(),
		LoadError:    a.config.LoadError(),
		HotkeyErrors: errs,
		OpenAtLogin:  mygo.App.OpenAtLogin(),
	}
	if c := mygo.Theme.Preferences().Accent; c.A != 0 {
		v.SystemAccent = fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B)
	}
	return v
}

func (a *App) userAssets() UserAssets {
	read := func(name string) string {
		raw, err := os.ReadFile(filepath.Join(a.paths.UI, name))
		if err != nil {
			return ""
		}
		return string(raw)
	}
	return UserAssets{ThemeCSS: read("theme.css"), UserCSS: read("user.css"), UserJS: read("user.js")}
}

// Launcher 是主窗口页面调用的服务。
type Launcher struct{ a *App }

// Info 返回页面启动时需要的信息。
func (l *Launcher) Info() AppInfo {
	return AppInfo{
		Platform:       runtime.GOOS,
		Version:        l.a.version,
		GlassSupported: platform.GlassSupported(),
		Dark:           mygo.Theme.IsDark(),
		Paths:          l.a.paths,
		E2E:            allowSecondInstance, // 只有测试构建里为真
	}
}

// Config 返回当前配置。
func (l *Launcher) Config() ConfigView { return l.a.configView() }

// Assets 返回用户的主题和钩子文件。
func (l *Launcher) Assets() UserAssets { return l.a.userAssets() }

// Query 执行一次查询，结果分批推送。新查询会取消上一次。
func (l *Launcher) Query(ctx context.Context, req core.QueryRequest, out *mygo.Channel[core.Batch]) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	l.a.queryMu.Lock()
	if l.a.queryCancel != nil {
		l.a.queryCancel()
	}
	l.a.queryCancel = cancel
	l.a.queryMu.Unlock()

	req.Payload = l.a.payloads.get(req.PayloadID)
	err := l.a.engine.Query(ctx, req, func(b core.Batch) error {
		if ctx.Err() != nil {
			return nil
		}
		return out.Send(b)
	})
	if errors.Is(err, mygo.ErrChannelClosed) {
		return nil
	}
	return err
}

// Execute 执行一个动作，过程中的事件通过 out 推送。
func (l *Launcher) Execute(ctx context.Context, req core.ExecRequest, out *mygo.Channel[core.ExecEvent]) error {
	err := l.a.engine.Execute(ctx, req, func(ev core.ExecEvent) { _ = out.Send(ev) })
	if err != nil && ctx.Err() == nil && !l.a.panel.IsVisible() {
		// 窗口已经隐藏，界面上的提示看不到，改用系统通知。
		l.a.host.Notify("执行失败", err.Error())
	}
	return err
}

// Hide 隐藏主窗口。
func (l *Launcher) Hide() { l.a.hidePanel() }

// SetInTool 记录主窗口当前是否停留在工具页面或命令作用域中（隐藏后不自动重置）。
func (l *Launcher) SetInTool(active bool) { l.a.panelInTool.Store(active) }

// ClipboardPayload 把剪贴板里的内容（文件、图片或文字）做成一块带进搜索框。剪贴板是空的时返回 null。
func (l *Launcher) ClipboardPayload() *PayloadInfo {
	return l.a.payloadInfo(l.a.clipboardPayload("paste"))
}

// PayloadText 返回文字块的完整文字（按退格把块变回可以编辑的文字时用）。
func (l *Launcher) PayloadText(id string) string {
	if p := l.a.payloads.get(id); p != nil && p.Kind == core.PayloadText {
		return p.Text
	}
	return ""
}

// Resize 让主窗口跟随页面内容的大小。
func (l *Launcher) Resize(width, height int) { l.a.resizePanel(width, height) }

// CopyText 复制文本（文本视图里按回车复制全文）。
func (l *Launcher) CopyText(text string) { mygo.Clipboard.WriteText(text) }

// OpenExternal 用默认浏览器打开链接（Markdown 视图里的链接）。
func (l *Launcher) OpenExternal(target string) error {
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		return errors.New("只能打开 http / https 链接")
	}
	l.a.hidePanel()
	return openExternal(target)
}

// OpenSettings 打开设置窗口。
func (l *Launcher) OpenSettings(section string) {
	l.a.hidePanel()
	l.a.openSettings(section, "")
}

// FilePreview 读取文件预览。
func (l *Launcher) FilePreview(path string) *providers.FileDetail { return l.a.fileDetail(path) }

// PauseBlur 在打开系统对话框时暂停失焦隐藏。
func (l *Launcher) PauseBlur(paused bool) { l.a.blurPaused.Store(paused) }

// PickFile 打开文件选择框（表单的 file 字段用）。
func (l *Launcher) PickFile(ctx context.Context) (string, error) {
	l.a.blurPaused.Store(true)
	defer l.a.blurPaused.Store(false)
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx)})
	if err != nil || len(files) == 0 {
		return "", err
	}
	return files[0], nil
}

// PluginCall 转发插件的请求。主页面只把来自当前插件 iframe 的消息转过来，
// PluginCall 是扩展页面里 window.pocket 的调用入口：tool 是页面属于哪个工具，按清单里声明的权限放行。
func (l *Launcher) PluginCall(ctx context.Context, plugin, tool, method string, args []any) (any, error) {
	return l.a.pluginHost.call(ctx, plugin, tool, method, args)
}

// Settings 是设置窗口调用的服务。
type Settings struct{ a *App }

// Info 返回页面启动时需要的信息。
func (s *Settings) Info() AppInfo { return (&Launcher{a: s.a}).Info() }

// Get 返回当前配置。
func (s *Settings) Get() ConfigView { return s.a.configView() }

// Save 保存配置并立即生效。
func (s *Settings) Save(cfg store.Config) (ConfigView, error) {
	c := cfg
	if err := s.a.config.Save(&c); err != nil {
		return ConfigView{}, err
	}
	s.a.configApplied()
	return s.a.configView(), nil
}

// Reset 恢复默认配置。
func (s *Settings) Reset() (ConfigView, error) {
	return s.Save(*store.DefaultConfig())
}

// SetOpenAtLogin 设置开机启动。
func (s *Settings) SetOpenAtLogin(open bool) error { return mygo.App.SetOpenAtLogin(open) }

// ModuleInfo 描述一个功能模块。
type ModuleInfo struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Icon        string `json:"icon"`
	Description string `json:"description"`
}

var moduleDescriptions = map[string]string{
	"apps":      "搜索并打开已安装的应用，支持拼音和首字母",
	"scripts":   "commands 目录里的脚本，任何语言都可以",
	"plugins":   "plugins 目录里的网页插件",
	"system":    "锁屏、睡眠、关机、清空回收站、系统设置页",
	"self":      "打开设置、重新加载、退出等",
	"calc":      "四则运算、函数、进制和单位换算",
	"tools":     "Base64、URL、JSON、哈希、UUID、时间戳……",
	"snippets":  "常用文字模板，回车粘贴到当前窗口",
	"clipboard": "记录复制过的文字、图片和文件",
	"files":     fileModuleDescription(),
	"paths":     "以 / 或 ~ 或盘符开头时逐级浏览文件夹",
	"shell":     "运行一行命令，输出显示在窗口里",
	"web":       "关键词搜索和网址别名，也是无结果时的兜底",
	"features":  "翻译、截图识别、摸鱼阅读和各种开发工具",
	"windows":   "在搜索里切换到已分离的独立窗口",
}

func fileModuleDescription() string {
	if runtime.GOOS == "windows" {
		return "用 Everything 搜索全盘文件；未安装时搜索指定目录"
	}
	return "用 Spotlight 搜索文件名"
}

// Modules 返回全部功能模块。
func (s *Settings) Modules() []ModuleInfo {
	var out []ModuleInfo
	for _, p := range s.a.engine.Providers() {
		info := p.Info()
		out = append(out, ModuleInfo{ID: info.ID, Title: info.Title, Icon: info.Icon, Description: moduleDescriptions[info.ID]})
	}
	return out
}

// Commands 返回全部脚本命令。
func (s *Settings) Commands() []providers.CommandInfo {
	list := s.a.commands.Commands()
	for i := range list {
		list[i].Icon = s.a.engine.NormalizeIcon(list[i].Icon)
	}
	return list
}

// Plugins 返回全部网页插件。
func (s *Settings) Plugins() []providers.PluginInfo {
	list := s.a.plugins.List()
	for i := range list {
		list[i].Icon = s.a.engine.NormalizeIcon(list[i].Icon)
	}
	return list
}

// CreateCommand 从模板新建脚本并用编辑器打开。
func (s *Settings) CreateCommand(language, name string) (string, error) {
	path, err := s.a.commands.CreateCommand(language, name)
	if err != nil {
		return "", err
	}
	return path, s.a.host.EditFile(path)
}

// CommandTarget 是可绑定快捷键的命令。
type CommandTarget struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle,omitempty"`
	Icon     string `json:"icon,omitempty"`
	Source   string `json:"source"`
}

// SearchCommands 搜索可以绑定快捷键的命令。
func (s *Settings) SearchCommands(ctx context.Context, text string) ([]CommandTarget, error) {
	var last core.Batch
	err := s.a.engine.Query(ctx, core.QueryRequest{Text: text}, func(b core.Batch) error {
		last = b
		return nil
	})
	if err != nil {
		return nil, err
	}
	out := []CommandTarget{}
	for _, it := range last.Items {
		if !slices.Contains([]string{"apps", "scripts", "plugins", "system", "self", "snippets"}, it.Source) || it.Error {
			continue
		}
		out = append(out, CommandTarget{ID: it.ID, Title: it.Title, Subtitle: it.Subtitle, Icon: it.Icon, Source: it.Source})
	}
	return out, nil
}

// ResolveCommands 按 ID 查询命令的显示信息（设置页列出已绑定的快捷键、隐藏的项目用）。
func (s *Settings) ResolveCommands(ids []string) []CommandTarget {
	out := make([]CommandTarget, 0, len(ids))
	for _, id := range ids {
		if it, ok := s.a.engine.Resolve(id); ok {
			out = append(out, CommandTarget{ID: id, Title: it.Title, Subtitle: it.Subtitle, Icon: it.Icon, Source: it.Source})
		} else {
			out = append(out, CommandTarget{ID: id, Title: id, Subtitle: "已找不到这个命令"})
		}
	}
	return out
}

// Snippets 返回全部文本片段。
func (s *Settings) Snippets() []providers.Snippet { return s.a.snippets.List() }

// SaveSnippet 新建或更新文本片段。
func (s *Settings) SaveSnippet(oldName, name, body string) error {
	return s.a.snippets.Save(oldName, name, body)
}

// DeleteSnippet 删除文本片段。
func (s *Settings) DeleteSnippet(name string) error { return s.a.snippets.Delete(name) }

// OpenFolder 打开用户目录下的某个位置。
func (s *Settings) OpenFolder(which string) error {
	p := s.a.paths
	target := map[string]string{
		"home": p.Home, "commands": p.Commands, "plugins": p.Plugins, "snippets": p.Snippets,
		"ui": p.UI, "logs": p.Logs,
	}[which]
	if target == "" {
		return fmt.Errorf("未知的目录：%s", which)
	}
	return openPath(target)
}

// EditFile 用编辑器打开文件。只能打开用户目录里的文件。
func (s *Settings) EditFile(path string) error {
	rel, err := filepath.Rel(s.a.paths.Home, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return errors.New("只能打开配置目录里的文件")
	}
	return s.a.host.EditFile(path)
}

// EditUserFile 打开 ui 目录下的 theme.css / user.css / user.js，不存在时先创建。
func (s *Settings) EditUserFile(name string) error {
	if !slices.Contains([]string{"theme.css", "user.css", "user.js"}, name) {
		return fmt.Errorf("未知的文件：%s", name)
	}
	p := filepath.Join(s.a.paths.UI, name)
	if _, err := os.Stat(p); os.IsNotExist(err) {
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			return err
		}
	}
	return s.a.host.EditFile(p)
}

// Reveal 在文件管理器中显示。
func (s *Settings) Reveal(path string) { s.a.host.Reveal(path) }

// ClearUsage 清空使用记录。
func (s *Settings) ClearUsage() { s.a.usage.Clear() }

// ClearClipboard 清空剪贴板历史。
func (s *Settings) ClearClipboard() { s.a.clipboard.Clear() }

// DoctorItem 是一项环境检查结果。
type DoctorItem struct {
	Title  string `json:"title"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	Action string `json:"action,omitempty"` // 可执行的修复动作
}

// Doctor 检查运行环境：解释器、辅助功能权限、文件搜索、热键。
func (s *Settings) Doctor() []DoctorItem {
	var out []DoctorItem
	check := func(title string, names ...string) {
		for _, n := range names {
			if p, err := exec.LookPath(n); err == nil {
				out = append(out, DoctorItem{Title: title, OK: true, Detail: p})
				return
			}
		}
		out = append(out, DoctorItem{Title: title, Detail: "未找到，对应语言的脚本无法运行"})
	}
	if runtime.GOOS == "darwin" {
		trusted := platform.AccessibilityTrusted()
		item := DoctorItem{Title: "辅助功能权限", OK: trusted, Detail: "已授权，可以自动粘贴"}
		if !trusted {
			item.Detail = "未授权：回车只会复制，不会自动粘贴到当前窗口"
			item.Action = "accessibility"
		}
		out = append(out, item)
	}
	if runtime.GOOS == "darwin" {
		ok := platform.ScreenCaptureAllowed()
		item := DoctorItem{Title: "屏幕录制权限", OK: ok, Detail: "已授权，可以截图识别文字"}
		if !ok {
			item.Detail = "未授权：截图识别只能截到桌面背景"
			item.Action = "screen"
		}
		out = append(out, item)
	}
	if runtime.GOOS == "windows" {
		if p, ok := providers.EverythingStatus(s.a.config.Get()); ok {
			out = append(out, DoctorItem{Title: "Everything", OK: true, Detail: p})
		} else {
			out = append(out, DoctorItem{Title: "Everything", Detail: "未找到 es.exe，文件搜索只查指定目录。安装 Everything 和 ES 命令行工具后可搜全盘"})
		}
		check("PowerShell", "pwsh.exe", "powershell.exe")
		check("Python", "python.exe", "python3.exe", "py.exe")
		check("Git Bash", "bash.exe")
	} else {
		check("Bash", "bash")
		check("Python", "python3")
	}
	check("Node.js", "node")
	s.a.hotkeyMu.Lock()
	errs := s.a.hotkeyErrors
	s.a.hotkeyMu.Unlock()
	if msg := errs["main"]; msg != "" {
		out = append(out, DoctorItem{Title: "主热键", Detail: msg})
	} else {
		out = append(out, DoctorItem{Title: "主热键", OK: true, Detail: s.a.config.Get().Hotkey})
	}
	out = append(out, DoctorItem{Title: "应用列表", OK: s.a.apps.Count() > 0, Detail: fmt.Sprintf("找到 %d 个应用", s.a.apps.Count())})
	return out
}

// ResetPanelPosition 让主窗口回到屏幕中间，忘掉拖动过的位置。
func (s *Settings) ResetPanelPosition() { s.a.resetPanelPosition() }

// Permissions 报告系统权限的状态。
func (s *Settings) Permissions() map[string]bool {
	return map[string]bool{"accessibility": platform.AccessibilityTrusted(), "screen": platform.ScreenCaptureAllowed()}
}

// Relaunch 重启应用（授予系统权限后需要重启才生效）。
func (s *Settings) Relaunch() { mygo.App.Relaunch() }

// OpenScreenCapture 请求屏幕录制权限并打开设置页。
func (s *Settings) OpenScreenCapture() { platform.RequestScreenCapture() }

// OpenAccessibility 打开系统的辅助功能设置页。
func (s *Settings) OpenAccessibility() { platform.OpenAccessibilitySettings() }

// OpenCatalog 打开道具库窗口。
func (s *Settings) OpenCatalog() { s.a.openCatalog() }

// PreviewPanel 显示或收起主窗口，方便在调整外观时看效果。预览期间点回设置窗口不会把它隐藏。
func (s *Settings) PreviewPanel(show bool) {
	if !show {
		s.a.hidePanel()
		return
	}
	s.a.blurPaused.Store(true)
	s.a.showPanel("")
}

// SuspendHotkeys 在设置里录快捷键时暂停全部全局热键：否则按下已经在用的组合（比如 Alt+Space）会直接触发它，录不进去。
func (s *Settings) SuspendHotkeys(suspend bool) { s.a.suspendHotkeys(suspend) }
