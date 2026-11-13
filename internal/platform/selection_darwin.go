//go:build darwin

package platform

import (
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

// 用辅助功能接口（Accessibility）读取前台应用里选中的文字：只读，不动剪贴板。
var (
	axOnce sync.Once
	axOK   bool

	axCreateSystemWide    func() uintptr
	axCopyAttributeValue  func(element, attribute uintptr, value *uintptr) int32
	axSetMessagingTimeout func(element uintptr, seconds float32) int32

	cfStringCreateWithCString func(alloc uintptr, cstr string, encoding uint32) uintptr
	cfStringGetLength         func(s uintptr) int
	cfStringGetMaximumSize    func(length int, encoding uint32) int
	cfStringGetCString        func(s uintptr, buf *byte, size int, encoding uint32) bool
	cfGetTypeID               func(v uintptr) uintptr
	cfStringGetTypeID         func() uintptr
	cfReleaseValue            func(v uintptr)

	axAttrFocused, axAttrSelectedText uintptr
)

const cfEncodingUTF8 = 0x08000100

func loadAX() bool {
	axOnce.Do(func() {
		defer func() {
			if recover() != nil {
				axOK = false
			}
		}()
		as, err := purego.Dlopen(appServicesPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		cf, err := purego.Dlopen(coreFoundationLib, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		purego.RegisterLibFunc(&axCreateSystemWide, as, "AXUIElementCreateSystemWide")
		purego.RegisterLibFunc(&axCopyAttributeValue, as, "AXUIElementCopyAttributeValue")
		purego.RegisterLibFunc(&axSetMessagingTimeout, as, "AXUIElementSetMessagingTimeout")
		purego.RegisterLibFunc(&cfStringCreateWithCString, cf, "CFStringCreateWithCString")
		purego.RegisterLibFunc(&cfStringGetLength, cf, "CFStringGetLength")
		purego.RegisterLibFunc(&cfStringGetMaximumSize, cf, "CFStringGetMaximumSizeForEncoding")
		purego.RegisterLibFunc(&cfStringGetCString, cf, "CFStringGetCString")
		purego.RegisterLibFunc(&cfGetTypeID, cf, "CFGetTypeID")
		purego.RegisterLibFunc(&cfStringGetTypeID, cf, "CFStringGetTypeID")
		purego.RegisterLibFunc(&cfReleaseValue, cf, "CFRelease")
		axAttrFocused = cfStringCreateWithCString(0, "AXFocusedUIElement", cfEncodingUTF8)
		axAttrSelectedText = cfStringCreateWithCString(0, "AXSelectedText", cfEncodingUTF8)
		axOK = axAttrFocused != 0 && axAttrSelectedText != 0
	})
	return axOK
}

func cfStringToGo(s uintptr) string {
	n := cfStringGetLength(s)
	if n <= 0 {
		return ""
	}
	size := cfStringGetMaximumSize(n, cfEncodingUTF8) + 1
	buf := make([]byte, size)
	if !cfStringGetCString(s, unsafe.SliceData(buf), size, cfEncodingUTF8) {
		return ""
	}
	for i, b := range buf {
		if b == 0 {
			return string(buf[:i])
		}
	}
	return string(buf)
}

// SelectedText 读取前台应用里选中的文字。
// ok 为 false 表示这个应用不支持通过辅助功能读取（例如部分 Electron 应用），调用者可以再用模拟复制。
// ok 为 true 而文字为空，表示确实没有选中任何内容。
func SelectedText() (text string, ok bool) {
	if !loadAX() || !AccessibilityTrusted() {
		return "", false
	}
	system := axCreateSystemWide()
	if system == 0 {
		return "", false
	}
	defer cfReleaseValue(system)
	// 对方应用卡住时不能拖慢唤出。
	axSetMessagingTimeout(system, 0.15)

	var focused uintptr
	if axCopyAttributeValue(system, axAttrFocused, &focused) != 0 || focused == 0 {
		return "", false
	}
	defer cfReleaseValue(focused)
	var value uintptr
	if axCopyAttributeValue(focused, axAttrSelectedText, &value) != 0 || value == 0 {
		return "", false
	}
	defer cfReleaseValue(value)
	if cfGetTypeID(value) != cfStringGetTypeID() {
		return "", false
	}
	return cfStringToGo(value), true
}

const keyC = 8

// SendCopy 向前台应用发送 ⌘C。事件的修饰键只有 ⌘，不受用户还按着的热键修饰键影响。
func SendCopy() error {
	if err := loadCG(); err != nil {
		return err
	}
	if !AccessibilityTrusted() {
		return ErrNeedAccessibility
	}
	postKey(keyC, cgFlagCommand, nil)
	return nil
}

// WaitClipboardChange 等剪贴板的变更序号变化，返回是否变了。
func WaitClipboardChange(before uint64, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if seq, ok := ClipboardSeq(); ok && seq != before {
			return true
		}
		time.Sleep(8 * time.Millisecond)
	}
	return false
}
