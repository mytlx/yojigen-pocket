package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/ocr"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/reader"
	"yojigen-pocket/internal/store"
	"yojigen-pocket/internal/translate"
)

// Windows 管理分离出来的独立窗口。
type Windows struct{ a *App }

// Detach 把功能页或网页插件分离成独立窗口，返回窗口 ID。
func (w *Windows) Detach(req DetachRequest) (int, error) { return w.a.detach(req) }

// List 返回全部独立窗口。
func (w *Windows) List() []WindowInfo { return w.a.windowList() }

// Focus 切换到一个独立窗口。
func (w *Windows) Focus(id int) { w.a.focusWindow(id) }

// Current 返回调用者所在窗口的信息。
func (w *Windows) Current(ctx context.Context) WindowInfo {
	win := mygo.CallerWindow(ctx)
	if win == nil {
		return WindowInfo{}
	}
	for _, info := range w.a.windowList() {
		if info.ID == win.ID() {
			return info
		}
	}
	return WindowInfo{ID: win.ID()}
}

// Control 调整调用者所在的窗口：opacity（0-1）、top（置顶 1/0）、hide、minimize、close。
func (w *Windows) Control(ctx context.Context, op string, value float64) error {
	win := mygo.CallerWindow(ctx)
	if win == nil {
		return errors.New("找不到窗口")
	}
	switch op {
	case "opacity":
		win.SetOpacity(min(max(value, 0.1), 1))
	case "top":
		win.SetAlwaysOnTop(value > 0)
	case "hide":
		win.Hide()
	case "minimize":
		win.Minimize()
	case "close":
		win.Close()
	default:
		return errors.New("不支持的操作：" + op)
	}
	return nil
}

// Resize 调整调用者所在窗口的内容大小（摸鱼小窗按行数变高变矮）。
func (w *Windows) Resize(ctx context.Context, width, height int) {
	if win := mygo.CallerWindow(ctx); win != nil && width > 0 && height > 0 {
		win.SetContentSize(width, height)
	}
}

// DragStart 开始手动拖动调用者所在的窗口（在不能用原生拖动的地方，比如输入框的空白处）。
func (w *Windows) DragStart(ctx context.Context) {
	if win := mygo.CallerWindow(ctx); win != nil {
		x, y := win.Position()
		w.a.dragMu.Lock()
		w.a.dragOrigin[win.ID()] = mygo.Point{X: x, Y: y}
		w.a.dragMu.Unlock()
	}
}

// DragMove 把窗口移到「开始拖动时的位置 + 偏移」。
func (w *Windows) DragMove(ctx context.Context, dx, dy int) {
	win := mygo.CallerWindow(ctx)
	if win == nil {
		return
	}
	w.a.dragMu.Lock()
	origin, ok := w.a.dragOrigin[win.ID()]
	w.a.dragMu.Unlock()
	if ok {
		win.SetPosition(origin.X+dx, origin.Y+dy)
	}
}

// ShowPanel 显示主窗口（从独立窗口回到搜索）。
func (w *Windows) ShowPanel() { w.a.showPanel("") }

// IsTop 报告调用者所在窗口是否置顶。
func (w *Windows) IsTop(ctx context.Context) bool {
	win := mygo.CallerWindow(ctx)
	return win != nil && win.IsAlwaysOnTop()
}

// Translator 是翻译服务。
type Translator struct{ a *App }

// TranslateEvent 是翻译过程中推给页面的事件。
type TranslateEvent struct {
	Kind   string            `json:"kind"` // delta | result
	Text   string            `json:"text,omitempty"`
	Result *translate.Result `json:"result,omitempty"`
}

// Translate 翻译文字；大模型的译文边生成边推送。
func (t *Translator) Translate(ctx context.Context, req translate.Request, out *mygo.Channel[TranslateEvent]) error {
	cfg := t.a.config.Get().Translate
	res, err := translate.Translate(ctx, cfg, t.a.secret, req, func(s string) {
		_ = out.Send(TranslateEvent{Kind: "delta", Text: s})
	})
	if err != nil {
		return err
	}
	return out.Send(TranslateEvent{Kind: "result", Result: &res})
}

// Languages 返回可选的语言。
func (t *Translator) Languages() []translate.Language { return translate.Languages }

// Speak 用系统语音朗读（网页的语音合成不可用时的后备）。
func (t *Translator) Speak(text, lang string) error { return speak(text, lang) }

// StopSpeaking 停止朗读。
func (t *Translator) StopSpeaking() { stopSpeaking() }

// KeyStatus 返回各个密钥是否已经填写（不返回密钥本身）。
func (t *Translator) KeyStatus() map[string]bool {
	out := map[string]bool{}
	for _, k := range []string{translate.KeyClaude, translate.KeyOpenAI, translate.KeyYoudaoSecret, translate.KeyBaidu} {
		out[k] = t.a.secret(k) != ""
	}
	return out
}

// SetKey 保存或清除一个密钥。密钥存在系统的凭据管理器里，不写进配置文件。
func (t *Translator) SetKey(name, value string) error {
	if !slices.Contains([]string{translate.KeyClaude, translate.KeyOpenAI, translate.KeyYoudaoSecret, translate.KeyBaidu}, name) {
		return errors.New("未知的密钥")
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return mygo.Secrets.Delete(name)
	}
	return mygo.Secrets.Set(name, []byte(value))
}

// Test 用一句话试一下某个翻译服务能否用。
func (t *Translator) Test(ctx context.Context, provider string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	res, err := translate.Translate(ctx, t.a.config.Get().Translate, t.a.secret, translate.Request{Text: "Hello, world", To: "zh", Provider: provider}, nil)
	if err != nil {
		return "", err
	}
	return res.Text, nil
}

// OCR 是文字识别服务。
type OCR struct{ a *App }

// Capture 框选屏幕并返回图片路径；取消时返回空字符串。
// 截图期间临时收起调用的窗口，截完原样显示回来，页面接着识别。
func (o *OCR) Capture(ctx context.Context) (string, error) {
	if !platform.ScreenCaptureAllowed() {
		platform.RequestScreenCapture()
		return "", errScreenPermission
	}
	win := mygo.CallerWindow(ctx)
	isPanel := win != nil && win == o.a.panel
	switch {
	case isPanel:
		o.a.hidePanel()
	case win != nil:
		win.Hide()
	}
	time.Sleep(160 * time.Millisecond) // 等窗口完全收起，免得截进图里
	path, err := o.a.captureScreen(context.WithoutCancel(ctx))
	time.Sleep(120 * time.Millisecond) // 等系统的截图界面退场
	switch {
	case isPanel:
		o.a.resumePanel()
	case win != nil && !win.IsDestroyed():
		win.Show()
		win.Focus()
	}
	return path, err
}

// Recognize 识别图片里的文字。
func (o *OCR) Recognize(ctx context.Context, path string) (ocr.Result, error) {
	return o.a.recognize(ctx, path)
}

// ClipboardImage 把剪贴板里的图片存下来，返回路径；没有图片时返回空字符串。
func (o *OCR) ClipboardImage() (string, error) {
	data := mygo.Clipboard.ReadImage()
	if len(data) == 0 {
		if files, err := mygo.Clipboard.ReadFiles(); err == nil {
			for _, f := range files {
				if isImageFile(f) {
					return f, nil
				}
			}
		}
		return "", nil
	}
	dir := filepath.Join(o.a.paths.Cache, "ocr")
	_ = os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, time.Now().Format("20060102-150405.000")+"-clip.png")
	return path, os.WriteFile(path, data, 0o600)
}

// PickImage 打开文件选择框选一张图片。
func (o *OCR) PickImage(ctx context.Context) (string, error) {
	o.a.blurPaused.Store(true)
	defer o.a.blurPaused.Store(false)
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:  mygo.CallerWindow(ctx),
		Title:   "选择图片",
		Filters: []mygo.FileFilter{{Name: "图片", Extensions: []string{"png", "jpg", "jpeg", "gif", "bmp", "webp", "tiff", "heic"}}},
	})
	if err != nil || len(files) == 0 {
		return "", err
	}
	return files[0], nil
}

// ImageURL 返回图片在页面里显示用的地址。
func (o *OCR) ImageURL(path string) string { return o.a.engine.NormalizeIcon("image:" + path) }

// Permission 报告截图需要的系统权限是否已经授予（macOS 的「屏幕录制」）。
func (o *OCR) Permission() bool { return platform.ScreenCaptureAllowed() }

// RequestPermission 请求截图权限，并打开系统设置。
func (o *OCR) RequestPermission() { platform.RequestScreenCapture() }

func isImageFile(p string) bool {
	return slices.Contains(imageExts, strings.ToLower(filepath.Ext(p)))
}

// Library 是摸鱼阅读的书库。
type Library struct{ a *App }

// Books 返回全部书。
func (l *Library) Books() []reader.Book { return l.a.library.Books() }

// ImportDialog 打开文件选择框导入书（可多选）。
func (l *Library) ImportDialog(ctx context.Context) ([]reader.Book, error) {
	l.a.blurPaused.Store(true)
	defer l.a.blurPaused.Store(false)
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent:   mygo.CallerWindow(ctx),
		Title:    "添加书籍",
		Multiple: true,
		Filters:  []mygo.FileFilter{{Name: "电子书", Extensions: []string{"txt", "epub"}}},
	})
	if err != nil {
		return nil, err
	}
	return l.ImportPaths(files)
}

// ImportPaths 导入指定的文件（拖进窗口的文件）。
func (l *Library) ImportPaths(paths []string) ([]reader.Book, error) {
	var out []reader.Book
	var errs []string
	for _, p := range paths {
		b, err := l.a.library.Import(p)
		if err != nil {
			errs = append(errs, filepath.Base(p)+"："+err.Error())
			continue
		}
		out = append(out, b)
	}
	if len(errs) > 0 {
		return out, errors.New(strings.Join(errs, "；"))
	}
	return out, nil
}

// Remove 删除一本书。
func (l *Library) Remove(id string) error { return l.a.library.Remove(id) }

// Chapters 返回目录。
func (l *Library) Chapters(id string) ([]string, error) { return l.a.library.Chapters(id) }

// Chapter 读取一章。
func (l *Library) Chapter(id string, index int) (reader.ChapterText, error) {
	return l.a.library.Chapter(id, index)
}

// SaveProgress 记录阅读进度。
func (l *Library) SaveProgress(id string, chapter int, position float64) error {
	return l.a.library.SaveProgress(id, chapter, position)
}

// Prefs 返回阅读设置。
func (l *Library) Prefs() store.ReaderConfig { return l.a.config.Get().Reader }

// SavePrefs 保存阅读设置（含老板键），立即生效。
func (l *Library) SavePrefs(p store.ReaderConfig) (string, error) {
	if err := l.a.config.Update(func(c *store.Config) { c.Reader = p }); err != nil {
		return "", err
	}
	l.a.configApplied()
	l.a.hotkeyMu.Lock()
	defer l.a.hotkeyMu.Unlock()
	for _, k := range []string{"reader-boss", "reader-prev", "reader-next"} {
		if msg := l.a.hotkeyErrors[k]; msg != "" {
			return "快捷键被占用：" + msg, nil
		}
	}
	return "", nil
}

// ToggleBoss 隐藏或显示阅读窗口（老板键）。
func (l *Library) ToggleBoss() { l.a.toggleReader() }

// DevTools 是开发工具功能页用到的后端能力。
type DevTools struct{ a *App }

// Hash 计算文字的各种哈希。
func (d *DevTools) Hash(text string) map[string]string {
	out, _ := hashAll(strings.NewReader(text))
	return out
}

// FileHash 是文件的哈希。
type FileHash struct {
	Name   string            `json:"name"`
	Size   int64             `json:"size"`
	Hashes map[string]string `json:"hashes"`
}

// HashFile 选择一个文件并计算哈希。
func (d *DevTools) HashFile(ctx context.Context) (*FileHash, error) {
	d.a.blurPaused.Store(true)
	files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "选择文件"})
	d.a.blurPaused.Store(false)
	if err != nil || len(files) == 0 {
		return nil, err
	}
	return d.HashPath(files[0])
}

// HashPath 计算指定文件的哈希（拖进窗口的文件）。
func (d *DevTools) HashPath(path string) (*FileHash, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errors.New("请选择文件而不是文件夹")
	}
	hashes, err := hashAll(f)
	if err != nil {
		return nil, err
	}
	return &FileHash{Name: filepath.Base(path), Size: info.Size(), Hashes: hashes}, nil
}

// Catalog 是「道具库」窗口的服务。
type Catalog struct{ a *App }

// Items 返回全部功能，带分类。
func (c *Catalog) Items() []CatalogItem { return c.a.catalogItems() }

// Open 在主窗口里打开一项（功能页）或直接执行（命令）。
func (c *Catalog) Open(id string) error { return c.a.openItem(id, false) }

// Detach 以独立窗口打开一项。
func (c *Catalog) Detach(id string) error { return c.a.openItem(id, true) }

// SetEnabled 启用或停用一项；内置模块（module:xxx）是整个模块的开关。
func (c *Catalog) SetEnabled(id string, enabled bool) error {
	err := c.a.config.Update(func(cfg *store.Config) {
		if name, ok := strings.CutPrefix(id, "module:"); ok {
			m := cfg.Modules[name]
			m.Enabled = enabled
			cfg.Modules[name] = m
			return
		}
		cfg.Disabled = slices.DeleteFunc(cfg.Disabled, func(x string) bool { return x == id })
		if !enabled {
			cfg.Disabled = append(cfg.Disabled, id)
		}
	})
	if err == nil {
		c.a.configApplied()
		ResultsChanged.Broadcast(struct{}{})
	}
	return err
}

// SetKeywords 改一项的关键词（内置模块就是它的前缀），可以有多个。空列表表示不要关键词。
func (c *Catalog) SetKeywords(id string, words []string) error {
	return c.a.setKeywords(id, words, false)
}

// ResetKeywords 把一项的关键词恢复成自带的。
func (c *Catalog) ResetKeywords(id string) error { return c.a.setKeywords(id, nil, true) }

// Conflicts 列出所有“同一个关键词被几项共用”的情况：命令 ID → 撞了的词。设置里的模块页用它提示。
func (c *Catalog) Conflicts() map[string][]KeywordConflict {
	out := map[string][]KeywordConflict{}
	for _, it := range c.a.catalogItems() {
		if len(it.Conflicts) > 0 {
			out[it.ID] = it.Conflicts
		}
	}
	return out
}

// SetHotkey 给一项绑定直达热键，返回注册失败的原因（成功时为空）。
func (c *Catalog) SetHotkey(id, accel string, detach bool, inputMode string) (string, error) {
	err := c.a.config.Update(func(cfg *store.Config) {
		if accel == "" {
			delete(cfg.Hotkeys, id)
		} else {
			cfg.Hotkeys[id] = accel
		}
		if detach {
			cfg.DetachOnHotkey[id] = true
		} else {
			delete(cfg.DetachOnHotkey, id)
		}
		switch inputMode {
		case "clipboard", "both", "none":
			cfg.HotkeyInput[id] = inputMode
		default:
			delete(cfg.HotkeyInput, id)
		}
	})
	if err != nil {
		return "", err
	}
	c.a.configApplied()
	c.a.hotkeyMu.Lock()
	defer c.a.hotkeyMu.Unlock()
	return c.a.hotkeyErrors[id], nil
}

// Edit 用编辑器打开脚本或插件的源文件。
func (c *Catalog) Edit(path string) error {
	return (&Settings{a: c.a}).EditFile(path)
}
