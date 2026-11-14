//go:build windows

package platform

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	ole32    = syscall.NewLazyDLL("ole32.dll")

	procSendInput                  = user32.NewProc("SendInput")
	procGetForegroundWindow        = user32.NewProc("GetForegroundWindow")
	procSetForegroundWindow        = user32.NewProc("SetForegroundWindow")
	procGetWindowTextW             = user32.NewProc("GetWindowTextW")
	procGetWindowThreadProcessID   = user32.NewProc("GetWindowThreadProcessId")
	procGetClipboardSequenceNumber = user32.NewProc("GetClipboardSequenceNumber")
	procRegisterClipboardFormatW   = user32.NewProc("RegisterClipboardFormatW")
	procIsClipboardFormatAvailable = user32.NewProc("IsClipboardFormatAvailable")
	procOpenProcess                = kernel32.NewProc("OpenProcess")
	procCloseHandle                = kernel32.NewProc("CloseHandle")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
	procShellExecuteW              = shell32.NewProc("ShellExecuteW")
	procCoInitializeEx             = ole32.NewProc("CoInitializeEx")
	procCoUninitialize             = ole32.NewProc("CoUninitialize")
)

const (
	inputKeyboard   = 1
	keyEventUp      = 0x0002
	keyEventUnicode = 0x0004
	vkControl       = 0x11
	vkV             = 0x56

	createNoWindow          = 0x08000000
	createNewProcessGroup   = 0x00000200
	processQueryLimitedInfo = 0x1000
	swShowNormal            = 1
	coinitApartmentThreaded = 0x2
	coinitDisableOle1Dde    = 0x4
)

// keybdInput 对应 Win32 的 KEYBDINPUT。
type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

// input 对应 64 位下的 INPUT（4 字节类型 + 4 字节对齐 + 32 字节联合体）。
type input struct {
	inputType uint32
	_         uint32
	ki        keybdInput
	_         [8]byte
}

func sendInputs(in []input) {
	if len(in) == 0 {
		return
	}
	procSendInput.Call(uintptr(len(in)), uintptr(unsafe.Pointer(&in[0])), unsafe.Sizeof(in[0]))
}

var frontWindow atomic.Uintptr

// CaptureFront 在显示面板前记住前台窗口，粘贴时要把焦点还给它。
func CaptureFront() {
	hwnd, _, _ := procGetForegroundWindow.Call()
	frontWindow.Store(hwnd)
}

// RestoreFront 把焦点还给之前的前台窗口。
func RestoreFront() {
	if hwnd := frontWindow.Load(); hwnd != 0 {
		procSetForegroundWindow.Call(hwnd)
	}
}

// AccessibilityTrusted 在 Windows 上不需要额外权限。
func AccessibilityTrusted() bool { return true }

// OpenAccessibilitySettings 在 Windows 上无事可做。
func OpenAccessibilitySettings() {}

// SendPaste 向前台窗口发送 Ctrl+V。目标窗口以管理员运行时系统会拦截，这种情况内容仍在剪贴板里。
func SendPaste() error {
	RestoreFront()
	time.Sleep(60 * time.Millisecond)
	sendInputs([]input{
		{inputType: inputKeyboard, ki: keybdInput{wVk: vkControl}},
		{inputType: inputKeyboard, ki: keybdInput{wVk: vkV}},
		{inputType: inputKeyboard, ki: keybdInput{wVk: vkV, dwFlags: keyEventUp}},
		{inputType: inputKeyboard, ki: keybdInput{wVk: vkControl, dwFlags: keyEventUp}},
	})
	return nil
}

// SendText 向前台窗口模拟键入文本。
func SendText(text string) error {
	RestoreFront()
	time.Sleep(60 * time.Millisecond)
	units := utf16.Encode([]rune(text))
	in := make([]input, 0, len(units)*2)
	for _, u := range units {
		in = append(in,
			input{inputType: inputKeyboard, ki: keybdInput{wScan: u, dwFlags: keyEventUnicode}},
			input{inputType: inputKeyboard, ki: keybdInput{wScan: u, dwFlags: keyEventUnicode | keyEventUp}},
		)
	}
	sendInputs(in)
	return nil
}

// FrontApp 返回当前前台应用。
func FrontApp() App {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return App{}
	}
	var app App
	buf := make([]uint16, 512)
	if n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf))); n > 0 {
		app.Title = syscall.UTF16ToString(buf[:n])
	}
	var pid uint32
	procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid != 0 {
		h, _, _ := procOpenProcess.Call(processQueryLimitedInfo, 0, uintptr(pid))
		if h != 0 {
			size := uint32(len(buf))
			if ok, _, _ := procQueryFullProcessImageNameW.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size))); ok != 0 {
				app.Name = filepath.Base(syscall.UTF16ToString(buf[:size]))
			}
			procCloseHandle.Call(h)
		}
	}
	return app
}

// ClipboardSeq 返回剪贴板的变更序号。
func ClipboardSeq() (uint64, bool) {
	n, _, _ := procGetClipboardSequenceNumber.Call()
	return uint64(n), true
}

var concealedFormats = func() []uintptr {
	var out []uintptr
	for _, name := range []string{"ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "Clipboard Viewer Ignore"} {
		p, err := syscall.UTF16PtrFromString(name)
		if err != nil {
			continue
		}
		f, _, _ := procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(p)))
		if f != 0 {
			out = append(out, f)
		}
	}
	return out
}()

// ClipboardConcealed 判断当前剪贴板内容是否带「不要记录」标记。
func ClipboardConcealed() bool {
	for _, f := range concealedFormats {
		if ok, _, _ := procIsClipboardFormatAvailable.Call(f); ok != 0 {
			return true
		}
	}
	return false
}

func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// taskkill /T 连同子进程一起结束。
		kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
		kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
		if err := kill.Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
	cmd.WaitDelay = 2 * time.Second
}

func prepareDetachedCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow | createNewProcessGroup,
	}
}

func utf16PtrOpt(s string) (*uint16, error) {
	if s == "" {
		return nil, nil
	}
	return syscall.UTF16PtrFromString(s)
}

// ShellOpen 通过 ShellExecuteW 打开应用、文件或链接，并显式指定工作目录。
// 避免 lpDirectory 为 NULL 时子进程继承启动器所在目录而造成目录锁定。
func ShellOpen(verb, target string) error {
	if target == "" {
		return fmt.Errorf("打开目标不能为空")
	}
	dir := WorkDir(target)
	vPtr, err := utf16PtrOpt(verb)
	if err != nil {
		return err
	}
	tPtr, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	dPtr, err := utf16PtrOpt(dir)
	if err != nil {
		return err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if hr, _, _ := procCoInitializeEx.Call(0, coinitApartmentThreaded|coinitDisableOle1Dde); int32(hr) >= 0 {
		defer procCoUninitialize.Call()
	}

	r, _, _ := procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(vPtr)),
		uintptr(unsafe.Pointer(tPtr)),
		0,
		uintptr(unsafe.Pointer(dPtr)),
		swShowNormal,
	)
	runtime.KeepAlive(vPtr)
	runtime.KeepAlive(tPtr)
	runtime.KeepAlive(dPtr)
	if r <= 32 {
		return fmt.Errorf("打开 %s 失败（错误码 %d）", target, r)
	}
	return nil
}

func powershell() string {
	if p := LookFirst("pwsh.exe"); p != "" {
		return p
	}
	return LookFirst("powershell.exe")
}

// ShellCommand 用 PowerShell 执行一行命令，输出统一成 UTF-8。
func ShellCommand(ctx context.Context, line string) *exec.Cmd {
	if ps := powershell(); ps != "" {
		return Command(ctx, ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
			"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"+line)
	}
	return Command(ctx, "cmd", "/c", "chcp 65001 >nul & "+line)
}

// Interpreter 返回扩展名默认的解释器。
func Interpreter(ext string) []string {
	switch ext {
	case ".ps1":
		if ps := powershell(); ps != "" {
			return []string{ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}
		}
	case ".py":
		if p := LookFirst("python.exe", "python3.exe", "py.exe"); p != "" {
			return []string{p}
		}
	case ".js", ".mjs", ".cjs":
		return []string{"node"}
	case ".ts":
		if p := LookFirst("bun.exe", "deno.exe"); strings.HasSuffix(strings.ToLower(p), "deno.exe") {
			return []string{p, "run", "-A"}
		} else if p != "" {
			return []string{p}
		}
	case ".sh":
		for _, p := range []string{
			filepath.Join(os.Getenv("ProgramFiles"), "Git", "bin", "bash.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Git", "bin", "bash.exe"),
		} {
			if _, err := os.Stat(p); err == nil {
				return []string{p}
			}
		}
		if p := LookFirst("bash.exe"); p != "" {
			return []string{p}
		}
	case ".bat", ".cmd":
		return []string{"cmd", "/c"}
	case ".lnk":
		return []string{"cmd", "/c", "start", ""} // 快捷方式不能直接执行，交给系统打开
	case ".ahk":
		if p := LookFirst("AutoHotkey64.exe", "AutoHotkey.exe"); p != "" {
			return []string{p}
		}
	case ".rb":
		return []string{"ruby"}
	case ".pl":
		return []string{"perl"}
	case ".php":
		return []string{"php"}
	case ".lua":
		return []string{"lua"}
	}
	return nil
}

// OpenInEditor 用默认编辑器打开文件。
func OpenInEditor(path string) error {
	dir := WorkDir(path)
	for _, editor := range []string{"code.cmd", "notepad++.exe"} {
		if p := LookFirst(editor); p != "" {
			cmd := DetachedCommand(p, path)
			cmd.Dir = dir
			return cmd.Start()
		}
	}
	cmd := DetachedCommand("notepad.exe", path)
	cmd.Dir = dir
	return cmd.Start()
}

// FixPath 在 Windows 上不需要处理。
func FixPath() {}

type osVersionInfo struct {
	size, major, minor, build, platformID uint32
	csd                                   [128]uint16
}

// GlassSupported 报告系统能否显示窗口材质：需要 Windows 11 22H2（build 22621）及以上。
func GlassSupported() bool {
	info := osVersionInfo{}
	info.size = uint32(unsafe.Sizeof(info))
	proc := syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion")
	if err := proc.Find(); err != nil {
		return false
	}
	proc.Call(uintptr(unsafe.Pointer(&info)))
	return info.major >= 10 && info.build >= 22621
}

// ScreenCaptureAllowed 在 Windows 上不需要额外权限。
func ScreenCaptureAllowed() bool { return true }

// RequestScreenCapture 在 Windows 上无事可做。
func RequestScreenCapture() {}

// CaptureRegion 在 Windows 上由应用层调用系统的截图工具（ms-screenclip），这里不处理。
func CaptureRegion(context.Context, string) (bool, error) { return false, ErrUnsupported }
