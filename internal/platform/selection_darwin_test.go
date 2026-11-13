//go:build darwin

package platform

import "testing"

// 只读地问一下系统当前选中的文字：不管有没有权限、前台是什么应用，都不能崩溃。
func TestSelectedTextDoesNotCrash(t *testing.T) {
	for range 3 {
		text, ok := SelectedText()
		t.Logf("ok=%v len=%d", ok, len(text))
	}
}
