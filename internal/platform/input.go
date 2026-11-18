package platform

// 模拟鼠标和键盘（连点器、键盘宏用）。按键用网页 KeyboardEvent.code 的名字（KeyA、Digit1、Enter、ShiftLeft……），
// 录制时页面拿到的就是它，两个系统各自换成自己的键码。

// MouseButtons 是支持的鼠标按键。
var MouseButtons = []string{"left", "right", "middle"}

// KeyCodes 返回这个系统上能模拟的全部按键名。
func KeyCodes() []string {
	out := make([]string, 0, len(keyTable))
	for k := range keyTable {
		out = append(out, k)
	}
	return out
}

// KeySupported 报告这个按键名能不能模拟。
func KeySupported(code string) bool {
	_, ok := keyTable[code]
	return ok
}
