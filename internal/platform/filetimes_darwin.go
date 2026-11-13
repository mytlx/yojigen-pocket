package platform

import (
	"os"
	"syscall"
	"time"
)

// FileTimes 返回文件的创建时间和最近访问时间；拿不到的为零值。
func FileTimes(info os.FileInfo) (created, accessed time.Time) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return
	}
	return time.Unix(st.Birthtimespec.Sec, st.Birthtimespec.Nsec), time.Unix(st.Atimespec.Sec, st.Atimespec.Nsec)
}
