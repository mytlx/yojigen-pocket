// Package seed 在第一次启动时写入示例脚本、示例插件、文本片段和主题文件。
// 只写一次：用户删掉之后不会再冒出来。
package seed

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed all:files
var files embed.FS

// Install 把示例文件写入用户目录，已存在的文件不覆盖。
func Install(home string) error {
	dirs := []string{"files/common"}
	switch runtime.GOOS {
	case "darwin":
		dirs = append(dirs, "files/darwin")
	case "windows":
		dirs = append(dirs, "files/windows")
	}
	for _, root := range dirs {
		err := fs.WalkDir(files, root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			target := filepath.Join(home, rel)
			if _, err := os.Stat(target); err == nil {
				return nil
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			data, err := files.ReadFile(p)
			if err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if strings.HasPrefix(filepath.ToSlash(rel), "commands/") {
				mode = 0o755 // 脚本要能直接执行
			}
			return os.WriteFile(target, data, mode)
		})
		if err != nil {
			return err
		}
	}
	return nil
}
