//go:build !darwin && !windows

package platform

var keyTable = map[string]uint16{}

// InputAllowed 报告现在能不能模拟输入；这个系统上还没有实现。
func InputAllowed() bool { return false }

// MousePos 这个系统上还没有实现。
func MousePos() (x, y int, ok bool) { return 0, 0, false }

// MouseMove 这个系统上还没有实现。
func MouseMove(int, int) error { return ErrUnsupported }

// MouseButton 这个系统上还没有实现。
func MouseButton(string, bool, int) error { return ErrUnsupported }

// MouseScroll 这个系统上还没有实现。
func MouseScroll(int) error { return ErrUnsupported }

// KeyEvent 这个系统上还没有实现。
func KeyEvent(string, bool) error { return ErrUnsupported }
