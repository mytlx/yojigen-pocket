package main

import (
	"context"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/llm"
	"yojigen-pocket/internal/ocr"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/store"
	"yojigen-pocket/internal/translate"
)

// --- 独立窗口 ---

// DetachRequest 描述要分离出来的页面：内置功能页，或网页插件。
type DetachRequest struct {
	Feature string            `json:"feature,omitempty"`
	Input   string            `json:"input,omitempty"`
	Args    map[string]string `json:"args,omitempty"`
	URL     string            `json:"url,omitempty"`    // 网页插件的地址
	Plugin  string            `json:"plugin,omitempty"` // 网页插件 ID
	Title   string            `json:"title"`
	Icon    string            `json:"icon,omitempty"`
	Height  int               `json:"height,omitempty"`
	Width   int               `json:"width,omitempty"`
	Mode    string            `json:"mode,omitempty"` // stealth：摸鱼小窗
}

// WindowInfo 是一个已分离的窗口。
type WindowInfo struct {
	ID      int    `json:"id"`
	Title   string `json:"title"`
	Icon    string `json:"icon,omitempty"`
	Feature string `json:"feature,omitempty"`
	Mode    string `json:"mode,omitempty"`
	Visible bool   `json:"visible"`
}

type detachedWindow struct {
	win  *mygo.Window
	key  string // 同一个功能只开一个窗口
	info WindowInfo
}

// FeatureInputEvent 让已经打开的独立窗口换上新的输入。
type FeatureInputEvent struct {
	Input string            `json:"input"`
	Args  map[string]string `json:"args,omitempty"`
}

func (r DetachRequest) key() string {
	switch {
	case r.Mode == "stealth":
		return "reader-stealth"
	case r.Plugin != "":
		// 一个扩展可以有几个工具，各开各的窗口。
		if tool := r.Args["tool"]; tool != "" && tool != r.Plugin {
			return "plugin-" + r.Plugin + "-" + tool
		}
		return "plugin-" + r.Plugin
	}
	return "feature-" + r.Feature
}

// detach 把功能页分离成独立窗口。同一个功能已经有窗口时，切过去并换上新的输入。
// featureWidths 是需要更宽窗口的功能页分离出来时的宽度。
var featureWidths = map[string]int{"find": 1080, "clipboard": 880, "calc": 760, "wintools": 820, "macro": 980, "clicker": 820, "inputtest": 1000}

// modulePages 是有独立页面的内置模块：模块 ID → 功能页的 ID。
var modulePages = map[string]string{"calc": "features:calc", "clipboard": "features:clipboard", "files": "features:find"}

// openModule 带着模块的前缀打开搜索框（没有独立页面的模块）。
func (a *App) openModule(name string) {
	if prefixes := a.config.Get().Modules[name].Prefixes(); len(prefixes) > 0 {
		a.showPanel(prefixes[0] + " ")
		return
	}
	a.showPanel("")
}

func (a *App) detach(req DetachRequest) (int, error) {
	if req.Feature == "" && req.URL == "" {
		return 0, errors.New("这个页面不能分离")
	}
	key := req.key()
	a.detachedMu.Lock()
	for id, d := range a.detached {
		if d.key == key {
			a.detachedMu.Unlock()
			if req.Input != "" || len(req.Args) > 0 {
				_ = FeatureInput.Emit(d.win, FeatureInputEvent{Input: req.Input, Args: req.Args})
			}
			a.focusWindow(id)
			a.hidePanel()
			return id, nil
		}
	}
	a.detachedMu.Unlock()

	q := url.Values{}
	set := func(k, v string) {
		if v != "" {
			q.Set(k, v)
		}
	}
	set("f", req.Feature)
	set("q", req.Input)
	set("u", req.URL)
	set("p", req.Plugin)
	set("t", req.Title)
	set("i", req.Icon)
	set("m", req.Mode)
	if req.Height > 0 {
		q.Set("h", strconv.Itoa(req.Height))
	}
	if len(req.Args) > 0 {
		raw, _ := json.Marshal(req.Args)
		q.Set("a", string(raw))
	}
	cfg := a.config.Get()
	glass := platform.GlassSupported()
	opts := mygo.WindowOptions{
		Title:     req.Title,
		URL:       "/feature.html?" + q.Encode(),
		Hidden:    true,
		StateKey:  key,
		MinWidth:  420,
		MinHeight: 300,
	}
	if req.Mode == "stealth" {
		// 摸鱼小窗：无边框、透明、置顶、不进任务栏，看起来不像一个窗口。
		opts.Frameless, opts.Transparent, opts.AlwaysOnTop, opts.SkipTaskbar, opts.DisableShadow = true, true, true, true, true
		opts.Width, opts.Height, opts.MinWidth, opts.MinHeight = 560, 84, 200, 32
	} else {
		width := max(cfg.Appearance.Width, 640, featureWidths[req.Feature], req.Width)
		height := 600
		if req.Height > 0 {
			height = req.Height + 56
		}
		opts.Width, opts.Height = width, height
		opts.TitleBarStyle = mygo.TitleBarHidden
		opts.Transparent = glass
		if glass && cfg.Appearance.Material != "none" {
			opts.Vibrancy = mygo.VibrancyUnderWindow
		} else {
			opts.BackgroundColor = "light-dark(#f4f5f7, #1d1f24)"
		}
	}
	win := mygo.NewWindow(opts)
	if req.Plugin != "" {
		a.pluginHost.bindPeerWindow(req.Plugin, win)
	}
	id := win.ID()
	d := &detachedWindow{win: win, key: key, info: WindowInfo{ID: id, Title: req.Title, Icon: req.Icon, Feature: req.Feature, Mode: req.Mode}}
	a.detachedMu.Lock()
	a.detached[id] = d
	a.detachedMu.Unlock()
	win.OnReadyToShow(func() {
		if req.Mode == "stealth" {
			win.ShowInactive()
		} else {
			win.Show()
			win.Focus()
		}
		a.windowsChanged()
	})
	win.OnClosed(func() {
		a.detachedMu.Lock()
		delete(a.detached, id)
		a.detachedMu.Unlock()
		a.windowsChanged()
	})
	win.OnShow(a.windowsChanged)
	win.OnHide(a.windowsChanged)
	a.hidePanel()
	a.updatePolicy()
	return id, nil
}

func (a *App) windowList() []WindowInfo {
	a.detachedMu.Lock()
	defer a.detachedMu.Unlock()
	out := make([]WindowInfo, 0, len(a.detached))
	for _, d := range a.detached {
		info := d.info
		info.Visible = !d.win.IsDestroyed() && d.win.IsVisible()
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (a *App) focusWindow(id int) {
	a.detachedMu.Lock()
	d := a.detached[id]
	a.detachedMu.Unlock()
	if d == nil || d.win.IsDestroyed() {
		return
	}
	if d.info.Mode == "stealth" {
		d.win.ShowInactive()
		return
	}
	d.win.Show()
	d.win.Focus()
	mygo.App.Focus()
}

// windowsChanged 通知各个页面和托盘：独立窗口有变化。
func (a *App) windowsChanged() {
	list := a.windowList()
	WindowsChanged.Broadcast(list)
	a.refreshTray(list)
	a.updatePolicy()
}

// updatePolicy 在 macOS 上：有普通窗口（独立功能窗口、设置、道具库）开着时出现在程序坞和 ⌘Tab 里，
// 全部关掉后回到只在菜单栏的状态。摸鱼小窗不算。
func (a *App) updatePolicy() {
	if runtime.GOOS != "darwin" {
		return
	}
	regular := (a.settings != nil && !a.settings.IsDestroyed()) || (a.catalog != nil && !a.catalog.IsDestroyed())
	for _, w := range a.windowList() {
		if w.Mode != "stealth" {
			regular = true
		}
	}
	want := mygo.ActivationPolicyAccessory
	if regular {
		want = mygo.ActivationPolicyRegular
	}
	if mygo.App.ActivationPolicy() != want {
		mygo.App.SetActivationPolicy(want)
	}
}

// showPanelWithView 显示主窗口并直接进入一个页面（热键、道具库、截图识别等入口）。
func (a *App) showPanelWithView(v *core.View) {
	if v != nil {
		shown := *v
		shown.Icon = a.engine.NormalizeIcon(v.Icon)
		v = &shown
	}
	a.pendingView.Store(v)
	a.showPanel("")
}

// --- 摸鱼阅读 ---

func (a *App) readerWindows() []*detachedWindow {
	a.detachedMu.Lock()
	defer a.detachedMu.Unlock()
	var out []*detachedWindow
	for _, d := range a.detached {
		if d.info.Feature == "reader" {
			out = append(out, d)
		}
	}
	return out
}

// toggleReader 是老板键：有阅读窗口在显示就全部藏起来，否则显示出来；还没有窗口时打开摸鱼小窗。
func (a *App) toggleReader() {
	wins := a.readerWindows()
	if len(wins) == 0 {
		_, _ = a.detach(DetachRequest{Feature: "reader", Mode: "stealth", Title: "摸鱼阅读", Icon: "svg:book-open"})
		return
	}
	anyVisible := false
	for _, d := range wins {
		if d.win.IsVisible() {
			anyVisible = true
		}
	}
	for _, d := range wins {
		switch {
		case anyVisible:
			d.win.Hide()
		case d.info.Mode == "stealth":
			d.win.ShowInactive()
		default:
			d.win.ShowInactive()
		}
	}
}

// readerCommand 把全局翻页等命令发给正在显示的阅读窗口。
func (a *App) readerCommand(cmd string) {
	for _, d := range a.readerWindows() {
		if d.win.IsVisible() {
			_ = ReaderCommand.Emit(d.win, cmd)
		}
	}
	if a.panel != nil && a.panel.IsVisible() {
		_ = ReaderCommand.Emit(a.panel, cmd)
	}
}

// --- 截图识别 ---

// captureScreen 让用户框选屏幕区域，返回保存的图片路径；用户取消时返回空字符串。
func (a *App) captureScreen(ctx context.Context) (string, error) {
	dir := filepath.Join(a.paths.Cache, "ocr")
	_ = os.MkdirAll(dir, 0o700)
	cleanupOld(dir, 20)
	path := filepath.Join(dir, time.Now().Format("20060102-150405.000")+".png")
	if runtime.GOOS != "windows" {
		ok, err := platform.CaptureRegion(ctx, path)
		if err != nil || !ok {
			return "", err
		}
		return path, nil
	}
	// Windows：调用系统截图工具，截好的图会放进剪贴板。
	before, _ := platform.ClipboardSeq()
	if err := platform.Command(ctx, "cmd", "/c", "start", "", "ms-screenclip:").Run(); err != nil {
		return "", fmt.Errorf("打开系统截图工具失败：%w", err)
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
		if seq, _ := platform.ClipboardSeq(); seq != before {
			if data := mygo.Clipboard.ReadImage(); len(data) > 0 {
				return path, os.WriteFile(path, data, 0o600)
			}
			before = seq
		}
	}
	return "", nil
}

func cleanupOld(dir string, keep int) {
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) <= keep {
		return
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, n := range names[:len(names)-keep] {
		_ = os.Remove(filepath.Join(dir, n))
	}
}

func (a *App) llmConfig(provider string) llm.Config {
	t := a.config.Get().Translate
	switch provider {
	case llm.OpenAI:
		return llm.Config{Provider: llm.OpenAI, BaseURL: t.OpenAI.BaseURL, Model: t.OpenAI.Model, APIKey: a.secret(translate.KeyOpenAI)}
	default:
		return llm.Config{Provider: llm.Claude, BaseURL: t.Claude.BaseURL, Model: t.Claude.Model, APIKey: a.secret(translate.KeyClaude)}
	}
}

func (a *App) secret(name string) string {
	v, err := mygo.Secrets.Get(name)
	if err != nil {
		return ""
	}
	return string(v)
}

func (a *App) recognize(ctx context.Context, path string) (ocr.Result, error) {
	cfg := a.config.Get().OCR
	return ocr.Recognize(ctx, path, ocr.Options{
		Engine: cfg.Engine, Language: cfg.Language, Model: a.llmConfig(cfg.Engine),
		TempDir: filepath.Join(a.paths.Cache, "ocr"),
	})
}

var errScreenPermission = errors.New("没有「屏幕录制」权限，截不到其他应用的窗口。请在「系统设置 → 隐私与安全性 → 屏幕录制」里允许 Yojigen Pocket，然后重启本应用")

// showOCR 显示主窗口并进入图片文字识别页。截图刚结束时系统会把焦点还给之前的应用，所以给一小段保护时间。
func (a *App) showOCR(args map[string]string) {
	a.blurGrace.Store(time.Now().Add(900 * time.Millisecond).UnixMilli())
	a.showPanelWithView(&core.View{Type: "feature", Feature: "ocr", Title: "图片文字识别", Icon: "svg:scan-text", Args: args})
}

// featureCommands 是功能页之外的命令：截图识别的几种用法、摸鱼阅读的控制。
func (a *App) featureCommands() []*providers.FeatureCommand {
	// 截图类命令：先收起主窗口，截完再做后面的事。任何一步失败都回到识别页把原因说清楚，不会悄悄没了下文。
	afterCapture := func(after func(path string)) func(context.Context, *core.Run) error {
		return func(_ context.Context, r *core.Run) error {
			r.Hide()
			go func() {
				if !platform.ScreenCaptureAllowed() {
					platform.RequestScreenCapture()
					a.showOCR(map[string]string{"error": errScreenPermission.Error()})
					return
				}
				time.Sleep(160 * time.Millisecond) // 等主窗口完全收起，免得截进图里
				path, err := a.captureScreen(context.Background())
				time.Sleep(120 * time.Millisecond) // 等系统的截图界面退场
				switch {
				case err != nil:
					a.showOCR(map[string]string{"error": "截图失败：" + err.Error()})
				case path != "":
					after(path)
				}
			}()
			return nil
		}
	}
	return []*providers.FeatureCommand{
		{ID: "ocr-capture", Title: "截图识别文字", Icon: "svg:scan-text", Category: "效率工具", Desc: "框选屏幕区域，识别里面的文字",
			Keywords: []string{"ocr", "jt", "jietu", "screenshot", "截图", "截图识别"},
			Run:      afterCapture(func(path string) { a.showOCR(map[string]string{"image": path}) })},
		{ID: "ocr-copy", Title: "截图识别并复制", Icon: "svg:scan-text", Category: "效率工具", Desc: "识别后直接复制文字，不打开窗口",
			Keywords: []string{"ocrc", "jtfz", "截图复制"},
			Run: afterCapture(func(path string) {
				res, err := a.recognize(context.Background(), path)
				switch {
				case err != nil:
					a.showOCR(map[string]string{"image": path, "error": "识别失败：" + err.Error()})
				case strings.TrimSpace(res.Text) == "":
					a.showOCR(map[string]string{"image": path})
				default:
					mygo.Clipboard.WriteText(res.Text)
					a.host.Notify("已复制识别结果", fmt.Sprintf("%d 个字", len([]rune(res.Text))))
				}
			})},
		{ID: "ocr-translate", Title: "截图识别并翻译", Icon: "svg:languages", Category: "效率工具", Desc: "识别后带着文字打开翻译",
			Keywords: []string{"ocrt", "jtfy", "截图翻译"},
			Run: afterCapture(func(path string) {
				res, err := a.recognize(context.Background(), path)
				if err != nil || strings.TrimSpace(res.Text) == "" {
					args := map[string]string{"image": path}
					if err != nil {
						args["error"] = "识别失败：" + err.Error()
					}
					a.showOCR(args)
					return
				}
				a.blurGrace.Store(time.Now().Add(900 * time.Millisecond).UnixMilli())
				a.showPanelWithView(&core.View{Type: "feature", Feature: "translate", Title: "翻译", Icon: "svg:languages", Input: res.Text})
			})},
		{ID: "reader-stealth", Title: "摸鱼小窗", Icon: "svg:book-open", Category: "效率工具", Desc: "以无边框、半透明的小窗继续阅读",
			Keywords: []string{"mymo", "stealth", "小窗"},
			Run: func(_ context.Context, r *core.Run) error {
				r.Hide()
				_, err := a.detach(DetachRequest{Feature: "reader", Mode: "stealth", Title: "摸鱼阅读", Icon: "svg:book-open"})
				return err
			}},
		{ID: "reader-boss", Title: "隐藏/显示阅读器", Icon: "svg:eye-off", Category: "效率工具", Desc: "老板键，默认 " + a.config.Get().Reader.BossKey,
			Keywords: []string{"boss", "laobanjian", "老板键"},
			Run: func(_ context.Context, r *core.Run) error {
				r.Hide()
				a.toggleReader()
				return nil
			}},
		{ID: "reader-autopage", Title: "开始/停止自动翻页", Icon: "svg:play", Category: "效率工具", Desc: "摸鱼阅读按设置的间隔自动翻页",
			Keywords: []string{"zdfy", "autopage"},
			Run: func(_ context.Context, r *core.Run) error {
				r.Hide()
				a.readerCommand("autopage")
				return nil
			}},
	}
}

// --- 托盘 ---

func (a *App) trayMenu(list []WindowInfo) *mygo.Menu {
	items := []*mygo.MenuItem{
		{Label: "打开 Yojigen Pocket", Click: func(*mygo.MenuItem, *mygo.Window) { a.showPanel("") }},
		{Label: "道具库…", Click: func(*mygo.MenuItem, *mygo.Window) { a.openCatalog() }},
		{Label: "设置…", Click: func(*mygo.MenuItem, *mygo.Window) { a.openSettings("", "") }},
	}
	if len(list) > 0 {
		var sub []*mygo.MenuItem
		for _, w := range list {
			id := w.ID
			label := w.Title
			if !w.Visible {
				label += "（已隐藏）"
			}
			sub = append(sub, &mygo.MenuItem{Label: label, Click: func(*mygo.MenuItem, *mygo.Window) { a.focusWindow(id) }})
		}
		items = append(items, mygo.Separator(), &mygo.MenuItem{Label: "独立窗口", Submenu: sub})
	}
	items = append(items,
		mygo.Separator(),
		&mygo.MenuItem{Label: "打开配置目录", Click: func(*mygo.MenuItem, *mygo.Window) { _ = openPath(a.paths.Home) }},
		&mygo.MenuItem{Label: "重新加载", Click: func(*mygo.MenuItem, *mygo.Window) { a.reloadAll() }},
		mygo.Separator(),
		&mygo.MenuItem{Label: "退出", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
	)
	return mygo.NewMenu(items)
}

func (a *App) refreshTray(list []WindowInfo) {
	if a.tray != nil {
		a.tray.SetMenu(a.trayMenu(list))
	}
}

// --- 道具库窗口 ---

func (a *App) openCatalog() {
	if a.catalog != nil && !a.catalog.IsDestroyed() {
		a.catalog.Show()
		a.catalog.Focus()
		mygo.App.Focus()
		return
	}
	glass := platform.GlassSupported()
	opts := mygo.WindowOptions{
		Title: "道具库", URL: "/catalog.html", Width: 1040, Height: 700, MinWidth: 760, MinHeight: 480,
		StateKey: "catalog", TitleBarStyle: mygo.TitleBarHidden, Hidden: true, Transparent: glass,
	}
	if glass && a.config.Get().Appearance.Material != "none" {
		opts.Vibrancy = mygo.VibrancySidebar
	} else {
		opts.BackgroundColor = "light-dark(#f4f5f7, #1d1f24)"
	}
	win := mygo.NewWindow(opts)
	a.catalog = win
	win.OnReadyToShow(func() {
		a.registerHotkeyCapture(win)
		win.Show()
		win.Focus()
		mygo.App.Focus()
	})
	win.OnClosed(func() {
		a.catalog = nil
		a.suspendHotkeys(false) // 录到一半就关了窗口：把热键恢复回来
		a.updatePolicy()
	})
	a.updatePolicy()
}

// --- 朗读（网页的语音合成不可用时的后备） ---

var (
	speakMu     sync.Mutex
	speakCancel context.CancelFunc
	voicesOnce  sync.Once
	macVoices   map[string]string // 语言 → 声音
)

var voiceLine = regexp.MustCompile(`^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#`)

func macVoiceFor(lang string) string {
	voicesOnce.Do(func() {
		macVoices = map[string]string{}
		out, err := exec.Command("say", "-v", "?").Output()
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			m := voiceLine.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			locale := m[2]
			if _, ok := macVoices[locale]; !ok {
				macVoices[locale] = strings.TrimSpace(m[1])
			}
		}
	})
	want := map[string]string{"zh": "zh_CN", "zh-TW": "zh_TW", "en": "en_US", "ja": "ja_JP", "ko": "ko_KR", "fr": "fr_FR", "de": "de_DE", "es": "es_ES", "ru": "ru_RU", "pt": "pt_BR", "it": "it_IT"}[lang]
	return macVoices[want]
}

// 文字通过环境变量交给 PowerShell。放在命令行参数里的话，-Command 会把它按空格拆开，
// 结果只读第一个词（英文句子读到第一个空格就停）。
const winSpeak = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$c = $env:POCKET_SPEAK_CULTURE
if ($c) {
  $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like ($c + '*') } | Select-Object -First 1
  if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
}
$r = 0
[void][int]::TryParse($env:POCKET_SPEAK_RATE, [ref]$r)
$s.Rate = $r
$s.Speak($env:POCKET_SPEAK_TEXT)`

// speakSystem 用系统语音朗读，读完或被打断后返回。rate 是语速增减的百分比。
func speakSystem(text, lang string, rate int) error {
	speakMu.Lock()
	if speakCancel != nil {
		speakCancel()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	speakCancel = cancel
	speakMu.Unlock()
	defer cancel()
	if strings.TrimSpace(text) == "" {
		return nil
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		var args []string
		if v := macVoiceFor(lang); v != "" {
			args = append(args, "-v", v)
		}
		if rate != 0 {
			args = append(args, "-r", strconv.Itoa(max(90, 180+180*rate/100))) // 每分钟的词数，默认大约 180
		}
		// 文字从标准输入给，开头是减号也不会被当成参数。
		cmd = platform.Command(ctx, "say", args...)
		cmd.Stdin = strings.NewReader(text)
	case "windows":
		ps := platform.LookFirst("powershell.exe")
		if ps == "" {
			return errors.New("找不到 PowerShell")
		}
		culture := map[string]string{"zh": "zh-CN", "zh-TW": "zh-TW", "en": "en-US", "ja": "ja-JP", "ko": "ko-KR", "fr": "fr-FR", "de": "de-DE", "es": "es-ES", "ru": "ru-RU"}[lang]
		cmd = platform.Command(ctx, ps, "-NoProfile", "-NonInteractive", "-Command", winSpeak)
		cmd.Env = append(os.Environ(), "POCKET_SPEAK_TEXT="+text, "POCKET_SPEAK_CULTURE="+culture,
			"POCKET_SPEAK_RATE="+strconv.Itoa(max(-10, min(rate/10, 10)))) // System.Speech 的语速是 -10 到 10
	default:
		return platform.ErrUnsupported
	}
	if err := cmd.Run(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("系统语音朗读失败：%v", err)
	}
	return nil
}

// speak 在后台用系统语音朗读（不等读完）。
func speak(text, lang string) error {
	go func() {
		if err := speakSystem(translate.Truncate(text, 2000), lang, 0); err != nil {
			log.Printf("[ERROR] %v", err)
		}
	}()
	return nil
}

func stopSpeaking() {
	speakMu.Lock()
	defer speakMu.Unlock()
	if speakCancel != nil {
		speakCancel()
		speakCancel = nil
	}
}

// --- 哈希 ---

func hashAll(r io.Reader) (map[string]string, error) {
	hs := map[string]hash.Hash{"md5": md5.New(), "sha1": sha1.New(), "sha256": sha256.New(), "sha512": sha512.New()}
	writers := make([]io.Writer, 0, len(hs))
	for _, h := range hs {
		writers = append(writers, h)
	}
	if _, err := io.Copy(io.MultiWriter(writers...), r); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for k, h := range hs {
		out[k] = hex.EncodeToString(h.Sum(nil))
	}
	return out, nil
}

// --- 道具库数据 ---

// CatalogItem 是道具库里的一项。
type CatalogItem struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Subtitle  string   `json:"subtitle,omitempty"`
	Icon      string   `json:"icon,omitempty"`
	Category  string   `json:"category"`
	Keywords  []string `json:"keywords,omitempty"`
	Prefix    string   `json:"prefix,omitempty"` // 内置模块的前缀
	Hotkey    string   `json:"hotkey,omitempty"`
	Kind      string   `json:"kind"` // item | module
	Enabled   bool     `json:"enabled"`
	CanDetach bool     `json:"canDetach"`
	CanHotkey bool     `json:"canHotkey,omitempty"` // 能不能绑直达快捷键
	Path      string   `json:"path,omitempty"`
	// 关键词（内置模块就是前缀）：能不能在这里改、自带的是什么、是不是改过、哪些和别的项撞了。
	CanKeywords     bool              `json:"canKeywords,omitempty"`
	DefaultKeywords []string          `json:"defaultKeywords,omitempty"`
	CustomKeywords  bool              `json:"customKeywords,omitempty"`
	Conflicts       []KeywordConflict `json:"conflicts,omitempty"`
}

// 道具库的分类顺序。
var catalogOrder = []string{"效率工具", "开发工具", "内置模块", "扩展", "脚本命令", "系统指令", "网页搜索", "文本片段", "Pocket"}

func (a *App) catalogItems() []CatalogItem {
	cfg := a.config.Get()
	hotkeys := a.commands.Hotkeys()
	for id, k := range cfg.Hotkeys {
		hotkeys[id] = k
	}
	var out []CatalogItem
	owners := a.keywordOwners(cfg)
	add := func(it core.Item, category string, keywords []string) {
		ui := a.engine.NormalizeIcon(it.Icon)
		canDetach := false
		if len(it.Actions) > 0 && it.Actions[0].View != nil {
			v := it.Actions[0].View
			canDetach = v.Type == "feature" || (v.Type == "panel" && v.URL != "")
		}
		item := CatalogItem{
			ID: it.ID, Title: it.Title, Subtitle: it.Subtitle, Icon: ui, Category: category, Keywords: keywords,
			Hotkey: hotkeys[it.ID], Kind: "item", Enabled: !slices.Contains(cfg.Disabled, it.ID), CanDetach: canDetach, CanHotkey: true, Path: it.Path,
		}
		if defaults, ok := a.defaultKeywords(it.ID); ok {
			item.CanKeywords, item.DefaultKeywords = true, defaults
			_, item.CustomKeywords = cfg.Keywords[it.ID]
		}
		isCommand := strings.HasPrefix(it.ID, "features:") && a.features.Def(strings.TrimPrefix(it.ID, "features:")) == nil
		if item.Enabled && !isCommand {
			item.Conflicts = conflictsOf(owners, a.ownerKey(it.ID), keywords)
		}
		out = append(out, item)
	}
	for _, it := range a.features.CatalogItems() {
		add(it, it.SourceLabel, a.features.KeywordsOf(it.ID))
	}
	// 内置模块：按前缀或全局搜索使用的能力。
	defaults := store.DefaultConfig()
	for _, id := range moduleOrder {
		m := cfg.Modules[id]
		meta := moduleMeta[id]
		_, hasPage := modulePages[id]
		item := CatalogItem{
			ID: "module:" + id, Title: meta.title, Subtitle: moduleDescriptions[id], Icon: meta.icon, Category: "内置模块",
			Prefix: m.Prefix, Kind: "module", Enabled: m.Enabled,
			// 有页面的能开独立窗口；有页面或有前缀的能绑快捷键（按下就是打开它）。
			Hotkey: hotkeys["module:"+id], CanDetach: hasPage, CanHotkey: hasPage || m.Prefix != "",
			CanKeywords: true, DefaultKeywords: defaults.Modules[id].Prefixes(), CustomKeywords: m.Prefix != defaults.Modules[id].Prefix,
		}
		if m.Enabled {
			item.Conflicts = conflictsOf(owners, "module:"+id, m.Prefixes())
		}
		out = append(out, item)
	}
	for _, it := range a.plugins.CatalogItems() {
		// 扩展里的工具可以声明自己归到哪一类（效率工具、开发工具），没写的归到“扩展”。
		category := "扩展"
		if slices.Contains(catalogOrder, it.SourceLabel) {
			category = it.SourceLabel
		}
		add(it, category, a.plugins.KeywordsOf(it.ID))
	}
	for _, it := range a.commands.CatalogItems() {
		add(it, "脚本命令", a.commands.KeywordsOf(it.ID))
	}
	for _, it := range a.system.CatalogItems() {
		add(it, "系统指令", nil)
	}
	for _, it := range a.web.CatalogItems() {
		add(it, "网页搜索", nil)
	}
	for _, it := range a.snippets.CatalogItems() {
		add(it, "文本片段", nil)
	}
	for _, it := range a.self.CatalogItems() {
		add(it, "Pocket", nil)
	}
	order := map[string]int{}
	for i, c := range catalogOrder {
		order[c] = i
	}
	sort.SliceStable(out, func(i, j int) bool { return order[out[i].Category] < order[out[j].Category] })
	return out
}

// openItem 以默认动作打开一项：功能页在主窗口里打开（或直接分离），其他命令直接执行。
func (a *App) openItem(id string, detached bool) error {
	if name, ok := strings.CutPrefix(id, "module:"); ok {
		page, hasPage := modulePages[name]
		if !hasPage {
			a.openModule(name)
			return nil
		}
		id = page
	}
	it, ok := a.engine.Resolve(id)
	if !ok {
		return fmt.Errorf("找不到：%s", id)
	}
	if len(it.Actions) > 0 && it.Actions[0].Type == core.ActionView && it.Actions[0].View != nil {
		v := it.Actions[0].View
		if detached {
			_, err := a.detach(detachRequestFor(v))
			return err
		}
		a.showPanelWithView(v)
		return nil
	}
	a.runByHotkey(id)
	return nil
}

func detachRequestFor(v *core.View) DetachRequest {
	return DetachRequest{Feature: v.Feature, Input: v.Input, Args: v.Args, URL: v.URL, Plugin: v.Plugin, Title: v.Title, Icon: v.Icon, Height: v.Height, Width: v.Width}
}
