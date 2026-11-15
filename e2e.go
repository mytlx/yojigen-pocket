//go:build e2e

package main

// 只有带 -tags e2e 构建时才启用自动化接口和下面的测试钩子，用于端到端测试，不进入正式版本。
import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/egoist/mygo"
	_ "github.com/egoist/mygo/plugins/automation"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/providers"
)

// E2E 是测试钩子：模拟「带着选中的文字唤出」等只能靠真实按键触发的流程。
type E2E struct{ a *App }

func init() {
	allowSecondInstance = true
	providers.ForceFeatures["wintools"] = true // 在 macOS 上也能测 Windows 工具页的搜索
	bindExtra = func(a *App) { mygo.Bind(&E2E{a: a}) }
}

// Summon 像热键唤出一样显示主窗口，text 当作读到的选中文字。
func (e *E2E) Summon(text string) {
	if text != "" {
		e.a.pendingPayload.Store(e.a.payloads.put(core.Payload{Kind: core.PayloadText, Text: text, Source: "selection"}))
	}
	e.a.showPanel("")
}

// Hotkey 像按下某个命令的直达热键一样执行它。
func (e *E2E) Hotkey(id string) { e.a.runByHotkey(id) }

// Selection 通过辅助功能接口读取当前选中的文字（只读）。
func (e *E2E) Selection() map[string]any {
	text, ok := platform.SelectedText()
	return map[string]any{"text": text, "ok": ok, "trusted": platform.AccessibilityTrusted()}
}

// CopyImage 把一张图片放进剪贴板。
func (e *E2E) CopyImage(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return mygo.Clipboard.WriteImage(data)
}

// SetSelection 设定之后「读到的选中文字」，不去碰真实的前台应用。
func (e *E2E) SetSelection(text string) {
	e.a.selectionHook = func() string { return text }
}

// Resume 模拟截图期间收起主窗口、截完原样显示回来。
func (e *E2E) Resume() {
	e.a.hidePanel()
	e.a.resumePanel()
}

// ShowOCR 像截图命令结束后那样进入识别页。
func (e *E2E) ShowOCR(args map[string]string) { e.a.showOCR(args) }

// PanelPosition 返回主窗口的位置。
func (e *E2E) PanelPosition() []int {
	x, y := e.a.panel.Position()
	return []int{x, y}
}

// TimeSummon 走一遍真实的唤出路径并计时（毫秒）：读取选中文字用辅助功能接口，只读，不发按键。
func (e *E2E) TimeSummon() map[string]int64 {
	e.a.hidePanel()
	time.Sleep(150 * time.Millisecond)
	hook := e.a.selectionHook
	e.a.selectionHook = nil
	defer func() { e.a.selectionHook = hook }()
	t0 := time.Now()
	text := e.a.captureSelection()
	t1 := time.Now()
	e.a.showPanel("")
	t2 := time.Now()
	return map[string]int64{"start": t0.UnixMilli(), "capture": t1.Sub(t0).Milliseconds(), "show": t2.Sub(t1).Milliseconds(), "len": int64(len(text))}
}

// SlowSummon 走真实的热键唤出路径，但把“模拟复制”换成等一会儿再返回 text：
// 用来验证读选中文字慢的时候，窗口也是立刻出现、内容随后补上。
func (e *E2E) SlowSummon(text string, delayMs int) {
	e.a.hidePanel()
	hook := e.a.selectionHook
	e.a.selectionHook = nil
	e.a.selectionSlowHook = func() string {
		time.Sleep(time.Duration(delayMs) * time.Millisecond)
		return text
	}
	go func() {
		time.Sleep(time.Duration(delayMs+400) * time.Millisecond)
		e.a.selectionSlowHook, e.a.selectionHook = nil, hook
	}()
	e.a.togglePanel()
}

// HotkeysSuspended 报告全局热键是不是暂停着（设置里正在录快捷键）。
func (e *E2E) HotkeysSuspended() bool {
	e.a.hotkeyMu.Lock()
	defer e.a.hotkeyMu.Unlock()
	return e.a.hotkeysSuspended
}

// recordingInjector 只记录、不发送：端到端测试里连点器和宏用它，不会碰到真实的鼠标键盘。
type recordingInjector struct {
	mu  sync.Mutex
	log []string
}

func (r *recordingInjector) add(s string) {
	r.mu.Lock()
	r.log = append(r.log, s)
	r.mu.Unlock()
}
func (r *recordingInjector) MousePos() (int, int, bool) { return 640, 360, true }
func (r *recordingInjector) MouseMove(x, y int) error {
	r.add(fmt.Sprintf("move %d,%d", x, y))
	return nil
}
func (r *recordingInjector) MouseButton(b string, down bool, n int) error {
	r.add(fmt.Sprintf("%s %v #%d", b, down, n))
	return nil
}
func (r *recordingInjector) MouseScroll(lines int) error {
	r.add(fmt.Sprintf("scroll %d", lines))
	return nil
}
func (r *recordingInjector) Key(code string, down bool) error {
	r.add(fmt.Sprintf("key %s %v", code, down))
	return nil
}
func (r *recordingInjector) Text(s string) error { r.add("text " + s); return nil }

// FakeInput 把连点器和宏的输入换成只记录的假实现，返回是否已经换上。
func (e *E2E) FakeInput() bool {
	e.a.auto.stop()
	e.a.auto.inject = &recordingInjector{}
	_, ok := e.a.auto.inject.(*recordingInjector)
	return ok
}

// InputLog 返回假实现记下的全部输入，并清空。
func (e *E2E) InputLog() []string {
	r, ok := e.a.auto.inject.(*recordingInjector)
	if !ok {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.log
	r.log = nil
	return out
}

// BackendRunning 报告一个扩展的后端进程是不是开着。
func (e *E2E) BackendRunning(id string) bool { return e.a.pluginHost.backendRunning(id) }
