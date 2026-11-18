//go:build !darwin

package platform

import "errors"

// 这几个只在 macOS 上有意义。

// FullDiskAccess 报告有没有“完全磁盘访问权限”。
func FullDiskAccess() bool { return true }

// OpenFullDiskAccessSettings 打开系统设置里的“完全磁盘访问权限”。
func OpenFullDiskAccessSettings() {}

// AdHocSigned 报告应用是不是没有固定的签名。
func AdHocSigned() bool { return false }

// ResetPermission 清掉系统里这个应用的某项授权记录。
func ResetPermission(string) error { return errors.New("只有 macOS 需要") }

// PromptAccessibility 让系统弹出辅助功能的授权提示。
func PromptAccessibility() {}
