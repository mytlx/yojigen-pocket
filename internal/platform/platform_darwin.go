//go:build darwin

package platform

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

const (
	cgHIDEventTap     = 0
	cgStateHID        = 1
	cgFlagCommand     = 0x100000
	keyV              = 9
	coreGraphicsPath  = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
	appServicesPath   = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
	coreFoundationLib = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
)

var (
	cgOnce sync.Once
	cgErr  error

	cgEventSourceCreate          uintptr
	cgEventCreateKeyboardEvent   uintptr
	cgEventSetFlags              uintptr
	cgEventPost                  uintptr
	cgEventKeyboardSetUnicodeStr uintptr
	cfRelease                    uintptr
	axIsProcessTrusted           uintptr
)

func loadCG() error {
	cgOnce.Do(func() {
		cg, err := purego.Dlopen(coreGraphicsPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			cgErr = err
			return
		}
		cf, err := purego.Dlopen(coreFoundationLib, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			cgErr = err
			return
		}
		as, err := purego.Dlopen(appServicesPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			cgErr = err
			return
		}
		for _, s := range []struct {
			lib  uintptr
			name string
			into *uintptr
		}{
			{cg, "CGEventSourceCreate", &cgEventSourceCreate},
			{cg, "CGEventCreateKeyboardEvent", &cgEventCreateKeyboardEvent},
			{cg, "CGEventSetFlags", &cgEventSetFlags},
			{cg, "CGEventPost", &cgEventPost},
			{cg, "CGEventKeyboardSetUnicodeString", &cgEventKeyboardSetUnicodeStr},
			{cf, "CFRelease", &cfRelease},
			{as, "AXIsProcessTrusted", &axIsProcessTrusted},
		} {
			p, err := purego.Dlsym(s.lib, s.name)
			if err != nil {
				cgErr = err
				return
			}
			*s.into = p
		}
	})
	return cgErr
}

// AccessibilityTrusted 报告应用是否有辅助功能权限（模拟按键需要）。
func AccessibilityTrusted() bool {
	if loadCG() != nil {
		return false
	}
	r, _, _ := purego.SyscallN(axIsProcessTrusted)
	return r&0xff != 0
}

// OpenAccessibilitySettings 打开系统的辅助功能设置页。
func OpenAccessibilitySettings() {
	_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").Start()
}

// ErrNeedAccessibility 表示缺少辅助功能权限。
var ErrNeedAccessibility = errors.New("需要在「系统设置 → 隐私与安全性 → 辅助功能」中允许本应用")

func postKey(code uintptr, flags uint64, text []uint16) {
	source, _, _ := purego.SyscallN(cgEventSourceCreate, cgStateHID)
	for _, down := range []uintptr{1, 0} {
		ev, _, _ := purego.SyscallN(cgEventCreateKeyboardEvent, source, code, down)
		if ev == 0 {
			continue
		}
		if flags != 0 {
			purego.SyscallN(cgEventSetFlags, ev, uintptr(flags))
		}
		if len(text) > 0 {
			purego.SyscallN(cgEventKeyboardSetUnicodeStr, ev, uintptr(len(text)), uintptr(unsafe.Pointer(&text[0])))
		}
		purego.SyscallN(cgEventPost, cgHIDEventTap, ev)
		purego.SyscallN(cfRelease, ev)
	}
	if source != 0 {
		purego.SyscallN(cfRelease, source)
	}
}

// SendPaste 向前台应用发送 ⌘V。
func SendPaste() error {
	if err := loadCG(); err != nil {
		return err
	}
	if !AccessibilityTrusted() {
		return ErrNeedAccessibility
	}
	// 等面板让出键盘焦点。
	time.Sleep(40 * time.Millisecond)
	postKey(keyV, cgFlagCommand, nil)
	return nil
}

// SendText 向前台应用模拟键入文本。
func SendText(text string) error {
	if err := loadCG(); err != nil {
		return err
	}
	if !AccessibilityTrusted() {
		return ErrNeedAccessibility
	}
	time.Sleep(40 * time.Millisecond)
	units := utf16.Encode([]rune(text))
	for len(units) > 0 {
		n := min(len(units), 16)
		postKey(0, 0, units[:n])
		units = units[n:]
		time.Sleep(4 * time.Millisecond)
	}
	return nil
}

// CaptureFront 在显示面板前记住前台窗口。macOS 的面板不抢激活状态，不需要记录。
func CaptureFront() {}

// RestoreFront 把焦点还给之前的前台窗口。macOS 上隐藏面板即可。
func RestoreFront() {}

// FrontApp 返回当前前台应用。使用 lsappinfo，不需要任何权限，通常十几毫秒。
func FrontApp() App {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	asn, err := exec.CommandContext(ctx, "lsappinfo", "front").Output()
	if err != nil {
		return App{}
	}
	out, err := exec.CommandContext(ctx, "lsappinfo", "info", "-only", "name", strings.TrimSpace(string(asn))).Output()
	if err != nil {
		return App{}
	}
	// 输出形如："LSDisplayName"="Safari"
	_, name, ok := strings.Cut(strings.TrimSpace(string(out)), "=")
	if !ok {
		return App{}
	}
	return App{Name: strings.Trim(name, `"`)}
}

var (
	pasteboardOnce sync.Once
	pasteboard     objc.ID
	selChangeCount objc.SEL
	selTypes       objc.SEL
	selCount       objc.SEL
	selObjectAt    objc.SEL
	selUTF8        objc.SEL
)

func loadPasteboard() bool {
	pasteboardOnce.Do(func() {
		if _, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
			return
		}
		cls := objc.GetClass("NSPasteboard")
		if cls == 0 {
			return
		}
		pasteboard = objc.ID(cls).Send(objc.RegisterName("generalPasteboard"))
		selChangeCount = objc.RegisterName("changeCount")
		selTypes = objc.RegisterName("types")
		selCount = objc.RegisterName("count")
		selObjectAt = objc.RegisterName("objectAtIndex:")
		selUTF8 = objc.RegisterName("UTF8String")
	})
	return pasteboard != 0
}

// ClipboardSeq 返回剪贴板的变更序号。内容变化时序号变化，读取它几乎没有开销。
func ClipboardSeq() (uint64, bool) {
	if !loadPasteboard() {
		return 0, false
	}
	return uint64(pasteboard.Send(selChangeCount)), true
}

// ClipboardConcealed 判断当前剪贴板内容是否带「不要记录」标记（密码管理器复制密码时会打）。
func ClipboardConcealed() bool {
	if !loadPasteboard() {
		return false
	}
	types := pasteboard.Send(selTypes)
	if types == 0 {
		return false
	}
	n := int(types.Send(selCount))
	for i := range n {
		t := types.Send(selObjectAt, i)
		if t == 0 {
			continue
		}
		p := t.Send(selUTF8)
		if p == 0 {
			continue
		}
		name := cString(uintptr(p))
		switch name {
		case "org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType",
			"com.agilebits.onepassword", "com.typeit4me.clipping":
			return true
		}
	}
	return false
}

func cString(p uintptr) string {
	var b []byte
	for i := uintptr(0); i < 512; i++ {
		c := *(*byte)(unsafe.Add(unsafe.Pointer(nil), p+i))
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// 负数 pid：杀掉整个进程组，不留孤儿进程。
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = 2 * time.Second
}

func prepareDetachedCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// ShellOpen 在非 Windows 平台由上层交由 mygo.Shell 处理。
func ShellOpen(_, _ string) error { return ErrUnsupported }

// ShellCommand 用用户的 shell 执行一行命令。
func ShellCommand(ctx context.Context, line string) *exec.Cmd {
	shell := LookFirst("zsh", "bash", "sh")
	return Command(ctx, shell, "-lc", line)
}

// Interpreter 返回扩展名默认的解释器。
func Interpreter(ext string) []string {
	switch ext {
	case ".sh":
		return []string{"/bin/bash"}
	case ".zsh":
		return []string{"/bin/zsh"}
	case ".py":
		return []string{"python3"}
	case ".js", ".mjs", ".cjs":
		return []string{"node"}
	case ".ts":
		if p := LookFirst("bun", "deno"); strings.HasSuffix(p, "deno") {
			return []string{p, "run", "-A"}
		} else if p != "" {
			return []string{p}
		}
		return nil
	case ".rb":
		return []string{"ruby"}
	case ".pl":
		return []string{"perl"}
	case ".php":
		return []string{"php"}
	case ".lua":
		return []string{"lua"}
	case ".applescript", ".scpt":
		return []string{"osascript"}
	case ".ps1":
		if p := LookFirst("pwsh"); p != "" {
			return []string{p, "-NoProfile", "-File"}
		}
	}
	return nil
}

// OpenInEditor 用默认编辑器打开文件。
func OpenInEditor(path string) error {
	if err := exec.Command("open", "-t", path).Start(); err != nil {
		return fmt.Errorf("打开编辑器失败：%w", err)
	}
	return nil
}

// FixPath 补全 PATH。从 Finder 启动的应用只有最小的 PATH，找不到 brew、nvm 装的解释器。
func FixPath() {
	addPath("/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin")
	go func() {
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/zsh"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, shell, "-ilc", "printf '%s' \"$PATH\"").Output()
		if err == nil {
			addPath(strings.Split(strings.TrimSpace(string(out)), ":")...)
		}
	}()
}

func addPath(dirs ...string) {
	current := strings.Split(os.Getenv("PATH"), ":")
	for _, d := range dirs {
		if d != "" && !slices.Contains(current, d) {
			current = append(current, d)
		}
	}
	_ = os.Setenv("PATH", strings.Join(current, ":"))
}

// GlassSupported 报告系统能否显示窗口材质。
func GlassSupported() bool { return true }

var (
	screenOnce     sync.Once
	cgPreflightCap uintptr
	cgRequestCap   uintptr
)

func loadScreenCapture() {
	screenOnce.Do(func() {
		if loadCG() != nil {
			return
		}
		cg, err := purego.Dlopen(coreGraphicsPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		cgPreflightCap, _ = purego.Dlsym(cg, "CGPreflightScreenCaptureAccess")
		cgRequestCap, _ = purego.Dlsym(cg, "CGRequestScreenCaptureAccess")
	})
}

// ScreenCaptureAllowed 报告是否有「屏幕录制」权限。没有时截图只能截到桌面背景。
func ScreenCaptureAllowed() bool {
	loadScreenCapture()
	if cgPreflightCap == 0 {
		return true
	}
	r, _, _ := purego.SyscallN(cgPreflightCap)
	return r&0xff != 0
}

// RequestScreenCapture 请求「屏幕录制」权限（系统会弹出提示），并打开对应的设置页。
func RequestScreenCapture() {
	loadScreenCapture()
	if cgRequestCap != 0 {
		purego.SyscallN(cgRequestCap)
	}
	_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").Start()
}

// CaptureRegion 让用户框选屏幕区域并保存成 PNG。返回 false 表示用户取消了。
func CaptureRegion(ctx context.Context, path string) (bool, error) {
	cmd := exec.CommandContext(ctx, "screencapture", "-i", "-x", path)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	_ = cmd.Run() // 用户按 Esc 取消时退出码也不是 0，所以只看有没有截出图
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		return true, nil
	}
	if msg := strings.TrimSpace(stderr.String()); msg != "" && ctx.Err() == nil {
		return false, errors.New(msg)
	}
	return false, nil
}
