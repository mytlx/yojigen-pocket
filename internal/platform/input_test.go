package platform

import (
	"runtime"
	"testing"
)

// 只测读取，不发任何输入事件。
func TestMousePosAndKeyTable(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		t.Skip("这个系统上没有实现")
	}
	x, y, ok := MousePos()
	if !ok {
		t.Skip("读不到鼠标位置（没有图形会话）")
	}
	if x < -20000 || x > 20000 || y < -20000 || y > 20000 {
		t.Fatalf("鼠标位置不像是屏幕坐标：%d, %d", x, y)
	}
	for _, code := range []string{"KeyA", "KeyZ", "Digit0", "Enter", "Space", "ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft", "ArrowUp", "F1", "F12", "Backspace", "Tab", "Escape"} {
		if !KeySupported(code) {
			t.Errorf("常用键 %s 应该能模拟", code)
		}
	}
	if KeySupported("NotAKey") || len(KeyCodes()) < 80 {
		t.Errorf("按键表不对：%d 个", len(KeyCodes()))
	}
}
