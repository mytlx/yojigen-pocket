package platform

import (
	"os"
	"syscall"
	"time"
)

// FileTimes 返回文件的创建时间和最近访问时间；拿不到的为零值。
func FileTimes(info os.FileInfo) (created, accessed time.Time) {
	d, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return
	}
	return time.Unix(0, d.CreationTime.Nanoseconds()), time.Unix(0, d.LastAccessTime.Nanoseconds())
}

// FileFlags 返回只读、隐藏、系统这些属性的说明。
func FileFlags(info os.FileInfo) []string {
	d, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return nil
	}
	var out []string
	if d.FileAttributes&syscall.FILE_ATTRIBUTE_READONLY != 0 {
		out = append(out, "只读")
	}
	if d.FileAttributes&syscall.FILE_ATTRIBUTE_HIDDEN != 0 {
		out = append(out, "隐藏")
	}
	if d.FileAttributes&syscall.FILE_ATTRIBUTE_SYSTEM != 0 {
		out = append(out, "系统")
	}
	return out
}
