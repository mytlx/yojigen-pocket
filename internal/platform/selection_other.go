//go:build !darwin && !windows

package platform

import "time"

// SelectedText 其他系统不支持。
func SelectedText() (string, bool) { return "", false }

// SendCopy 其他系统不支持。
func SendCopy() error { return ErrUnsupported }

// WaitClipboardChange 其他系统不支持。
func WaitClipboardChange(uint64, time.Duration) bool { return false }
