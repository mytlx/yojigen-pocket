package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/store"
)

// PayloadInfo 是带入内容在界面上显示用的信息。内容本身留在后端。
type PayloadInfo struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Label   string `json:"label"`             // 块上显示的文字
	Detail  string `json:"detail"`            // 来源和大小，例如「选中的文字 · 32 字」
	Preview string `json:"preview,omitempty"` // 图片的缩略图地址
}

// payloadStore 保存最近带入的几块内容。
type payloadStore struct {
	mu    sync.Mutex
	seq   int
	items map[string]*core.Payload
	order []string
}

const maxPayloadText = 2 << 20

func (s *payloadStore) put(p core.Payload) *core.Payload {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.items == nil {
		s.items = map[string]*core.Payload{}
	}
	s.seq++
	p.ID = "p" + strconv.Itoa(s.seq)
	if len(p.Text) > maxPayloadText {
		p.Text = strings.ToValidUTF8(p.Text[:maxPayloadText], "")
	}
	s.items[p.ID] = &p
	s.order = append(s.order, p.ID)
	for len(s.order) > 8 {
		delete(s.items, s.order[0])
		s.order = s.order[1:]
	}
	return &p
}

func (s *payloadStore) get(id string) *core.Payload {
	if id == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items[id]
}

var payloadSources = map[string]string{"selection": "选中的文字", "clipboard": "刚复制的", "paste": "粘贴的"}

func (a *App) payloadInfo(p *core.Payload) *PayloadInfo {
	if p == nil {
		return nil
	}
	info := &PayloadInfo{ID: p.ID, Kind: p.Kind}
	source := payloadSources[p.Source]
	switch p.Kind {
	case core.PayloadText:
		line := strings.Join(strings.Fields(p.Text), " ")
		r := []rune(line)
		if len(r) > 36 {
			line = string(r[:36]) + "…"
		}
		info.Label = line
		info.Detail = fmt.Sprintf("%s · %d 字", source, utf8.RuneCountInString(p.Text))
		if p.Source != "selection" {
			info.Detail = fmt.Sprintf("%s文字 · %d 字", source, utf8.RuneCountInString(p.Text))
		}
	case core.PayloadImage:
		info.Label = "图片"
		info.Detail = source + "图片"
		if st, err := os.Stat(p.Image); err == nil {
			info.Detail += " · " + providers.HumanSize(st.Size())
		}
		info.Preview = a.engine.NormalizeIcon("image:" + p.Image)
	case core.PayloadFiles:
		info.Label = filepath.Base(p.Files[0])
		if len(p.Files) > 1 {
			info.Label += fmt.Sprintf(" 等 %d 个", len(p.Files))
		}
		info.Detail = fmt.Sprintf("%s文件 · %d 个", source, len(p.Files))
		if img := p.ImagePath(); img != "" {
			info.Preview = a.engine.NormalizeIcon("image:" + img)
		} else {
			info.Preview = a.engine.NormalizeIcon("file:" + p.Files[0])
		}
	}
	return info
}

func (a *App) payloadDir() string {
	dir := filepath.Join(a.paths.Cache, "payload")
	_ = os.MkdirAll(dir, 0o700)
	return dir
}

// clipboardPayload 把系统剪贴板里的内容做成一块：文件优先，其次图片，最后文字。
func (a *App) clipboardPayload(source string) *core.Payload {
	if files, err := mygo.Clipboard.ReadFiles(); err == nil && len(files) > 0 {
		return a.payloads.put(core.Payload{Kind: core.PayloadFiles, Files: files, Source: source})
	}
	if text := mygo.Clipboard.ReadText(); strings.TrimSpace(text) != "" {
		return a.payloads.put(core.Payload{Kind: core.PayloadText, Text: text, Source: source})
	}
	if data := mygo.Clipboard.ReadImage(); len(data) > 0 {
		dir := a.payloadDir()
		cleanupOld(dir, 20)
		path := filepath.Join(dir, time.Now().Format("20060102-150405.000")+".png")
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return nil
		}
		return a.payloads.put(core.Payload{Kind: core.PayloadImage, Image: path, Source: source})
	}
	return nil
}

// entryPayload 把刚复制的一条剪贴板记录做成一块。
func (a *App) entryPayload(e *providers.ClipEntry) *core.Payload {
	switch e.Kind {
	case "image":
		if _, err := os.Stat(e.Image); err != nil {
			return nil
		}
		return a.payloads.put(core.Payload{Kind: core.PayloadImage, Image: e.Image, Source: "clipboard"})
	case "files":
		return a.payloads.put(core.Payload{Kind: core.PayloadFiles, Files: e.Files, Source: "clipboard"})
	}
	if strings.TrimSpace(e.Text) == "" {
		return nil
	}
	return a.payloads.put(core.Payload{Kind: core.PayloadText, Text: e.Text, Source: "clipboard"})
}

// --- 读取选中的文字 ---

func (a *App) selectionMode() string {
	if v := os.Getenv("POCKET_SELECTION"); v != "" {
		return v // 测试和排查问题时临时覆盖
	}
	return a.config.Get().Selection.Mode
}

// clipboardSnapshot 记下剪贴板的内容，模拟复制之后放回去。
type clipboardSnapshot struct {
	files []string
	image []byte
	text  string
	html  string
}

func snapshotClipboard() clipboardSnapshot {
	var s clipboardSnapshot
	if files, err := mygo.Clipboard.ReadFiles(); err == nil && len(files) > 0 {
		s.files = files
		return s
	}
	s.text = mygo.Clipboard.ReadText()
	s.html = mygo.Clipboard.ReadHTML()
	if s.text == "" {
		s.image = mygo.Clipboard.ReadImage()
	}
	return s
}

func (s clipboardSnapshot) restore() {
	switch {
	case len(s.files) > 0:
		_ = mygo.Clipboard.WriteFiles(s.files...)
	case s.text != "" && s.html != "":
		_ = mygo.Clipboard.Write(transfer.New(transfer.NewItem(
			transfer.Bytes(transfer.Text, []byte(s.text)),
			transfer.Bytes(transfer.HTML, []byte(s.html)),
		)))
	case s.text != "":
		mygo.Clipboard.WriteText(s.text)
	case len(s.image) > 0:
		_ = mygo.Clipboard.WriteImage(s.image)
	default:
		mygo.Clipboard.Clear()
	}
}

// captureSelection 读取前台应用里选中的文字。必须在自己的窗口抢到键盘焦点之前调用。
//
// 先用辅助功能接口直接读（只读，很快）；应用不支持时，如果设置允许，
// 模拟一次复制，读完把剪贴板恢复原样，这次复制也不会进剪贴板历史。
func (a *App) captureSelection() string {
	text, done := a.selectionFast()
	if done {
		return text
	}
	return a.selectionSlow()
}

// selectionFast 是不用等的那部分：关着就不读；能用辅助功能接口直接读到就读。
// done 为假表示还得靠模拟复制（selectionSlow）。
func (a *App) selectionFast() (text string, done bool) {
	if a.selectionHook != nil {
		return a.selectionHook(), true // 端到端测试用：不去碰真实的前台应用
	}
	if a.selectionSlowHook != nil {
		return "", false
	}
	mode := a.selectionMode()
	if mode == "off" {
		return "", true
	}
	if text, ok := platform.SelectedText(); ok {
		if strings.TrimSpace(text) == "" {
			return "", true
		}
		return text, true
	}
	return "", mode != "auto"
}

// copyWait 是模拟复制后等剪贴板变化的时间。正常的应用几十毫秒内就会响应；
// 等到头也没变，就当作什么都没选中。
const copyWait = 130 * time.Millisecond

// selectionSlow 模拟一次复制来读选中的文字，读完把剪贴板原样放回去。要在原来的窗口还有焦点时调用。
func (a *App) selectionSlow() string {
	if a.selectionSlowHook != nil {
		return a.selectionSlowHook()
	}
	before, ok := platform.ClipboardSeq()
	if !ok {
		return ""
	}
	a.clipboard.Suppress(1500 * time.Millisecond)
	saved := snapshotClipboard()
	if err := platform.SendCopy(); err != nil {
		return ""
	}
	if !platform.WaitClipboardChange(before, copyWait) {
		return "" // 什么都没选中
	}
	text := mygo.Clipboard.ReadText()
	saved.restore()
	if strings.TrimSpace(text) == "" {
		return ""
	}
	return text
}

// --- 主窗口的位置 ---

type appState struct {
	PanelX   int  `json:"panelX"`
	PanelY   int  `json:"panelY"`
	PanelSet bool `json:"panelSet"`
	// Floats 是上次退出时开着的悬浮窗工具（扩展/工具），启动时恢复。
	Floats []string `json:"floats,omitempty"`
}

func (a *App) statePath() string { return filepath.Join(a.paths.Data, "state.json") }

func (a *App) loadState() {
	if raw, err := os.ReadFile(a.statePath()); err == nil {
		_ = json.Unmarshal(raw, &a.state)
	}
}

func (a *App) saveStateSoon() {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	if a.stateTimer != nil {
		a.stateTimer.Stop()
	}
	a.stateTimer = time.AfterFunc(400*time.Millisecond, func() {
		a.stateMu.Lock()
		raw, _ := json.Marshal(a.state)
		a.stateMu.Unlock()
		_ = store.WriteFileAtomic(a.statePath(), raw)
	})
}

// placePanel 决定主窗口出现在哪里：用户拖动过就回到那个位置（保证还在屏幕里），否则在鼠标所在的屏幕居中。
func (a *App) placePanel(cfg *store.Config) {
	w, _ := a.panel.Size()
	a.stateMu.Lock()
	st := a.state
	a.stateMu.Unlock()
	var x, y int
	if cfg.PanelPosition == "remember" && st.PanelSet {
		wa := mygo.Screen.DisplayMatching(mygo.Rectangle{X: st.PanelX, Y: st.PanelY, Width: w, Height: 64}).WorkArea
		x = min(max(st.PanelX, wa.X-w+160), wa.X+wa.Width-160)
		y = min(max(st.PanelY, wa.Y), wa.Y+wa.Height-90)
	} else {
		wa := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint()).WorkArea
		x, y = wa.X+(wa.Width-w)/2, wa.Y+wa.Height/4
	}
	a.expectedX.Store(int64(x))
	a.expectedY.Store(int64(y))
	a.panel.SetPosition(x, y)
}

// panelMoved 在主窗口位置变化时调用：是用户拖的，就记下来。
func (a *App) panelMoved() {
	if a.panel == nil || !a.panel.IsVisible() {
		return
	}
	x, y := a.panel.Position()
	if int64(x) == a.expectedX.Load() && int64(y) == a.expectedY.Load() {
		return
	}
	a.expectedX.Store(int64(x))
	a.expectedY.Store(int64(y))
	a.stateMu.Lock()
	a.state.PanelX, a.state.PanelY, a.state.PanelSet = x, y, true
	a.stateMu.Unlock()
	a.saveStateSoon()
}

func (a *App) resetPanelPosition() {
	a.stateMu.Lock()
	a.state.PanelSet = false
	a.stateMu.Unlock()
	a.saveStateSoon()
	if a.panel != nil && a.panel.IsVisible() {
		a.placePanel(&store.Config{PanelPosition: "center"})
	}
}

// --- 针对带入内容的命令 ---

var imageSearchSites = []struct{ id, name, url string }{
	{"google", "Google 智能镜头", "https://lens.google.com/"},
	{"baidu", "百度识图", "https://graph.baidu.com/pcpage/index?tpl_from=pc"},
	{"bing", "必应视觉搜索", "https://www.bing.com/visualsearch"},
}

func copyFile(dst, src string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func (a *App) payloadCommands() []*providers.PayloadCommand {
	isImage := func(p *core.Payload) bool { return p.ImagePath() != "" }
	isFiles := func(p *core.Payload) bool { return p.Kind == core.PayloadFiles }
	pasteKey := "Ctrl+V"
	if isDarwin {
		pasteKey = "⌘V"
	}
	cmds := []*providers.PayloadCommand{
		{ID: "ocr-copy", Title: "识别文字并复制", Desc: "识别图片里的文字，直接放进剪贴板", Icon: "svg:scan-text", Score: 0.85, KeepOpen: true,
			Keywords: []string{"ocr", "sbfz", "识别复制"}, Accept: isImage,
			Run: func(ctx context.Context, r *core.Run, p *core.Payload) error {
				res, err := a.recognize(ctx, p.ImagePath())
				if err != nil {
					return err
				}
				if strings.TrimSpace(res.Text) == "" {
					return errors.New("没有识别到文字")
				}
				mygo.Clipboard.WriteText(res.Text)
				r.Toast(fmt.Sprintf("已复制识别结果 · %d 字", utf8.RuneCountInString(res.Text)))
				return nil
			}},
		{ID: "ocr-translate", Title: "识别文字并翻译", Desc: "识别后带着文字打开翻译", Icon: "svg:languages", Score: 0.80,
			Keywords: []string{"fy", "sbfy", "translate", "识别翻译"}, Accept: isImage,
			Run: func(ctx context.Context, r *core.Run, p *core.Payload) error {
				res, err := a.recognize(ctx, p.ImagePath())
				if err != nil {
					return err
				}
				if strings.TrimSpace(res.Text) == "" {
					return errors.New("没有识别到文字")
				}
				r.Show(&core.View{Type: "feature", Feature: "translate", Title: "翻译", Icon: "svg:languages", Input: res.Text})
				return nil
			}},
		{ID: "image-save", Title: "保存图片到文件…", Desc: "选择位置，保存成图片文件", Icon: "svg:download", Score: 0.70, KeepOpen: true,
			Keywords: []string{"save", "bc", "baocun", "保存", "另存为"}, Accept: isImage,
			Run: func(_ context.Context, r *core.Run, p *core.Payload) error {
				src := p.ImagePath()
				name := filepath.Base(src)
				if p.Kind == core.PayloadImage {
					name = "图片 " + time.Now().Format("2006-01-02 15.04.05") + ".png"
				}
				dir, _ := mygo.App.Path(mygo.PathDownloads)
				a.blurPaused.Store(true)
				defer a.blurPaused.Store(false)
				dst, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Title: "保存图片", DefaultPath: filepath.Join(dir, name)})
				a.panel.Focus()
				if err != nil || dst == "" {
					return err
				}
				if err := copyFile(dst, src); err != nil {
					return err
				}
				r.Toast("已保存到 " + dst)
				return nil
			}},
		{ID: "image-copy", Title: "复制图片", Desc: "把图片放进剪贴板", Icon: "svg:image", Score: 0.60, KeepOpen: true,
			Keywords: []string{"copy", "fz", "复制"}, Accept: isImage,
			Run: func(_ context.Context, r *core.Run, p *core.Payload) error {
				if err := a.host.CopyImageFile(p.ImagePath()); err != nil {
					return err
				}
				r.Toast("已复制图片")
				return nil
			}},
		{ID: "image-open", Title: "用默认应用打开图片", Desc: "在看图软件里查看", Icon: "svg:external", Score: 0.55,
			Keywords: []string{"open", "dk", "打开", "预览"}, Accept: func(p *core.Payload) bool { return p.Kind == core.PayloadImage },
			Run: func(_ context.Context, r *core.Run, p *core.Payload) error {
				r.Hide()
				return openPath(p.ImagePath())
			}},
		{ID: "file-open", Title: "打开", Desc: "用默认应用打开", Icon: "svg:external", Score: 0.62,
			Keywords: []string{"open", "dk"}, Accept: isFiles,
			Run: func(_ context.Context, r *core.Run, p *core.Payload) error {
				r.Hide()
				for _, f := range p.Files {
					if err := openPath(f); err != nil {
						return err
					}
				}
				return nil
			}},
		{ID: "file-reveal", Title: "在文件夹中显示", Icon: "svg:folder", Score: 0.58,
			Keywords: []string{"reveal", "finder", "xs", "显示"}, Accept: isFiles,
			Run: func(_ context.Context, r *core.Run, p *core.Payload) error {
				r.Hide()
				mygo.Shell.ShowItemInFolder(p.Files[0])
				return nil
			}},
		{ID: "file-copy-path", Title: "复制路径", Icon: "svg:text", Score: 0.56, KeepOpen: true,
			Keywords: []string{"path", "lj", "路径"}, Accept: isFiles,
			Run: func(_ context.Context, r *core.Run, p *core.Payload) error {
				mygo.Clipboard.WriteText(strings.Join(p.Files, "\n"))
				r.Toast("已复制路径")
				return nil
			}},
		{ID: "text-copy", Title: "复制这段文字", Icon: "svg:text", Score: 0.15, KeepOpen: true,
			Keywords: []string{"copy", "fz", "复制"}, Accept: func(p *core.Payload) bool { return p.Kind == core.PayloadText },
			Run: func(_ context.Context, r *core.Run, p *core.Payload) error {
				mygo.Clipboard.WriteText(p.Text)
				r.Toast("已复制")
				return nil
			}},
	}
	for i, site := range imageSearchSites {
		s := site
		cmds = append(cmds, &providers.PayloadCommand{
			ID: "image-search-" + s.id, Title: "以图搜图：" + s.name, Icon: "svg:search", Score: 0.50 - float64(i)*0.01,
			Desc:     "复制图片并打开网页，在页面里按 " + pasteKey + " 粘贴",
			Keywords: []string{"search", "st", "soutu", "搜图", "识图", s.id}, Accept: isImage,
			Run: func(_ context.Context, r *core.Run, p *core.Payload) error {
				if err := a.host.CopyImageFile(p.ImagePath()); err != nil {
					return err
				}
				r.Hide()
				a.host.Notify("图片已复制", "在打开的"+s.name+"页面里按 "+pasteKey+" 粘贴")
				return openExternal(s.url)
			}})
	}
	return cmds
}
