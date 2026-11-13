//go:build !darwin && !windows

package platform

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

// 目前只正式支持 Windows 和 macOS。其他系统保留一层可编译的实现。

func AccessibilityTrusted() bool   { return false }
func OpenAccessibilitySettings()   {}
func SendPaste() error             { return ErrUnsupported }
func SendText(string) error        { return ErrUnsupported }
func CaptureFront()                {}
func RestoreFront()                {}
func FrontApp() App                { return App{} }
func ClipboardSeq() (uint64, bool) { return 0, false }
func ClipboardConcealed() bool     { return false }

func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
}

// ShellCommand 用 sh 执行一行命令。
func ShellCommand(ctx context.Context, line string) *exec.Cmd {
	return Command(ctx, "sh", "-c", line)
}

// Interpreter 返回扩展名默认的解释器。
func Interpreter(ext string) []string {
	switch ext {
	case ".sh":
		return []string{"sh"}
	case ".py":
		return []string{"python3"}
	case ".js", ".mjs":
		return []string{"node"}
	}
	return nil
}

// OpenInEditor 用默认程序打开文件。
func OpenInEditor(path string) error {
	return exec.Command("xdg-open", path).Start()
}

// FixPath 无需处理。
func FixPath() {}

// GlassSupported 其他系统没有窗口材质。
func GlassSupported() bool { return false }

// ScreenCaptureAllowed 其他系统不检查。
func ScreenCaptureAllowed() bool { return true }

// RequestScreenCapture 其他系统无事可做。
func RequestScreenCapture() {}

// CaptureRegion 其他系统不支持。
func CaptureRegion(context.Context, string) (bool, error) { return false, ErrUnsupported }
