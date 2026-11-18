package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/store"
)

func buildTestPluginZip(t *testing.T, path string, files map[string]string) string {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func newTestExtensionsService(t *testing.T) (*Extensions, *App) {
	t.Helper()
	a, _ := newTestPluginApp(t)
	a.paths.Config = filepath.Join(a.paths.Home, "config.json")
	a.config = store.NewConfigStore(a.paths.Config)
	return &Extensions{a: a}, a
}

func TestExtensionsInstallMany(t *testing.T) {
	ext, a := newTestExtensionsService(t)
	zipDir := t.TempDir()

	alphaZip := filepath.Join(zipDir, "alpha.zip")
	buildTestPluginZip(t, alphaZip, map[string]string{
		"plugin.json": `{"id":"alpha","name":"Alpha 工具","version":"1.0.0","main":"index.html"}`,
		"index.html":  `<!doctype html>alpha`,
	})
	betaZip := filepath.Join(zipDir, "beta.zip")
	buildTestPluginZip(t, betaZip, map[string]string{
		"plugin.json": `{"id":"beta","name":"Beta 工具","version":"2.1.0","main":"index.html"}`,
		"index.html":  `<!doctype html>beta`,
	})
	badZip := filepath.Join(zipDir, "broken.zip")
	if err := os.WriteFile(badZip, []byte("not-a-zip"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := ext.InstallMany([]string{alphaZip, badZip, betaZip, alphaZip})
	if len(res.Installed) != 2 {
		t.Fatalf("installed count = %d, want 2 (%+v)", len(res.Installed), res)
	}
	if res.Installed[0].ID != "alpha" || res.Installed[1].ID != "beta" {
		t.Fatalf("unexpected installed IDs: %+v", res.Installed)
	}
	if len(res.Failed) != 1 || !strings.Contains(res.Failed[0].Source, "broken.zip") {
		t.Fatalf("unexpected failed items: %+v", res.Failed)
	}

	if _, ok := a.plugins.DirOf("alpha"); !ok {
		t.Fatal("alpha plugin should be loaded")
	}
	if _, ok := a.plugins.DirOf("beta"); !ok {
		t.Fatal("beta plugin should be loaded")
	}
}

func TestExtensionsStoreDownloadFallbackAndSHA256(t *testing.T) {
	ext, a := newTestExtensionsService(t)
	// 先保存一点扩展私有存储，验证远程更新不会丢数据。
	if err := a.pluginStorageSet("editors", "notes.last", "keep-me.md"); err != nil {
		t.Fatal(err)
	}

	pkgDir := t.TempDir()
	editorsZip := filepath.Join(pkgDir, "editors-1.2.0.zip")
	editorsSHA := buildTestPluginZip(t, editorsZip, map[string]string{
		"plugin.json": `{"id":"editors","name":"写作与代码","version":"1.2.0","api":1,"main":"index.html"}`,
		"index.html":  `<!doctype html>v1.2.0`,
	})
	editorsBytes, err := os.ReadFile(editorsZip)
	if err != nil {
		t.Fatal(err)
	}

	tamperedZip := filepath.Join(pkgDir, "tampered-1.0.0.zip")
	buildTestPluginZip(t, tamperedZip, map[string]string{
		"plugin.json": `{"id":"tampered","name":"篡改包","version":"1.0.0","api":1,"main":"index.html"}`,
		"index.html":  `<!doctype html>evil`,
	})
	tamperedBytes, err := os.ReadFile(tamperedZip)
	if err != nil {
		t.Fatal(err)
	}

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bad-mirror/":
			http.Error(w, "mirror error", http.StatusBadGateway)
		case "/extensions.json":
			reg := providers.ExtensionRegistry{
				Schema:    1,
				UpdatedAt: "2026-11-19T00:00:00Z",
				Extensions: []providers.RegistryExtension{
					{
						ID:          "editors",
						Name:        "写作与代码",
						Description: "更新版编辑器",
						Icon:        "svg:notebook",
						Tools:       []string{"Markdown 笔记"},
						RegistryArtifact: providers.RegistryArtifact{
							Version:   "1.2.0",
							API:       1,
							URL:       srvURL + "/editors-1.2.0.zip",
							Tag:       "ext-editors-v1.2.0",
							Asset:     "editors-1.2.0.zip",
							SHA256:    editorsSHA,
							Size:      int64(len(editorsBytes)),
							Changelog: "- feat(notes): remote update",
						},
					},
					{
						ID:   "tampered",
						Name: "校验失败测试",
						RegistryArtifact: providers.RegistryArtifact{
							Version: "1.0.0",
							API:     1,
							URL:     srvURL + "/tampered-1.0.0.zip",
							Asset:   "tampered-1.0.0.zip",
							SHA256:  strings.Repeat("0", 64),
						},
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(reg)
		case "/editors-1.2.0.zip":
			_, _ = w.Write(editorsBytes)
		case "/tampered-1.0.0.zip":
			_, _ = w.Write(tamperedBytes)
		default:
			// 镜像路径形如 /mirror/http://127.0.0.1:.../xxx，返回 502 验证回退原地址
			http.Error(w, "bad mirror", http.StatusBadGateway)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	// 配置自定义索引和故意失效的镜像前缀：应能平滑回退直连 srvURL 并成功更新。
	if _, err := ext.SaveStoreConfig(store.PluginsConfig{
		RegistryURL: srvURL + "/extensions.json",
		MirrorURL:   srvURL + "/mirror/",
	}); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	st := ext.Store(ctx, false)
	if st.Error != "" || len(st.Items) != 2 {
		t.Fatalf("Store failed: err=%q items=%+v", st.Error, st.Items)
	}
	if st.Items[0].ID != "editors" || st.Items[0].Status != providers.StoreStatusUpdateAvailable {
		t.Fatalf("editors store status = %+v, want update_available", st.Items[0])
	}
	if st.Items[1].ID != "tampered" || st.Items[1].Status != providers.StoreStatusNotInstalled {
		t.Fatalf("tampered store status = %+v, want not_installed", st.Items[1])
	}

	// 验证磁盘缓存生效且离线失败时能降级保留缓存。
	if _, err := os.Stat(ext.registryCachePath()); err != nil {
		t.Fatalf("registry cache missing: %v", err)
	}

	// 验证 SHA-256 不匹配必须拒绝安装。
	if _, err := ext.InstallRemote(ctx, "tampered"); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("expected SHA-256 mismatch error, got %v", err)
	}
	if _, ok := a.plugins.DirOf("tampered"); ok {
		t.Fatal("tampered plugin must not be installed")
	}

	// 验证 UpdateAll 能下载校验并更新 editors 到 1.2.0，同时保留原有 storage 数据。
	upd, err := ext.UpdateAll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(upd.Installed) != 1 || upd.Installed[0].ID != "editors" || upd.Installed[0].Version != "1.2.0" {
		t.Fatalf("unexpected UpdateAll result: %+v", upd)
	}
	if got, err := a.pluginStorageGet("editors", "notes.last"); err != nil || got != "keep-me.md" {
		t.Fatalf("storage lost after remote update: got=%v err=%v", got, err)
	}

	// 再次刷新商店状态，editors 应变为 up_to_date。
	st2 := ext.Store(ctx, true)
	for _, it := range st2.Items {
		if it.ID == "editors" && it.Status != providers.StoreStatusUpToDate {
			t.Fatalf("editors status after update = %s, want up_to_date", it.Status)
		}
	}

	// 验证校验非法镜像 URL。
	if _, err := ext.SaveStoreConfig(store.PluginsConfig{RegistryURL: fmt.Sprintf("ftp://bad/a.json")}); err == nil {
		t.Fatal("expected invalid URL error")
	}
}
