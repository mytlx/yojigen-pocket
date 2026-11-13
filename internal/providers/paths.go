package providers

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/platform"
)

// Paths 是路径浏览：以 /、~ 或盘符开头时逐级浏览文件夹，Tab 进入下一级。
type Paths struct{}

// Info 实现 core.Provider。
func (Paths) Info() core.Info { return core.Info{ID: "paths", Title: "路径", Icon: "svg:folder"} }

var driveRe = regexp.MustCompile(`^[a-zA-Z]:[\\/]`)

// IsPathInput 判断输入是否是路径。
func IsPathInput(s string) bool {
	return strings.HasPrefix(s, "/") || s == "~" || strings.HasPrefix(s, "~/") || strings.HasPrefix(s, `~\`) || driveRe.MatchString(s)
}

// Search 实现 core.Provider。
func (Paths) Search(_ context.Context, req *core.Request) []core.Item {
	input := strings.TrimSpace(req.Text)
	if !IsPathInput(input) {
		return nil
	}
	return ListPath(input)
}

const maxPathEntries = 60

// ListPath 列出路径下的条目；最后一段作为名字前缀过滤。
func ListPath(input string) []core.Item {
	full := platform.ExpandHome(input)
	dir, prefix := full, ""
	if !strings.HasSuffix(full, "/") && !strings.HasSuffix(full, `\`) {
		if info, err := os.Stat(full); err != nil || !info.IsDir() || input == "~" {
			dir, prefix = filepath.Dir(full), filepath.Base(full)
		}
		if input == "~" {
			dir, prefix = full, ""
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	lower := strings.ToLower(prefix)
	sep := string(filepath.Separator)
	var out []core.Item
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") && !strings.HasPrefix(prefix, ".") {
			continue
		}
		if lower != "" && !strings.HasPrefix(strings.ToLower(name), lower) {
			continue
		}
		path := filepath.Join(dir, name)
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			if info, err := os.Stat(path); err == nil {
				isDir = info.IsDir()
			}
		}
		score := 0.5
		complete := path
		if isDir {
			score = 0.6
			complete += sep
		}
		out = append(out, core.Item{
			ID:       "paths:" + path,
			Title:    name,
			Subtitle: path,
			Icon:     "file:" + path,
			Source:   "paths",
			Score:    score + 1,
			Ephem:    true,
			Complete: complete,
			Dedup:    path,
			Preview:  filePreview(path, isDir),
			Actions:  fileActions(path, isDir),
		})
	}
	slices.SortStableFunc(out, func(a, b core.Item) int {
		if a.Score != b.Score {
			if a.Score > b.Score {
				return -1
			}
			return 1
		}
		return strings.Compare(strings.ToLower(a.Title), strings.ToLower(b.Title))
	})
	if len(out) > maxPathEntries {
		out = out[:maxPathEntries]
	}
	return out
}

// fileActions 是文件结果通用的一组动作。
func fileActions(path string, isDir bool) []core.Action {
	actions := []core.Action{
		{Type: core.ActionOpen, Title: "打开", Target: path},
		{Type: core.ActionReveal, Title: "在文件夹中显示", Target: path},
		{Type: core.ActionCopy, Title: "复制路径", Text: path, KeepOpen: true},
	}
	if !isDir {
		actions = append(actions, core.Action{Type: core.ActionCopy, Title: "复制文件", Files: []string{path}, KeepOpen: true})
	}
	return actions
}

// filePreview 文件的预览由界面在选中时按需加载。
func filePreview(path string, isDir bool) *core.Preview {
	if isDir {
		return nil
	}
	return &core.Preview{Type: "file", Text: path}
}
