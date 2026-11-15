//go:build darwin

package platform

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// macOS 的隐私权限（TCC）有几个容易让人摸不着头脑的地方，这个文件里的函数都是为它们准备的：
//
//  1. 授权是记在“签名”上的。没有开发者签名的应用（ad-hoc 签名）每次构建的签名都不一样，
//     更新或重装之后，系统设置里的开关看着还开着，其实认的是旧版本，新版本仍然没有权限。
//     只能把旧记录清掉（ResetPermission）再重新授权。
//  2. 屏幕录制权限在进程启动时读一次，授权后要重启应用才生效。
//  3. 别的应用的数据目录（~/Library/Containers/…，比如微信收到的文件）受“完全磁盘访问”保护：
//     没有这个权限的程序去查聚焦（Spotlight），这些目录里的结果会被系统悄悄去掉。

// FullDiskAccess 报告有没有“完全磁盘访问权限”。
//
// 没有公开的接口可查，通行的做法是试着打开一个只有拿到这个权限才读得了的文件。
// 这个文件读不了时系统直接拒绝，不会弹窗。
func FullDiskAccess() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return true
	}
	f, err := os.Open(filepath.Join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db"))
	if err == nil {
		_ = f.Close()
		return true
	}
	// 文件不在（系统版本不同）时说不准，当成有，免得一直提示。
	return !errors.Is(err, fs.ErrPermission)
}

// OpenFullDiskAccessSettings 打开系统设置里的“完全磁盘访问权限”。
func OpenFullDiskAccessSettings() {
	_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles").Start()
}

// bundlePath 返回应用包的路径（…/X.app）。直接运行可执行文件（开发时）返回空。
func bundlePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	dir := filepath.Dir(exe) // …/X.app/Contents/MacOS
	if filepath.Base(dir) != "MacOS" || filepath.Base(filepath.Dir(dir)) != "Contents" {
		return ""
	}
	app := filepath.Dir(filepath.Dir(dir))
	if !strings.HasSuffix(app, ".app") {
		return ""
	}
	return app
}

var (
	adhocOnce sync.Once
	adhoc     bool
)

// AdHocSigned 报告应用是不是没有固定的签名（ad-hoc）。是的话，每次更新后都得重新授权。
func AdHocSigned() bool {
	adhocOnce.Do(func() {
		app := bundlePath()
		if app == "" {
			return
		}
		out, _ := exec.Command("/usr/bin/codesign", "-dv", app).CombinedOutput()
		adhoc = strings.Contains(string(out), "Signature=adhoc")
	})
	return adhoc
}

var tccServices = map[string]string{"accessibility": "Accessibility", "screen": "ScreenCapture"}

// ResetPermission 清掉系统里这个应用的某项授权记录（kind：accessibility | screen），
// 用来处理“系统设置里明明开着、应用却说没有权限”的情况。清掉之后要重新授权。
func ResetPermission(kind string) error {
	service, ok := tccServices[kind]
	if !ok {
		return errors.New("不认识的权限：" + kind)
	}
	app := bundlePath()
	if app == "" {
		return errors.New("现在运行的不是打包好的应用，系统没有给它单独记授权")
	}
	// 授权是按应用的标识符记的，从应用包里读出来。
	id, err := exec.Command("/usr/bin/defaults", "read", filepath.Join(app, "Contents", "Info"), "CFBundleIdentifier").Output()
	bundleID := strings.TrimSpace(string(id))
	if err != nil || bundleID == "" {
		return errors.New("读不到应用的标识符")
	}
	if out, err := exec.Command("/usr/bin/tccutil", "reset", service, bundleID).CombinedOutput(); err != nil {
		return errors.New("重置失败：" + strings.TrimSpace(string(out)))
	}
	return nil
}

// PromptAccessibility 让系统弹出“想要控制这台电脑”的提示，并把应用加进辅助功能的列表里
// （只是加进去，开关要用户自己打开）。重置授权之后调用它，用户就不用自己去点“+”找应用。
func PromptAccessibility() {
	as, err := purego.Dlopen(appServicesPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return
	}
	cf, err := purego.Dlopen(coreFoundationLib, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return
	}
	sym := func(lib uintptr, name string) uintptr {
		p, _ := purego.Dlsym(lib, name)
		return p
	}
	trusted := sym(as, "AXIsProcessTrustedWithOptions")
	keyVar := sym(as, "kAXTrustedCheckOptionPrompt")
	trueVar := sym(cf, "kCFBooleanTrue")
	create := sym(cf, "CFDictionaryCreate")
	keyCB := sym(cf, "kCFTypeDictionaryKeyCallBacks")
	valCB := sym(cf, "kCFTypeDictionaryValueCallBacks")
	release := sym(cf, "CFRelease")
	if trusted == 0 || keyVar == 0 || trueVar == 0 || create == 0 || keyCB == 0 || valCB == 0 {
		return
	}
	// 这两个符号是“指向常量的变量”，要再取一次值。
	keys := [1]uintptr{*(*uintptr)(unsafe.Add(unsafe.Pointer(nil), keyVar))}
	vals := [1]uintptr{*(*uintptr)(unsafe.Add(unsafe.Pointer(nil), trueVar))}
	dict, _, _ := purego.SyscallN(create, 0, uintptr(unsafe.Pointer(&keys[0])), uintptr(unsafe.Pointer(&vals[0])), 1, keyCB, valCB)
	if dict == 0 {
		return
	}
	purego.SyscallN(trusted, dict)
	if release != 0 {
		purego.SyscallN(release, dict)
	}
}
