// Package platform 封装各操作系统的差异：模拟按键、前台应用、进程管理等。
// 全部用纯 Go 实现（darwin 通过 purego 调系统框架，windows 通过 syscall 调 user32），不需要 cgo。
package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrUnsupported 表示当前平台不支持该操作。
var ErrUnsupported = errors.New("当前系统不支持")

// App 是前台应用的信息。
type App struct {
	Name  string
	Title string
}

// LookFirst 返回第一个能找到的可执行文件。
func LookFirst(names ...string) string {
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
	}
	return ""
}

// ExpandHome 展开路径开头的 ~。
func ExpandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if h, err := os.UserHomeDir(); err == nil {
			return h + p[1:]
		}
	}
	return p
}

// Command 创建一个受管的子进程：不弹控制台窗口，取消时连同子进程一起结束。
func Command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	prepareCommand(cmd)
	return cmd
}

// DetachedCommand 创建一个脱离启动器工作目录的独立后台进程，用于启动外部应用或编辑器。
func DetachedCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	prepareDetachedCommand(cmd)
	if cmd.Dir == "" {
		cmd.Dir = DefaultWorkDir()
	}
	return cmd
}

// DefaultWorkDir 返回脱离启动器自身目录的默认工作目录（用户家目录）。
func DefaultWorkDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return os.TempDir()
}

// WorkDir 为外部打开的目标挑选工作目录，避免子进程继承启动器自身目录而长期占用。
func WorkDir(target string) string {
	fallback := DefaultWorkDir()
	if target == "" || strings.Contains(target, "://") || strings.HasPrefix(strings.ToLower(target), "shell:") {
		return fallback
	}
	clean := filepath.Clean(ExpandHome(target))
	if !filepath.IsAbs(clean) {
		return fallback
	}
	if info, err := os.Stat(clean); err == nil {
		if info.IsDir() {
			return fallback
		}
		return filepath.Dir(clean)
	}
	dir := filepath.Dir(clean)
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		return dir
	}
	return fallback
}
