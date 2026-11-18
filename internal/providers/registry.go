package providers

import (
	"errors"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// DefaultRegistryURL 是默认的官方扩展在线索引地址。
const DefaultRegistryURL = "https://github.com/mytlx/yojigen-pocket/releases/download/extensions/extensions.json"

// 扩展商店状态常量。
const (
	StoreStatusNotInstalled    = "not_installed"
	StoreStatusUpdateAvailable = "update_available"
	StoreStatusUpToDate        = "up_to_date"
	StoreStatusIncompatible    = "incompatible"
)

// RegistryArtifact 描述在线扩展索引中的一个可下载版本包。
type RegistryArtifact struct {
	Version     string `json:"version"`
	API         int    `json:"api"`
	URL         string `json:"url"`
	Tag         string `json:"tag"`
	Asset       string `json:"asset"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	PublishedAt string `json:"publishedAt"`
	Changelog   string `json:"changelog"`
}

// RegistryExtension 描述在线扩展索引里的单个扩展及其各 API 兼容版本。
type RegistryExtension struct {
	ID          string                      `json:"id"`
	Name        string                      `json:"name"`
	Description string                      `json:"description,omitempty"`
	Icon        string                      `json:"icon,omitempty"`
	Author      string                      `json:"author,omitempty"`
	Tools       []string                    `json:"tools,omitempty"`
	Permissions Permissions                 `json:"permissions,omitempty"`
	Backend     bool                        `json:"backend,omitempty"`
	Compat      map[string]RegistryArtifact `json:"compat,omitempty"`
	RegistryArtifact
}

// ExtensionRegistry 对应远程 extensions.json 的顶层结构。
type ExtensionRegistry struct {
	Schema     int                 `json:"schema"`
	UpdatedAt  string              `json:"updatedAt"`
	Extensions []RegistryExtension `json:"extensions"`
}

// StoreExtension 是结合本地安装状态计算后的商店展示条目。
type StoreExtension struct {
	ID                 string      `json:"id"`
	Name               string      `json:"name"`
	Description        string      `json:"description,omitempty"`
	Icon               string      `json:"icon,omitempty"`
	Author             string      `json:"author,omitempty"`
	Tools              []string    `json:"tools,omitempty"`
	Permissions        Permissions `json:"permissions,omitempty"`
	Backend            bool        `json:"backend,omitempty"`
	Installed          bool        `json:"installed"`
	Enabled            bool        `json:"enabled"`
	InstalledVersion   string      `json:"installedVersion,omitempty"`
	Problem            string      `json:"problem,omitempty"`
	LatestVersion      string      `json:"latestVersion"`
	LatestAPI          int         `json:"latestApi"`
	InstallableVersion string      `json:"installableVersion,omitempty"`
	InstallableAPI     int         `json:"installableApi,omitempty"`
	DownloadURL        string      `json:"downloadUrl,omitempty"`
	Tag                string      `json:"tag,omitempty"`
	Asset              string      `json:"asset,omitempty"`
	SHA256             string      `json:"sha256,omitempty"`
	Size               int64       `json:"size,omitempty"`
	PublishedAt        string      `json:"publishedAt,omitempty"`
	Changelog          string      `json:"changelog,omitempty"`
	Status             string      `json:"status"`
	RequiresAppUpdate  bool        `json:"requiresAppUpdate,omitempty"`
}

var semverRe = regexp.MustCompile(`^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`)

type semverParts struct {
	major, minor, patch int
	pre                 string
	valid               bool
}

func parseSemver(v string) semverParts {
	m := semverRe.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return semverParts{}
	}
	maj, _ := strconv.Atoi(m[1])
	minV, _ := strconv.Atoi(m[2])
	pat, _ := strconv.Atoi(m[3])
	return semverParts{major: maj, minor: minV, patch: pat, pre: m[4], valid: true}
}

// CompareSemver 按 SemVer 2.0.0 规则比较两个版本，返回 >0 表示 a > b，<0 表示 a < b，0 表示相等。
func CompareSemver(a, b string) int {
	pa, pb := parseSemver(a), parseSemver(b)
	if !pa.valid || !pb.valid {
		return strings.Compare(strings.TrimSpace(a), strings.TrimSpace(b))
	}
	if pa.major != pb.major {
		return cmpInt(pa.major, pb.major)
	}
	if pa.minor != pb.minor {
		return cmpInt(pa.minor, pb.minor)
	}
	if pa.patch != pb.patch {
		return cmpInt(pa.patch, pb.patch)
	}
	if pa.pre == "" && pb.pre == "" {
		return 0
	}
	if pa.pre == "" {
		return 1
	}
	if pb.pre == "" {
		return -1
	}
	sa, sb := strings.Split(pa.pre, "."), strings.Split(pb.pre, ".")
	for i := 0; i < max(len(sa), len(sb)); i++ {
		if i >= len(sa) {
			return -1
		}
		if i >= len(sb) {
			return 1
		}
		if d := comparePrePart(sa[i], sb[i]); d != 0 {
			return d
		}
	}
	return 0
}

func cmpInt(a, b int) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func comparePrePart(a, b string) int {
	na, errA := strconv.Atoi(a)
	nb, errB := strconv.Atoi(b)
	isNumA, isNumB := errA == nil && allDigits(a), errB == nil && allDigits(b)
	switch {
	case isNumA && isNumB:
		return cmpInt(na, nb)
	case isNumA != isNumB:
		if isNumA {
			return -1
		}
		return 1
	default:
		return strings.Compare(a, b)
	}
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// SelectCompatibleArtifact 从扩展条目及其 compat 历史兼容表中挑出满足 hostAPI 的最高版本工件。
func SelectCompatibleArtifact(ext RegistryExtension, hostAPI int) (*RegistryArtifact, bool) {
	var candidates []RegistryArtifact
	if ext.Version != "" && ext.URL != "" {
		candidates = append(candidates, ext.RegistryArtifact)
	}
	for _, slot := range ext.Compat {
		if slot.Version != "" && slot.URL != "" {
			candidates = append(candidates, slot)
		}
	}

	var best *RegistryArtifact
	for i := range candidates {
		c := candidates[i]
		api := max(c.API, 1)
		if api > hostAPI {
			continue
		}
		if best == nil || CompareSemver(c.Version, best.Version) > 0 || (CompareSemver(c.Version, best.Version) == 0 && api > best.API) {
			copyItem := c
			copyItem.API = api
			best = &copyItem
		}
	}

	topAPI := max(ext.API, 1)
	if best == nil {
		return nil, ext.Version != "" && topAPI > hostAPI
	}
	requiresAppUpdate := topAPI > hostAPI && CompareSemver(ext.Version, best.Version) > 0
	return best, requiresAppUpdate
}

func storeRemoteIcon(icon string) string {
	switch {
	case strings.HasPrefix(icon, "svg:"), strings.HasPrefix(icon, "text:"),
		strings.HasPrefix(icon, "http://"), strings.HasPrefix(icon, "https://"), strings.HasPrefix(icon, "data:image/"):
		return icon
	default:
		return "svg:puzzle"
	}
}

// BuildStoreExtensions 结合本地已安装列表，计算每个在线扩展的安装/更新/兼容状态，并按展示优先级排序。
func BuildStoreExtensions(reg *ExtensionRegistry, installed []PluginInfo, hostAPI int) []StoreExtension {
	if reg == nil {
		return nil
	}
	local := map[string]PluginInfo{}
	for _, p := range installed {
		local[p.ID] = p
	}

	out := make([]StoreExtension, 0, len(reg.Extensions))
	for _, ext := range reg.Extensions {
		if !ValidPluginID(ext.ID) {
			continue
		}
		best, requiresAppUpdate := SelectCompatibleArtifact(ext, hostAPI)
		name := ext.Name
		if name == "" {
			name = ext.ID
		}
		item := StoreExtension{
			ID:                ext.ID,
			Name:              name,
			Description:       ext.Description,
			Icon:              storeRemoteIcon(ext.Icon),
			Author:            ext.Author,
			Tools:             slices.Clone(ext.Tools),
			Permissions:       ext.Permissions,
			Backend:           ext.Backend,
			LatestVersion:     ext.Version,
			LatestAPI:         max(ext.API, 1),
			RequiresAppUpdate: requiresAppUpdate,
			Changelog:         ext.Changelog,
			Tag:               ext.Tag,
			Asset:             ext.Asset,
			Size:              ext.Size,
			PublishedAt:       ext.PublishedAt,
		}
		if best != nil {
			item.InstallableVersion = best.Version
			item.InstallableAPI = best.API
			item.DownloadURL = best.URL
			item.Tag = best.Tag
			item.Asset = best.Asset
			item.SHA256 = best.SHA256
			item.Size = best.Size
			item.PublishedAt = best.PublishedAt
			if best.Changelog != "" {
				item.Changelog = best.Changelog
			}
		}

		if inst, ok := local[ext.ID]; ok {
			item.Installed = true
			item.Enabled = inst.Enabled
			item.InstalledVersion = inst.Version
			item.Problem = inst.Problem
			if inst.Icon != "" {
				item.Icon = inst.Icon
			}
			if len(item.Tools) == 0 && len(inst.Tools) > 0 {
				item.Tools = slices.Clone(inst.Tools)
			}
			if hasEmptyPermissions(item.Permissions) && !hasEmptyPermissions(inst.Permissions) {
				item.Permissions = inst.Permissions
			}
			if !item.Backend && inst.Backend {
				item.Backend = true
			}
			switch {
			case best == nil:
				item.Status = StoreStatusIncompatible
			case inst.Problem != "" || inst.Version == "" || CompareSemver(best.Version, inst.Version) > 0:
				item.Status = StoreStatusUpdateAvailable
			default:
				item.Status = StoreStatusUpToDate
			}
		} else if best == nil {
			item.Status = StoreStatusIncompatible
		} else {
			item.Status = StoreStatusNotInstalled
		}

		out = append(out, item)
	}

	sort.Slice(out, func(i, j int) bool {
		pi, pj := statusRank(out[i].Status), statusRank(out[j].Status)
		if pi != pj {
			return pi < pj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func hasEmptyPermissions(p Permissions) bool {
	return !p.Peer && !p.Runner && !p.Files && len(p.Dirs) == 0 && len(p.Fetch) == 0
}

func statusRank(status string) int {
	switch status {
	case StoreStatusUpdateAvailable:
		return 0
	case StoreStatusNotInstalled:
		return 1
	case StoreStatusIncompatible:
		return 2
	default:
		return 3
	}
}

// ValidateHTTPURL 验证 URL 是否为空（允许默认）或为有效的 http/https 地址。
func ValidateHTTPURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", errors.New("请输入有效的 http:// 或 https:// 地址")
	}
	return trimmed, nil
}

// ResolveDownloadURLs 按镜像配置生成下载候选 URL 列表（配置了镜像时优先走镜像，失败后回退原地址）。
func ResolveDownloadURLs(rawURL, mirrorPrefix string) ([]string, error) {
	cleanRaw, err := ValidateHTTPURL(rawURL)
	if err != nil || cleanRaw == "" {
		return nil, errors.New("扩展下载地址无效")
	}
	mirror, err := ValidateHTTPURL(mirrorPrefix)
	if err != nil {
		return nil, err
	}
	if mirror == "" {
		return []string{cleanRaw}, nil
	}
	var mirrored string
	if strings.Contains(mirror, "{url}") {
		mirrored = strings.ReplaceAll(mirror, "{url}", cleanRaw)
	} else {
		mirrored = strings.TrimRight(mirror, "/") + "/" + cleanRaw
	}
	if mirrored == cleanRaw {
		return []string{cleanRaw}, nil
	}
	return []string{mirrored, cleanRaw}, nil
}
