package providers

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/store"
)

// ClipEntry 是一条剪贴板历史。
type ClipEntry struct {
	ID     string    `json:"id"`
	Kind   string    `json:"kind"` // text | image | files
	Text   string    `json:"text,omitempty"`
	Image  string    `json:"image,omitempty"`
	Files  []string  `json:"files,omitempty"`
	Size   int64     `json:"size,omitempty"`
	App    string    `json:"app,omitempty"`
	Time   time.Time `json:"time"`
	Pinned bool      `json:"pinned,omitempty"`
	target *match.Target
}

// ClipSource 读取系统剪贴板。
type ClipSource interface {
	ReadText() string
	ReadImage() []byte
	ReadFiles() ([]string, error)
	HasImage() bool
}

// Clipboard 记录剪贴板历史，可搜索、可固定。
type Clipboard struct {
	Config  func() *store.Config
	Source  ClipSource
	Dir     string // 存放历史和图片的目录
	Enabled func() bool
	// Changed 在历史有变化时调用（剪贴板页面据此刷新）。
	Changed func()

	mu      sync.RWMutex
	entries []*ClipEntry
	lastSig string
	timer   *time.Timer
	// last 是应用运行期间最近一次复制的内容，用于「自动带入刚复制的内容」。
	last *ClipEntry
	// suppressUntil 之前的剪贴板变化不记录：读取选中文字时会临时复制一次，再把原内容放回去。
	suppressUntil atomic.Int64
}

// Suppress 在接下来的一段时间里不记录剪贴板变化。
func (c *Clipboard) Suppress(d time.Duration) {
	c.suppressUntil.Store(time.Now().Add(d).UnixMilli())
}

const maxClipText = 1 << 20

// Info 实现 core.Provider。
func (c *Clipboard) Info() core.Info {
	return core.Info{ID: "clipboard", Title: "剪贴板", Icon: "svg:clipboard"}
}

// Entrance 实现 core.Entrance。
func (c *Clipboard) Entrance() core.Scope {
	return core.Scope{ID: "clipboard", Title: "剪贴板历史", Icon: "svg:clipboard", Placeholder: "搜索剪贴板历史…"}
}

func (c *Clipboard) file() string { return filepath.Join(c.Dir, "clipboard.json") }

// Load 读取历史。
func (c *Clipboard) Load() {
	_ = os.MkdirAll(filepath.Join(c.Dir, "clipboard"), 0o700)
	raw, err := os.ReadFile(c.file())
	if err != nil {
		return
	}
	var entries []*ClipEntry
	if json.Unmarshal(raw, &entries) != nil {
		return
	}
	for _, e := range entries {
		e.prepare()
	}
	c.mu.Lock()
	c.entries = entries
	c.mu.Unlock()
}

func (e *ClipEntry) prepare() {
	e.target = match.Prepare(truncate(e.label(), 200))
}

func (e *ClipEntry) label() string {
	switch e.Kind {
	case "image":
		return "图片"
	case "files":
		names := make([]string, 0, len(e.Files))
		for _, f := range e.Files {
			names = append(names, filepath.Base(f))
		}
		return strings.Join(names, "，")
	}
	line := strings.TrimSpace(e.Text)
	if first, _, ok := strings.Cut(line, "\n"); ok {
		line = strings.TrimSpace(first)
	}
	return line
}

// Start 开始监听剪贴板。优先用系统的变更序号判断内容是否变化，几乎没有开销。
func (c *Clipboard) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		var lastSeq uint64
		if seq, ok := platform.ClipboardSeq(); ok {
			lastSeq = seq // 启动前的内容不算新复制
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			seq, ok := platform.ClipboardSeq()
			if ok {
				if seq == lastSeq {
					continue
				}
				lastSeq = seq
			}
			if time.Now().UnixMilli() < c.suppressUntil.Load() {
				continue
			}
			c.capture()
		}
	}()
}

func (c *Clipboard) capture() {
	defer func() { _ = recover() }() // 读剪贴板出错不能影响主程序
	if c.Enabled != nil && !c.Enabled() {
		return
	}
	if platform.ClipboardConcealed() {
		return
	}
	cfg := c.Config()
	entry := c.read(cfg)
	if entry == nil {
		return
	}
	if len(cfg.Clipboard.IgnoreApps) > 0 {
		app := platform.FrontApp().Name
		for _, ignore := range cfg.Clipboard.IgnoreApps {
			if ignore != "" && strings.EqualFold(app, ignore) {
				return
			}
		}
		entry.App = app
	}
	c.mu.Lock()
	recent := *entry
	c.last = &recent
	c.mu.Unlock()
	c.add(entry, cfg)
}

func (c *Clipboard) read(cfg *store.Config) *ClipEntry {
	now := time.Now()
	if files, err := c.Source.ReadFiles(); err == nil && len(files) > 0 {
		return &ClipEntry{ID: hashText("files:" + strings.Join(files, "\n")), Kind: "files", Files: files, Time: now}
	}
	if text := c.Source.ReadText(); strings.TrimSpace(text) != "" {
		if len(text) > maxClipText {
			text = text[:maxClipText]
		}
		return &ClipEntry{ID: hashText("text:" + text), Kind: "text", Text: text, Size: int64(len(text)), Time: now}
	}
	if cfg.Clipboard.Images && c.Source.HasImage() {
		data := c.Source.ReadImage()
		if len(data) == 0 {
			return nil
		}
		id := hashText("image:" + string(data))
		path := filepath.Join(c.Dir, "clipboard", id+".png")
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return nil
		}
		return &ClipEntry{ID: id, Kind: "image", Image: path, Size: int64(len(data)), Time: now}
	}
	return nil
}

func hashText(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:8])
}

// add 写入一条历史。相同内容不重复记录，只提到最前面。
func (c *Clipboard) add(e *ClipEntry, cfg *store.Config) {
	e.prepare()
	c.mu.Lock()
	defer c.mu.Unlock()
	if i := slices.IndexFunc(c.entries, func(x *ClipEntry) bool { return x.ID == e.ID }); i >= 0 {
		e.Pinned = c.entries[i].Pinned
		if e.App == "" {
			e.App = c.entries[i].App
		}
		c.entries = slices.Delete(c.entries, i, i+1)
	}
	c.entries = slices.Insert(c.entries, 0, e)
	c.prune(cfg)
	c.scheduleSave()
}

// prune 按数量和时间淘汰，固定的不淘汰。
func (c *Clipboard) prune(cfg *store.Config) {
	deadline := time.Now().AddDate(0, 0, -cfg.Clipboard.MaxDays)
	kept := c.entries[:0:0]
	count := 0
	for _, e := range c.entries {
		if !e.Pinned && (count >= cfg.Clipboard.MaxItems || e.Time.Before(deadline)) {
			if e.Image != "" {
				_ = os.Remove(e.Image)
			}
			continue
		}
		kept = append(kept, e)
		count++
	}
	c.entries = kept
}

func (c *Clipboard) scheduleSave() {
	if c.Changed != nil {
		go c.Changed()
	}
	if c.timer != nil {
		c.timer.Stop()
	}
	c.timer = time.AfterFunc(time.Second, func() { _ = c.Flush() })
}

// Flush 立即写盘。
func (c *Clipboard) Flush() error {
	c.mu.RLock()
	raw, err := json.Marshal(c.entries)
	c.mu.RUnlock()
	if err != nil {
		return err
	}
	return store.WriteFileAtomic(c.file(), raw)
}

// Recent 返回 within 时间内复制的内容（文字、图片或文件），用于唤出时自动带入。只带入一次。
func (c *Clipboard) Recent(within time.Duration) *ClipEntry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.last == nil || time.Since(c.last.Time) > within {
		return nil
	}
	e := c.last
	c.last = nil
	return e
}

// Clear 清空历史（固定的保留）。
func (c *Clipboard) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	kept := c.entries[:0:0]
	for _, e := range c.entries {
		if e.Pinned {
			kept = append(kept, e)
		} else if e.Image != "" {
			_ = os.Remove(e.Image)
		}
	}
	c.entries = kept
	c.scheduleSave()
}

// Search 实现 core.Provider。
func (c *Clipboard) Search(_ context.Context, req *core.Request) []core.Item {
	text := strings.TrimSpace(req.Text)
	lower := strings.ToLower(text)
	c.mu.RLock()
	defer c.mu.RUnlock()

	var pinned, rest []core.Item
	for i, e := range c.entries {
		score := 1 - float64(i)*0.0001 // 没有输入时按时间排序
		var highlights []int
		if text != "" {
			r := e.target.Match(req.Query)
			switch {
			case r.OK && r.Score > 0:
				score, highlights = r.Score, r.Positions
			case e.Kind == "text" && strings.Contains(strings.ToLower(e.Text), lower):
				score = 0.5 - float64(i)*0.0001
			default:
				continue
			}
		}
		it := c.item(e)
		it.Score, it.Highlights = score, highlights
		if e.Pinned {
			it.Score += 0.3
			pinned = append(pinned, it)
		} else {
			rest = append(rest, it)
		}
	}
	return append(pinned, rest...)
}

func (c *Clipboard) item(e *ClipEntry) core.Item {
	id := e.ID
	sub := humanTime(e.Time)
	if e.App != "" {
		sub += " · " + e.App
	}
	it := core.Item{
		ID:       "clipboard:" + id,
		Title:    truncate(e.label(), 200),
		Subtitle: sub,
		Source:   "clipboard",
		Ephem:    true,
		Pinned:   e.Pinned,
	}
	paste := core.Action{Type: core.ActionPaste, Title: "粘贴到当前窗口"}
	cp := core.Action{Type: core.ActionCopy, Title: "复制"}
	switch e.Kind {
	case "image":
		it.Icon = "svg:image"
		it.Subtitle = sub + " · " + HumanSize(e.Size)
		paste.Image, cp.Image = e.Image, e.Image
		it.Preview = &core.Preview{Type: "image", URL: "image:" + e.Image, Info: HumanSize(e.Size)}
	case "files":
		it.Icon = "file:" + e.Files[0]
		paste.Files, cp.Files = e.Files, e.Files
		it.Preview = &core.Preview{Type: "text", Text: strings.Join(e.Files, "\n"), Info: fmt.Sprintf("%d 个文件", len(e.Files))}
	default:
		it.Icon = "svg:text"
		paste.Text, cp.Text = e.Text, e.Text
		it.Preview = &core.Preview{Type: "text", Text: truncate(e.Text, 20000), Info: HumanSize(e.Size)}
	}
	pinTitle := "固定"
	if e.Pinned {
		pinTitle = "取消固定"
	}
	it.Actions = []core.Action{paste, cp}
	if e.Kind == "text" && scriptsLooksOpenable(strings.TrimSpace(e.Text)) {
		it.Actions = append(it.Actions, core.Action{Type: core.ActionOpen, Title: "打开", Target: strings.TrimSpace(e.Text)})
	}
	it.Actions = append(it.Actions,
		core.Action{Type: core.ActionFunc, Title: pinTitle, Shortcut: "mod+shift+p", KeepOpen: true, Fn: func(_ context.Context, r *core.Run) error {
			c.togglePin(id)
			r.Refresh()
			return nil
		}},
		core.Action{Type: core.ActionFunc, Title: "删除这条", Shortcut: "mod+backspace", KeepOpen: true, Fn: func(_ context.Context, r *core.Run) error {
			c.remove(id)
			r.Refresh()
			return nil
		}},
		core.Action{Type: core.ActionFunc, Title: "清空历史", KeepOpen: true, Confirm: "确定清空剪贴板历史？固定的内容会保留。", Fn: func(_ context.Context, r *core.Run) error {
			c.Clear()
			r.Refresh()
			return nil
		}},
	)
	return it
}

func scriptsLooksOpenable(s string) bool {
	return !strings.ContainsAny(s, " \n\t") && (strings.Contains(s, "://") || IsPathInput(s))
}

func (c *Clipboard) togglePin(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.entries {
		if e.ID == id {
			e.Pinned = !e.Pinned
			break
		}
	}
	c.scheduleSave()
}

func (c *Clipboard) remove(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if i := slices.IndexFunc(c.entries, func(e *ClipEntry) bool { return e.ID == id }); i >= 0 {
		if c.entries[i].Image != "" {
			_ = os.Remove(c.entries[i].Image)
		}
		c.entries = slices.Delete(c.entries, i, i+1)
	}
	c.scheduleSave()
}

func humanTime(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "刚刚"
	case d < time.Hour:
		return fmt.Sprintf("%d 分钟前", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d 小时前", int(d.Hours()))
	case d < 7*24*time.Hour:
		return fmt.Sprintf("%d 天前", int(d.Hours()/24))
	}
	return t.Format("2006-01-02")
}

// ClipView 是剪贴板页面里的一条。
type ClipView struct {
	ID     string   `json:"id"`
	Kind   string   `json:"kind"`
	Label  string   `json:"label"`
	Text   string   `json:"text,omitempty"` // 预览用，过长时截断
	Image  string   `json:"image,omitempty"`
	Files  []string `json:"files,omitempty"`
	Size   string   `json:"size,omitempty"`
	Chars  int      `json:"chars,omitempty"`
	App    string   `json:"app,omitempty"`
	Time   int64    `json:"time"`
	When   string   `json:"when"`
	Pinned bool     `json:"pinned,omitempty"`
}

// Entries 列出历史：固定的在前，其余按时间；query 不为空时按匹配程度。kind 为空表示全部。
func (c *Clipboard) Entries(query, kind string, limit int) []ClipView {
	q := match.NewQuery(strings.TrimSpace(query))
	lower := strings.ToLower(strings.TrimSpace(query))
	c.mu.RLock()
	defer c.mu.RUnlock()
	type scored struct {
		v     ClipView
		score float64
	}
	var list []scored
	for i, e := range c.entries {
		if kind != "" && e.Kind != kind {
			continue
		}
		score := 1 - float64(i)*0.0001
		if lower != "" {
			r := e.target.Match(q)
			switch {
			case r.OK && r.Score > 0:
				score = r.Score
			case e.Kind == "text" && strings.Contains(strings.ToLower(e.Text), lower):
				score = 0.5 - float64(i)*0.0001
			default:
				continue
			}
		}
		if e.Pinned {
			score += 2
		}
		v := ClipView{
			ID: e.ID, Kind: e.Kind, Label: truncate(e.label(), 200), Image: e.Image, Files: e.Files, Size: HumanSize(e.Size),
			App: e.App, Time: e.Time.UnixMilli(), When: humanTime(e.Time), Pinned: e.Pinned,
		}
		if e.Kind == "text" {
			v.Text, v.Chars = truncate(e.Text, 20000), utf8.RuneCountInString(e.Text)
		}
		list = append(list, scored{v, score})
	}
	slices.SortStableFunc(list, func(a, b scored) int {
		switch {
		case a.score > b.score:
			return -1
		case a.score < b.score:
			return 1
		}
		return 0
	})
	if limit > 0 && len(list) > limit {
		list = list[:limit]
	}
	out := make([]ClipView, len(list))
	for i, x := range list {
		out[i] = x.v
	}
	return out
}

// Entry 返回一条历史的完整内容。
func (c *Clipboard) Entry(id string) (ClipEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, e := range c.entries {
		if e.ID == id {
			return *e, true
		}
	}
	return ClipEntry{}, false
}

// TogglePin 固定或取消固定一条。
func (c *Clipboard) TogglePin(id string) { c.togglePin(id) }

// Remove 删除一条。
func (c *Clipboard) Remove(id string) { c.remove(id) }
