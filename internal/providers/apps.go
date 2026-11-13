// Package providers 是各个内置数据源。
package providers

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
)

// AppEntry 是一个已安装的应用。
type AppEntry struct {
	ID   string
	Name string
	Path string
	Alt  []string // 其他语言下的名字（时钟 ↔ Clock），也参与匹配
}

type appItem struct {
	AppEntry
	title    *match.Target
	keywords []*match.Target
}

// Apps 提供应用搜索。
type Apps struct {
	List   func() ([]AppEntry, error)
	Launch func(AppEntry) error

	mu    sync.RWMutex
	items []appItem
	last  time.Time
}

// Info 实现 core.Provider。
func (a *Apps) Info() core.Info {
	return core.Info{ID: "apps", Title: "应用", Icon: "svg:app"}
}

// Refresh 重新扫描已安装的应用。拼音在这里预计算，不在每次输入时算。
func (a *Apps) Refresh() error {
	list, err := a.List()
	if err != nil {
		return err
	}
	items := make([]appItem, 0, len(list))
	for _, e := range list {
		it := appItem{AppEntry: e, title: match.Prepare(e.Name)}
		// 文件夹名常常和显示名不同（微信 ↔ WeChat），也参与匹配。
		if stem := strings.TrimSuffix(filepath.Base(e.Path), filepath.Ext(e.Path)); stem != "" && stem != e.Name && !strings.Contains(stem, "!") {
			it.keywords = append(it.keywords, match.Prepare(stem))
		}
		for _, alt := range e.Alt {
			if alt != "" && alt != e.Name {
				it.keywords = append(it.keywords, match.Prepare(alt))
			}
		}
		items = append(items, it)
	}
	a.mu.Lock()
	a.items, a.last = items, time.Now()
	a.mu.Unlock()
	return nil
}

// RefreshIfStale 在数据过期时后台刷新。
func (a *Apps) RefreshIfStale(age time.Duration) {
	a.mu.RLock()
	stale := time.Since(a.last) > age
	a.mu.RUnlock()
	if stale {
		go func() { _ = a.Refresh() }()
	}
}

// Count 返回应用数量。
func (a *Apps) Count() int {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return len(a.items)
}

// Search 实现 core.Provider。
func (a *Apps) Search(_ context.Context, req *core.Request) []core.Item {
	a.mu.RLock()
	defer a.mu.RUnlock()
	var out []core.Item
	for i := range a.items {
		it := &a.items[i]
		r := match.Best(req.Query, it.title, it.keywords...)
		if !r.OK || r.Score <= 0 {
			continue
		}
		item := a.item(it.AppEntry)
		item.Score, item.Highlights = r.Score, r.Positions
		out = append(out, item)
	}
	return out
}

// Resolve 实现 core.Resolver。
func (a *Apps) Resolve(id string) (core.Item, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	for i := range a.items {
		if "apps:"+a.items[i].ID == id {
			return a.item(a.items[i].AppEntry), true
		}
	}
	return core.Item{}, false
}

func (a *Apps) item(e AppEntry) core.Item {
	entry := e
	actions := []core.Action{{Type: core.ActionFunc, Title: "打开", Fn: func(_ context.Context, r *core.Run) error {
		r.Hide()
		return a.Launch(entry)
	}}}
	subtitle := "应用"
	if !strings.HasPrefix(e.Path, "shell:") {
		subtitle = e.Path
		actions = append(actions,
			core.Action{Type: core.ActionReveal, Title: "在文件夹中显示", Target: e.Path},
			core.Action{Type: core.ActionCopy, Title: "复制路径", Text: e.Path, KeepOpen: true},
		)
	}
	return core.Item{
		ID:          "apps:" + e.ID,
		Title:       e.Name,
		Subtitle:    subtitle,
		Icon:        "file:" + e.Path,
		Source:      "apps",
		SourceLabel: "应用",
		Actions:     actions,
		Dedup:       e.Path,
	}
}
