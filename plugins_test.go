package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/store"
)

func newTestPluginApp(t *testing.T) (*App, string) {
	t.Helper()
	home := t.TempDir()
	paths := store.Paths{
		Home:    home,
		Plugins: filepath.Join(home, "plugins"),
		Data:    filepath.Join(home, "data"),
		Cache:   filepath.Join(home, "cache"),
	}
	if err := os.MkdirAll(paths.Plugins, 0o755); err != nil {
		t.Fatal(err)
	}
	extDir := filepath.Join(paths.Plugins, "editors")
	if err := os.MkdirAll(filepath.Join(extDir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extDir, "plugin.json"), []byte(`{"id":"editors","title":"写作与代码","main":"index.html"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extDir, "index.html"), []byte(`<!doctype html><script src="/__pocket.js"></script><script type="module" src="./assets/app.js"></script>`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extDir, "assets", "app.js"), []byte(`console.log("loaded");`), 0o644); err != nil {
		t.Fatal(err)
	}

	a := &App{
		paths: paths,
	}
	a.plugins = &providers.Plugins{
		Dir:      paths.Plugins,
		URL:      a.pluginURL,
		Disabled: func(string) bool { return false },
	}
	a.plugins.Reload()
	return a, extDir
}

func TestPluginURLAndServeIsolation(t *testing.T) {
	a, _ := newTestPluginApp(t)

	gotURL := a.pluginURL("editors", "index.html")
	if runtime.GOOS == "windows" {
		want := "http://editors.pocketplugin.localhost/index.html"
		if gotURL != want {
			t.Fatalf("pluginURL = %q, want %q", gotURL, want)
		}
	} else {
		want := "pocketplugin://editors/index.html"
		if gotURL != want {
			t.Fatalf("pluginURL = %q, want %q", gotURL, want)
		}
	}

	// 同扩展 Origin 访问自身静态资源：应返回匹配的 CORS 头。
	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	req.Host = "editors.pocketplugin.localhost"
	req.Header.Set("Origin", "http://editors.pocketplugin.localhost")
	rec := httptest.NewRecorder()
	a.servePlugin(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `console.log("loaded")`) {
		t.Fatalf("servePlugin assets/app.js: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://editors.pocketplugin.localhost" {
		t.Fatalf("CORS Allow-Origin = %q, want plugin origin", got)
	}

	// 其他扩展的 Origin（如 pet 请求 editors）：不应获得 CORS 放行头。
	reqOtherPlugin := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	reqOtherPlugin.Host = "editors.pocketplugin.localhost"
	reqOtherPlugin.Header.Set("Origin", "http://pet.pocketplugin.localhost")
	recOtherPlugin := httptest.NewRecorder()
	a.servePlugin(recOtherPlugin, reqOtherPlugin)
	if got := recOtherPlugin.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("other plugin origin should not receive CORS header, got %q", got)
	}

	// 外部网站 Origin：不应获得 CORS 放行头。
	reqEvil := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	reqEvil.Host = "editors.pocketplugin.localhost"
	reqEvil.Header.Set("Origin", "https://example.com")
	recEvil := httptest.NewRecorder()
	a.servePlugin(recEvil, reqEvil)
	if got := recEvil.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("external origin should not receive CORS header, got %q", got)
	}

	// 非只读请求应被拒绝。
	reqPost := httptest.NewRequest(http.MethodPost, "/index.html", nil)
	reqPost.Host = "editors.pocketplugin.localhost"
	recPost := httptest.NewRecorder()
	a.servePlugin(recPost, reqPost)
	if recPost.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", recPost.Code)
	}
}

func TestPluginRuntimeIsStaticAndChecksInstalled(t *testing.T) {
	a, _ := newTestPluginApp(t)

	// 写入扩展私有存储数据：/__pocket.js 必须保持为纯静态公共代码，不能夹带任何私有数据。
	secret := "my-secret-note-path.md"
	if err := a.pluginStorageSet("editors", "notes.last", secret); err != nil {
		t.Fatal(err)
	}
	if err := a.pluginStorageSet("editors", "notes.mode", "source"); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/__pocket.js", nil)
	req.Host = "editors.pocketplugin.localhost"
	rec := httptest.NewRecorder()
	a.servePlugin(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("servePlugin /__pocket.js status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("/__pocket.js leaked private storage data")
	}

	// 已卸载或不存在的扩展，即使磁盘上有残留存储文件，请求 /__pocket.js 也必须返回 404。
	if err := a.pluginStorageSet("uninstalled-ext", "notes.last", secret); err != nil {
		t.Fatal(err)
	}
	reqGhost := httptest.NewRequest(http.MethodGet, "/__pocket.js", nil)
	reqGhost.Host = "uninstalled-ext.pocketplugin.localhost"
	recGhost := httptest.NewRecorder()
	a.servePlugin(recGhost, reqGhost)
	if recGhost.Code != http.StatusNotFound {
		t.Fatalf("uninstalled plugin /__pocket.js status = %d, want 404", recGhost.Code)
	}

	// 各键在宿主存储中独立保存、互不覆盖，且重启后仍可按扩展 ID 读回。
	if got, err := a.pluginStorageGet("editors", "notes.last"); err != nil || got != secret {
		t.Fatalf("pluginStorageGet(notes.last) = %v, %v", got, err)
	}
	if got, err := a.pluginStorageGet("editors", "notes.mode"); err != nil || got != "source" {
		t.Fatalf("pluginStorageGet(notes.mode) = %v, %v", got, err)
	}
}
