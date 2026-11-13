// Package store 管理用户目录、配置和使用记录。所有状态都是普通文件，可以直接放进 git。
package store

import (
	"os"
	"path/filepath"
)

// Paths 是用户目录下的各个位置。
type Paths struct {
	Home     string `json:"home"`
	Config   string `json:"config"`
	Commands string `json:"commands"`
	Plugins  string `json:"plugins"`
	Snippets string `json:"snippets"`
	UI       string `json:"ui"`
	Data     string `json:"data"`
	Cache    string `json:"cache"`
	Logs     string `json:"logs"`
}

// ResolvePaths 计算用户目录：优先 POCKET_HOME，否则 ~/.yojigen-pocket。
// 开发版使用独立目录，可以和正式版同时运行互不干扰。
func ResolvePaths(dev bool) Paths {
	home := os.Getenv("POCKET_HOME")
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			h = "."
		}
		name := ".yojigen-pocket"
		if dev {
			name += "-dev"
		}
		home = filepath.Join(h, name)
	}
	return Paths{
		Home:     home,
		Config:   filepath.Join(home, "config.json"),
		Commands: filepath.Join(home, "commands"),
		Plugins:  filepath.Join(home, "plugins"),
		Snippets: filepath.Join(home, "snippets"),
		UI:       filepath.Join(home, "ui"),
		Data:     filepath.Join(home, "data"),
		Cache:    filepath.Join(home, "cache"),
		Logs:     filepath.Join(home, "logs"),
	}
}

// Ensure 创建目录结构，并写入 .gitignore。
func (p Paths) Ensure() error {
	for _, d := range []string{p.Home, p.Commands, p.Plugins, p.Snippets, p.UI, p.Data, p.Cache, p.Logs} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	ignore := filepath.Join(p.Home, ".gitignore")
	if _, err := os.Stat(ignore); os.IsNotExist(err) {
		return os.WriteFile(ignore, []byte("data/\ncache/\nlogs/\n"), 0o644)
	}
	return nil
}

// WriteFileAtomic 先写临时文件再改名，避免写到一半崩溃损坏数据。
func WriteFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
