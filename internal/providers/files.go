package providers

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/store"
)

// Files 是文件搜索：macOS 用 Spotlight，Windows 用 Everything，都不可用时退回内置索引。
type Files struct {
	Config func() *store.Config

	mu       sync.Mutex
	index    []string
	indexed  time.Time
	indexing bool
}

// Info 实现 core.Provider。
func (f *Files) Info() core.Info {
	return core.Info{ID: "files", Title: "文件", Icon: "svg:file", Async: true, Delay: 120 * time.Millisecond}
}

const fileLimit = 30

// Search 实现 core.Provider。
func (f *Files) Search(ctx context.Context, req *core.Request) []core.Item {
	text := strings.TrimSpace(req.Text)
	// 全局搜索时，太短的输入不查文件，避免噪音。
	if text == "" || (!req.Scoped && utf8.RuneCountInString(text) < 3) || IsPathInput(text) {
		return nil
	}
	cfg := f.Config()
	paths, native := nativeSearch(ctx, text, cfg, fileLimit)
	if !native {
		paths = f.searchIndex(text, cfg)
	}
	var out []core.Item
	q := match.NewQuery(text)
	for _, p := range paths {
		if ctx.Err() != nil {
			return nil
		}
		base := filepath.Base(p)
		isDir := false
		if info, err := os.Stat(p); err == nil {
			isDir = info.IsDir()
		} else {
			continue
		}
		r := match.Prepare(base).Match(q)
		score := 0.5 // 原生搜索可能按语法命中（ext:pdf），文件名未必匹配
		if r.OK && r.Score > score {
			score = r.Score
		}
		out = append(out, core.Item{
			ID:         "files:" + p,
			Title:      base,
			Subtitle:   p,
			Icon:       "file:" + p,
			Source:     "files",
			Score:      score,
			Highlights: r.Positions,
			Dedup:      p,
			Preview:    filePreview(p, isDir),
			Actions:    fileActions(p, isDir),
		})
	}
	return out
}

// Resolve 实现 core.Resolver：文件结果可以固定到首页。
func (f *Files) Resolve(id string) (core.Item, bool) {
	p, ok := strings.CutPrefix(id, "files:")
	if !ok {
		return core.Item{}, false
	}
	info, err := os.Stat(p)
	if err != nil {
		return core.Item{}, false
	}
	return core.Item{
		ID: id, Title: filepath.Base(p), Subtitle: p, Icon: "file:" + p, Source: "files",
		Preview: filePreview(p, info.IsDir()), Actions: fileActions(p, info.IsDir()),
	}, true
}

// searchIndex 在内置索引里按文件名查找。
func (f *Files) searchIndex(text string, cfg *store.Config) []string {
	f.ensureIndex(cfg)
	f.mu.Lock()
	index := f.index
	f.mu.Unlock()

	lower := strings.ToLower(text)
	var out []string
	for _, p := range index {
		if strings.Contains(strings.ToLower(filepath.Base(p)), lower) {
			out = append(out, p)
			if len(out) >= fileLimit {
				break
			}
		}
	}
	return out
}

// ensureIndex 在索引没有或过期时后台重建。
func (f *Files) ensureIndex(cfg *store.Config) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if (f.index == nil || time.Since(f.indexed) > 15*time.Minute) && !f.indexing {
		f.indexing = true
		go f.rebuild(cfg.Files.Roots)
	}
}

// Indexing 报告内置索引是不是还在建。
func (f *Files) Indexing() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.indexing && f.index == nil
}

var skipDirs = map[string]bool{
	"node_modules": true, "vendor": true, "dist": true, "build": true, "target": true, "__pycache__": true,
	"Library": true, "AppData": true, "$RECYCLE.BIN": true,
}

const maxIndexEntries = 100000

func (f *Files) rebuild(roots []string) {
	var paths []string
	for _, root := range roots {
		root = platform.ExpandHome(root)
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			name := d.Name()
			if p != root && (strings.HasPrefix(name, ".") || (d.IsDir() && skipDirs[name])) {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if p != root {
				paths = append(paths, p)
			}
			if len(paths) >= maxIndexEntries {
				return fs.SkipAll
			}
			return nil
		})
	}
	f.mu.Lock()
	f.index, f.indexed, f.indexing = paths, time.Now(), false
	f.mu.Unlock()
}

// readLines 读取外部工具的输出，够数就结束进程。
func readLines(ctx context.Context, limit int, name string, args ...string) ([]string, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := platform.Command(ctx, name, args...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var lines []string
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" {
			lines = append(lines, line)
			if len(lines) >= limit {
				break
			}
		}
	}
	cancel()
	_ = cmd.Wait()
	return lines, nil
}

// HumanSize 把字节数格式化成易读的形式。
func HumanSize(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1<<20:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	case n < 1<<30:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
}
