package main

import (
	"context"
	_ "embed"
	"log"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/reader"
	"yojigen-pocket/internal/scripts"
	"yojigen-pocket/internal/seed"
	"yojigen-pocket/internal/store"
)

//go:embed assets/tray.png
var trayIconTemplate []byte

//go:embed assets/tray-color.png
var trayIconColor []byte

// App 把引擎、窗口和系统能力粘在一起。
type App struct {
	paths   store.Paths
	config  *store.ConfigStore
	usage   *store.Usage
	engine  *core.Engine
	host    *host
	version string

	apps      *providers.Apps
	clipboard *providers.Clipboard
	snippets  *providers.Snippets
	commands  *providers.Scripts
	plugins   *providers.Plugins
	files     *providers.Files

	panel    *mygo.Window
	settings *mygo.Window
	catalog  *mygo.Window
	tray     *mygo.Tray

	features *providers.Features
	system   *providers.System
	self     *providers.Self
	web      *providers.Web
	library  *reader.Library

	detachedMu  sync.Mutex
	detached    map[int]*detachedWindow
	pendingView atomic.Pointer[core.View]

	payloads          payloadStore
	auto              *autoEngine
	media             *mediaServer
	calcHistory       *calcHistory
	wintools          *providers.WinTools
	selectionSlowHook func() string // 测试用：代替模拟复制
	selectionHook     func() string
	pendingPayload    atomic.Pointer[core.Payload]
	summoning         atomic.Bool

	stateMu    sync.Mutex
	state      appState
	stateTimer *time.Timer
	expectedX  atomic.Int64 // 程序自己摆放主窗口的位置：和它不同的移动才是用户拖的
	expectedY  atomic.Int64

	blurGrace  atomic.Int64 // 这个时间点之前失去焦点不隐藏（截图结束后系统会把焦点还给之前的应用）
	dragMu     sync.Mutex
	dragOrigin map[int]mygo.Point

	queryMu     sync.Mutex
	queryCancel context.CancelFunc

	hotkeyMu     sync.Mutex
	hotkeyErrors map[string]string // 注册失败的热键：命令 ID（主热键为 "main"）→ 错误
	registered   []string
	// hotkeysSuspended 为真时不注册任何全局热键：设置里正在录快捷键，按下的组合要交给页面，而不是触发它。
	hotkeysSuspended bool
	hotkeyCapture    atomic.Bool

	urlMu      sync.Mutex
	pendingURL string
	isReady    bool

	blurPaused  atomic.Bool
	quitting    atomic.Bool
	lastHidden  atomic.Int64
	panelInTool atomic.Bool
	cancel      context.CancelFunc
}

// ready 在应用就绪后初始化一切。
func (a *App) ready() {
	platform.FixPath()
	a.version = mygo.App.Version()
	a.paths = store.ResolvePaths(mygo.IsDev())
	if err := a.paths.Ensure(); err != nil {
		log.Printf("创建用户目录失败：%v", err)
	}
	if _, err := os.Stat(a.paths.Config); os.IsNotExist(err) {
		if err := seed.Install(a.paths.Home); err != nil {
			log.Printf("写入示例文件失败：%v", err)
		}
	}
	a.config = store.NewConfigStore(a.paths.Config)
	a.detached = map[int]*detachedWindow{}
	a.dragOrigin = map[int]mygo.Point{}
	a.loadState()
	a.library = reader.Open(filepath.Join(a.paths.Data, "reader"))
	a.usage = store.NewUsage(a.paths.Data + "/usage.json")
	a.host = &host{a: a}

	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel

	a.registerProtocols()
	a.buildEngine(ctx)

	cfg := a.config.Get()
	a.applyTheme(cfg)
	a.createPanel(cfg)
	a.startMedia()
	a.createTray()
	a.applyHotkeys(cfg)
	a.watchHome(ctx)
	mygo.Theme.OnUpdated(func() { ThemeChanged.Broadcast(mygo.Theme.IsDark()) })

	// 手动打开时直接显示主窗口，让人知道它已经在运行了；开机启动时安静地待在后台。
	if !mygo.App.WasOpenedAtLogin() && os.Getenv("POCKET_HIDDEN") == "" {
		a.panel.OnReadyToShow(func() {
			a.showPanel("")
			a.flushPendingURL()
		})
	} else {
		a.panel.OnReadyToShow(a.flushPendingURL)
	}
}

func (a *App) flushPendingURL() {
	a.urlMu.Lock()
	pending := a.pendingURL
	a.pendingURL = ""
	a.isReady = true
	a.urlMu.Unlock()
	if pending != "" {
		a.handleURL(pending)
	}
}

func (a *App) buildEngine(ctx context.Context) {
	get := a.config.Get
	a.apps = &providers.Apps{
		List: func() ([]providers.AppEntry, error) {
			list, err := mygo.Shell.InstalledApps()
			if err != nil {
				return nil, err
			}
			out := make([]providers.AppEntry, len(list))
			chinese := platform.PrefersChinese()
			for i, x := range list {
				e := providers.AppEntry{ID: x.ID, Name: x.Name, Path: x.Path}
				// macOS 只按本进程的语言给一个名字。把中英文名都读出来：
				// 显示跟系统语言走，另一个留作别名，两种写法都搜得到。
				if zh, en := platform.AppNames(x.Path); zh != "" || en != "" {
					e.Alt = []string{zh, en, x.Name}
					if chinese && zh != "" {
						e.Name = zh
					}
				}
				out[i] = e
			}
			return out, nil
		},
		Launch: func(e providers.AppEntry) error {
			return launchApp(e.Path)
		},
	}
	go func() {
		if err := a.apps.Refresh(); err != nil {
			log.Printf("读取应用列表失败：%v", err)
		}
	}()

	a.clipboard = &providers.Clipboard{Config: get, Source: clipSource{}, Dir: a.paths.Data,
		Enabled: func() bool { return a.config.Get().Modules["clipboard"].Enabled },
		Changed: func() { ClipboardChanged.Broadcast(struct{}{}) }}
	a.clipboard.Load()
	a.clipboard.Start(ctx)

	a.snippets = &providers.Snippets{Dir: a.paths.Snippets}
	a.snippets.Reload()

	a.commands = &providers.Scripts{
		Dir: a.paths.Commands,
		Runner: &scripts.Runner{
			DataDir:      a.paths.Data,
			CacheDir:     a.paths.Cache,
			Interpreters: func() map[string]string { return a.config.Get().Interpreters },
		},
		Host: func() core.Host { return a.host },
	}
	a.commands.Reload()

	a.plugins = &providers.Plugins{Dir: a.paths.Plugins, URL: pluginURL}
	a.plugins.Reload()

	a.files = &providers.Files{Config: get}
	a.auto = newAutoEngine(filepath.Join(a.paths.Data, "auto.json"))
	a.auto.onStatus = func(st AutoStatus) { AutoChanged.Broadcast(st) }
	a.auto.onHotkeys = func() { a.applyHotkeys(a.config.Get()) }
	a.calcHistory = &calcHistory{file: filepath.Join(a.paths.Data, "calc-history.json")}
	a.calcHistory.load()
	a.wintools = providers.NewWinTools()
	a.system = providers.NewSystem()
	a.self = providers.NewSelf(a.selfCommands())
	a.web = &providers.Web{Config: get}
	a.features = providers.NewFeatures(a.featureCommands(), func(v *core.View) error {
		_, err := a.detach(detachRequestFor(v))
		return err
	})
	a.features.PayloadCommands = a.payloadCommands()
	windows := &providers.Windows{
		List: func() []providers.WindowEntry {
			var out []providers.WindowEntry
			for _, w := range a.windowList() {
				out = append(out, providers.WindowEntry{ID: w.ID, Title: w.Title, Icon: w.Icon})
			}
			return out
		},
		Focus: a.focusWindow,
	}

	a.engine = core.NewEngine(a.host, a.config, a.usage,
		a.apps,
		a.features,
		windows,
		a.commands,
		a.plugins,
		a.system,
		a.self,
		providers.Calc{Record: a.calcHistory.add},
		providers.NewTools(),
		a.snippets,
		a.clipboard,
		a.files,
		providers.Paths{},
		providers.Shell{},
		a.wintools,
		a.web,
	)
	a.engine.IconURL = iconURL
}

func (a *App) selfCommands() []*providers.SelfCommand {
	return []*providers.SelfCommand{
		{ID: "settings", Title: "打开设置", Subtitle: "快捷键、外观、功能模块", Icon: "svg:settings",
			Keywords: []string{"settings", "preferences", "config", "偏好设置"},
			Run: func(_ context.Context, r *core.Run) error {
				r.Hide()
				a.openSettings("", "")
				return nil
			}},
		{ID: "catalog", Title: "道具库", Subtitle: "分类查看全部功能、插件和脚本", Icon: "svg:layout-grid",
			Keywords: []string{"djk", "catalog", "gadgets", "all", "全部功能"},
			Run: func(_ context.Context, r *core.Run) error {
				r.Hide()
				a.openCatalog()
				return nil
			}},
		{ID: "new-command", Title: "新建脚本命令", Subtitle: "选一种语言，用模板写一个自己的工具", Icon: "svg:plus",
			Keywords: []string{"new command", "new script", "create"},
			Run: func(_ context.Context, r *core.Run) error {
				r.Hide()
				a.openSettings("commands", "new")
				return nil
			}},
		{ID: "open-home", Title: "打开配置目录", Subtitle: "所有配置、脚本和插件都在这里", Icon: "svg:folder",
			Keywords: []string{"config folder", "home", "data"},
			Run: func(_ context.Context, r *core.Run) error {
				r.Hide()
				return openPath(a.paths.Home)
			}},
		{ID: "reload", Title: "重新加载", Subtitle: "重新读取配置、脚本和插件", Icon: "svg:refresh",
			Keywords: []string{"reload", "refresh"}, KeepOpen: true,
			Run: func(_ context.Context, r *core.Run) error {
				a.reloadAll()
				r.Toast("已重新加载")
				return nil
			}},
		{ID: "clear-usage", Title: "清空使用记录", Subtitle: "排序回到初始状态，首页只保留固定项", Icon: "svg:eraser",
			Keywords: []string{"clear usage", "reset"}, Confirm: "确定清空使用记录？固定的项目会保留。", KeepOpen: true,
			Run: func(_ context.Context, r *core.Run) error {
				a.usage.Clear()
				r.Toast("已清空使用记录")
				r.Refresh()
				return nil
			}},
		{ID: "quit", Title: "退出 Yojigen Pocket", Subtitle: "完全退出，不再响应快捷键", Icon: "svg:power",
			Keywords: []string{"quit", "exit"},
			Run: func(_ context.Context, r *core.Run) error {
				r.Hide()
				mygo.App.Quit()
				return nil
			}},
	}
}

func (a *App) reloadAll() {
	a.config.Reload()
	a.commands.Reload()
	a.plugins.Reload()
	a.snippets.Reload()
	go func() { _ = a.apps.Refresh() }()
	a.configApplied()
	ResultsChanged.Broadcast(struct{}{})
	UserAssetsChanged.Broadcast(a.userAssets())
}

func (a *App) flush() {
	if a.cancel != nil {
		a.cancel()
	}
	if a.usage != nil {
		_ = a.usage.Flush()
	}
	if a.clipboard != nil {
		_ = a.clipboard.Flush()
	}
}

// --- 窗口 ---

func material(cfg *store.Config) mygo.Vibrancy {
	if !platform.GlassSupported() {
		return mygo.VibrancyNone
	}
	switch cfg.Appearance.Material {
	case "clear":
		return mygo.VibrancyGlassClear
	case "hud":
		return mygo.VibrancyHUD
	case "none":
		return mygo.VibrancyNone
	}
	return mygo.VibrancyGlass
}

func (a *App) createPanel(cfg *store.Config) {
	width := cfg.Appearance.Width
	glass := platform.GlassSupported()
	opts := mygo.WindowOptions{
		Title:         "Yojigen Pocket",
		Panel:         true,
		Hidden:        true,
		Frameless:     true,
		Transparent:   glass,
		CornerRadius:  panelRadius,
		Width:         width,
		Height:        panelInitialHeight,
		DisableResize: true,
		URL:           "/",
	}
	if glass {
		// Windows 上只有创建时带材质的窗口才能切换材质，所以始终带上。
		opts.Vibrancy = mygo.VibrancyGlass
	} else {
		opts.BackgroundColor = "light-dark(#f4f5f7, #1d1f24)"
	}
	a.panel = mygo.NewWindow(opts)
	if glass && material(cfg) != mygo.VibrancyGlass {
		a.panel.SetVibrancy(material(cfg))
	}
	a.panel.OnClose(func(e *mygo.CloseEvent) { // Esc、Cmd-W、Alt-F4
		// App.Quit 会逐个关闭窗口，这里拒绝的话整个退出都会被取消，所以退出时要放行。
		if a.quitting.Load() {
			return
		}
		e.PreventDefault()
		a.hidePanel()
	})
	a.panel.OnBlur(func() {
		if wait := a.blurGrace.Load() - time.Now().UnixMilli(); wait > 0 {
			// 刚截完图：系统会把焦点还给之前的应用。不隐藏，稍后把焦点拿回来。
			time.AfterFunc(time.Duration(wait+80)*time.Millisecond, func() {
				if a.panel.IsVisible() && !a.panel.IsFocused() {
					a.panel.Focus()
				}
			})
			return
		}
		if a.config.Get().HideOnBlur && !a.blurPaused.Load() && os.Getenv("POCKET_KEEP_OPEN") == "" {
			a.hidePanel()
		}
	})
	a.panel.OnMove(a.panelMoved)
}

const (
	panelRadius        = 18
	panelInitialHeight = 200
)

// resizePanel 让窗口跟随页面内容的大小。没有用 WindowOptions.FitContent：
// macOS 上不可调整大小的窗口 isZoomed 恒为真，mygo 会把它当成最大化而不再跟随。
// 窗口的左上角保持不动，内容变化时输入框不会跳。
func (a *App) resizePanel(width, height int) {
	if a.panel == nil || width <= 0 || height <= 0 {
		return
	}
	x, y := a.panel.Position()
	d := mygo.Screen.DisplayNearestPoint(mygo.Point{X: x, Y: y})
	if limit := d.WorkArea.Height * 9 / 10; limit > 0 {
		height = min(height, limit)
	}
	if w, h := a.panel.ContentSize(); w != width || h != height {
		a.panel.SetContentSize(width, height)
	}
}

func (a *App) hidePanel() {
	if a.panel == nil || !a.panel.IsVisible() {
		return
	}
	a.panel.Hide()
	a.blurPaused.Store(false)
	a.lastHidden.Store(time.Now().UnixMilli())
}

// showPanel 显示主窗口。query 非空时填入输入框。
func (a *App) showPanel(query string) { a.showPanelWith(query, true) }

// showPanelWith 显示主窗口。activate 为假时只显示、不拿焦点（见 togglePanel）。
func (a *App) showPanelWith(query string, activate bool) {
	if a.panel == nil {
		return
	}
	cfg := a.config.Get()
	platform.CaptureFront()

	payload := a.pendingPayload.Swap(nil)
	view := a.pendingView.Swap(nil)
	inTool := a.panelInTool.Load()
	if payload == nil && query == "" && view == nil && !inTool && cfg.AutoFillSeconds > 0 && cfg.Modules["clipboard"].Enabled {
		// 刚复制的内容（文字、图片、文件）自动带进来，每次复制只带一次。
		if e := a.clipboard.Recent(time.Duration(cfg.AutoFillSeconds) * time.Second); e != nil {
			payload = a.entryPayload(e)
		}
	}

	// 上下文抓取不能挡住显示。
	go func() {
		c := core.Context{Clipboard: mygo.Clipboard.ReadText()}
		if payload != nil && payload.Source == "selection" {
			c.Selection = payload.Text
		}
		app := platform.FrontApp()
		c.FgProcess, c.FgTitle = app.Name, app.Title
		a.engine.SetContext(c)
	}()
	a.apps.RefreshIfStale(5 * time.Minute)

	a.placePanel(cfg)

	shown := PanelShownEvent{Query: query, View: view, Payload: a.payloadInfo(payload)}
	if query == "" && view == nil && payload == nil {
		hiddenFor := time.Since(time.UnixMilli(a.lastHidden.Load()))
		shown.Keep = hiddenFor < time.Duration(cfg.RememberSeconds)*time.Second
	}
	_ = PanelShown.Emit(a.panel, shown)
	if !activate {
		a.panel.ShowInactive()
		return
	}
	a.panel.Show()
	a.panel.Focus()
}

// resumePanel 把主窗口原样显示回来（截图期间临时收起），页面上的内容不变。
func (a *App) resumePanel() {
	if a.panel == nil {
		return
	}
	a.blurGrace.Store(time.Now().Add(900 * time.Millisecond).UnixMilli())
	_ = PanelShown.Emit(a.panel, PanelShownEvent{Resume: true})
	a.panel.Show()
	a.panel.Focus()
}

// togglePanel 是唤出热键：显示或隐藏主窗口。显示前先读取前台应用里选中的文字。
func (a *App) togglePanel() {
	if a.panel != nil && a.panel.IsVisible() {
		a.hidePanel()
		return
	}
	if !a.summoning.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer a.summoning.Store(false)
		// 当前停留在工具页面或命令作用域时，唤出直接恢复原状态，不抓取外部选中文字。
		if a.panelInTool.Load() {
			a.showPanel("")
			return
		}
		// 快的路：选中的文字能直接读到（或者根本不用读），几毫秒，读完就显示。
		text, done := a.selectionFast()
		if done {
			if text != "" {
				a.pendingPayload.Store(a.payloads.put(core.Payload{Kind: core.PayloadText, Text: text, Source: "selection"}))
			}
			a.showPanel("")
			return
		}
		// 慢的路要模拟一次复制，得趁原来的窗口还有焦点时做，可能要等一两百毫秒。
		// 不让这段等待挡住窗口：先把窗口亮出来（不抢焦点），复制完再把焦点拿过来，
		// 读到的文字随后补进搜索框。
		a.showPanelWith("", false)
		text = a.selectionSlow()
		if text != "" && a.panel.IsVisible() {
			p := a.payloads.put(core.Payload{Kind: core.PayloadText, Text: text, Source: "selection"})
			c := a.engine.Context()
			c.Selection = text
			a.engine.SetContext(c)
			_ = PayloadArrived.Emit(a.panel, *a.payloadInfo(p))
		}
		if a.panel.IsVisible() {
			a.panel.Show()
			a.panel.Focus()
		}
	}()
}

// openSettings 打开设置窗口。窗口只有一个，已打开时跳到指定分区。
func (a *App) openSettings(section, arg string) {
	if a.settings != nil && !a.settings.IsDestroyed() {
		a.settings.Show()
		a.settings.Focus()
		mygo.App.Focus()
		if section != "" {
			_ = SettingsNavigate.Emit(a.settings, SettingsTarget{Section: section, Arg: arg})
		}
		return
	}
	u := "/settings.html"
	if section != "" {
		u += "?section=" + url.QueryEscape(section) + "&arg=" + url.QueryEscape(arg)
	}
	glass := platform.GlassSupported()
	cfg := a.config.Get()
	opts := mygo.WindowOptions{
		Title:         "Yojigen Pocket 设置",
		Width:         960,
		Height:        660,
		MinWidth:      780,
		MinHeight:     520,
		StateKey:      "settings",
		TitleBarStyle: mygo.TitleBarHidden,
		Hidden:        true,
		Transparent:   glass,
		URL:           u,
	}
	if glass && cfg.Appearance.Material != "none" {
		opts.Vibrancy = mygo.VibrancySidebar
	} else {
		opts.BackgroundColor = "light-dark(#f4f5f7, #1d1f24)"
	}
	win := mygo.NewWindow(opts)
	a.settings = win
	win.OnReadyToShow(func() {
		a.registerHotkeyCapture(win)
		win.Show()
		win.Focus()
		mygo.App.Focus()
	})
	win.OnClosed(func() {
		a.settings = nil
		a.suspendHotkeys(false) // 录到一半就关了窗口：把热键恢复回来
		a.updatePolicy()
	})
	a.updatePolicy()
}

func (a *App) createTray() {
	icon := trayIconColor
	if runtime.GOOS == "darwin" {
		icon = trayIconTemplate
	}
	tray, err := mygo.NewTray(mygo.TrayOptions{
		Icon:           icon,
		IconIsTemplate: runtime.GOOS == "darwin",
		ToolTip:        "Yojigen Pocket",
		Menu:           a.trayMenu(nil),
	})
	if err != nil {
		log.Printf("创建托盘图标失败：%v", err)
		return
	}
	// Windows 托盘左键触发 OnClick、右键弹出 Menu；macOS/Linux 有 Menu 时左键直接展开菜单（Linux 注册 OnClick 还会拖慢菜单响应）。
	if runtime.GOOS == "windows" {
		tray.OnClick(func() { a.showPanel("") })
	}
	a.tray = tray
}

// --- 配置应用 ---

func (a *App) applyTheme(cfg *store.Config) {
	switch cfg.Appearance.Theme {
	case "light":
		mygo.Theme.SetSource(mygo.ThemeLight)
	case "dark":
		mygo.Theme.SetSource(mygo.ThemeDark)
	default:
		mygo.Theme.SetSource(mygo.ThemeSystem)
	}
}

// configApplied 让新配置生效：主题、材质、热键，并通知所有窗口。
func (a *App) configApplied() {
	cfg := a.config.Get()
	a.applyTheme(cfg)
	if a.panel != nil && platform.GlassSupported() {
		a.panel.SetVibrancy(material(cfg))
	}
	a.applyHotkeys(cfg)
	ConfigChanged.Broadcast(a.configView())
}

// applyHotkeys 重新注册全部全局热键。注册失败的记下来显示在设置里。
// suspendHotkeys 暂停或恢复全部全局热键。
func (a *App) suspendHotkeys(suspend bool) {
	a.hotkeyMu.Lock()
	changed := a.hotkeysSuspended != suspend
	a.hotkeysSuspended = suspend
	a.hotkeyMu.Unlock()
	a.hotkeyCapture.Store(suspend)
	if changed {
		a.applyHotkeys(a.config.Get())
	}
}

func (a *App) registerHotkeyCapture(win *mygo.Window) {
	platform.RegisterHotkeyCapture(win.NativeHandle(), &a.hotkeyCapture, func(accel string) {
		_ = HotkeyCaptured.Emit(win, accel)
	})
}

func (a *App) applyHotkeys(cfg *store.Config) {
	a.hotkeyMu.Lock()
	defer a.hotkeyMu.Unlock()
	for _, k := range a.registered {
		mygo.GlobalShortcut.Unregister(k)
	}
	a.registered = nil
	if a.hotkeysSuspended {
		return
	}
	errs := map[string]string{}

	register := func(id, accel string, fn func()) bool {
		if accel == "" || slices.Contains(a.registered, accel) {
			return false
		}
		if err := mygo.GlobalShortcut.Register(accel, fn); err != nil {
			errs[id] = err.Error()
			return false
		}
		a.registered = append(a.registered, accel)
		return true
	}

	mainHotkey := cfg.Hotkey
	if v := os.Getenv("POCKET_HOTKEY"); v != "" {
		mainHotkey = v // 测试和开发时临时覆盖，不抢正式版的热键
	}
	if !register("main", mainHotkey, a.togglePanel) {
		// 主热键被占用时，退到一个备选组合，保证至少有一个入口；托盘图标也还能用。
		if mainHotkey == store.DefaultHotkey && register("fallback", "Alt+Shift+Space", a.togglePanel) {
			errs["main"] = "Alt+Space 已被其他程序占用，暂时改用 Alt+Shift+Space。可以在设置里换一个。"
		}
	}
	all := map[string]string{}
	for id, k := range a.commands.Hotkeys() {
		all[id] = k
	}
	for id, k := range cfg.Hotkeys {
		all[id] = k
	}
	for id, accel := range all {
		register(id, accel, func() { a.runByHotkey(id) })
	}
	// 连点器和键盘宏的开始 / 停止键。
	for id, accel := range a.auto.hotkeys() {
		register(id, accel, func() { a.auto.toggle(id, a.host.Notify) })
	}
	r := cfg.Reader
	register("reader-boss", r.BossKey, a.toggleReader)
	register("reader-prev", r.PrevKey, func() { a.readerCommand("prev") })
	register("reader-next", r.NextKey, func() { a.readerCommand("next") })
	a.hotkeyErrors = errs
}

func normalizeHotkeyInputMode(v string) string {
	switch v {
	case "selection", "clipboard", "both", "none":
		return v
	default:
		return "selection"
	}
}

func resolveHotkeyInput(mode string, readSelection, readClipboard func() string) string {
	clipboardText := func() string {
		if text := readClipboard(); strings.TrimSpace(text) != "" {
			return text
		}
		return ""
	}
	switch normalizeHotkeyInputMode(mode) {
	case "none":
		return ""
	case "clipboard":
		return clipboardText()
	case "both":
		if text := readSelection(); text != "" {
			return text
		}
		return clipboardText()
	default:
		return readSelection()
	}
}

func (a *App) runByHotkey(id string) {
	go func() {
		cfg := a.config.Get()
		detach := cfg.DetachOnHotkey[id]
		inputMode := cfg.HotkeyInput[id]
		// 内置模块：有页面的开页面（计算器、剪贴板、文件搜索），其余的带着前缀打开搜索框。
		if name, isModule := strings.CutPrefix(id, "module:"); isModule {
			page, hasPage := modulePages[name]
			if !hasPage {
				a.openModule(name)
				return
			}
			id = page
			if !detach {
				detach = cfg.DetachOnHotkey[id]
			}
			if inputMode == "" {
				inputMode = cfg.HotkeyInput[id]
			}
		}
		it, ok := a.engine.Resolve(id)
		isView := ok && len(it.Actions) > 0 && it.Actions[0].Type == core.ActionView && it.Actions[0].View != nil
		// 功能页和脚本：按该快捷键的带入设置读取选中的文字或剪贴板文字。
		// 功能页直接填进输入框；脚本可以用 {selection} 和 POCKET_SELECTION 拿到。
		captured := ""
		if ok && ((isView && it.Actions[0].View.Type == "feature") || it.Source == "scripts") {
			// 带入的内容可能来自剪贴板；上下文里的“选中文字”只记真正选中的，
			// 免得脚本的 {selection} / POCKET_SELECTION 拿到的其实是剪贴板。
			selected := ""
			captured = resolveHotkeyInput(inputMode, func() string {
				selected = a.captureSelection()
				return selected
			}, mygo.Clipboard.ReadText)
			c := a.engine.Context()
			c.Selection = selected
			a.engine.SetContext(c)
		}
		if isView {
			view := *it.Actions[0].View
			if captured != "" && view.Type == "feature" && view.Input == "" {
				view.Input = captured
			}
			v := &view
			if (detach || cfg.DetachOnHotkey[id]) && (v.Type == "feature" || v.URL != "") {
				if _, err := a.detach(detachRequestFor(v)); err != nil {
					a.host.Notify("打开失败", err.Error())
				}
				return
			}
			a.showPanelWithView(v)
			return
		}
		err := a.engine.ExecuteByID(context.Background(), id, func(ev core.ExecEvent) {
			// 需要界面的结果（视图、作用域）：把主窗口打开再交给页面处理。
			switch ev.Kind {
			case "view":
				a.showPanelWithView(ev.View)
			case "scope", "input", "toast", "error", "append", "done":
				if !a.panel.IsVisible() {
					a.showPanel("")
				}
				_ = ExternalEvent.Emit(a.panel, ev)
			}
		})
		if err != nil {
			a.host.Notify("命令执行失败", err.Error())
		}
	}()
}

// handleURL 处理 yojigen-pocket:// 链接。
//
//	yojigen-pocket://query?q=文字     打开主窗口并填入文字
//	yojigen-pocket://run/<命令 ID>    执行命令。来自网页的链接可能是诱导，
//	                                  所以只有白名单里的命令会直接执行，其余只是填入搜索框。
func (a *App) handleURL(raw string) {
	// 被链接唤起启动时，链接可能比窗口先到。
	a.urlMu.Lock()
	if !a.isReady {
		a.pendingURL = raw
		a.urlMu.Unlock()
		return
	}
	a.urlMu.Unlock()

	u, err := url.Parse(raw)
	if err != nil {
		return
	}
	switch u.Host {
	case "query":
		a.showPanel(u.Query().Get("q"))
	case "run":
		id := strings.TrimPrefix(path.Clean(u.EscapedPath()), "/")
		if unescaped, err := url.PathUnescape(id); err == nil {
			id = unescaped
		}
		if slices.Contains(a.config.Get().URIAllowlist, id) {
			a.runByHotkey(id)
			return
		}
		if it, ok := a.engine.Resolve(id); ok {
			a.showPanel(it.Title)
		} else {
			a.showPanel("")
		}
	default:
		a.showPanel("")
	}
}

// watchHome 监听用户目录：文件一变就重新加载对应的部分。
func (a *App) watchHome(ctx context.Context) {
	w, err := mygo.WatchFiles(ctx, a.paths.Home, mygo.FileWatchOptions{
		Recursive: true,
		Debounce:  200 * time.Millisecond,
		Ignore: func(p string, isDir bool) bool {
			top, _, _ := strings.Cut(p, "/")
			switch top {
			case "data", "cache", "logs", ".git":
				return true
			}
			return false
		},
	})
	if err != nil {
		log.Printf("监听用户目录失败：%v", err)
		return
	}
	go func() {
		for {
			events, err := w.Next(ctx)
			if err != nil {
				return
			}
			a.onHomeChanged(events)
		}
	}()
}

func (a *App) onHomeChanged(events []mygo.FileEvent) {
	var config, commands, plugins, snippets, ui bool
	for _, e := range events {
		top, _, _ := strings.Cut(e.Path, "/")
		switch top {
		case "config.json":
			config = true
		case "commands":
			commands = true
		case "plugins":
			plugins = true
		case "snippets":
			snippets = true
		case "ui":
			ui = true
		}
	}
	if commands {
		a.commands.Reload()
		a.applyHotkeys(a.config.Get())
	}
	if plugins {
		a.plugins.Reload()
	}
	if snippets {
		a.snippets.Reload()
	}
	if config && a.config.Reload() {
		a.configApplied()
	}
	if commands || plugins || snippets || config {
		ResultsChanged.Broadcast(struct{}{})
	}
	if ui {
		UserAssetsChanged.Broadcast(a.userAssets())
	}
}
