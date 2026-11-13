package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseConfigKeepsDefaults(t *testing.T) {
	c, err := ParseConfig([]byte(`{"hotkey":"Ctrl+Space","modules":{"files":{"enabled":false}},"appearance":{"width":99999}}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.Hotkey != "Ctrl+Space" {
		t.Errorf("hotkey = %q", c.Hotkey)
	}
	if c.Appearance.Width != 1200 {
		t.Errorf("越界的宽度应被拉回：%d", c.Appearance.Width)
	}
	if c.Appearance.Rows != 8 {
		t.Errorf("缺失字段应保持默认：%d", c.Appearance.Rows)
	}
	f := c.Modules["files"]
	if f.Enabled || f.Prefix != "f" {
		t.Errorf("模块内缺失的字段应保持默认：%+v", f)
	}
	if !c.Modules["apps"].Enabled {
		t.Errorf("未提到的模块应保持默认")
	}
}

func TestBadConfigKeepsLastValid(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.json")
	s := NewConfigStore(p)
	if err := s.Update(func(c *Config) { c.Hotkey = "Ctrl+Space" }); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("{\n  \"hotkey\": \n}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !s.Reload() {
		t.Fatal("内容变化应返回 true")
	}
	if s.Get().Hotkey != "Ctrl+Space" {
		t.Errorf("写错时应保留上一份有效配置，得到 %q", s.Get().Hotkey)
	}
	if s.LoadError() == "" {
		t.Errorf("应记录错误")
	}
	if err := os.WriteFile(p, []byte(`{"hotkey":"F1"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s.Reload()
	if s.Get().Hotkey != "F1" || s.LoadError() != "" {
		t.Errorf("修好后应恢复：%q %q", s.Get().Hotkey, s.LoadError())
	}
}

func TestUsageBoostAndDecay(t *testing.T) {
	u := NewUsage(filepath.Join(t.TempDir(), "usage.json"))
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	u.now = func() time.Time { return now }
	for range 5 {
		u.Record("chr", Entry{ID: "a", Title: "Chrome"})
	}
	u.Record("c", Entry{ID: "b", Title: "Code"})

	if u.Boost("c", "a", 14) <= u.Boost("c", "b", 14) {
		t.Errorf("选过更多次的应加分更多")
	}
	if u.Boost("zzz", "a", 14) >= u.Boost("chr", "a", 14) {
		t.Errorf("命中前缀应比未命中加分更多")
	}
	fresh := u.Boost("c", "a", 14)
	now = now.AddDate(0, 0, 14)
	if got := u.Boost("c", "a", 14); got > fresh*0.51 || got < fresh*0.49 {
		t.Errorf("过一个半衰期应减半：%.3f → %.3f", fresh, got)
	}
	if top := u.Top(1, 14); len(top) != 1 || top[0].ID != "a" {
		t.Errorf("Top = %+v", top)
	}
}

func TestUsagePersists(t *testing.T) {
	p := filepath.Join(t.TempDir(), "usage.json")
	u := NewUsage(p)
	u.Record("x", Entry{ID: "a", Title: "A"})
	u.TogglePin(Entry{ID: "b", Title: "B"})
	if err := u.Flush(); err != nil {
		t.Fatal(err)
	}
	v := NewUsage(p)
	if !v.IsPinned("b") || len(v.Top(5, 14)) != 1 {
		t.Errorf("重新加载后数据丢失")
	}
	if v.TogglePin(Entry{ID: "b"}) || v.IsPinned("b") {
		t.Errorf("再次切换应取消置顶")
	}
}
