//go:build !darwin && !windows

package platform

import (
	"os"
	"time"
)

// FileTimes 返回文件的创建时间和最近访问时间；这个系统上拿不到。
func FileTimes(os.FileInfo) (created, accessed time.Time) { return }

// FileFlags 只在 Windows 上有内容。
func FileFlags(os.FileInfo) []string { return nil }
