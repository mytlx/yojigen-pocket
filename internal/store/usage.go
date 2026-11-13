package store

import (
	"encoding/json"
	"math"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

// Entry 是一个结果项的使用记录，同时保存一份快照，供首页和置顶显示。
type Entry struct {
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Subtitle string         `json:"subtitle,omitempty"`
	Icon     string         `json:"icon,omitempty"`
	Source   string         `json:"source"`
	Count    int            `json:"count"`
	Last     time.Time      `json:"last"`
	Prefixes map[string]int `json:"prefixes,omitempty"`
}

type usageFile struct {
	Entries map[string]*Entry `json:"entries"`
	Pins    []*Entry          `json:"pins"`
}

// Usage 记录「输入前缀 → 选中项」，用于排序和首页。
type Usage struct {
	mu    sync.RWMutex
	path  string
	data  usageFile
	timer *time.Timer
	now   func() time.Time
}

const (
	maxPrefixLen     = 6
	maxPrefixPerItem = 200
	maxEntries       = 2000
)

// NewUsage 读取使用记录。文件损坏时从空开始，不影响启动。
func NewUsage(path string) *Usage {
	u := &Usage{path: path, now: time.Now, data: usageFile{Entries: map[string]*Entry{}}}
	if raw, err := os.ReadFile(path); err == nil {
		var f usageFile
		if json.Unmarshal(raw, &f) == nil && f.Entries != nil {
			u.data = f
		}
	}
	return u
}

// Record 记录一次使用。
func (u *Usage) Record(query string, snapshot Entry) {
	u.mu.Lock()
	defer u.mu.Unlock()
	e := u.data.Entries[snapshot.ID]
	if e == nil {
		e = &Entry{ID: snapshot.ID, Prefixes: map[string]int{}}
		u.data.Entries[snapshot.ID] = e
	}
	e.Title, e.Subtitle, e.Icon, e.Source = snapshot.Title, snapshot.Subtitle, snapshot.Icon, snapshot.Source
	e.Count++
	e.Last = u.now()
	if e.Prefixes == nil {
		e.Prefixes = map[string]int{}
	}
	runes := []rune(strings.ToLower(strings.TrimSpace(query)))
	for i := 1; i <= min(len(runes), maxPrefixLen); i++ {
		if len(e.Prefixes) >= maxPrefixPerItem {
			break
		}
		e.Prefixes[string(runes[:i])]++
	}
	u.prune()
	u.scheduleSave()
}

// prune 限制记录总数，淘汰最久未用的。
func (u *Usage) prune() {
	if len(u.data.Entries) <= maxEntries {
		return
	}
	all := make([]*Entry, 0, len(u.data.Entries))
	for _, e := range u.data.Entries {
		all = append(all, e)
	}
	slices.SortFunc(all, func(a, b *Entry) int { return a.Last.Compare(b.Last) })
	for _, e := range all[:len(all)-maxEntries] {
		delete(u.data.Entries, e.ID)
	}
}

// Boost 返回使用记录带来的加分。
func (u *Usage) Boost(query, id string, halfLifeDays float64) float64 {
	u.mu.RLock()
	defer u.mu.RUnlock()
	e := u.data.Entries[id]
	if e == nil {
		return 0
	}
	days := u.now().Sub(e.Last).Hours() / 24
	decay := math.Pow(2, -days/halfLifeDays)
	q := []rune(strings.ToLower(strings.TrimSpace(query)))
	if len(q) > maxPrefixLen {
		q = q[:maxPrefixLen]
	}
	nq := e.Prefixes[string(q)]
	return (0.30*math.Log2(1+float64(nq)) + 0.10*math.Log2(1+float64(e.Count))) * decay
}

// Top 返回最常用的 n 项（按使用次数和新近程度）。
func (u *Usage) Top(n int, halfLifeDays float64) []Entry {
	u.mu.RLock()
	defer u.mu.RUnlock()
	type scored struct {
		e Entry
		s float64
	}
	all := make([]scored, 0, len(u.data.Entries))
	for _, e := range u.data.Entries {
		days := u.now().Sub(e.Last).Hours() / 24
		all = append(all, scored{*e, float64(e.Count) * math.Pow(2, -days/halfLifeDays)})
	}
	slices.SortFunc(all, func(a, b scored) int {
		if a.s != b.s {
			if a.s > b.s {
				return -1
			}
			return 1
		}
		return strings.Compare(a.e.ID, b.e.ID)
	})
	out := make([]Entry, 0, min(n, len(all)))
	for _, s := range all[:min(n, len(all))] {
		out = append(out, s.e)
	}
	return out
}

// Pins 返回置顶项。
func (u *Usage) Pins() []Entry {
	u.mu.RLock()
	defer u.mu.RUnlock()
	out := make([]Entry, len(u.data.Pins))
	for i, p := range u.data.Pins {
		out[i] = *p
	}
	return out
}

// IsPinned 判断是否已置顶。
func (u *Usage) IsPinned(id string) bool {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return slices.ContainsFunc(u.data.Pins, func(e *Entry) bool { return e.ID == id })
}

// TogglePin 切换置顶，返回切换后的状态。
func (u *Usage) TogglePin(snapshot Entry) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	defer u.scheduleSave()
	i := slices.IndexFunc(u.data.Pins, func(e *Entry) bool { return e.ID == snapshot.ID })
	if i >= 0 {
		u.data.Pins = slices.Delete(u.data.Pins, i, i+1)
		return false
	}
	u.data.Pins = append(u.data.Pins, &snapshot)
	return true
}

// Forget 删除一项的使用记录（不影响置顶）。
func (u *Usage) Forget(id string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	delete(u.data.Entries, id)
	u.scheduleSave()
}

// Clear 清空使用记录（不影响置顶）。
func (u *Usage) Clear() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.data.Entries = map[string]*Entry{}
	u.scheduleSave()
}

func (u *Usage) scheduleSave() {
	if u.timer != nil {
		u.timer.Stop()
	}
	u.timer = time.AfterFunc(800*time.Millisecond, func() { _ = u.Flush() })
}

// Flush 立即写盘。
func (u *Usage) Flush() error {
	u.mu.RLock()
	raw, err := json.Marshal(u.data)
	u.mu.RUnlock()
	if err != nil {
		return err
	}
	return WriteFileAtomic(u.path, raw)
}
