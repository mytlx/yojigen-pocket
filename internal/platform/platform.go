// Package platform 封装各操作系统的差异：模拟按键、前台应用、进程管理等。
// 全部用纯 Go 实现（darwin 通过 purego 调系统框架，windows 通过 syscall 调 user32），不需要 cgo。
package platform

import (
	"context"
	"errors"
	"os"
	"os/exec"
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
