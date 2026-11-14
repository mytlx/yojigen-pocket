package platform

import (
	"errors"
	"unsafe"
)

var (
	procGetCursorPos   = user32.NewProc("GetCursorPos")
	procSetCursorPos   = user32.NewProc("SetCursorPos")
	procMapVirtualKeyW = user32.NewProc("MapVirtualKeyW")
)

// mouseInput 对应 64 位下鼠标用的 INPUT：4 字节类型 + 4 字节对齐 + MOUSEINPUT（32 字节），一共 40 字节，
// 和键盘用的 input 一样大。
type mouseInput struct {
	inputType uint32
	_         uint32
	dx, dy    int32
	mouseData uint32
	flags     uint32
	time      uint32
	_         uint32
	extra     uintptr
}

const (
	inputMouse      = 0
	mouseLeftDown   = 0x0002
	mouseLeftUp     = 0x0004
	mouseRightDown  = 0x0008
	mouseRightUp    = 0x0010
	mouseMiddleDown = 0x0020
	mouseMiddleUp   = 0x0040
	mouseWheel      = 0x0800
	wheelDelta      = 120
	keyEventExtend  = 0x0001
	keyEventScan    = 0x0008
)

// InputAllowed 报告现在能不能模拟输入。Windows 上不需要额外授权（对以管理员身份运行的窗口无效）。
func InputAllowed() bool { return true }

// MousePos 返回鼠标现在的位置。
func MousePos() (x, y int, ok bool) {
	var pt struct{ X, Y int32 }
	r, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	return int(pt.X), int(pt.Y), r != 0
}

// MouseMove 把鼠标移到指定位置。
func MouseMove(x, y int) error {
	if r, _, _ := procSetCursorPos.Call(uintptr(x), uintptr(y)); r == 0 {
		return errors.New("移动鼠标失败")
	}
	return nil
}

func sendMouse(flags, data uint32) error {
	in := mouseInput{inputType: inputMouse, flags: flags, mouseData: data}
	if r, _, _ := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in)); r == 0 {
		return errors.New("系统拒绝了这次模拟输入（目标窗口可能以管理员身份运行）")
	}
	return nil
}

// MouseButton 在鼠标当前位置按下或松开一个键。Windows 自己按时间间隔判断双击，clicks 用不上。
func MouseButton(button string, down bool, _ int) error {
	var flags uint32
	switch button {
	case "left":
		flags = mouseLeftDown
	case "right":
		flags = mouseRightDown
	case "middle":
		flags = mouseMiddleDown
	default:
		return errors.New("不认识的鼠标按键：" + button)
	}
	if !down {
		flags <<= 1
	}
	return sendMouse(flags, 0)
}

// MouseScroll 滚动滚轮，正数向上。
func MouseScroll(lines int) error {
	return sendMouse(mouseWheel, uint32(int32(lines*wheelDelta)))
}

// 按键名 → 虚拟键码。高位的 0x100 标记“扩展键”（方向键、右边的 Ctrl / Alt 等）。
var keyTable = func() map[string]uint16 {
	m := map[string]uint16{
		"Enter": 0x0D, "Tab": 0x09, "Space": 0x20, "Backspace": 0x08, "Escape": 0x1B, "CapsLock": 0x14,
		"Delete": 0x12E, "Insert": 0x12D, "Home": 0x124, "End": 0x123, "PageUp": 0x121, "PageDown": 0x122,
		"ArrowLeft": 0x125, "ArrowUp": 0x126, "ArrowRight": 0x127, "ArrowDown": 0x128,
		"ShiftLeft": 0xA0, "ShiftRight": 0xA1, "ControlLeft": 0xA2, "ControlRight": 0x1A3, "AltLeft": 0xA4, "AltRight": 0x1A5,
		"MetaLeft": 0x15B, "MetaRight": 0x15C, "ContextMenu": 0x15D, "PrintScreen": 0x12C, "Pause": 0x13, "ScrollLock": 0x91, "NumLock": 0x190,
		"Semicolon": 0xBA, "Equal": 0xBB, "Comma": 0xBC, "Minus": 0xBD, "Period": 0xBE, "Slash": 0xBF, "Backquote": 0xC0,
		"BracketLeft": 0xDB, "Backslash": 0xDC, "BracketRight": 0xDD, "Quote": 0xDE,
		"NumpadMultiply": 0x6A, "NumpadAdd": 0x6B, "NumpadSubtract": 0x6D, "NumpadDecimal": 0x6E, "NumpadDivide": 0x16F, "NumpadEnter": 0x10D,
	}
	for c := 'A'; c <= 'Z'; c++ {
		m["Key"+string(c)] = uint16(c)
	}
	for d := '0'; d <= '9'; d++ {
		m["Digit"+string(d)] = uint16(d)
		m["Numpad"+string(d)] = uint16(0x60 + d - '0')
	}
	names := []string{"F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24"}
	for i, n := range names {
		m[n] = uint16(0x70 + i)
	}
	return m
}()

// KeyEvent 按下或松开一个键。同时带上扫描码：有些程序（尤其是游戏）只认扫描码。
func KeyEvent(code string, down bool) error {
	v, ok := keyTable[code]
	if !ok {
		return errors.New("这个键模拟不了：" + code)
	}
	vk := v & 0xFF
	scan, _, _ := procMapVirtualKeyW.Call(uintptr(vk), 0)
	var flags uint32
	if v&0x100 != 0 {
		flags |= keyEventExtend
	}
	if !down {
		flags |= keyEventUp
	}
	in := input{inputType: inputKeyboard, ki: keybdInput{wVk: vk, wScan: uint16(scan), dwFlags: flags}}
	if r, _, _ := procSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in)); r == 0 {
		return errors.New("系统拒绝了这次模拟输入（目标窗口可能以管理员身份运行）")
	}
	return nil
}
