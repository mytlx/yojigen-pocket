package providers

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
)

// Snippet 是一段文本模板，对应 snippets 目录下的一个文件。
type Snippet struct {
	Name string `json:"name"`
	Body string `json:"body"`
	Path string `json:"path"`

	target *match.Target
}

// Snippets 是文本片段：snippets 目录下的 .md / .txt 文件，文件名是标题，内容是正文。
type Snippets struct {
	Dir string

	mu   sync.RWMutex
	list []*Snippet
}

// Info 实现 core.Provider。
func (s *Snippets) Info() core.Info {
	return core.Info{ID: "snippets", Title: "片段", Icon: "svg:snippet"}
}

// Entrance 实现 core.Entrance。
func (s *Snippets) Entrance() core.Scope {
	return core.Scope{ID: "snippets", Title: "文本片段", Icon: "svg:snippet", Placeholder: "搜索文本片段…"}
}

// Reload 重新读取目录。
func (s *Snippets) Reload() {
	var list []*Snippet
	_ = filepath.WalkDir(s.Dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		if (ext != ".md" && ext != ".txt") || strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil
		}
		name := strings.TrimSuffix(d.Name(), filepath.Ext(p))
		list = append(list, &Snippet{Name: name, Body: string(raw), Path: p, target: match.Prepare(name)})
		return nil
	})
	slices.SortFunc(list, func(a, b *Snippet) int { return strings.Compare(a.Name, b.Name) })
	s.mu.Lock()
	s.list = list
	s.mu.Unlock()
}

// List 返回全部片段（设置页用）。
func (s *Snippets) List() []Snippet {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Snippet, len(s.list))
	for i, x := range s.list {
		out[i] = *x
	}
	return out
}

var badName = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)

// Save 新建或更新片段。oldName 非空且与 name 不同时视为改名。
func (s *Snippets) Save(oldName, name, body string) error {
	name = strings.TrimSpace(badName.ReplaceAllString(name, "-"))
	name = strings.TrimLeft(name, ".")
	if name == "" {
		return errors.New("片段需要一个名字")
	}
	s.mu.RLock()
	var oldPath string
	exists := false
	for _, x := range s.list {
		if x.Name == oldName {
			oldPath = x.Path
		}
		if x.Name == name && oldName != name {
			exists = true
		}
	}
	s.mu.RUnlock()
	if exists {
		return errors.New("已经有同名的片段了")
	}
	path := filepath.Join(s.Dir, name+".md")
	if oldPath != "" && oldName == name {
		path = oldPath
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return err
	}
	if oldPath != "" && oldPath != path {
		_ = os.Remove(oldPath)
	}
	s.Reload()
	return nil
}

// Delete 删除片段。
func (s *Snippets) Delete(name string) error {
	s.mu.RLock()
	var path string
	for _, x := range s.list {
		if x.Name == name {
			path = x.Path
		}
	}
	s.mu.RUnlock()
	if path == "" {
		return errors.New("找不到这个片段")
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	s.Reload()
	return nil
}

// Search 实现 core.Provider。
func (s *Snippets) Search(_ context.Context, req *core.Request) []core.Item {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []core.Item
	text := strings.TrimSpace(req.Text)
	for i, x := range s.list {
		if text == "" {
			it := s.item(x)
			it.Score = 1 - float64(i)*0.001
			out = append(out, it)
			continue
		}
		r := x.target.Match(req.Query)
		if r.OK && r.Score > 0 {
			it := s.item(x)
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
		}
	}
	return out
}

// Resolve 实现 core.Resolver。
func (s *Snippets) Resolve(id string) (core.Item, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, x := range s.list {
		if "snippets:"+x.Name == id {
			return s.item(x), true
		}
	}
	return core.Item{}, false
}

func (s *Snippets) item(x *Snippet) core.Item {
	body := x.Body
	line, _, _ := strings.Cut(strings.TrimSpace(body), "\n")
	return core.Item{
		ID:       "snippets:" + x.Name,
		Title:    x.Name,
		Subtitle: truncate(line, 80),
		Icon:     "svg:snippet",
		Source:   "snippets",
		Path:     x.Path,
		Preview:  &core.Preview{Type: "text", Text: truncate(body, 20000)},
		Actions: []core.Action{
			{Type: core.ActionFunc, Title: "粘贴到当前窗口", Fn: func(_ context.Context, r *core.Run) error {
				text := ExpandTemplate(body, r.Host.ReadClipboardText())
				r.Host.CopyText(text)
				r.Hide()
				if err := r.Host.PasteToFront(); err != nil {
					r.Host.Notify("已复制到剪贴板", "无法自动粘贴："+err.Error())
				}
				return nil
			}},
			{Type: core.ActionFunc, Title: "复制", Fn: func(_ context.Context, r *core.Run) error {
				r.Host.CopyText(ExpandTemplate(body, r.Host.ReadClipboardText()))
				return nil
			}},
		},
	}
}

// ExpandTemplate 展开片段里的变量：{date}、{time}、{datetime}、{clipboard}、{uuid}。
func ExpandTemplate(body, clipboard string) string {
	now := time.Now()
	return strings.NewReplacer(
		"{date}", now.Format("2006-01-02"),
		"{time}", now.Format("15:04"),
		"{datetime}", now.Format("2006-01-02 15:04"),
		"{clipboard}", clipboard,
		"{uuid}", NewUUID(),
		"{cursor}", "",
	).Replace(body)
}

// CatalogItems 实现 core.Lister。
func (s *Snippets) CatalogItems() []core.Item {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]core.Item, 0, len(s.list))
	for _, x := range s.list {
		out = append(out, s.item(x))
	}
	return out
}
