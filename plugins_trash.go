package main

import (
	"errors"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/workspace"
)

// trash 把文件库里的一项移到系统的废纸篓；移不了（比如在网络盘上）时才直接删除。
func trash(s *workspace.Store, p string) error {
	abs, err := s.Abs(p)
	if err != nil {
		return err
	}
	if p == "" || abs == s.Dir {
		return errors.New("没有指定文件")
	}
	if err := mygo.Shell.TrashItem(abs); err != nil {
		return s.Remove(p)
	}
	return nil
}
