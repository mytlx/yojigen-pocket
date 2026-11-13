//go:build !darwin && !windows

package providers

import (
	"context"

	"yojigen-pocket/internal/store"
)

func nativeSearch(context.Context, string, *store.Config, int) ([]string, bool) { return nil, false }

// EverythingStatus 只在 Windows 上有意义。
func EverythingStatus(*store.Config) (string, bool) { return "", false }

func findEngine(*store.Config) (string, string) {
	return "index", "只搜设置里指定的目录。支持 * 和 ? 通配符。"
}

func nativeFind(context.Context, FindRequest, *store.Config) ([]string, string, string, bool) {
	return nil, "", "", false
}
