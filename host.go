package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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

// host 实现 core.Host：引擎需要的系统能力。
type host struct{ a *App }

func (h *host) OpenTarget(t string) error {
	if strings.Contains(t, "://") || strings.HasPrefix(t, "mailto:") {
		return mygo.Shell.OpenExternal(t)
	}
	return mygo.Shell.OpenPath(platform.ExpandHome(t))
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
			log.Printf("通知失败（%s：%s）：%v", title, body, err)
		}
	}()
}

func (h *host) EditFile(p string) error {
	if editor := h.a.config.Get().Editor; editor != "" {
		parts := strings.Fields(editor)
		cmd := platform.Command(ctxBackground(), parts[0], append(parts[1:], p)...)
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

func pluginURL(id, main string) string {
	return schemeURL("pocketplugin", id, "/"+strings.TrimPrefix(path.Clean("/"+filepath.ToSlash(main)), "/"))
}

var imageExts = []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".heic", ".tiff", ".icns"}

func (a *App) registerProtocols() {
	if err := mygo.Protocol.HandleFunc("pocketicon", a.serveIcon); err != nil {
		log.Printf("注册协议失败：%v", err)
	}
	if err := mygo.Protocol.HandleFunc("pocketplugin", a.servePlugin); err != nil {
		log.Printf("注册协议失败：%v", err)
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

// pluginRuntime 是插件页面里的 window.pocket。插件跑在 iframe 里，只能用这里列出的能力，
// 请求经由主页面转发给后端，后端按插件 ID 隔离存储。
const pluginRuntime = `(() => {
  let seq = 0;
  const pending = new Map();
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.__pocketReply !== true) return;
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
  });
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ __pocket: true, id, method, args }, "*");
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); window.parent.postMessage({ __pocket: true, method: "back" }, "*"); }
  });
  window.pocket = {
    copyText: (text) => call("copyText", String(text)),
    readClipboard: () => call("readClipboard"),
    pasteText: (text) => call("pasteText", String(text)),
    openExternal: (url) => call("openExternal", String(url)),
    notify: (title, body) => call("notify", String(title), String(body ?? "")),
    hide: () => call("hide"),
    getStorage: (key) => call("getStorage", String(key)),
    setStorage: (key, value) => call("setStorage", String(key), value),
  };
})();`

// servePlugin 提供插件的文件。地址的 host 部分是插件 ID。
func (a *App) servePlugin(w http.ResponseWriter, r *http.Request) {
	id := strings.ToLower(r.URL.Hostname())
	if id == "" {
		id = strings.ToLower(r.Host)
	}
	id = strings.TrimSuffix(id, ".pocketplugin.localhost")
	if r.URL.Path == "/__pocket.js" {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write([]byte(pluginRuntime))
		return
	}
	dir, ok := a.plugins.DirOf(id)
	if !ok {
		http.NotFound(w, r)
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
