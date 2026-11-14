package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeInjector 只把“本来要发出去的输入”记下来，不碰真实的鼠标键盘。
type fakeInjector struct {
	mu     sync.Mutex
	log    []string
	x, y   int
	failOn string
}

func (f *fakeInjector) add(format string, args ...any) {
	f.mu.Lock()
	f.log = append(f.log, fmt.Sprintf(format, args...))
	f.mu.Unlock()
}
func (f *fakeInjector) events() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.log...)
}
func (f *fakeInjector) MousePos() (int, int, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.x, f.y, true
}
func (f *fakeInjector) MouseMove(x, y int) error {
	f.mu.Lock()
	f.x, f.y = x, y
	f.mu.Unlock()
	f.add("move %d,%d", x, y)
	return nil
}
func (f *fakeInjector) MouseButton(b string, down bool, n int) error {
	f.add("%s %v #%d", b, down, n)
	return nil
}
func (f *fakeInjector) MouseScroll(lines int) error { f.add("scroll %d", lines); return nil }
func (f *fakeInjector) Key(code string, down bool) error {
	if code == f.failOn && down {
		return fmt.Errorf("模拟失败")
	}
	f.add("key %s %v", code, down)
	return nil
}
func (f *fakeInjector) Text(s string) error { f.add("text %s", s); return nil }

func newTestEngine(t *testing.T) (*autoEngine, *fakeInjector, func() AutoStatus) {
	t.Helper()
	e := newAutoEngine(filepath.Join(t.TempDir(), "auto.json"))
	fake := &fakeInjector{x: 500, y: 400}
	e.inject = fake
	var mu sync.Mutex
	var last AutoStatus
	finished := make(chan struct{}, 8)
	e.onStatus = func(s AutoStatus) {
		mu.Lock()
		last = s
		mu.Unlock()
		if !s.Running {
			finished <- struct{}{}
		}
	}
	wait := func() AutoStatus {
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Fatal("任务没有在 5 秒内结束")
		}
		mu.Lock()
		defer mu.Unlock()
		return last
	}
	return e, fake, wait
}

func count(events []string, prefix string) int {
	n := 0
	for _, e := range events {
		if strings.HasPrefix(e, prefix) {
			n++
		}
	}
	return n
}

func TestClickerCount(t *testing.T) {
	e, fake, wait := newTestEngine(t)
	e.setClicker(ClickerConfig{Button: "right", Kind: "double", IntervalMs: 2, StopMode: "count", Count: 5, Position: "fixed", X: 100, Y: 200, Jitter: 3})
	if err := e.startClicker(); err != nil {
		t.Fatal(err)
	}
	st := wait()
	ev := fake.events()
	if st.Count != 5 || !strings.Contains(st.Note, "5 次") {
		t.Fatalf("应该点完 5 次：%+v", st)
	}
	// 双击：每次是两下，按下和松开成对，第二下标着 #2。
	if count(ev, "right true") != 10 || count(ev, "right false") != 10 || count(ev, "right true #2") != 5 {
		t.Fatalf("双击的事件不对：%v", ev)
	}
	if count(ev, "move ") != 5 {
		t.Fatalf("固定位置时每次都应该先移过去：%v", ev)
	}
	for _, x := range ev {
		if strings.HasPrefix(x, "move ") {
			var mx, my int
			fmt.Sscanf(x, "move %d,%d", &mx, &my)
			if mx < 97 || mx > 103 || my < 197 || my > 203 {
				t.Fatalf("随机偏移超出了设定的范围：%s", x)
			}
		}
	}
}

func TestClickerDurationAndStop(t *testing.T) {
	e, fake, wait := newTestEngine(t)
	e.setClicker(ClickerConfig{Button: "left", Kind: "single", IntervalMs: 20, IntervalMaxMs: 40, StopMode: "duration", DurationSec: 0.3})
	start := time.Now()
	if err := e.startClicker(); err != nil {
		t.Fatal(err)
	}
	st := wait()
	if d := time.Since(start); d < 250*time.Millisecond || d > 900*time.Millisecond {
		t.Fatalf("应该在大约 0.3 秒后停下，用了 %s", d)
	}
	if st.Count < 5 || st.Count > 16 || count(fake.events(), "left true") != st.Count {
		t.Fatalf("20–40 毫秒随机间隔、0.3 秒，应该点 7–15 次左右：%d", st.Count)
	}

	// 手动停止：一直点，直到 stop。
	e.setClicker(ClickerConfig{Button: "left", Kind: "hold", HoldMs: 30, IntervalMs: 10, StopMode: "manual"})
	_ = e.startClicker()
	time.Sleep(120 * time.Millisecond)
	e.stop()
	st = wait()
	ev := fake.events()
	if st.Running || st.Note != "已停止" || count(ev, "left true") != count(ev, "left false") {
		t.Fatalf("停止后状态不对，或者有按下没松开的：%+v", st)
	}
	if e.running() {
		t.Fatal("停止后不该还在运行")
	}
}

func TestClickerFailsafe(t *testing.T) {
	e, fake, wait := newTestEngine(t)
	fake.x, fake.y = 0, 0
	e.setClicker(ClickerConfig{Button: "left", Kind: "single", IntervalMs: 5, StopMode: "manual", Failsafe: true})
	_ = e.startClicker()
	st := wait()
	if st.Count != 0 || !strings.Contains(st.Note, "左上角") {
		t.Fatalf("鼠标在左上角时应该立刻停止：%+v", st)
	}
}

func TestMacro(t *testing.T) {
	e, fake, wait := newTestEngine(t)
	m, err := e.saveMacro(Macro{Name: "测试", Loops: 2, Speed: 10, Steps: []MacroStep{
		{Type: "key", Keys: []string{"ControlLeft", "ShiftLeft", "KeyK"}},
		{Type: "key", Keys: []string{"KeyA"}, Repeat: 3, IntervalMs: 20, HoldMs: 50},
		{Type: "text", Text: "你好"},
		{Type: "delay", Ms: 10, MsMax: 30},
		{Type: "down", Keys: []string{"ShiftLeft"}},
		{Type: "click", Button: "left", Move: true, X: 10, Y: 20, Repeat: 2},
		{Type: "scroll", Lines: -3},
	}})
	if err != nil || m.ID == "" {
		t.Fatalf("保存：%+v %v", m, err)
	}
	if err := e.startMacro(m.ID); err != nil {
		t.Fatal(err)
	}
	st := wait()
	ev := fake.events()
	if st.Count != 2 || !strings.Contains(st.Note, "2 遍") {
		t.Fatalf("应该执行 2 遍：%+v", st)
	}
	// 组合键：按顺序按下，倒序松开。
	want := []string{"key ControlLeft true", "key ShiftLeft true", "key KeyK true", "key KeyK false", "key ShiftLeft false", "key ControlLeft false"}
	for i, w := range want {
		if ev[i] != w {
			t.Fatalf("组合键的顺序不对，第 %d 个是 %q，应为 %q", i, ev[i], w)
		}
	}
	if count(ev, "key KeyA true") != 6 || count(ev, "text 你好") != 2 || count(ev, "move 10,20") != 2 || count(ev, "left true") != 4 || count(ev, "scroll -3") != 2 {
		t.Fatalf("各步骤的次数不对：%v", ev)
	}
	// “按住不放”的 Shift 没有对应的松开步骤：每一遍结束不松，整个宏结束时必须松开。
	lastShift := ""
	for _, x := range ev {
		if strings.HasPrefix(x, "key ShiftLeft") {
			lastShift = x
		}
	}
	if lastShift != "key ShiftLeft false" || ev[len(ev)-1] != "key ShiftLeft false" {
		t.Fatalf("宏结束后还有键按着没松开：%v", ev)
	}

	// 中途出错：报出是第几步，已经按下的键也要松开。
	fake.failOn = "KeyK"
	fake.mu.Lock()
	fake.log = nil
	fake.mu.Unlock()
	_ = e.startMacro(m.ID)
	st = wait()
	ev = fake.events()
	if !strings.Contains(st.Note, "第 1 步") || count(ev, "key ControlLeft true") != count(ev, "key ControlLeft false") {
		t.Fatalf("出错时应该指出步骤并松开按键：%+v %v", st, ev)
	}

	if _, err := e.saveMacro(Macro{Steps: []MacroStep{{Type: "key"}}}); err == nil {
		t.Fatal("没选按键的步骤应该保存不了")
	}
	if got := e.hotkeys(); len(got) != 0 {
		t.Fatalf("没设快捷键时不该注册：%v", got)
	}
	m.Hotkey = "Ctrl+Alt+M"
	_, _ = e.saveMacro(m)
	e.setClicker(ClickerConfig{Hotkey: "F6"})
	if got := e.hotkeys(); got["macro:"+m.ID] != "Ctrl+Alt+M" || got["auto:clicker"] != "F6" {
		t.Fatalf("快捷键：%v", got)
	}
	// 设置和宏存在文件里，重新加载还在。
	again := newAutoEngine(e.file)
	c, macros, _ := again.snapshot()
	if len(macros) != 1 || macros[0].Name != "测试" || c.Hotkey != "F6" {
		t.Fatalf("重新加载后不对：%+v %+v", c, macros)
	}
	e.deleteMacro(m.ID)
	if _, macros, _ := e.snapshot(); len(macros) != 0 {
		t.Fatal("删除后还在")
	}
}
