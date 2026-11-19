package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/store"
)

func launchApp(path string) error {
	if path == "" {
		return errors.New("应用路径为空")
	}
	if runtime.GOOS == "windows" {
		return platform.ShellOpen("", path)
	}
	return mygo.Shell.LaunchApp(mygo.InstalledApp{Path: path})
}

func openPath(p string) error {
	if runtime.GOOS == "windows" {
		return platform.ShellOpen("open", p)
	}
	return mygo.Shell.OpenPath(p)
}

func openExternal(rawURL string) error {
	if runtime.GOOS == "windows" {
		return platform.ShellOpen("open", rawURL)
	}
	return mygo.Shell.OpenExternal(rawURL)
}

func platformPaste() error { return platform.SendPaste() }

// openWith 让用户选一个应用来打开文件。
func openWith(p string) error {
	switch runtime.GOOS {
	case "windows":
		return platform.DetachedCommand("rundll32.exe", "shell32.dll,OpenAs_RunDLL", p).Start()
	case "darwin":
		apps, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Title: "选择用来打开的应用", DefaultPath: "/Applications", Filters: []mygo.FileFilter{{Name: "应用", Extensions: []string{"app"}}}})
		if err != nil || len(apps) == 0 {
			return err
		}
		return platform.DetachedCommand("open", "-a", apps[0], p).Start()
	}
	return openPath(p)
}

// host 实现 core.Host：引擎需要的系统能力。
type host struct{ a *App }

func (h *host) OpenTarget(t string) error {
	if strings.Contains(t, "://") || strings.HasPrefix(t, "mailto:") {
		return openExternal(t)
	}
	return openPath(platform.ExpandHome(t))
}
func (h *host) Reveal(p string)   { mygo.Shell.ShowItemInFolder(platform.ExpandHome(p)) }
func (h *host) CopyText(t string) { mygo.Clipboard.WriteText(t) }
func (h *host) CopyImageFile(p string) error {
	data, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return mygo.Clipboard.WriteImage(data)
}
func (h *host) CopyFiles(paths []string) error { return mygo.Clipboard.WriteFiles(paths...) }
func (h *host) ReadClipboardText() string      { return mygo.Clipboard.ReadText() }
func (h *host) PasteToFront() error            { return platform.SendPaste() }
func (h *host) TypeToFront(t string) error     { return platform.SendText(t) }
func (h *host) HidePanel()                     { h.a.hidePanel() }
func (h *host) OpenSettings(section, arg string) {
	h.a.openSettings(section, arg)
}

func (h *host) Notify(title, body string) {
	go func() {
		n := mygo.NewNotification(mygo.NotificationOptions{Title: title, Body: body})
		if err := n.Show(); err != nil {
			log.Printf("[ERROR] 通知失败（%s：%s）：%v", title, body, err)
		}
	}()
}

func (h *host) EditFile(p string) error {
	if editor := h.a.config.Get().Editor; editor != "" {
		parts := strings.Fields(editor)
		cmd := platform.DetachedCommand(parts[0], append(parts[1:], p)...)
		cmd.Dir = platform.WorkDir(p)
		return cmd.Start()
	}
	return platform.OpenInEditor(p)
}

// clipSource 从系统剪贴板读取内容。
type clipSource struct{}

func (clipSource) ReadText() string             { return mygo.Clipboard.ReadText() }
func (clipSource) ReadImage() []byte            { return mygo.Clipboard.ReadImage() }
func (clipSource) ReadFiles() ([]string, error) { return mygo.Clipboard.ReadFiles() }
func (clipSource) HasImage() bool {
	return slices.Contains(mygo.Clipboard.Formats(), transfer.PNG)
}

// --- 自定义协议 ---

// schemeURL 生成自定义协议的地址。WebView2 把自定义协议放在 http://<scheme>.localhost 下，
// 带子域名时是 http://<host>.<scheme>.localhost。
func schemeURL(scheme, host, pathAndQuery string) string {
	if runtime.GOOS == "windows" {
		if host == "" || host == "localhost" {
			return "http://" + scheme + ".localhost" + pathAndQuery
		}
		return "http://" + host + "." + scheme + ".localhost" + pathAndQuery
	}
	if host == "" {
		host = "localhost"
	}
	return scheme + "://" + host + pathAndQuery
}

func iconURL(kind, p string) string {
	return schemeURL("pocketicon", "", "/"+kind+"?path="+url.QueryEscape(p))
}

// pluginURL 生成扩展页面的地址。
func (a *App) pluginURL(id, main string) string {
	p := "/" + strings.TrimPrefix(path.Clean("/"+filepath.ToSlash(main)), "/")
	return schemeURL("pocketplugin", id, p)
}

var imageExts = []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".bmp", ".heic", ".tiff", ".icns"}

func (a *App) registerProtocols() {
	if err := mygo.Protocol.HandleFunc("pocketicon", a.serveIcon); err != nil {
		log.Printf("[ERROR] 注册协议失败：%v", err)
	}
	if err := mygo.Protocol.HandleFunc("pocketplugin", a.servePlugin); err != nil {
		log.Printf("[ERROR] 注册协议失败：%v", err)
	}
}

// iconLocks 同一个图标只画一次。
var iconLocks sync.Map

// serveIcon 提供系统图标（/file）和图片文件（/image）。
func (a *App) serveIcon(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		http.NotFound(w, r)
		return
	}
	switch r.URL.Path {
	case "/image":
		// 只提供图片：这个协议不是通用的文件读取接口。
		if !slices.Contains(imageExts, strings.ToLower(filepath.Ext(p))) {
			http.Error(w, "not an image", http.StatusForbidden)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, p)
	case "/file":
		data, err := a.fileIcon(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "max-age=3600")
		_, _ = w.Write(data)
	default:
		http.NotFound(w, r)
	}
}

const iconPixels = 96

func (a *App) fileIcon(p string) ([]byte, error) {
	key := p
	if info, err := os.Stat(p); err == nil {
		key += "|" + info.ModTime().String()
	}
	sum := sha1.Sum([]byte(key))
	name := hex.EncodeToString(sum[:])
	dir := filepath.Join(a.paths.Cache, "icons")
	cached := filepath.Join(dir, name+".png")
	if data, err := os.ReadFile(cached); err == nil {
		return data, nil
	}
	lock, _ := iconLocks.LoadOrStore(name, &sync.Mutex{})
	mu := lock.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	if data, err := os.ReadFile(cached); err == nil {
		return data, nil
	}
	data, err := mygo.Shell.FileIcon(p, iconPixels)
	if err != nil {
		return nil, err
	}
	_ = os.MkdirAll(dir, 0o755)
	_ = store.WriteFileAtomic(cached, data)
	return data, nil
}

// pluginRuntime 是扩展页面里的 window.pocket。扩展跑在 iframe 里，只能用这里列出的能力：
// 请求经由宿主页面转发给后端，后端按清单里声明的权限放行。
const pluginRuntime = `(() => {
  let seq = 0;
  let context = null;
  let resolveReady;
  const pending = new Map();
  const listeners = {};
  const ready = new Promise((r) => (resolveReady = r));
  const post = (msg) => window.parent.postMessage(msg, "*");
  const emit = (name, data) => (listeners[name] || []).slice().forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
  const on = (name, fn) => {
    (listeners[name] = listeners[name] || []).push(fn);
    return () => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); };
  };
  // 外观跟着宿主走：把宿主页面上的主题属性和 CSS 变量原样搬过来。
  const applyTheme = (t) => {
    if (!t) return;
    const el = document.documentElement;
    for (const [k, v] of Object.entries(t.attrs || {})) el.setAttribute(k, v);
    if (typeof t.style === "string") el.style.cssText = t.style;
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data) return;
    const d = e.data;
    if (d.__pocketReply === true) {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.error ? p.reject(new Error(d.error)) : p.resolve(d.result);
    } else if (d.__pocketEvent) {
      if (d.__pocketEvent === "theme") applyTheme(d.data);
      if (d.__pocketEvent === "enter") { context = Object.assign({}, context, d.data); pocket.context = context; }
      emit(d.__pocketEvent, d.data);
    } else if (d.__pocketEval && context && context.e2e) {
      // 只在测试构建里：让端到端测试能看到页面里面。
      Promise.resolve().then(() => (0, eval)(d.code)).then(
        (result) => post({ __pocketEvalReply: true, id: d.id, result }),
        (err) => post({ __pocketEvalReply: true, id: d.id, error: String(err) }),
      );
    }
  });
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    post({ __pocket: true, id, method, args });
  });
  // 串行发送 setStorage：后端每次 IPC 调用在独立 goroutine 里执行，排队发送保证同一页面连续写入时顺序不乱。
  let storageQueue = Promise.resolve();
  const setStorageQueued = (key, value) => {
    const next = storageQueue.then(() => call("setStorage", String(key), value));
    storageQueue = next.catch(() => {});
    return next;
  };
  // Esc 返回（仅主窗口面板有效，独立窗口按 Esc 不关闭）、分离窗口快捷键：页面自己没处理时才交给宿主。
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === "Escape") {
      if (context && (context.detached || context.float)) return;
      e.preventDefault();
      post({ __pocket: true, method: "back" });
      return;
    }
    const k = context && context.detachKey;
    if (k && e.key.toLowerCase() === k.key && !!k.mod === (e.metaKey || e.ctrlKey) && !!k.shift === e.shiftKey && !!k.alt === e.altKey) {
      e.preventDefault();
      post({ __pocket: true, method: "ui.detach" });
    }
  });
  // Ctrl + 滚轮：WebView 默认会缩放整个页面，拦掉。扩展想用它调字号可以自己处理这个事件。
  window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false, capture: true });
  const pocket = (window.pocket = {
    api: 2,
    context: null,
    ready,
    call,
    on,
    onEnter(fn) { const off = on("enter", fn); if (context) fn(context); return off; },
    // 老接口，保留。
    copyText: (text) => call("copyText", String(text)),
    readClipboard: () => call("readClipboard"),
    readClipboardImage: () => call("readClipboardImage"),
    pasteText: (text) => call("pasteText", String(text)),
    openExternal: (url) => call("openExternal", String(url)),
    notify: (title, body) => call("notify", String(title), String(body ?? "")),
    hide: () => call("hide"),
    getStorage: (key) => call("getStorage", String(key)),
    setStorage: setStorageQueued,
    ui: {
      toast: (text, error) => call("ui.toast", String(text), !!error),
      copy: (text, label) => call("ui.copy", String(text), label),
      close: () => call("ui.close"),
      detach: () => call("ui.detach"),
      remember: (value) => call("ui.remember", String(value ?? "")),
    },
    storage: { get: (key) => call("getStorage", String(key)), set: setStorageQueued },
    fs: {
      tree: (root = "") => call("fs.tree", root),
      read: (root, path) => call("fs.read", root, path),
      write: (root, path, content) => call("fs.write", root, path, content),
      createFile: (root, dir, name, content = "") => call("fs.createFile", root, dir, name, content),
      writeBinary: (root, dir, name, base64) => call("fs.writeBinary", root, dir, name, base64),
      assetUrl: (root, path) => call("fs.assetUrl", root, path),
      createFolder: (root, dir, name) => call("fs.createFolder", root, dir, name),
      rename: (root, path, name) => call("fs.rename", root, path, name),
      move: (root, path, dir) => call("fs.move", root, path, dir),
      delete: (root, path) => call("fs.delete", root, path),
      reveal: (root, path = "") => call("fs.reveal", root, path),
      abs: (root, path = "") => call("fs.abs", root, path),
      open: (root, path) => call("fs.open", root, path),
      openWith: (root, path) => call("fs.openWith", root, path),
      pick: (exts = []) => call("fs.pick", exts),
      saveAs: (name, content) => call("fs.saveAs", name, content),
    },
    fetch: (url, options = {}) => call("fetch", String(url), options),
    runner: {
      languages: () => call("runner.languages"),
      format: (lang, code) => call("runner.format", lang, code),
      stop: () => call("runner.stop"),
      run(request, onEvent) {
        const id = Date.now() + "-" + ++seq;
        const off = on("run", (d) => { if (d && d.id === id && onEvent) onEvent(d.event); });
        return call("runner.run", request, id).finally(off);
      },
    },
    window: {
      info: () => call("window.info"),
      move: (dx, dy) => call("window.move", dx, dy),
      ground: () => call("window.ground"),
      resize: (width, height) => call("window.resize", width, height),
      dragStart: () => call("window.dragStart"),
      dragMove: (dx, dy) => call("window.dragMove", dx, dy),
      setAlwaysOnTop: (on) => call("window.setAlwaysOnTop", !!on),
      close: () => call("window.close"),
    },
    backend: {
      call: (method, ...params) => call("backend.call", method, ...params),
      on: (fn) => on("backend", fn),
    },
  });
  call("init").then((c) => {
    context = c;
    pocket.context = c;
    applyTheme(c.theme);
    resolveReady(c);
    emit("enter", c);
  });
})();`

// setPluginCORS 只对当前被请求扩展自身的源（pocketplugin://<id> 或 http://<id>.pocketplugin.localhost[:port]）开放跨域读取，
// 供构建工具生成的 <script type="module" crossorigin> 和 <link rel="stylesheet" crossorigin> 使用，拒绝其他扩展或外部站点。
func setPluginCORS(w http.ResponseWriter, r *http.Request, id string) {
	origin := r.Header.Get("Origin")
	if origin == "" || id == "" {
		return
	}
	u, err := url.Parse(origin)
	if err != nil {
		return
	}
	host := strings.ToLower(u.Hostname())
	if (u.Scheme == "pocketplugin" && host == id) || (u.Scheme == "http" && host == id+".pocketplugin.localhost") {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
}

// servePlugin 提供插件的文件。地址的 host 部分是插件 ID。
func (a *App) servePlugin(w http.ResponseWriter, r *http.Request) {
	id := strings.ToLower(r.URL.Hostname())
	if id == "" {
		id = strings.ToLower(r.Host)
	}
	if h, _, err := net.SplitHostPort(id); err == nil {
		id = h
	}
	id = strings.TrimSuffix(id, ".pocketplugin.localhost")
	setPluginCORS(w, r, id)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	dir, ok := a.plugins.DirOf(id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if r.URL.Path == "/__pocket.js" {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(pluginRuntime))
		return
	}
	root, err := os.OpenRoot(dir) // os.Root 保证路径逃不出插件目录，符号链接也不行
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	f, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	// 不用 mygo.FileServer：它和 http.FileServer 一样会把 /index.html 重定向到 /，
	// 而自定义协议的 iframe 不跟随重定向，页面会是空白。
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, name, info.ModTime(), f)
}

// --- 插件存储 ---

func (a *App) pluginStoragePath(id string) string {
	return filepath.Join(a.paths.Data, "plugins", id+".json")
}

var pluginStorageMu sync.Mutex

func (a *App) pluginStorageGet(id, key string) (any, error) {
	pluginStorageMu.Lock()
	defer pluginStorageMu.Unlock()
	values := map[string]any{}
	raw, err := os.ReadFile(a.pluginStoragePath(id))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("插件数据已损坏：%w", err)
	}
	return values[key], nil
}

func (a *App) pluginStorageSet(id, key string, value any) error {
	pluginStorageMu.Lock()
	defer pluginStorageMu.Unlock()
	values := map[string]any{}
	path := a.pluginStoragePath(id)
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &values)
	}
	values[key] = value
	raw, err := json.Marshal(values)
	if err != nil {
		return err
	}
	if len(raw) > 4<<20 {
		return errors.New("插件数据超过 4 MB 上限")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return store.WriteFileAtomic(path, raw)
}
