package main

import (
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
)

type diagnosticLog struct {
	mu   sync.Mutex
	file *os.File
}

func (a *App) configureLog() {
	d := &a.diagnostic
	d.mu.Lock()
	defer d.mu.Unlock()
	enabled := a.config.Get().DiagnosticLogging
	if enabled == (d.file != nil) {
		return
	}
	if !enabled {
		log.SetOutput(os.Stderr)
		d.file.Close()
		d.file = nil
		return
	}
	path := filepath.Join(a.paths.Logs, "app.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 4<<20 {
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		log.Printf("[ERROR] 打开日志失败：%v", err)
		return
	}
	d.file = f
	log.SetOutput(io.MultiWriter(os.Stderr, f))
	log.Print("诊断日志已开启")
}

func (s *Settings) ReadLog() (string, error) {
	f, err := os.Open(filepath.Join(s.a.paths.Logs, "app.log"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	end, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return "", err
	}
	if _, err = f.Seek(max(0, end-64*1024), io.SeekStart); err != nil {
		return "", err
	}
	b, err := io.ReadAll(io.LimitReader(f, 64*1024))
	return string(b), err
}
