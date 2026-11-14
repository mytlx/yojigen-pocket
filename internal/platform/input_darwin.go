package platform

import (
	"errors"
	"sync"

	"github.com/ebitengine/purego"
)

type cgPoint struct{ X, Y float64 }

var (
	inputOnce sync.Once
	inputErr  error

	cgEventCreate                  func(source uintptr) uintptr
	cgEventGetLocation             func(event uintptr) cgPoint
	cgEventCreateMouseEvent        func(source uintptr, mouseType uint32, pos cgPoint, button uint32) uintptr
	cgEventSetIntegerValueField    func(event uintptr, field uint32, value int64)
	cgEventCreateScrollWheelEvent2 func(source uintptr, units uint32, wheelCount uint32, wheel1, wheel2, wheel3 int32) uintptr
	cgEventPostFn                  func(tap uint32, event uintptr)
	cgEventCreateKeyboard          func(source uintptr, key uint16, down bool) uintptr
	cgEventSetFlagsFn              func(event uintptr, flags uint64)
	cfReleaseFn                    func(ref uintptr)
)

const (
	cgMouseEventClickState = 1
	cgScrollUnitLine       = 1
)

func loadInput() error {
	inputOnce.Do(func() {
		defer func() {
			if r := recover(); r != nil {
				inputErr = errors.New("加载系统的输入接口失败")
			}
		}()
		cg, err := purego.Dlopen(coreGraphicsPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			inputErr = err
			return
		}
		cf, err := purego.Dlopen(coreFoundationLib, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			inputErr = err
			return
		}
		purego.RegisterLibFunc(&cgEventCreate, cg, "CGEventCreate")
		purego.RegisterLibFunc(&cgEventGetLocation, cg, "CGEventGetLocation")
		purego.RegisterLibFunc(&cgEventCreateMouseEvent, cg, "CGEventCreateMouseEvent")
		purego.RegisterLibFunc(&cgEventSetIntegerValueField, cg, "CGEventSetIntegerValueField")
		purego.RegisterLibFunc(&cgEventCreateScrollWheelEvent2, cg, "CGEventCreateScrollWheelEvent2")
		purego.RegisterLibFunc(&cgEventPostFn, cg, "CGEventPost")
		purego.RegisterLibFunc(&cgEventCreateKeyboard, cg, "CGEventCreateKeyboardEvent")
		purego.RegisterLibFunc(&cgEventSetFlagsFn, cg, "CGEventSetFlags")
		purego.RegisterLibFunc(&cfReleaseFn, cf, "CFRelease")
	})
	return inputErr
}

// InputAllowed 报告现在能不能模拟输入。macOS 上需要“辅助功能”权限。
func InputAllowed() bool { return AccessibilityTrusted() }

// MousePos 返回鼠标现在的位置（屏幕坐标，原点在主屏左上角）。只读，不需要权限。
func MousePos() (x, y int, ok bool) {
	if loadInput() != nil {
		return 0, 0, false
	}
	ev := cgEventCreate(0)
	if ev == 0 {
		return 0, 0, false
	}
	defer cfReleaseFn(ev)
	p := cgEventGetLocation(ev)
	return int(p.X + 0.5), int(p.Y + 0.5), true
}

func ready() error {
	if err := loadInput(); err != nil {
		return err
	}
	if !AccessibilityTrusted() {
		return ErrNeedAccessibility
	}
	return nil
}

func postMouse(kind uint32, x, y int, button uint32, clicks int) {
	ev := cgEventCreateMouseEvent(0, kind, cgPoint{float64(x), float64(y)}, button)
	if ev == 0 {
		return
	}
	if clicks > 0 {
		cgEventSetIntegerValueField(ev, cgMouseEventClickState, int64(clicks))
	}
	cgEventPostFn(cgHIDEventTap, ev)
	cfReleaseFn(ev)
}

// MouseMove 把鼠标移到指定位置。
func MouseMove(x, y int) error {
	if err := ready(); err != nil {
		return err
	}
	postMouse(5, x, y, 0, 0) // kCGEventMouseMoved
	return nil
}

// MouseButton 在鼠标当前位置按下或松开一个键。clicks 是这是连续的第几下（双击的第二下传 2）。
func MouseButton(button string, down bool, clicks int) error {
	if err := ready(); err != nil {
		return err
	}
	x, y, ok := MousePos()
	if !ok {
		return errors.New("读不到鼠标位置")
	}
	var kind, btn uint32
	switch button {
	case "left":
		kind, btn = 1, 0
	case "right":
		kind, btn = 3, 1
	case "middle":
		kind, btn = 25, 2
	default:
		return errors.New("不认识的鼠标按键：" + button)
	}
	if !down {
		kind++
	}
	postMouse(kind, x, y, btn, max(clicks, 1))
	return nil
}

// MouseScroll 滚动滚轮，正数向上。
func MouseScroll(lines int) error {
	if err := ready(); err != nil {
		return err
	}
	ev := cgEventCreateScrollWheelEvent2(0, cgScrollUnitLine, 1, int32(lines), 0, 0)
	if ev == 0 {
		return errors.New("创建滚轮事件失败")
	}
	cgEventPostFn(cgHIDEventTap, ev)
	cfReleaseFn(ev)
	return nil
}

// 按键名 → macOS 的虚拟键码（ANSI 布局）。
var keyTable = map[string]uint16{
	"KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9, "KeyB": 11,
	"KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17, "KeyO": 31, "KeyU": 32, "KeyI": 34, "KeyP": 35,
	"KeyL": 37, "KeyJ": 38, "KeyK": 40, "KeyN": 45, "KeyM": 46,
	"Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Digit9": 25, "Digit7": 26, "Digit8": 28, "Digit0": 29,
	"Equal": 24, "Minus": 27, "BracketRight": 30, "BracketLeft": 33, "Quote": 39, "Semicolon": 41, "Backslash": 42, "Comma": 43,
	"Slash": 44, "Period": 47, "Backquote": 50,
	"Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117, "CapsLock": 57,
	"MetaLeft": 55, "MetaRight": 54, "ShiftLeft": 56, "ShiftRight": 60, "AltLeft": 58, "AltRight": 61, "ControlLeft": 59, "ControlRight": 62,
	"ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
	"F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
	"F13": 105, "F14": 107, "F15": 113, "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90,
	"Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85, "Numpad4": 86, "Numpad5": 87, "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92,
	"NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69, "NumpadDivide": 75, "NumpadEnter": 76, "NumpadSubtract": 78, "NumpadEqual": 81,
}

var modifierFlags = map[string]uint64{
	"MetaLeft": 0x100000, "MetaRight": 0x100000, "ShiftLeft": 0x20000, "ShiftRight": 0x20000,
	"AltLeft": 0x80000, "AltRight": 0x80000, "ControlLeft": 0x40000, "ControlRight": 0x40000,
}

var (
	heldMu   sync.Mutex
	heldMods = map[string]bool{}
)

// KeyEvent 按下或松开一个键。按着的修饰键会带在后面的按键事件上，组合键才能生效。
func KeyEvent(code string, down bool) error {
	if err := ready(); err != nil {
		return err
	}
	key, ok := keyTable[code]
	if !ok {
		return errors.New("这个键模拟不了：" + code)
	}
	heldMu.Lock()
	if _, isMod := modifierFlags[code]; isMod {
		if down {
			heldMods[code] = true
		} else {
			delete(heldMods, code)
		}
	}
	var flags uint64
	for m := range heldMods {
		flags |= modifierFlags[m]
	}
	heldMu.Unlock()
	ev := cgEventCreateKeyboard(0, key, down)
	if ev == 0 {
		return errors.New("创建按键事件失败")
	}
	cgEventSetFlagsFn(ev, flags)
	cgEventPostFn(cgHIDEventTap, ev)
	cfReleaseFn(ev)
	return nil
}
