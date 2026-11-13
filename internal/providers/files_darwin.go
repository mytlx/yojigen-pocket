//go:build darwin

package providers

import (
	"context"
	"os"
	"strings"

	"yojigen-pocket/internal/store"
)

func findEngine(*store.Config) (string, string) {
	return "spotlight", "用系统的“聚焦”索引搜索。支持 * 和 ? 通配符，多个词用空格隔开表示都要包含。"
}

func spotlightQuote(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
}

// nativeFind 用 Spotlight 搜索：每个词都要出现在文件名里，带通配符的词按通配符匹配。
func nativeFind(ctx context.Context, req FindRequest, _ *store.Config) ([]string, string, string, bool) {
	var conds []string
	for _, t := range queryTokens(req.Query) {
		if strings.ContainsAny(t, "*?") {
			conds = append(conds, `kMDItemFSName == "`+spotlightQuote(t)+`"c`)
		} else {
			conds = append(conds, `kMDItemFSName == "*`+spotlightQuote(t)+`*"cd`)
		}
	}
	switch req.Kind {
	case "", "all":
	case "folder":
		conds = append(conds, `kMDItemContentType == "public.folder"`)
	case "app":
		conds = append(conds, `kMDItemContentTypeTree == "com.apple.application"`)
	default:
		var alt []string
		for _, e := range KindExts(req.Kind) {
			alt = append(alt, `kMDItemFSName == "*.`+e+`"c`)
		}
		if len(alt) > 0 {
			conds = append(conds, "("+strings.Join(alt, " || ")+")")
		}
	}
	if len(conds) == 0 {
		return nil, "spotlight", "", true
	}
	args := []string{}
	if req.Scope != "all" {
		if home, err := os.UserHomeDir(); err == nil {
			args = append(args, "-onlyin", home)
		}
	}
	args = append(args, strings.Join(conds, " && "))
	lines, err := readLines(ctx, req.Limit, "mdfind", args...)
	if err != nil {
		return nil, "", "", false
	}
	_, note := findEngine(nil)
	return lines, "spotlight", note, true
}

// nativeSearch 用 Spotlight 搜索文件名。
func nativeSearch(ctx context.Context, text string, _ *store.Config, limit int) ([]string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, false
	}
	lines, err := readLines(ctx, limit, "mdfind", "-onlyin", home, "-name", text)
	if err != nil {
		return nil, false
	}
	return lines, true
}

// EverythingStatus 只在 Windows 上有意义。
func EverythingStatus(*store.Config) (string, bool) { return "", false }
