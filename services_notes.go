package main

import (
	"context"
	"errors"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/runner"
	"yojigen-pocket/internal/workspace"
)

// trash 把库里的一项移到系统的废纸篓；移不了（比如在网络盘上）时才直接删除。
func trash(s *workspace.Store, p string) error {
	abs, err := s.Abs(p)
	if err != nil {
		return err
	}
	if p == "" || abs == s.Dir {
		return errors.New("没有指定文件")
	}
	if err := mygo.Shell.TrashItem(abs); err != nil {
		return s.Remove(p)
	}
	return nil
}

// --- Markdown 笔记 ---

// Notes 是笔记页的服务。笔记是用户目录 notes 里的 .md 文件，可以用任何编辑器打开、同步。
type Notes struct{ a *App }

func (n *Notes) store() *workspace.Store {
	return &workspace.Store{Dir: filepath.Join(n.a.paths.Home, "notes"), Exts: []string{".md"}}
}

// Tree 返回笔记的目录树。
func (n *Notes) Tree() ([]workspace.Node, error) { return n.store().Tree() }

// Read 读一篇笔记。
func (n *Notes) Read(p string) (string, error) { return n.store().Read(p) }

// Write 保存一篇笔记。
func (n *Notes) Write(p, content string) error { return n.store().Write(p, content) }

// NewNote 在 dir 里新建一篇笔记，名字带当天的日期（2026-11-14 笔记.md），重名时自动加序号。
func (n *Notes) NewNote(dir string) (string, error) {
	return n.store().CreateFile(dir, time.Now().Format("2006-01-02")+" 笔记.md", "")
}

// NewFolder 在 dir 里新建文件夹。
func (n *Notes) NewFolder(dir string) (string, error) {
	return n.store().CreateFolder(dir, "新建文件夹")
}

// Rename 改名。笔记的名字不用带 .md，会自动补上。
func (n *Notes) Rename(p, name string) (string, error) {
	name = strings.TrimSpace(name)
	if strings.HasSuffix(strings.ToLower(p), ".md") && !strings.HasSuffix(strings.ToLower(name), ".md") {
		name += ".md"
	}
	return n.store().Rename(p, name)
}

// Move 把笔记或文件夹移到另一个文件夹（dir 为空是最外层）。
func (n *Notes) Move(p, dir string) (string, error) { return n.store().Move(p, dir) }

// Delete 把笔记或文件夹移到废纸篓。
func (n *Notes) Delete(p string) error { return trash(n.store(), p) }

// Reveal 在文件管理器里显示；p 为空时打开笔记目录。
func (n *Notes) Reveal(p string) error {
	s := n.store()
	if strings.TrimSpace(p) == "" {
		if _, err := s.Tree(); err != nil { // 顺便保证目录存在
			return err
		}
		return openPath(s.Dir)
	}
	abs, err := s.Abs(p)
	if err != nil {
		return err
	}
	n.a.host.Reveal(abs)
	return nil
}

// --- 代码草稿 ---

// Scratch 是代码草稿页的服务：存草稿文件、运行、格式化。
type Scratch struct {
	a  *App
	mu sync.Mutex
	// running 是每个窗口正在跑的那一次，新的一次或点“停止”会取消它。
	running map[int]context.CancelFunc
}

func (s *Scratch) store() *workspace.Store {
	return &workspace.Store{Dir: filepath.Join(s.a.paths.Home, "scratches")}
}

// ScratchLang 是页面上可选的一种语言。
type ScratchLang struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Ext       string `json:"ext"`
	Tool      string `json:"tool,omitempty"`      // 用什么程序运行；空表示这台电脑上跑不了
	Formatter string `json:"formatter,omitempty"` // 后端用什么格式化；空表示后端格式化不了
}

// Languages 返回支持的语言，以及每种在这台电脑上能不能运行。
func (s *Scratch) Languages() []ScratchLang {
	var out []ScratchLang
	for _, l := range runner.Langs() {
		out = append(out, ScratchLang{ID: l.ID, Name: l.Name, Ext: l.Ext, Tool: l.Tool(), Formatter: l.Formatter()})
	}
	return out
}

// List 返回全部草稿。
func (s *Scratch) List() ([]workspace.Node, error) { return s.store().Tree() }

// Read 读一个草稿。
func (s *Scratch) Read(p string) (string, error) { return s.store().Read(p) }

// Write 保存一个草稿。
func (s *Scratch) Write(p, content string) error { return s.store().Write(p, content) }

// New 新建一个某种语言的草稿：scratch.py、scratch 2.py……
func (s *Scratch) New(lang string) (string, error) {
	l, ok := runner.Find(lang)
	if !ok {
		return "", errors.New("不认识的语言：" + lang)
	}
	return s.store().CreateFile("", "scratch"+l.Ext, "")
}

// Rename 改名；没写扩展名时沿用原来的。
func (s *Scratch) Rename(p, name string) (string, error) {
	name = strings.TrimSpace(name)
	if path.Ext(name) == "" {
		name += path.Ext(p)
	}
	return s.store().Rename(p, name)
}

// Delete 把草稿移到废纸篓。
func (s *Scratch) Delete(p string) error { return trash(s.store(), p) }

// Reveal 打开草稿目录。
func (s *Scratch) Reveal() error {
	st := s.store()
	if _, err := st.Tree(); err != nil {
		return err
	}
	return openPath(st.Dir)
}

// RunRequest 是一次运行。
type RunRequest struct {
	Lang    string `json:"lang"`
	Code    string `json:"code"`
	Stdin   string `json:"stdin"`
	Timeout int    `json:"timeout"` // 秒；0 用默认的 60 秒
}

func callerID(ctx context.Context) int {
	if w := mygo.CallerWindow(ctx); w != nil {
		return w.ID()
	}
	return 0
}

// Run 运行代码，输出一边产生一边通过 out 送回；结束时最后一条是 exit。
func (s *Scratch) Run(ctx context.Context, req RunRequest, out *mygo.Channel[runner.Event]) error {
	l, ok := runner.Find(req.Lang)
	if !ok {
		return errors.New("不认识的语言：" + req.Lang)
	}
	timeout := time.Duration(req.Timeout) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	timeout = min(timeout, 10*time.Minute)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	id := callerID(ctx)
	s.mu.Lock()
	if s.running == nil {
		s.running = map[int]context.CancelFunc{}
	}
	if prev := s.running[id]; prev != nil {
		prev()
	}
	s.running[id] = cancel
	s.mu.Unlock()
	return runner.Run(ctx, l, req.Code, req.Stdin, filepath.Join(s.a.paths.Cache, "scratch"), timeout, func(e runner.Event) {
		_ = out.Send(e)
	})
}

// Stop 停掉这个窗口正在运行的代码。
func (s *Scratch) Stop(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cancel := s.running[callerID(ctx)]; cancel != nil {
		cancel()
	}
}

// Format 用后端的办法格式化（Go，以及装了对应工具的 Python、Rust、C/C++、Shell 等）。
func (s *Scratch) Format(ctx context.Context, lang, code string) (string, error) {
	l, ok := runner.Find(lang)
	if !ok {
		return "", errors.New("不认识的语言：" + lang)
	}
	return runner.Format(ctx, l, code)
}
