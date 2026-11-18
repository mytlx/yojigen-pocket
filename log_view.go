package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

type LogEntry struct {
	Time    string `json:"time"`
	Message string `json:"message"`
	Error   bool   `json:"error"`
}
type LogPage struct {
	Reset      bool       `json:"reset"`
	Entries    []LogEntry `json:"entries"`
	Offset     int64      `json:"offset"`
	Generation string     `json:"generation"`
	More       bool       `json:"more"`
}

func parseLogLine(line string, previousError bool) LogEntry {
	stamp, message := "", strings.TrimRight(line, "\r\n")
	if len(message) >= 20 && message[19] == ' ' {
		if _, err := time.Parse("2006/01/02 15:04:05", message[:19]); err == nil {
			stamp, message = message[:19], message[20:]
			// Older app versions wrote these error messages without a level.
			previousError = strings.HasPrefix(message, "[ERROR] ") || strings.Contains(strings.SplitN(message, "：", 2)[0], "失败")
			message = strings.TrimPrefix(message, "[ERROR] ")
		}
	}
	return LogEntry{stamp, message, previousError}
}

func (s *Settings) LogPage(offset int64, generation string, previousError bool) (LogPage, error) {
	d := &s.a.diagnostic
	d.mu.Lock()
	defer d.mu.Unlock()
	page := LogPage{Entries: []LogEntry{}, Generation: fmt.Sprint(d.clears)}
	path := filepath.Join(s.a.paths.Logs, "app.log")
	// The archived file changes only on rotation.
	if st, err := os.Stat(path + ".1"); err == nil {
		page.Generation += fmt.Sprint("/", st.ModTime().UnixNano(), "/", st.Size())
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return page, nil
	}
	if err != nil {
		return page, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return page, err
	}
	if generation != page.Generation || offset < 0 || offset > st.Size() {
		page.Reset = true
		offset = 0
		previousError = false
	}
	page.Offset = offset
	r := bufio.NewReader(io.NewSectionReader(f, offset, st.Size()-offset))
	for len(page.Entries) < 500 && page.Offset-offset < 256<<10 {
		line, err := r.ReadString('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			return page, err
		}
		e := parseLogLine(line, previousError)
		previousError = e.Error
		page.Entries = append(page.Entries, e)
		page.Offset += int64(len(line))
	}
	page.More = page.Offset < st.Size() && len(page.Entries) > 0
	return page, nil
}

// Export includes the retained archive as well as the current log.
func (s *Settings) ExportLog(errorsOnly bool) (bool, error) {
	dest, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: s.a.settings, Title: "导出日志", DefaultPath: "pocket-" + time.Now().Format("20060102-150405") + ".log"})
	if err != nil || dest == "" {
		return false, err
	}
	path := filepath.Join(s.a.paths.Logs, "app.log")
	outInfo, _ := os.Stat(dest)
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".pocket-log-*")
	if err != nil {
		return false, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	for _, source := range []string{path + ".1", path} {
		f, err := os.Open(source)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		st, err := f.Stat()
		if err == nil && outInfo != nil && os.SameFile(outInfo, st) {
			err = errors.New("请选择不同于原始日志的文件")
		}
		if err == nil {
			err = copyLog(io.LimitReader(f, st.Size()), tmp, errorsOnly)
		}
		f.Close()
		if err != nil {
			return false, err
		}
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		return false, err
	}
	return true, nil
}
func copyLog(src io.Reader, dst io.Writer, errorsOnly bool) error {
	if !errorsOnly {
		_, err := io.Copy(dst, src)
		return err
	}
	r := bufio.NewReader(src)
	isError := false
	for {
		line, err := r.ReadString('\n')
		if len(line) > 0 {
			isError = parseLogLine(line, isError).Error
			if isError {
				if _, e := io.WriteString(dst, line); e != nil {
					return e
				}
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// ClearLogs preserves the open append handle so recording can continue immediately.
func (s *Settings) ClearLogs() error {
	d := &s.a.diagnostic
	d.mu.Lock()
	defer d.mu.Unlock()
	path := filepath.Join(s.a.paths.Logs, "app.log")
	if err := os.Remove(path + ".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	d.clears++
	err := os.Truncate(path, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
