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
		media: &mediaServer{port: 18663, cache: paths.Cache},
	}
	a.plugins = &providers.Plugins{
		Dir:      paths.Plugins,
		URL:      a.pluginURL,
		Disabled: func(string) bool { return false },
	}
	a.plugins.Reload()
	return a, extDir
}

func TestPluginURLAndServeWithPort(t *testing.T) {
	a, _ := newTestPluginApp(t)

	gotURL := a.pluginURL("editors", "index.html")
	if runtime.GOOS == "windows" {
		want := "http://editors.pocketplugin.localhost:18663/index.html"
		if gotURL != want {
			t.Fatalf("pluginURL = %q, want %q", gotURL, want)
		}
	} else {
		want := "pocketplugin://editors/index.html"
		if gotURL != want {
			t.Fatalf("pluginURL = %q, want %q", gotURL, want)
		}
	}

	// 模拟本机回环 HTTP 服务收到的带端口 Host 请求：应正确剥离端口并返回静态资源。
	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	req.Host = "editors.pocketplugin.localhost:18663"
	req.Header.Set("Origin", "http://editors.pocketplugin.localhost:18663")
	rec := httptest.NewRecorder()
	a.servePlugin(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `console.log("loaded")`) {
		t.Fatalf("servePlugin assets/app.js: status=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://editors.pocketplugin.localhost:18663" {
		t.Fatalf("CORS Allow-Origin = %q, want plugin origin", got)
	}

	// 外部网站 Origin 不应获得 CORS 放行头。
	reqEvil := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	reqEvil.Host = "editors.pocketplugin.localhost:18663"
	reqEvil.Header.Set("Origin", "https://example.com")
	recEvil := httptest.NewRecorder()
	a.servePlugin(recEvil, reqEvil)
	if got := recEvil.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("external origin should not receive CORS header, got %q", got)
	}

	// 非只读请求应被拒绝。
	reqPost := httptest.NewRequest(http.MethodPost, "/index.html", nil)
	reqPost.Host = "editors.pocketplugin.localhost:18663"
	recPost := httptest.NewRecorder()
	a.servePlugin(recPost, reqPost)
	if recPost.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", recPost.Code)
	}
}

func TestPluginLocalStoragePersistsAcrossPortChange(t *testing.T) {
	a, _ := newTestPluginApp(t)

	// 模拟第一次启动（端口 18663）时，扩展通过 __pocket.js 把 localStorage 同步进插件存储。
	prefs := map[string]any{
		"pocket.notes.mode":  "source",
		"pocket.notes.prefs": `{"spell":true,"codeTheme":"one-dark"}`,
		"pocket.notes.last":  "2026-11-16 笔记.md",
	}
	if err := a.pluginStorageSet("editors", "__localStorage", prefs); err != nil {
		t.Fatal(err)
	}

	// 模拟重启后换了新的随机端口（29120），请求 /__pocket.js 应同步注入之前保存的 localStorage 快照。
	a.media.port = 29120
	req := httptest.NewRequest(http.MethodGet, "/__pocket.js", nil)
	req.Host = "editors.pocketplugin.localhost:29120"
	rec := httptest.NewRecorder()
	a.servePlugin(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("servePlugin /__pocket.js status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`"pocket.notes.mode":"source"`,
		`"pocket.notes.last":"2026-11-16 笔记.md"`,
		`one-dark`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("/__pocket.js on new port missing %q in:\n%s", want, body[:min(len(body), 300)])
		}
	}
}
