//go:build windows

package platform

import "time"

var procGetAsyncKeyState = user32.NewProc("GetAsyncKeyState")

const (
	vkShift = 0x10
	vkMenu  = 0x12
	vkLWin  = 0x5B
	vkRWin  = 0x5C
	vkC     = 0x43
)

// SelectedText 在 Windows 上没有只读的读取方式（UI Automation 尚未接入），总是交给模拟复制。
func SelectedText() (string, bool) { return "", false }

func keyDown(vk uintptr) bool {
	r, _, _ := procGetAsyncKeyState.Call(vk)
	return r&0x8000 != 0
}

// SendCopy 向前台窗口发送 Ctrl+C。
// 热键的修饰键（Alt、Win……）此时可能还按着，直接发会变成 Alt+Ctrl+C，所以先等它们松开。
func SendCopy() error {
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !keyDown(vkMenu) && !keyDown(vkShift) && !keyDown(vkControl) && !keyDown(vkLWin) && !keyDown(vkRWin) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	sendInputs([]input{
		{inputType: inputKeyboard, ki: keybdInput{wVk: vkControl}},
		{inputType: inputKeyboard, ki: keybdInput{wVk: vkC}},
		{inputType: inputKeyboard, ki: keybdInput{wVk: vkC, dwFlags: keyEventUp}},
		{inputType: inputKeyboard, ki: keybdInput{wVk: vkControl, dwFlags: keyEventUp}},
	})
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
