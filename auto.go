package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/providers"
)

// 鼠标连点器和键盘宏：按设定好的节奏模拟鼠标键盘。

// injector 是真正发出输入的那一层。测试时换成只记录、不发送的假实现。
type injector interface {
	MousePos() (x, y int, ok bool)
	MouseMove(x, y int) error
	MouseButton(button string, down bool, clicks int) error
	MouseScroll(lines int) error
	Key(code string, down bool) error
	Text(s string) error
}

type systemInjector struct{}

func (systemInjector) MousePos() (int, int, bool) { return platform.MousePos() }
func (systemInjector) MouseMove(x, y int) error   { return platform.MouseMove(x, y) }
func (systemInjector) MouseButton(b string, d bool, n int) error {
	return platform.MouseButton(b, d, n)
}
func (systemInjector) MouseScroll(lines int) error      { return platform.MouseScroll(lines) }
func (systemInjector) Key(code string, down bool) error { return platform.KeyEvent(code, down) }
func (systemInjector) Text(s string) error              { return platform.SendText(s) }

// ClickerConfig 是连点器的设置。
type ClickerConfig struct {
	Button string `json:"button"` // left | right | middle
	Kind   string `json:"kind"`   // single 单击 | double 双击 | triple 三击 | hold 长按
	HoldMs int    `json:"holdMs"` // 长按时按住多久

	IntervalMs    int `json:"intervalMs"`    // 两次点击之间的间隔
	IntervalMaxMs int `json:"intervalMaxMs"` // 大于 IntervalMs 时，每次在两者之间随机取

	StopMode    string  `json:"stopMode"`    // manual 手动停 | count 点够次数 | duration 到时间
	Count       int     `json:"count"`       // 点多少次
	DurationSec float64 `json:"durationSec"` // 持续多少秒

	Position string `json:"position"` // cursor 跟着鼠标 | fixed 固定位置
	X        int    `json:"x"`
	Y        int    `json:"y"`
	Jitter   int    `json:"jitter"` // 固定位置时，每次在这个半径（像素）里随机偏一点

	StartDelaySec float64 `json:"startDelaySec"` // 开始前倒计时，来得及把鼠标移过去
	Failsafe      bool    `json:"failsafe"`      // 把鼠标甩到屏幕左上角立刻停止
	Hotkey        string  `json:"hotkey"`        // 开始 / 停止的全局快捷键
}

// MacroStep 是宏里的一步。
type MacroStep struct {
	// Type：key 按一下（Keys 多于一个就是组合键）| down 按住不放 | up 松开 | text 输入文字 |
	// delay 等待 | click 鼠标点击 | scroll 滚轮
	Type string `json:"type"`
	// Keys 是按键名（KeyboardEvent.code）。组合键按顺序按下、倒序松开。
	Keys       []string `json:"keys,omitempty"`
	HoldMs     int      `json:"holdMs,omitempty"`     // key：按住多久再松开（长按）
	Repeat     int      `json:"repeat,omitempty"`     // key / click：连续几次
	IntervalMs int      `json:"intervalMs,omitempty"` // 连续多次时每次之间的间隔
	Text       string   `json:"text,omitempty"`
	Ms         int      `json:"ms,omitempty"`    // delay：等多久
	MsMax      int      `json:"msMax,omitempty"` // delay：大于 Ms 时在两者之间随机
	Button     string   `json:"button,omitempty"`
	Move       bool     `json:"move,omitempty"` // click：先把鼠标移到 X, Y
	X          int      `json:"x,omitempty"`
	Y          int      `json:"y,omitempty"`
	Lines      int      `json:"lines,omitempty"` // scroll：滚几行，正数向上
}

// Macro 是一个键盘宏。
type Macro struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	Steps         []MacroStep `json:"steps"`
	Loops         int         `json:"loops"`         // 执行几遍；0 表示一直到手动停止
	LoopDelayMs   int         `json:"loopDelayMs"`   // 每遍之间的间隔
	Speed         float64     `json:"speed"`         // 速度倍数，2 是两倍速
	StartDelaySec float64     `json:"startDelaySec"` // 开始前倒计时
	Hotkey        string      `json:"hotkey"`        // 运行 / 停止的全局快捷键
}

// AutoStatus 是运行状态，变化时发给页面。
type AutoStatus struct {
	Running   bool   `json:"running"`
	Kind      string `json:"kind,omitempty"` // clicker | macro
	ID        string `json:"id,omitempty"`   // 宏的 ID
	Name      string `json:"name,omitempty"`
	Count     int    `json:"count"`     // 已经点了多少次 / 跑完了几遍
	Step      int    `json:"step"`      // 宏：正在执行第几步（从 1 开始）
	Countdown int    `json:"countdown"` // 倒计时还剩几秒
	ElapsedMs int64  `json:"elapsedMs"`
	Note      string `json:"note,omitempty"` // 结束的原因，或出了什么错
}

type autoData struct {
	Clicker ClickerConfig `json:"clicker"`
	Macros  []Macro       `json:"macros"`
}

func defaultClicker() ClickerConfig {
	return ClickerConfig{
		Button: "left", Kind: "single", HoldMs: 500, IntervalMs: 100, StopMode: "manual", Count: 100, DurationSec: 10,
		// 快捷键默认不设：全局快捷键会从别的程序手里抢键，用到连点器的人自己挑一个。
		Position: "cursor", StartDelaySec: 3, Failsafe: true,
	}
}

func (c *ClickerConfig) normalize() {
	d := defaultClicker()
	if c.Button != "left" && c.Button != "right" && c.Button != "middle" {
		c.Button = d.Button
	}
	switch c.Kind {
	case "single", "double", "triple", "hold":
	default:
		c.Kind = d.Kind
	}
	switch c.StopMode {
	case "manual", "count", "duration":
	default:
		c.StopMode = d.StopMode
	}
	if c.Position != "fixed" {
		c.Position = "cursor"
	}
	c.HoldMs = min(max(c.HoldMs, 10), 600_000)
	c.IntervalMs = min(max(c.IntervalMs, 1), 3_600_000)
	c.IntervalMaxMs = min(max(c.IntervalMaxMs, 0), 3_600_000)
	c.Count = min(max(c.Count, 1), 10_000_000)
	c.DurationSec = min(max(c.DurationSec, 0.1), 86_400)
	c.StartDelaySec = min(max(c.StartDelaySec, 0), 60)
	c.Jitter = min(max(c.Jitter, 0), 500)
}

const (
	maxMacroSteps = 2000
	maxMacros     = 200
)

func (m *Macro) normalize() error {
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" {
		m.Name = "未命名的宏"
	}
	if len(m.Steps) > maxMacroSteps {
		return fmt.Errorf("步骤太多了（最多 %d 步）", maxMacroSteps)
	}
	if m.Speed <= 0 {
		m.Speed = 1
	}
	m.Speed = min(max(m.Speed, 0.1), 20)
	m.Loops = min(max(m.Loops, 0), 1_000_000)
	m.LoopDelayMs = min(max(m.LoopDelayMs, 0), 3_600_000)
	m.StartDelaySec = min(max(m.StartDelaySec, 0), 60)
	for i := range m.Steps {
		s := &m.Steps[i]
		switch s.Type {
		case "key", "down", "up":
			if len(s.Keys) == 0 {
				return fmt.Errorf("第 %d 步还没有选按键", i+1)
			}
			for _, k := range s.Keys {
				if !platform.KeySupported(k) && len(platform.KeyCodes()) > 0 {
					return fmt.Errorf("第 %d 步的按键「%s」在这个系统上模拟不了", i+1, k)
				}
			}
		case "text":
			if len(s.Text) > 20_000 {
				return fmt.Errorf("第 %d 步的文字太长了", i+1)
			}
		case "delay", "scroll":
		case "click":
			if s.Button != "right" && s.Button != "middle" {
				s.Button = "left"
			}
		default:
			return fmt.Errorf("第 %d 步的类型不认识：%s", i+1, s.Type)
		}
		s.HoldMs = min(max(s.HoldMs, 0), 600_000)
		s.Repeat = min(max(s.Repeat, 0), 100_000)
		s.IntervalMs = min(max(s.IntervalMs, 0), 3_600_000)
		s.Ms = min(max(s.Ms, 0), 3_600_000)
		s.MsMax = min(max(s.MsMax, 0), 3_600_000)
	}
	return nil
}

var errNeedInputPermission = errors.New("系统还不允许本应用模拟鼠标键盘。macOS 上要在“系统设置 → 隐私与安全性 → 辅助功能”里打开它；已经打开了还是这样的话，到“设置 → 关于 → 环境检查”里点“重置”再重新授权")

// autoEngine 保存设置并负责运行。同一时间只跑一个任务。
type autoEngine struct {
	file   string
	inject injector
	// onStatus 在状态变化时调用；onHotkeys 在快捷键设置变了之后调用（重新注册）。
	onStatus  func(AutoStatus)
	onHotkeys func()

	mu     sync.Mutex
	data   autoData
	status AutoStatus
	cancel context.CancelFunc
	done   chan struct{}
}

func newAutoEngine(file string) *autoEngine {
	e := &autoEngine{file: file, inject: systemInjector{}, data: autoData{Clicker: defaultClicker()}}
	if raw, err := os.ReadFile(file); err == nil {
		var d autoData
		if json.Unmarshal(raw, &d) == nil {
			d.Clicker.normalize()
			e.data = d
		}
	}
	return e
}

func (e *autoEngine) save() {
	raw, _ := json.MarshalIndent(e.data, "", "  ")
	_ = os.MkdirAll(filepath.Dir(e.file), 0o700)
	_ = os.WriteFile(e.file, raw, 0o600)
}

func (e *autoEngine) snapshot() (ClickerConfig, []Macro, AutoStatus) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.data.Clicker, append([]Macro{}, e.data.Macros...), e.status
}

// hotkeys 返回要注册的全局快捷键：ID → 组合键。
func (e *autoEngine) hotkeys() map[string]string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := map[string]string{}
	if e.data.Clicker.Hotkey != "" {
		out["auto:clicker"] = e.data.Clicker.Hotkey
	}
	for _, m := range e.data.Macros {
		if m.Hotkey != "" {
			out["macro:"+m.ID] = m.Hotkey
		}
	}
	return out
}

func (e *autoEngine) setClicker(c ClickerConfig) ClickerConfig {
	c.normalize()
	e.mu.Lock()
	changed := e.data.Clicker.Hotkey != c.Hotkey
	e.data.Clicker = c
	e.save()
	e.mu.Unlock()
	if changed && e.onHotkeys != nil {
		e.onHotkeys()
	}
	return c
}

func (e *autoEngine) saveMacro(m Macro) (Macro, error) {
	if err := m.normalize(); err != nil {
		return m, err
	}
	e.mu.Lock()
	if m.ID == "" {
		if len(e.data.Macros) >= maxMacros {
			e.mu.Unlock()
			return m, errors.New("宏太多了，先删掉几个")
		}
		m.ID = providers.NewUUID()[:8]
		e.data.Macros = append(e.data.Macros, m)
	} else {
		found := false
		for i := range e.data.Macros {
			if e.data.Macros[i].ID == m.ID {
				e.data.Macros[i], found = m, true
			}
		}
		if !found {
			e.data.Macros = append(e.data.Macros, m)
		}
	}
	e.save()
	e.mu.Unlock()
	if e.onHotkeys != nil {
		e.onHotkeys()
	}
	return m, nil
}

func (e *autoEngine) deleteMacro(id string) {
	e.mu.Lock()
	for i, m := range e.data.Macros {
		if m.ID == id {
			e.data.Macros = append(e.data.Macros[:i:i], e.data.Macros[i+1:]...)
			break
		}
	}
	e.save()
	e.mu.Unlock()
	if e.onHotkeys != nil {
		e.onHotkeys()
	}
}

func (e *autoEngine) report(s AutoStatus) {
	e.mu.Lock()
	e.status = s
	e.mu.Unlock()
	if e.onStatus != nil {
		e.onStatus(s)
	}
}

// stop 停掉正在跑的任务，并等它收尾（松开还按着的键）。
func (e *autoEngine) stop() {
	e.mu.Lock()
	cancel, done := e.cancel, e.done
	e.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

func (e *autoEngine) running() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.cancel != nil
}

// start 开始一个任务；已经有任务在跑时先停掉它。
func (e *autoEngine) start(kind, id, name string, delay float64, job func(ctx context.Context, st *AutoStatus, tick func()) string) error {
	if e.inject == (systemInjector{}) && !platform.InputAllowed() {
		return errNeedInputPermission
	}
	e.stop()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	e.mu.Lock()
	e.cancel, e.done = cancel, done
	e.mu.Unlock()
	go func() {
		st := AutoStatus{Running: true, Kind: kind, ID: id, Name: name}
		started := time.Now()
		last := time.Time{}
		// tick 把进度报给页面，最多每 80 毫秒一次，免得点得快时把界面刷爆。
		tick := func() {
			if time.Since(last) < 80*time.Millisecond {
				return
			}
			last = time.Now()
			st.ElapsedMs = time.Since(started).Milliseconds()
			e.report(st)
		}
		note := ""
		// 倒计时
		for left := delay; left > 0 && ctx.Err() == nil; left-- {
			st.Countdown = int(left + 0.999)
			e.report(st)
			sleepCtx(ctx, time.Duration(min(left, 1)*float64(time.Second)))
		}
		st.Countdown = 0
		if ctx.Err() == nil {
			started = time.Now()
			e.report(st)
			note = job(ctx, &st, tick)
		}
		if note == "" && ctx.Err() != nil {
			note = "已停止"
		}
		st.Running, st.Note, st.ElapsedMs = false, note, time.Since(started).Milliseconds()
		e.mu.Lock()
		e.cancel, e.done = nil, nil
		e.mu.Unlock()
		cancel()
		e.report(st)
		close(done)
	}()
	return nil
}

// sleepCtx 睡一会儿；任务被停掉时立刻返回 false。
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func between(lo, hi int) int {
	if hi > lo {
		return lo + rand.IntN(hi-lo+1)
	}
	return lo
}

// press 完成一次点击（单击、双击、三击或长按）。
func (e *autoEngine) press(ctx context.Context, button, kind string, holdMs int) error {
	times := map[string]int{"double": 2, "triple": 3}[kind]
	if times == 0 {
		times = 1
	}
	for i := 1; i <= times; i++ {
		if err := e.inject.MouseButton(button, true, i); err != nil {
			return err
		}
		hold := 12 * time.Millisecond
		if kind == "hold" {
			hold = time.Duration(holdMs) * time.Millisecond
		}
		ok := sleepCtx(ctx, hold)
		// 不管是不是被停掉，按下去的一定要松开。
		if err := e.inject.MouseButton(button, false, i); err != nil {
			return err
		}
		if !ok {
			return nil
		}
		if i < times && !sleepCtx(ctx, 45*time.Millisecond) {
			return nil
		}
	}
	return nil
}

func (e *autoEngine) startClicker() error {
	c, _, _ := e.snapshot()
	return e.start("clicker", "", "鼠标连点", c.StartDelaySec, func(ctx context.Context, st *AutoStatus, tick func()) string {
		began := time.Now()
		limit := time.Duration(c.DurationSec * float64(time.Second))
		for ctx.Err() == nil {
			if c.StopMode == "count" && st.Count >= c.Count {
				return fmt.Sprintf("点完了 %d 次", st.Count)
			}
			if c.StopMode == "duration" && time.Since(began) >= limit {
				return fmt.Sprintf("到时间了，一共点了 %d 次", st.Count)
			}
			if c.Failsafe {
				if x, y, ok := e.inject.MousePos(); ok && x <= 2 && y <= 2 {
					return "鼠标移到了屏幕左上角，已停止"
				}
			}
			if c.Position == "fixed" {
				x, y := c.X, c.Y
				if c.Jitter > 0 {
					x += between(-c.Jitter, c.Jitter)
					y += between(-c.Jitter, c.Jitter)
				}
				if err := e.inject.MouseMove(x, y); err != nil {
					return "出错了：" + err.Error()
				}
			}
			if err := e.press(ctx, c.Button, c.Kind, c.HoldMs); err != nil {
				return "出错了：" + err.Error()
			}
			st.Count++
			tick()
			wait := time.Duration(between(c.IntervalMs, c.IntervalMaxMs)) * time.Millisecond
			if c.StopMode == "duration" {
				wait = min(wait, max(limit-time.Since(began), 0))
			}
			if !sleepCtx(ctx, wait) {
				break
			}
		}
		return ""
	})
}

func (e *autoEngine) startMacro(id string) error {
	_, macros, _ := e.snapshot()
	var m *Macro
	for i := range macros {
		if macros[i].ID == id {
			m = &macros[i]
		}
	}
	if m == nil {
		return errors.New("这个宏已经不在了")
	}
	if len(m.Steps) == 0 {
		return errors.New("这个宏还没有步骤")
	}
	return e.start("macro", m.ID, m.Name, m.StartDelaySec, func(ctx context.Context, st *AutoStatus, tick func()) string {
		held := map[string]bool{}
		// 不管怎么结束，还按着的键都要松开，否则系统会以为 Shift 之类的一直按着。
		defer func() {
			for k := range held {
				_ = e.inject.Key(k, false)
			}
		}()
		scale := func(ms int) time.Duration { return time.Duration(float64(ms) / m.Speed * float64(time.Millisecond)) }
		key := func(code string, down bool) error {
			if err := e.inject.Key(code, down); err != nil {
				return err
			}
			if down {
				held[code] = true
			} else {
				delete(held, code)
			}
			return nil
		}
		for loop := 0; m.Loops == 0 || loop < m.Loops; loop++ {
			for i, s := range m.Steps {
				if ctx.Err() != nil {
					return ""
				}
				st.Step = i + 1
				tick()
				var err error
				switch s.Type {
				case "key":
					for r := 0; r < max(s.Repeat, 1) && ctx.Err() == nil; r++ {
						for _, k := range s.Keys {
							if err = key(k, true); err != nil {
								break
							}
						}
						if err == nil {
							sleepCtx(ctx, max(scale(max(s.HoldMs, 20)), 5*time.Millisecond))
						}
						for j := len(s.Keys) - 1; j >= 0; j-- {
							if held[s.Keys[j]] {
								_ = key(s.Keys[j], false)
							}
						}
						if err != nil {
							break
						}
						if r+1 < max(s.Repeat, 1) {
							sleepCtx(ctx, scale(max(s.IntervalMs, 20)))
						}
					}
				case "down":
					for _, k := range s.Keys {
						if err = key(k, true); err != nil {
							break
						}
					}
				case "up":
					for _, k := range s.Keys {
						_ = key(k, false)
					}
				case "text":
					err = e.inject.Text(s.Text)
				case "delay":
					sleepCtx(ctx, scale(between(s.Ms, s.MsMax)))
				case "click":
					if s.Move {
						err = e.inject.MouseMove(s.X, s.Y)
					}
					for r := 0; err == nil && r < max(s.Repeat, 1) && ctx.Err() == nil; r++ {
						err = e.press(ctx, s.Button, "single", 0)
						if r+1 < max(s.Repeat, 1) {
							sleepCtx(ctx, scale(max(s.IntervalMs, 30)))
						}
					}
				case "scroll":
					err = e.inject.MouseScroll(s.Lines)
				}
				if err != nil {
					return fmt.Sprintf("第 %d 步出错了：%v", i+1, err)
				}
				// 步骤之间留一点空，太快了有的程序收不全。
				sleepCtx(ctx, 4*time.Millisecond)
			}
			st.Count = loop + 1
			tick()
			if (m.Loops == 0 || loop+1 < m.Loops) && !sleepCtx(ctx, scale(m.LoopDelayMs)) {
				return ""
			}
		}
		return fmt.Sprintf("执行完了 %d 遍", st.Count)
	})
}

// toggle 是快捷键的行为：正在跑就停，没在跑就开始。
func (e *autoEngine) toggle(id string, notify func(title, body string)) {
	if e.running() {
		go e.stop()
		return
	}
	var err error
	if id == "auto:clicker" {
		err = e.startClicker()
	} else if mid, ok := strings.CutPrefix(id, "macro:"); ok {
		err = e.startMacro(mid)
	}
	if err != nil && notify != nil {
		notify("没能开始", err.Error())
	}
}

// --- 页面调用的服务 ---

// Auto 是连点器和键盘宏页面的服务。
type Auto struct{ a *App }

// AutoState 是页面打开时需要的全部内容。
type AutoState struct {
	Clicker ClickerConfig     `json:"clicker"`
	Macros  []Macro           `json:"macros"`
	Status  AutoStatus        `json:"status"`
	Allowed bool              `json:"allowed"`          // 系统允许模拟输入（macOS 的辅助功能权限）
	Keys    []string          `json:"keys"`             // 这个系统上能模拟的按键
	Errors  map[string]string `json:"errors,omitempty"` // 快捷键注册失败的原因
}

// State 返回设置、宏和运行状态。
func (s *Auto) State() AutoState {
	c, macros, st := s.a.auto.snapshot()
	errs := map[string]string{}
	s.a.hotkeyMu.Lock()
	for id, msg := range s.a.hotkeyErrors {
		if id == "auto:clicker" || strings.HasPrefix(id, "macro:") {
			errs[id] = msg
		}
	}
	s.a.hotkeyMu.Unlock()
	return AutoState{Clicker: c, Macros: macros, Status: st, Allowed: platform.InputAllowed(), Keys: platform.KeyCodes(), Errors: errs}
}

// SaveClicker 保存连点器的设置。
func (s *Auto) SaveClicker(c ClickerConfig) ClickerConfig { return s.a.auto.setClicker(c) }

// StartClicker 开始连点。
func (s *Auto) StartClicker() error { return s.a.auto.startClicker() }

// SaveMacro 新建或保存一个宏。
func (s *Auto) SaveMacro(m Macro) (Macro, error) { return s.a.auto.saveMacro(m) }

// DeleteMacro 删除一个宏。
func (s *Auto) DeleteMacro(id string) { s.a.auto.deleteMacro(id) }

// RunMacro 运行一个宏。
func (s *Auto) RunMacro(id string) error { return s.a.auto.startMacro(id) }

// Stop 停掉正在运行的连点或宏。
func (s *Auto) Stop() { s.a.auto.stop() }

// MousePos 返回鼠标现在的位置。
func (s *Auto) MousePos() []int {
	x, y, ok := s.a.auto.inject.MousePos()
	if !ok {
		return nil
	}
	return []int{x, y}
}

// PickPosition 等几秒再读鼠标的位置：点了“拾取”之后把鼠标移到目标上等着就行。
func (s *Auto) PickPosition(ctx context.Context, seconds float64) ([]int, error) {
	if !sleepCtx(ctx, time.Duration(min(max(seconds, 0), 10)*float64(time.Second))) {
		return nil, ctx.Err()
	}
	x, y, ok := s.a.auto.inject.MousePos()
	if !ok {
		return nil, errors.New("读不到鼠标位置")
	}
	return []int{x, y}, nil
}

// OpenAccessibility 打开系统的辅助功能授权页。
func (s *Auto) OpenAccessibility() { platform.OpenAccessibilitySettings() }

// AutoChanged 在连点器或宏的运行状态变化时发送。
var AutoChanged = mygo.NewEvent[AutoStatus]("auto:status")
