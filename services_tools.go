package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/store"
)

// --- 本地媒体服务 ---
//
// 视频、音频和 PDF 要能拖动进度、按范围读取，自定义协议做不到，所以在本机回环地址上开一个只读的小服务。
// 地址里带一个随机口令，只有本应用的页面知道；并且只放行能预览的文件类型和缓存目录里的文件。

type mediaServer struct {
	base  string
	port  int
	token string
	cache string
}

func (a *App) startMedia() {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return // 没有它只是不能预览音视频，不影响别的
	}
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	m := &mediaServer{
		base:  "http://" + ln.Addr().String(),
		port:  ln.Addr().(*net.TCPAddr).Port,
		token: hex.EncodeToString(raw),
		cache: a.paths.Cache,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/"+m.token+"/file", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := r.URL.Query().Get("p")
		if p == "" || !filepath.IsAbs(p) || !m.allowed(p) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, p)
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := strings.ToLower(r.Host)
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if strings.HasSuffix(host, ".pocketplugin.localhost") {
			a.servePlugin(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
	a.media = m
	go func() { _ = (&http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}).Serve(ln) }()
}

func (m *mediaServer) allowed(p string) bool {
	if rel, err := filepath.Rel(m.cache, p); err == nil && !strings.HasPrefix(rel, "..") {
		return true
	}
	return providers.MediaAllowed(p)
}

// url 返回界面可以加载的地址；服务没起来时为空。
func (m *mediaServer) url(p string) string {
	if m == nil || p == "" {
		return ""
	}
	return m.base + "/" + m.token + "/file?p=" + url.QueryEscape(p)
}

// --- 文件：高级搜索、预览和属性 ---

// Finder 是高级搜索和文件预览的服务。
type Finder struct {
	a  *App
	mu sync.Mutex
	// cancel 取消上一次还没结束的搜索；每个窗口各算各的。
	cancel map[int]context.CancelFunc
}

// FinderInfo 是高级搜索页打开时需要的东西。
type FinderInfo struct {
	Kinds   []FinderKind `json:"kinds"`
	Engine  string       `json:"engine"`
	Note    string       `json:"note"`
	Preview bool         `json:"preview"`
	Meta    bool         `json:"meta"`
	Scope   string       `json:"scope"`
	Scopes  bool         `json:"scopes"` // 这个系统上能不能选搜索范围
}

// FinderKind 是一个类型筛选。
type FinderKind struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Icon  string `json:"icon"`
}

// Info 返回类型筛选、当前引擎和界面偏好。
// OpenFullDisk 打开系统设置里的“完全磁盘访问权限”。
func (f *Finder) OpenFullDisk() { platform.OpenFullDiskAccessSettings() }

func (f *Finder) Info() FinderInfo {
	cfg := f.a.config.Get()
	out := FinderInfo{Preview: cfg.Files.FindPreview, Meta: cfg.Files.FindMeta, Scope: cfg.Files.FindScope, Scopes: isDarwin}
	out.Engine, out.Note = f.a.files.FindEngine()
	for _, k := range providers.FileKinds {
		out.Kinds = append(out.Kinds, FinderKind{ID: k.ID, Title: k.Title, Icon: f.a.engine.NormalizeIcon(k.Icon)})
	}
	return out
}

// Search 执行一次搜索。同一个窗口发起新的搜索时，上一次会被取消。
func (f *Finder) Search(ctx context.Context, req providers.FindRequest) providers.FindResult {
	win := 0
	if w := mygo.CallerWindow(ctx); w != nil {
		win = w.ID()
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	f.mu.Lock()
	if f.cancel == nil {
		f.cancel = map[int]context.CancelFunc{}
	}
	if prev := f.cancel[win]; prev != nil {
		prev()
	}
	f.cancel[win] = cancel
	f.mu.Unlock()
	defer cancel()
	if req.Scope == "" {
		req.Scope = f.a.config.Get().Files.FindScope
	}
	res := f.a.files.Find(ctx, req)
	for i := range res.Items {
		res.Items[i].Icon = f.a.engine.NormalizeIcon(res.Items[i].Icon)
	}
	// macOS：没有“完全磁盘访问”时，系统会把其他应用数据目录里的结果去掉（聚焦自己搜得到，这里搜不到）。
	if res.Engine == "spotlight" && !platform.FullDiskAccess() {
		res.Hint = "disk"
	}
	return res
}

// Detail 返回一个文件的预览内容和属性。
func (f *Finder) Detail(path string) *providers.FileDetail { return f.a.fileDetail(path) }

func (a *App) fileDetail(path string) *providers.FileDetail {
	d := providers.Detail(path)
	d.Icon = a.engine.NormalizeIcon(d.Icon)
	switch d.Kind {
	case "image", "video", "audio", "pdf":
		d.URL = a.media.url(path)
		if d.URL == "" {
			if d.Kind == "image" {
				d.URL = a.engine.NormalizeIcon("image:" + path)
			} else {
				d.Kind = "none"
			}
		}
	}
	return d
}

// Thumbnail 向系统要一张预览图（Office 文档、播放不了的视频等），返回图片地址；系统给不出时为空。
func (f *Finder) Thumbnail(ctx context.Context, path string) string {
	dir := filepath.Join(f.a.paths.Cache, "thumbs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	out, err := platform.Thumbnail(ctx, path, dir, 900)
	if err != nil {
		return ""
	}
	return f.a.media.url(out)
}

// SetPanes 记住预览区和属性区的开关。where 是 find（高级搜索）或 panel（搜索框）。
func (f *Finder) SetPanes(where string, preview, meta bool) error {
	err := f.a.config.Update(func(cfg *store.Config) {
		if where == "panel" {
			cfg.Appearance.ShowPreview, cfg.Appearance.ShowMeta = preview, meta
		} else {
			cfg.Files.FindPreview, cfg.Files.FindMeta = preview, meta
		}
	})
	if err == nil {
		f.a.configApplied()
	}
	return err
}

// SetScope 记住搜索范围。
func (f *Finder) SetScope(scope string) error {
	if scope != "all" {
		scope = "home"
	}
	return f.a.config.Update(func(cfg *store.Config) { cfg.Files.FindScope = scope })
}

// Open 打开文件；Reveal 在文件夹里显示它；CopyPath / CopyFile 复制路径或文件本身。
func (f *Finder) Open(path string) error { return f.a.host.OpenTarget(path) }

// Reveal 在文件夹中显示。
func (f *Finder) Reveal(path string) { f.a.host.Reveal(path) }

// CopyPath 复制路径。
func (f *Finder) CopyPath(path string) { f.a.host.CopyText(path) }

// CopyFile 复制文件本身。
func (f *Finder) CopyFile(path string) error { return f.a.host.CopyFiles([]string{path}) }

// --- 计算器 ---

// CalcEntry 是一条计算历史。
type CalcEntry struct {
	ID     string `json:"id"`
	Expr   string `json:"expr"`
	Result string `json:"result"`
	Time   int64  `json:"time"`
}

const maxCalcHistory = 500

type calcHistory struct {
	mu      sync.Mutex
	file    string
	entries []CalcEntry
}

func (h *calcHistory) load() {
	raw, err := os.ReadFile(h.file)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	_ = json.Unmarshal(raw, &h.entries)
}

func (h *calcHistory) save() {
	raw, _ := json.Marshal(h.entries)
	_ = os.WriteFile(h.file, raw, 0o600)
}

// add 记一条；和最近一条相同的不重复记。
func (h *calcHistory) add(expr, result string) {
	expr, result = strings.TrimSpace(expr), strings.TrimSpace(result)
	if expr == "" || result == "" || expr == result {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if n := len(h.entries); n > 0 && h.entries[0].Expr == expr && h.entries[0].Result == result {
		h.entries[0].Time = time.Now().UnixMilli()
		h.save()
		return
	}
	h.entries = append([]CalcEntry{{ID: providers.NewUUID(), Expr: expr, Result: result, Time: time.Now().UnixMilli()}}, h.entries...)
	if len(h.entries) > maxCalcHistory {
		h.entries = h.entries[:maxCalcHistory]
	}
	h.save()
}

func (h *calcHistory) list() []CalcEntry {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]CalcEntry, len(h.entries))
	copy(out, h.entries)
	return out
}

func (h *calcHistory) remove(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i, e := range h.entries {
		if e.ID == id {
			h.entries = append(h.entries[:i:i], h.entries[i+1:]...)
			break
		}
	}
	h.save()
}

func (h *calcHistory) clear() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.entries = nil
	h.save()
}

// Calc 是计算器页的服务。
type Calc struct{ a *App }

// Eval 逐行计算。
func (c *Calc) Eval(lines []string) []providers.CalcLine {
	if len(lines) > 2000 {
		lines = lines[:2000]
	}
	return providers.EvaluateLines(lines)
}

// History 返回计算历史，最近的在前。
func (c *Calc) History() []CalcEntry { return c.a.calcHistory.list() }

// Record 记一条历史（在页面里复制结果或按回车时）。
func (c *Calc) Record(expr, result string) []CalcEntry {
	c.a.calcHistory.add(expr, result)
	return c.a.calcHistory.list()
}

// Remove 删除一条历史。
func (c *Calc) Remove(id string) []CalcEntry {
	c.a.calcHistory.remove(id)
	return c.a.calcHistory.list()
}

// Clear 清空历史。
func (c *Calc) Clear() { c.a.calcHistory.clear() }

// --- 剪贴板历史 ---

// Clips 是剪贴板页的服务。
type Clips struct{ a *App }

// List 列出历史。kind：空 | text | image | files。
func (c *Clips) List(query, kind string) []providers.ClipView {
	list := c.a.clipboard.Entries(query, kind, 500)
	for i := range list {
		if list[i].Image != "" {
			list[i].Image = c.a.engine.NormalizeIcon("image:" + list[i].Image)
		}
	}
	return list
}

func (c *Clips) put(id string) error {
	e, ok := c.a.clipboard.Entry(id)
	if !ok {
		return errors.New("这条记录已经不在了")
	}
	switch e.Kind {
	case "image":
		return c.a.host.CopyImageFile(e.Image)
	case "files":
		return c.a.host.CopyFiles(e.Files)
	}
	c.a.host.CopyText(e.Text)
	return nil
}

// Copy 把一条放回剪贴板。
func (c *Clips) Copy(id string) error { return c.put(id) }

// Paste 把一条粘贴到之前的窗口：主窗口里会先收起自己；独立窗口里只是复制（它不知道该贴到哪）。
func (c *Clips) Paste(ctx context.Context, id string) (bool, error) {
	if err := c.put(id); err != nil {
		return false, err
	}
	if w := mygo.CallerWindow(ctx); w == nil || w.ID() != c.a.panel.ID() {
		return false, nil
	}
	c.a.host.HidePanel()
	if err := c.a.host.PasteToFront(); err != nil {
		c.a.host.Notify("已复制到剪贴板", "无法自动粘贴："+err.Error())
		return false, nil
	}
	return true, nil
}

// Text 返回一条文字记录的完整内容。
func (c *Clips) Text(id string) string {
	e, _ := c.a.clipboard.Entry(id)
	return e.Text
}

// TogglePin 固定或取消固定。
func (c *Clips) TogglePin(id string) { c.a.clipboard.TogglePin(id) }

// Remove 删除一条。
func (c *Clips) Remove(id string) { c.a.clipboard.Remove(id) }

// Clear 清空历史（固定的保留）。
func (c *Clips) Clear() { c.a.clipboard.Clear() }

// --- Windows 工具 ---

// WinTools 是 Windows 工具页的服务。
type WinTools struct{ a *App }

// WinToolsInfo 是页面打开时需要的东西。
type WinToolsInfo struct {
	Available bool `json:"available"`
}

// Info 报告这些工具在当前系统上能不能运行。
func (w *WinTools) Info() WinToolsInfo { return WinToolsInfo{Available: w.a.wintools.Available()} }

// Search 按原名、中文名或说明模糊搜索。
func (w *WinTools) Search(query string) []providers.WinTool { return w.a.wintools.Find(query) }

// Run 打开一个工具。
func (w *WinTools) Run(name string) error { return w.a.wintools.Launch(name) }
