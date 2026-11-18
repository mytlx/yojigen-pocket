package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/store"
	"yojigen-pocket/internal/tts"
)

// StoreResult 是返回给道具库扩展管理界面的商店状态。
type StoreResult struct {
	UpdatedAt   string                     `json:"updatedAt,omitempty"`
	FromCache   bool                       `json:"fromCache,omitempty"`
	Error       string                     `json:"error,omitempty"`
	HostAPI     int                        `json:"hostApi"`
	RegistryURL string                     `json:"registryUrl"`
	DefaultURL  string                     `json:"defaultUrl"`
	MirrorURL   string                     `json:"mirrorUrl"`
	Items       []providers.StoreExtension `json:"items"`
}

func (e *Extensions) pluginsConfig() store.PluginsConfig {
	if e.a.config == nil {
		return store.PluginsConfig{}
	}
	return e.a.config.Get().Plugins
}

func (e *Extensions) effectiveRegistryURL(cfg store.PluginsConfig) string {
	if u := strings.TrimSpace(cfg.RegistryURL); u != "" {
		return u
	}
	return providers.DefaultRegistryURL
}

func (e *Extensions) registryCachePath() string {
	return filepath.Join(e.a.paths.Cache, "extensions-registry.json")
}

func (e *Extensions) getLastRegistry() *providers.ExtensionRegistry {
	e.storeMu.Lock()
	defer e.storeMu.Unlock()
	return e.lastReg
}

func (e *Extensions) setLastRegistry(reg *providers.ExtensionRegistry) {
	e.storeMu.Lock()
	e.lastReg = reg
	e.storeMu.Unlock()
}

func (e *Extensions) beginDownload(id string) error {
	e.dlMu.Lock()
	defer e.dlMu.Unlock()
	if e.dlActive == nil {
		e.dlActive = map[string]bool{}
	}
	if e.dlActive[id] {
		return fmt.Errorf("扩展「%s」正在下载安装中", id)
	}
	e.dlActive[id] = true
	return nil
}

func (e *Extensions) endDownload(id string) {
	e.dlMu.Lock()
	delete(e.dlActive, id)
	e.dlMu.Unlock()
}

// StoreConfig 返回扩展商店的源地址与镜像配置。
func (e *Extensions) StoreConfig() store.PluginsConfig {
	return e.pluginsConfig()
}

// SaveStoreConfig 校验并保存扩展商店源地址和加速镜像配置。
func (e *Extensions) SaveStoreConfig(cfg store.PluginsConfig) (store.PluginsConfig, error) {
	regURL, err := providers.ValidateHTTPURL(cfg.RegistryURL)
	if err != nil {
		return store.PluginsConfig{}, fmt.Errorf("扩展源地址无效：%w", err)
	}
	mirrorURL, err := providers.ValidateHTTPURL(cfg.MirrorURL)
	if err != nil {
		return store.PluginsConfig{}, fmt.Errorf("镜像地址无效：%w", err)
	}
	saved := store.PluginsConfig{RegistryURL: regURL, MirrorURL: mirrorURL}
	if e.a.config == nil {
		return saved, nil
	}
	if err := e.a.config.Update(func(c *store.Config) {
		c.Plugins = saved
	}); err != nil {
		return store.PluginsConfig{}, err
	}
	// 切换源地址后清空旧内存索引，确保下次拉取新源内容。
	e.setLastRegistry(nil)
	_ = os.Remove(e.registryCachePath())
	return saved, nil
}

// Store 返回官方扩展商店列表及与本地版本的对比状态。refresh 为 false 时优先秒读缓存，缓存不存在时再联网拉取。
func (e *Extensions) Store(ctx context.Context, refresh bool) StoreResult {
	cfg := e.pluginsConfig()
	regURL := e.effectiveRegistryURL(cfg)
	res := StoreResult{
		HostAPI:     providers.APIVersion,
		RegistryURL: cfg.RegistryURL,
		DefaultURL:  providers.DefaultRegistryURL,
		MirrorURL:   cfg.MirrorURL,
	}

	var reg *providers.ExtensionRegistry
	if !refresh {
		if cached, err := readRegistryFile(e.registryCachePath()); err == nil {
			reg = cached
			res.FromCache = true
			e.setLastRegistry(reg)
		}
	}

	if reg == nil {
		fetched, err := e.fetchRegistry(ctx, regURL, cfg.MirrorURL)
		if err == nil {
			reg = fetched
			e.setLastRegistry(reg)
			res.FromCache = false
			_ = os.MkdirAll(filepath.Dir(e.registryCachePath()), 0o755)
			if raw, mErr := json.MarshalIndent(reg, "", "  "); mErr == nil {
				_ = store.WriteFileAtomic(e.registryCachePath(), raw)
			}
		} else {
			res.Error = err.Error()
			// 联网刷新失败时退回读取旧缓存，保证界面可用。
			if cached, cErr := readRegistryFile(e.registryCachePath()); cErr == nil {
				reg = cached
				res.FromCache = true
				e.setLastRegistry(reg)
			}
		}
	}

	if reg != nil {
		res.UpdatedAt = reg.UpdatedAt
		res.Items = providers.BuildStoreExtensions(reg, e.List(), providers.APIVersion)
	}
	return res
}

// InstallRemote 从扩展商店下载指定扩展、校验 SHA-256 后安装或更新。
func (e *Extensions) InstallRemote(ctx context.Context, id string) (*providers.PluginInfo, error) {
	if !providers.ValidPluginID(id) {
		return nil, errors.New("扩展的 ID 不对")
	}
	item, cfg, err := e.resolveStoreItem(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := e.beginDownload(id); err != nil {
		return nil, err
	}
	defer e.endDownload(id)

	tmpDir, zipPath, err := e.downloadAndVerify(ctx, item, cfg.MirrorURL)
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)

	return e.Install(zipPath)
}

// UpdateAll 下载并批量更新商店里全部可更新的已安装扩展。
func (e *Extensions) UpdateAll(ctx context.Context) (*BatchInstallResult, error) {
	res := e.Store(ctx, true)
	if res.Error != "" && len(res.Items) == 0 {
		return nil, errors.New(res.Error)
	}
	cfg := e.pluginsConfig()

	var toUpdate []providers.StoreExtension
	for _, it := range res.Items {
		if it.Status == providers.StoreStatusUpdateAvailable {
			toUpdate = append(toUpdate, it)
		}
	}
	if len(toUpdate) == 0 {
		return &BatchInstallResult{}, nil
	}

	var out BatchInstallResult
	var tmpDirs []string
	defer func() {
		for _, d := range tmpDirs {
			_ = os.RemoveAll(d)
		}
	}()

	var zipPaths []string
	for _, it := range toUpdate {
		if err := e.beginDownload(it.ID); err != nil {
			out.Failed = append(out.Failed, InstallFailure{Source: it.ID, Name: it.Name, Error: err.Error()})
			continue
		}
		tmpDir, zipPath, err := e.downloadAndVerify(ctx, it, cfg.MirrorURL)
		e.endDownload(it.ID)
		if err != nil {
			out.Failed = append(out.Failed, InstallFailure{Source: it.ID, Name: it.Name, Error: err.Error()})
			continue
		}
		tmpDirs = append(tmpDirs, tmpDir)
		zipPaths = append(zipPaths, zipPath)
	}

	if len(zipPaths) > 0 {
		batch := e.InstallMany(zipPaths)
		out.Installed = append(out.Installed, batch.Installed...)
		out.Failed = append(out.Failed, batch.Failed...)
	}
	return &out, nil
}

func (e *Extensions) resolveStoreItem(ctx context.Context, id string) (providers.StoreExtension, store.PluginsConfig, error) {
	cfg := e.pluginsConfig()
	reg := e.getLastRegistry()
	if reg == nil {
		res := e.Store(ctx, true)
		if res.Error != "" && len(res.Items) == 0 {
			return providers.StoreExtension{}, cfg, errors.New(res.Error)
		}
		reg = e.getLastRegistry()
	}
	if reg == nil {
		return providers.StoreExtension{}, cfg, errors.New("暂时获取不到扩展商店清单")
	}
	items := providers.BuildStoreExtensions(reg, e.List(), providers.APIVersion)
	for _, it := range items {
		if it.ID == id {
			if it.DownloadURL == "" || it.Status == providers.StoreStatusIncompatible {
				return providers.StoreExtension{}, cfg, fmt.Errorf("扩展「%s」需要更新版本的 Yojigen Pocket（要求接口 API v%d，当前为 v%d）", it.Name, it.LatestAPI, providers.APIVersion)
			}
			return it, cfg, nil
		}
	}
	return providers.StoreExtension{}, cfg, fmt.Errorf("商店清单里找不到扩展「%s」", id)
}

func readRegistryFile(path string) (*providers.ExtensionRegistry, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseRegistryJSON(raw)
}

func parseRegistryJSON(raw []byte) (*providers.ExtensionRegistry, error) {
	var reg providers.ExtensionRegistry
	if err := json.Unmarshal(raw, &reg); err != nil {
		return nil, fmt.Errorf("扩展索引格式不对：%w", err)
	}
	if reg.Schema > 1 {
		return nil, fmt.Errorf("扩展索引版本（schema %d）需要更新客户端", reg.Schema)
	}
	return &reg, nil
}

func (e *Extensions) fetchRegistry(ctx context.Context, registryURL, mirrorURL string) (*providers.ExtensionRegistry, error) {
	urls, err := providers.ResolveDownloadURLs(registryURL, mirrorURL)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Transport: tts.HTTPClient.Transport, Timeout: 12 * time.Second}
	var lastErr error
	for _, u := range urls {
		reqCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		req.Header.Set("Accept", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			cancel()
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		cancel()
		if resp.StatusCode != http.StatusOK {
			lastErr = fmt.Errorf("拉取扩展索引失败（HTTP %d）", resp.StatusCode)
			continue
		}
		if readErr != nil {
			lastErr = readErr
			if ctx.Err() != nil {
				break
			}
			continue
		}
		reg, parseErr := parseRegistryJSON(body)
		if parseErr != nil {
			lastErr = parseErr
			continue
		}
		return reg, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if lastErr == nil {
		lastErr = errors.New("拉取扩展索引失败")
	}
	return nil, lastErr
}

func (e *Extensions) downloadAndVerify(ctx context.Context, item providers.StoreExtension, mirrorURL string) (string, string, error) {
	wantSHA := strings.ToLower(strings.TrimSpace(item.SHA256))
	if len(wantSHA) != 64 {
		return "", "", fmt.Errorf("扩展「%s」缺少有效的 SHA-256 校验码，已拒绝下载", item.Name)
	}
	urls, err := providers.ResolveDownloadURLs(item.DownloadURL, mirrorURL)
	if err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(e.a.paths.Cache, 0o755); err != nil {
		return "", "", err
	}
	tmpDir, err := os.MkdirTemp(e.a.paths.Cache, "ext-dl-")
	if err != nil {
		return "", "", err
	}
	asset := filepath.Base(strings.ReplaceAll(item.Asset, "\\", "/"))
	if asset == "" || asset == "." || asset == ".." || !strings.HasSuffix(strings.ToLower(asset), ".zip") {
		asset = fmt.Sprintf("%s-%s.zip", item.ID, item.InstallableVersion)
	}
	zipPath := filepath.Join(tmpDir, asset)

	client := &http.Client{Transport: tts.HTTPClient.Transport, Timeout: 2 * time.Minute}
	var lastErr error
	for _, u := range urls {
		if err := downloadFileWithSHA256(ctx, client, u, zipPath, wantSHA); err != nil {
			lastErr = err
			_ = os.Remove(zipPath)
			if ctx.Err() != nil {
				break
			}
			continue
		}
		return tmpDir, zipPath, nil
	}
	_ = os.RemoveAll(tmpDir)
	return "", "", lastErr
}

func downloadFileWithSHA256(ctx context.Context, client *http.Client, targetURL, dstPath, wantSHA string) error {
	dlCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载扩展失败（HTTP %d）", resp.StatusCode)
	}

	f, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxPackageBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n > maxPackageBytes {
		return errors.New("扩展包体积超过限制")
	}
	gotSHA := hex.EncodeToString(h.Sum(nil))
	if gotSHA != wantSHA {
		return errors.New("扩展包 SHA-256 校验不通过，文件可能已损坏")
	}
	return nil
}
