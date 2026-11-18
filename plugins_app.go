package main

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/peer"
	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/runner"
	"yojigen-pocket/internal/store"
	"yojigen-pocket/internal/tts"
	"yojigen-pocket/internal/workspace"
)

// 扩展的宿主：页面里的 window.pocket 调到这里，按清单里声明的权限放行。

// PluginEvent 是宿主发给扩展页面的事件（代码运行的输出、后端程序的消息）。
var PluginEvent = mygo.NewEvent[PluginEventData]("plugin:event")

// PluginEventData 是一条事件。Plugin 用来让页面只收自己的。
type PluginEventData struct {
	Plugin string `json:"plugin"`
	Name   string `json:"name"`
	Data   any    `json:"data"`
}

type pluginHost struct {
	a            *App
	peerMu       sync.Mutex
	peers        map[string]*peer.Service
	peerStopping bool

	mu      sync.Mutex
	floats  map[string]*mygo.Window       // "扩展/工具" → 悬浮窗
	running map[string]context.CancelFunc // "窗口 ID/扩展" → 正在运行的代码
	backs   map[string]*backendProc       // 扩展 → 后端进程
	drag    map[int]mygo.Point
}

func newPluginHost(a *App) *pluginHost {
	return &pluginHost{a: a, floats: map[string]*mygo.Window{}, running: map[string]context.CancelFunc{}, backs: map[string]*backendProc{}, drag: map[int]mygo.Point{}}
}

type callArgs []any

func (c callArgs) str(i int) string {
	if i < len(c) {
		s, _ := c[i].(string)
		return s
	}
	return ""
}
func (c callArgs) num(i int) float64 {
	if i < len(c) {
		n, _ := c[i].(float64)
		return n
	}
	return 0
}
func (c callArgs) boolean(i int) bool {
	if i < len(c) {
		b, _ := c[i].(bool)
		return b
	}
	return false
}
func (c callArgs) obj(i int) map[string]any {
	if i < len(c) {
		m, _ := c[i].(map[string]any)
		return m
	}
	return nil
}

var errPermission = errors.New("这个扩展没有声明这项权限")

// fsStore 返回扩展能读写的一个目录：root 为空是它自己的私有目录，否则必须是清单里声明过的用户目录。
func (h *pluginHost) fsStore(m providers.Manifest, id, root string) (*workspace.Store, error) {
	if root == "" {
		return &workspace.Store{Dir: filepath.Join(h.a.paths.Data, "plugins", id+"-files")}, nil
	}
	if !providers.ValidUserDir(root) || !slices.Contains(m.Permissions.Dirs, root) {
		return nil, fmt.Errorf("这个扩展没有声明要用「%s」目录", root)
	}
	return &workspace.Store{Dir: filepath.Join(h.a.paths.Home, root)}, nil
}

// call 处理扩展页面的一次调用。
func (h *pluginHost) call(ctx context.Context, id, tool, method string, raw []any) (any, error) {
	a := h.a
	args := callArgs(raw)
	m, dir, ok := a.plugins.ManifestOf(id)
	if !ok {
		return nil, errors.New("这个扩展已经停用或卸载了")
	}
	win := mygo.CallerWindow(ctx)

	if name, isPeer := strings.CutPrefix(method, "peer."); isPeer {
		return h.peerCall(m, id, name, args, win)
	}
	if name, isFS := strings.CutPrefix(method, "fs."); isFS {
		return h.fs(ctx, m, id, name, args, win)
	}
	if name, isWin := strings.CutPrefix(method, "window."); isWin {
		return h.window(id, name, args, win)
	}
	switch method {
	case "copyText":
		mygo.Clipboard.WriteText(args.str(0))
	case "readClipboard":
		return mygo.Clipboard.ReadText(), nil
	case "pasteText":
		mygo.Clipboard.WriteText(args.str(0))
		a.hidePanel()
		return nil, platformPaste()
	case "openExternal":
		target := args.str(0)
		if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
			return nil, errors.New("只能打开 http / https 链接")
		}
		return nil, openExternal(target)
	case "notify":
		a.host.Notify(args.str(0), args.str(1))
	case "hide":
		a.hidePanel()
	case "getStorage":
		return a.pluginStorageGet(id, args.str(0))
	case "setStorage":
		var value any
		if len(args) > 1 {
			value = args[1]
		}
		return nil, a.pluginStorageSet(id, args.str(0), value)
	case "fetch":
		return h.fetch(ctx, m, args.str(0), args.obj(1))
	case "runner.languages":
		if !m.Permissions.Runner {
			return nil, errPermission
		}
		var langs []map[string]string
		for _, l := range runner.Langs() {
			langs = append(langs, map[string]string{"id": l.ID, "name": l.Name, "ext": l.Ext, "tool": l.Tool(), "formatter": l.Formatter()})
		}
		return langs, nil
	case "runner.format":
		if !m.Permissions.Runner {
			return nil, errPermission
		}
		l, ok := runner.Find(args.str(0))
		if !ok {
			return nil, errors.New("不认识的语言：" + args.str(0))
		}
		return runner.Format(ctx, l, args.str(1))
	case "runner.run":
		if !m.Permissions.Runner {
			return nil, errPermission
		}
		return nil, h.run(ctx, id, args.obj(0), args.str(1), win)
	case "runner.stop":
		h.mu.Lock()
		if cancel := h.running[runKey(win, id)]; cancel != nil {
			cancel()
		}
		h.mu.Unlock()
	case "backend.call":
		return h.backendCall(ctx, id, dir, m, args.str(0), raw[min(1, len(raw)):])
	default:
		return nil, fmt.Errorf("不支持的调用：%s", method)
	}
	_ = tool
	return nil, nil
}

func runKey(win *mygo.Window, id string) string {
	n := 0
	if win != nil {
		n = win.ID()
	}
	return fmt.Sprintf("%d/%s", n, id)
}

// run 运行一段代码，输出作为事件发回调用它的那个窗口。
func (h *pluginHost) run(ctx context.Context, id string, req map[string]any, runID string, win *mygo.Window) error {
	lang, _ := req["lang"].(string)
	code, _ := req["code"].(string)
	stdin, _ := req["stdin"].(string)
	seconds, _ := req["timeout"].(float64)
	l, ok := runner.Find(lang)
	if !ok {
		return errors.New("不认识的语言：" + lang)
	}
	timeout := time.Duration(seconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	key := runKey(win, id)
	h.mu.Lock()
	if prev := h.running[key]; prev != nil {
		prev()
	}
	h.running[key] = cancel
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.running, key)
		h.mu.Unlock()
	}()
	return runner.Run(ctx, l, code, stdin, filepath.Join(h.a.paths.Cache, "scratch"), min(timeout, 10*time.Minute), func(e runner.Event) {
		if win != nil && !win.IsDestroyed() {
			_ = PluginEvent.Emit(win, PluginEventData{Plugin: id, Name: "run", Data: map[string]any{"id": runID, "event": e}})
		}
	})
}

func (h *pluginHost) fs(ctx context.Context, m providers.Manifest, id, name string, args callArgs, win *mygo.Window) (any, error) {
	a := h.a
	// 对话框选出来的文件不在任何目录里，单独处理。
	switch name {
	case "pick":
		if !m.Permissions.Files {
			return nil, errPermission
		}
		opts := mygo.OpenDialogOptions{Parent: win}
		if exts := toStrings(args, 0); len(exts) > 0 {
			opts.Filters = []mygo.FileFilter{{Name: "文件", Extensions: exts}}
		}
		a.blurPaused.Store(true)
		files, err := mygo.Dialog.Open(opts)
		a.blurPaused.Store(false)
		if err != nil || len(files) == 0 {
			return nil, err
		}
		info, err := os.Stat(files[0])
		if err != nil {
			return nil, err
		}
		if info.Size() > 8<<20 {
			return nil, errors.New("文件太大了（超过 8 MB）")
		}
		data, err := os.ReadFile(files[0])
		if err != nil {
			return nil, err
		}
		out := map[string]any{"name": filepath.Base(files[0]), "path": files[0]}
		if utf8.Valid(data) {
			out["text"] = string(data)
		} else {
			out["base64"] = base64.StdEncoding.EncodeToString(data)
		}
		return out, nil
	case "saveAs":
		if !m.Permissions.Files {
			return nil, errPermission
		}
		a.blurPaused.Store(true)
		target, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: win, DefaultPath: filepath.Base(args.str(0))})
		a.blurPaused.Store(false)
		if err != nil || target == "" {
			return "", err
		}
		return target, os.WriteFile(target, []byte(args.str(1)), 0o644)
	}

	s, err := h.fsStore(m, id, args.str(0))
	if err != nil {
		return nil, err
	}
	// 同一个扩展可能同时开着几个页面（主窗口里一个、独立窗口里一个），
	// 文件变了就广播一声，其他页面跟着刷新，不会各改各的。
	changed := func(op, path, to string, err error) error {
		if err == nil {
			_ = PluginEvent.Broadcast(PluginEventData{Plugin: id, Name: "fs", Data: map[string]any{"root": args.str(0), "op": op, "path": path, "to": to}})
		}
		return err
	}
	switch name {
	case "tree":
		return s.Tree()
	case "read":
		return s.Read(args.str(1))
	case "write":
		return nil, changed("write", args.str(1), "", s.Write(args.str(1), args.str(2)))
	case "createFile":
		p, err := s.CreateFile(args.str(1), args.str(2), args.str(3))
		return p, changed("create", p, "", err)
	case "createFolder":
		p, err := s.CreateFolder(args.str(1), args.str(2))
		return p, changed("create", p, "", err)
	case "rename":
		p, err := s.Rename(args.str(1), args.str(2))
		return p, changed("rename", args.str(1), p, err)
	case "move":
		p, err := s.Move(args.str(1), args.str(2))
		return p, changed("rename", args.str(1), p, err)
	case "delete":
		return nil, changed("delete", args.str(1), "", trash(s, args.str(1)))
	case "abs":
		if strings.TrimSpace(args.str(1)) == "" {
			return filepath.Clean(s.Dir), nil
		}
		return s.Abs(args.str(1))
	case "reveal", "open", "openWith":
		if strings.TrimSpace(args.str(1)) == "" {
			if _, err := s.Tree(); err != nil { // 顺便保证目录存在
				return nil, err
			}
			return nil, openPath(s.Dir)
		}
		abs, err := s.Abs(args.str(1))
		if err != nil {
			return nil, err
		}
		switch name {
		case "reveal":
			a.host.Reveal(abs)
		case "open":
			return nil, openPath(abs)
		default:
			return nil, openWith(abs)
		}
		return nil, nil
	}
	return nil, fmt.Errorf("不支持的调用：fs.%s", name)
}

func toStrings(args callArgs, i int) []string {
	if i >= len(args) {
		return nil
	}
	list, _ := args[i].([]any)
	var out []string
	for _, v := range list {
		if s, ok := v.(string); ok {
			out = append(out, strings.TrimPrefix(s, "."))
		}
	}
	return out
}

// fetch 替扩展发一个网络请求：页面里直接发会被跨域规则拦住。只能访问清单里声明的域名。
func (h *pluginHost) fetch(ctx context.Context, m providers.Manifest, target string, opts map[string]any) (any, error) {
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, errors.New("只能请求 http / https 地址")
	}
	host := strings.ToLower(u.Hostname())
	if !fetchAllowed(m.Permissions.Fetch, host) {
		return nil, fmt.Errorf("这个扩展没有声明要访问 %s", host)
	}
	method, _ := opts["method"].(string)
	if method == "" {
		method = http.MethodGet
	}
	body, _ := opts["body"].(string)
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(method), target, strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	if hs, ok := opts["headers"].(map[string]any); ok {
		for k, v := range hs {
			if s, ok := v.(string); ok {
				req.Header.Set(k, s)
			}
		}
	}
	client := tts.HTTPClient // 走系统代理
	if isPrivateHost(host) {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	headers := map[string]string{}
	for k := range resp.Header {
		headers[strings.ToLower(k)] = resp.Header.Get(k)
	}
	out := map[string]any{"status": resp.StatusCode, "ok": resp.StatusCode >= 200 && resp.StatusCode < 300, "headers": headers}
	if utf8.Valid(data) {
		out["text"] = string(data)
	} else {
		out["base64"] = base64.StdEncoding.EncodeToString(data)
	}
	return out, nil
}

func isPrivateHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified())
}

// fetchAllowed 判断域名在不在允许的名单里。"*" 只放行公网地址；本机和内网地址必须写明。
func fetchAllowed(allow []string, host string) bool {
	for _, a := range allow {
		a = strings.ToLower(strings.TrimSpace(a))
		switch {
		case a == host:
			return true
		case a == "*" && !isPrivateHost(host):
			return true
		case strings.HasPrefix(a, "*.") && strings.HasSuffix(host, a[1:]) && !isPrivateHost(host):
			return true
		}
	}
	return false
}

// --- 悬浮窗 ---

func floatKey(plugin, tool string) string { return plugin + "/" + tool }

// toggleFloat 打开一个悬浮窗工具；已经开着就收起来。
func (h *pluginHost) toggleFloat(plugin, tool string) error {
	key := floatKey(plugin, tool)
	h.mu.Lock()
	w := h.floats[key]
	h.mu.Unlock()
	if w != nil && !w.IsDestroyed() {
		h.closeFloat(key, true)
		return nil
	}
	return h.openFloat(plugin, tool)
}

func (h *pluginHost) openFloat(plugin, tool string) error {
	a := h.a
	t, ok := a.plugins.ToolOf(plugin, tool)
	if !ok || t.Window != "float" {
		return errors.New("没有这个悬浮窗工具")
	}
	view, _ := a.plugins.ViewOf(plugin, t.ID)
	key := floatKey(plugin, t.ID)
	h.mu.Lock()
	if w := h.floats[key]; w != nil && !w.IsDestroyed() {
		h.mu.Unlock()
		return nil
	}
	h.mu.Unlock()
	w, hgt := t.Width, t.Height
	if w <= 0 {
		w = 240
	}
	if hgt <= 0 {
		hgt = 260
	}
	wa := mygo.Screen.PrimaryDisplay().WorkArea
	q := url.Values{"p": {plugin}, "t": {t.ID}, "u": {view.URL}}
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: t.Title, URL: "/float.html?" + q.Encode(), Width: w, Height: hgt,
		X: max(wa.X, wa.X+wa.Width-w-60), Y: max(wa.Y, wa.Y+wa.Height-hgt-10),
		Hidden: true, Frameless: true, Transparent: true, AlwaysOnTop: true, SkipTaskbar: true, DisableShadow: true,
		MinWidth: 60, MinHeight: 60, StateKey: "float-" + plugin + "-" + t.ID,
	})
	win.SetResizable(false)
	h.mu.Lock()
	h.floats[key] = win
	h.mu.Unlock()
	win.OnReadyToShow(func() {
		win.ShowInactive()
	})
	win.OnClosed(func() {
		h.mu.Lock()
		if h.floats[key] == win {
			delete(h.floats, key)
		}
		h.mu.Unlock()
	})
	h.remember(key, true)
	return nil
}

// closeFloat 关掉一个悬浮窗。forget 为真时下次启动不再自动打开它。
func (h *pluginHost) closeFloat(key string, forget bool) {
	h.mu.Lock()
	w := h.floats[key]
	delete(h.floats, key)
	h.mu.Unlock()
	if forget {
		h.remember(key, false)
	}
	if w != nil && !w.IsDestroyed() {
		w.Close()
	}
}

// remember 记下哪些悬浮窗开着：下次启动时恢复。
func (h *pluginHost) remember(key string, open bool) {
	a := h.a
	a.stateMu.Lock()
	list := slices.DeleteFunc(a.state.Floats, func(k string) bool { return k == key })
	if open {
		list = append(list, key)
	}
	a.state.Floats = list
	a.stateMu.Unlock()
	a.saveStateSoon()
}

// restoreFloats 在启动时把上次开着的悬浮窗打开。扩展没了或被停用的就忘掉。
func (h *pluginHost) restoreFloats() {
	a := h.a
	a.stateMu.Lock()
	keys := slices.Clone(a.state.Floats)
	a.stateMu.Unlock()
	for _, key := range keys {
		plugin, tool, _ := strings.Cut(key, "/")
		if err := h.openFloat(plugin, tool); err != nil {
			h.remember(key, false)
		}
	}
}

// stop 关掉一个扩展的悬浮窗和后端进程（停用、卸载、升级之前）。
func (h *pluginHost) stop(plugin string, forget bool) {
	h.mu.Lock()
	var keys []string
	for key := range h.floats {
		if strings.HasPrefix(key, plugin+"/") {
			keys = append(keys, key)
		}
	}
	back := h.backs[plugin]
	delete(h.backs, plugin)
	h.mu.Unlock()
	for _, key := range keys {
		h.closeFloat(key, forget)
	}
	if back != nil {
		back.stop()
	}
}

// stopAll 在退出时关掉全部后端进程。
func (h *pluginHost) stopAll() {
	h.mu.Lock()
	backs := h.backs
	h.backs = map[string]*backendProc{}
	h.mu.Unlock()
	for _, b := range backs {
		b.stop()
	}
}

// window 是悬浮窗自己能做的事：挪动、改大小、关掉。只对这个扩展自己的悬浮窗有效。
func (h *pluginHost) window(plugin, name string, args callArgs, win *mygo.Window) (any, error) {
	if win == nil {
		return nil, errors.New("找不到窗口")
	}
	h.mu.Lock()
	key := ""
	for k, w := range h.floats {
		if w == win && strings.HasPrefix(k, plugin+"/") {
			key = k
		}
	}
	h.mu.Unlock()
	if key == "" {
		return nil, errors.New("只有悬浮窗能调这个接口")
	}
	x, y := win.Position()
	ww, wh := win.Size()
	area := mygo.Screen.DisplayMatching(mygo.Rectangle{X: x, Y: y, Width: ww, Height: wh}).WorkArea
	switch name {
	case "info":
		return map[string]any{"x": x, "y": y, "width": ww, "height": wh, "area": area}, nil
	case "move":
		// 挪一点（自己走动时用），不会走出屏幕。返回新位置，以及有没有碰到左右的边。
		dx, dy := int(args.num(0)), int(args.num(1))
		nx := min(max(x+dx, area.X-ww/4), area.X+area.Width-ww+ww/4)
		ny := min(max(y+dy, area.Y), area.Y+area.Height-wh)
		if nx != x || ny != y {
			win.SetPosition(nx, ny)
		}
		return map[string]any{"x": nx, "y": ny, "hit": nx != x+dx}, nil
	case "ground":
		// 离屏幕底部还有多远（被拖到半空松手后往下掉）。
		return area.Y + area.Height - wh - y, nil
	case "resize":
		// 改大小，底边中点的位置不动。
		nw, nh := max(int(args.num(0)), 60), max(int(args.num(1)), 60)
		if nw != ww || nh != wh {
			win.SetBounds(mygo.Rectangle{X: x - (nw-ww)/2, Y: y - (nh - wh), Width: nw, Height: nh})
		}
	case "dragStart":
		h.mu.Lock()
		h.drag[win.ID()] = mygo.Point{X: x, Y: y}
		h.mu.Unlock()
	case "dragMove":
		h.mu.Lock()
		origin, ok := h.drag[win.ID()]
		h.mu.Unlock()
		if ok {
			win.SetPosition(origin.X+int(args.num(0)), origin.Y+int(args.num(1)))
		}
	case "setAlwaysOnTop":
		win.SetAlwaysOnTop(args.boolean(0))
	case "close":
		h.closeFloat(key, true)
	default:
		return nil, fmt.Errorf("不支持的调用：window.%s", name)
	}
	return nil, nil
}

// --- 安装、卸载、启停 ---

// Extensions 是道具库里管理扩展的服务。
type Extensions struct {
	a         *App
	installMu sync.Mutex
	dlMu      sync.Mutex
	dlActive  map[string]bool
	storeMu   sync.Mutex
	lastReg   *providers.ExtensionRegistry
}

// InstallFailure 记录批量安装或更新中失败的一项。
type InstallFailure struct {
	Source string `json:"source"`
	Name   string `json:"name"`
	Error  string `json:"error"`
}

// BatchInstallResult 描述一次批量安装 / 更新的结果。
type BatchInstallResult struct {
	Installed []providers.PluginInfo `json:"installed"`
	Failed    []InstallFailure       `json:"failed,omitempty"`
}

// List 返回全部扩展。
func (e *Extensions) List() []providers.PluginInfo {
	list := e.a.plugins.List()
	for i := range list {
		if e.a.engine != nil {
			list[i].Icon = e.a.engine.NormalizeIcon(list[i].Icon)
		}
	}
	return list
}

func (e *Extensions) reload() {
	e.a.plugins.Reload()
	if e.a.config != nil && mygo.App.IsReady() {
		e.a.applyHotkeys(e.a.config.Get())
	}
	ResultsChanged.Broadcast(struct{}{})
}

// InstallDialog 让用户选一个扩展包（.zip）并安装。取消时返回 null。
func (e *Extensions) InstallDialog(ctx context.Context) (*providers.PluginInfo, error) {
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "选择扩展包", Filters: []mygo.FileFilter{{Name: "扩展包", Extensions: []string{"zip"}}}})
	if err != nil || len(files) == 0 {
		return nil, err
	}
	return e.Install(files[0])
}

// InstallDialogMany 让用户选择一个或多个扩展包（.zip）并批量安装。取消时返回 null。
func (e *Extensions) InstallDialogMany(ctx context.Context) (*BatchInstallResult, error) {
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:   mygo.CallerWindow(ctx),
		Title:    "选择扩展包（支持多选）",
		Multiple: true,
		Filters:  []mygo.FileFilter{{Name: "扩展包", Extensions: []string{"zip"}}},
	})
	if err != nil || len(files) == 0 {
		return nil, err
	}
	res := e.InstallMany(files)
	return &res, nil
}

const (
	maxPackageFiles = 8000
	maxPackageBytes = 400 << 20
)

// Install 安装一个扩展包：zip 文件，或者已经解开的文件夹。同名的扩展会被替换（升级），它的数据保留。
func (e *Extensions) Install(source string) (*providers.PluginInfo, error) {
	e.installMu.Lock()
	defer e.installMu.Unlock()

	id, err := e.installOneLocked(source)
	if err != nil {
		return nil, err
	}
	e.reload()
	if e.a.pluginHost != nil {
		e.a.pluginHost.restoreFloats()
	}
	for _, p := range e.List() {
		if p.ID == id {
			return &p, nil
		}
	}
	return nil, errors.New("安装后没有找到这个扩展")
}

// InstallMany 顺序批量安装多个扩展包（zip 或文件夹），全部处理完后统一重载一次。
func (e *Extensions) InstallMany(sources []string) BatchInstallResult {
	var unique []string
	seen := map[string]bool{}
	for _, src := range sources {
		s := strings.TrimSpace(src)
		if s == "" {
			continue
		}
		clean := filepath.Clean(s)
		if seen[clean] {
			continue
		}
		seen[clean] = true
		unique = append(unique, clean)
	}

	e.installMu.Lock()
	defer e.installMu.Unlock()

	var result BatchInstallResult
	var installedIDs []string
	idSeen := map[string]bool{}
	for _, src := range unique {
		id, err := e.installOneLocked(src)
		if err != nil {
			result.Failed = append(result.Failed, InstallFailure{
				Source: src,
				Name:   filepath.Base(src),
				Error:  err.Error(),
			})
			continue
		}
		if !idSeen[id] {
			idSeen[id] = true
			installedIDs = append(installedIDs, id)
		}
	}

	if len(installedIDs) > 0 {
		e.reload()
		if e.a.pluginHost != nil {
			e.a.pluginHost.restoreFloats()
		}
		byID := map[string]providers.PluginInfo{}
		for _, p := range e.List() {
			byID[p.ID] = p
		}
		for _, id := range installedIDs {
			if p, ok := byID[id]; ok {
				result.Installed = append(result.Installed, p)
			}
		}
	}
	return result
}

func (e *Extensions) installOneLocked(source string) (string, error) {
	a := e.a
	if err := os.MkdirAll(a.paths.Plugins, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(a.paths.Plugins, ".install-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	info, err := os.Stat(source)
	if err != nil {
		return "", errors.New("找不到这个扩展包")
	}
	if info.IsDir() {
		if err := os.CopyFS(tmp, os.DirFS(source)); err != nil {
			return "", err
		}
	} else if err := unzip(source, tmp); err != nil {
		return "", err
	}
	// 压缩包里可能多套了一层文件夹。
	root := tmp
	if _, err := os.Stat(filepath.Join(root, "plugin.json")); err != nil {
		entries, _ := os.ReadDir(tmp)
		if len(entries) == 1 && entries[0].IsDir() {
			root = filepath.Join(tmp, entries[0].Name())
		}
	}
	m, _, err := providers.ReadManifest(root, strings.ToLower(strings.TrimSuffix(filepath.Base(source), filepath.Ext(source))))
	if err != nil {
		return "", fmt.Errorf("这不是一个能用的扩展包：%v", err)
	}
	if a.pluginHost != nil {
		if err := a.pluginHost.stopPeer(m.ID); err != nil {
			return "", err
		}
		a.pluginHost.stop(m.ID, false)
	}
	target := filepath.Join(a.paths.Plugins, m.ID)
	if err := os.RemoveAll(target); err != nil {
		return "", err
	}
	if err := os.Rename(root, target); err != nil {
		return "", err
	}
	return m.ID, nil
}

// unzip 解开压缩包。文件名里带 .. 或绝对路径的直接拒绝。
func unzip(file, dest string) error {
	r, err := zip.OpenReader(file)
	if err != nil {
		return errors.New("这不是一个 zip 文件")
	}
	defer r.Close()
	if len(r.File) > maxPackageFiles {
		return errors.New("扩展包里的文件太多了")
	}
	var total uint64
	for _, f := range r.File {
		name := path.Clean(strings.ReplaceAll(f.Name, `\`, "/"))
		if name == "." || strings.HasPrefix(name, "__MACOSX/") || path.Base(name) == ".DS_Store" {
			continue
		}
		if path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(name, ":") {
			return errors.New("扩展包里有不安全的路径：" + f.Name)
		}
		total += f.UncompressedSize64
		if total > maxPackageBytes {
			return errors.New("扩展包太大了")
		}
		out := filepath.Join(dest, filepath.FromSlash(name))
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
			continue
		}
		if f.Mode()&os.ModeSymlink != 0 {
			continue // 不解链接：它可以指到扩展目录外面去
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		src, err := f.Open()
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if f.Mode()&0o111 != 0 {
			mode = 0o755 // 后端程序要能执行
		}
		dst, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err == nil {
			_, err = io.Copy(dst, io.LimitReader(src, int64(maxPackageBytes)))
			if cerr := dst.Close(); err == nil {
				err = cerr
			}
		}
		src.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// Uninstall 卸载一个扩展：关掉它的窗口和进程，删掉它的文件夹。removeData 为真时连它存的设置和私有文件一起删；
// 它在用户目录里声明的文件夹（比如笔记）不会动。
func (e *Extensions) Uninstall(id string, removeData bool) error {
	a := e.a
	if !providers.ValidPluginID(id) {
		return errors.New("扩展的 ID 不对")
	}
	if err := a.pluginHost.stopPeer(id); err != nil {
		return err
	}
	a.pluginHost.stop(id, true)
	if err := os.RemoveAll(filepath.Join(a.paths.Plugins, id)); err != nil {
		return err
	}
	if removeData {
		_ = os.Remove(a.pluginStoragePath(id))
		_ = os.RemoveAll(filepath.Join(a.paths.Data, "plugins", id+"-files"))
	}
	_ = a.config.Update(func(c *store.Config) {
		c.DisabledPlugins = slices.DeleteFunc(c.DisabledPlugins, func(x string) bool { return x == id })
		for key := range c.Hotkeys {
			if key == "plugins:"+id || strings.HasPrefix(key, "plugins:"+id+"/") {
				delete(c.Hotkeys, key)
				delete(c.DetachOnHotkey, key)
				delete(c.HotkeyInput, key)
			}
		}
	})
	e.reload()
	return nil
}

// SetEnabled 启用或停用一个扩展。停用后它不出现在搜索里，快捷键注销，窗口和后端进程都关掉。
func (e *Extensions) SetEnabled(id string, enabled bool) error {
	a := e.a
	if !enabled {
		if err := a.pluginHost.stopPeer(id); err != nil {
			return err
		}
	}
	err := a.config.Update(func(c *store.Config) {
		c.DisabledPlugins = slices.DeleteFunc(c.DisabledPlugins, func(x string) bool { return x == id })
		if !enabled {
			c.DisabledPlugins = append(c.DisabledPlugins, id)
		}
	})
	if err != nil {
		return err
	}
	if !enabled {
		a.pluginHost.stop(id, false)
	}
	e.reload()
	if enabled {
		a.pluginHost.restoreFloats()
	}
	return nil
}

// Reveal 在文件管理器里打开扩展的文件夹；id 为空时打开放扩展的总目录。
func (e *Extensions) Reveal(id string) error {
	if id == "" {
		_ = os.MkdirAll(e.a.paths.Plugins, 0o755)
		return openPath(e.a.paths.Plugins)
	}
	if !providers.ValidPluginID(id) {
		return errors.New("扩展的 ID 不对")
	}
	return openPath(filepath.Join(e.a.paths.Plugins, id))
}
