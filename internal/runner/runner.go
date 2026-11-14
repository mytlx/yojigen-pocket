// Package runner 运行代码草稿：把代码写进临时文件，用本机装着的解释器或编译器跑，输出一边产生一边送回去。
package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"go/format"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/scripts"
)

// Lang 是一种语言：怎么运行、怎么格式化。
type Lang struct {
	ID   string
	Name string
	Ext  string
	// File 是临时文件的名字；为空时用 main + Ext。
	File string
	// Run 是几种运行办法，用第一个找得到程序的。{file} 换成源文件，{out} 换成编译出的程序。
	Run [][]string
	// Build 不为空时先编译：成功后再执行 Run。
	Build [][]string
	// Format 是外部格式化程序的几种办法：代码从标准输入给，结果从标准输出读。
	Format [][]string
	// OS 不为空时只在这个系统上能运行。
	OS string
}

func exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// Langs 是支持的语言。没有 Run 的只是高亮和格式化，不能运行。
func Langs() []Lang {
	return []Lang{
		{ID: "python", Name: "Python", Ext: ".py", Run: [][]string{{"python3", "-u", "{file}"}, {"python", "-u", "{file}"}, {"py", "-3", "-u", "{file}"}},
			Format: [][]string{{"ruff", "format", "-"}, {"black", "-q", "-"}}},
		{ID: "javascript", Name: "JavaScript", Ext: ".js", File: "main.mjs", Run: [][]string{{"node", "{file}"}, {"bun", "run", "{file}"}, {"deno", "run", "-A", "{file}"}}},
		{ID: "typescript", Name: "TypeScript", Ext: ".ts", Run: [][]string{{"bun", "run", "{file}"}, {"deno", "run", "-A", "{file}"}, {"tsx", "{file}"}, {"node", "--experimental-strip-types", "{file}"}}},
		{ID: "go", Name: "Go", Ext: ".go", Run: [][]string{{"go", "run", "{file}"}}},
		{ID: "shell", Name: "Shell", Ext: ".sh", Run: [][]string{{"bash", "{file}"}, {"zsh", "{file}"}, {"sh", "{file}"}}, Format: [][]string{{"shfmt", "-"}}},
		{ID: "powershell", Name: "PowerShell", Ext: ".ps1", Run: [][]string{{"pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "{file}"}, {"powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "{file}"}}},
		{ID: "batch", Name: "批处理", Ext: ".bat", OS: "windows", Run: [][]string{{"cmd", "/c", "{file}"}}},
		{ID: "java", Name: "Java", Ext: ".java", File: "Main.java", Run: [][]string{{"java", "{file}"}}, Format: [][]string{{"clang-format", "--assume-filename=Main.java"}}},
		{ID: "c", Name: "C", Ext: ".c", Build: [][]string{{"cc", "{file}", "-o", "{out}"}, {"gcc", "{file}", "-o", "{out}"}, {"clang", "{file}", "-o", "{out}"}}, Run: [][]string{{"{out}"}},
			Format: [][]string{{"clang-format", "--assume-filename=main.c"}}},
		{ID: "cpp", Name: "C++", Ext: ".cpp", Build: [][]string{{"c++", "-std=c++17", "{file}", "-o", "{out}"}, {"g++", "-std=c++17", "{file}", "-o", "{out}"}, {"clang++", "-std=c++17", "{file}", "-o", "{out}"}}, Run: [][]string{{"{out}"}},
			Format: [][]string{{"clang-format", "--assume-filename=main.cpp"}}},
		{ID: "rust", Name: "Rust", Ext: ".rs", Build: [][]string{{"rustc", "-o", "{out}", "{file}"}}, Run: [][]string{{"{out}"}}, Format: [][]string{{"rustfmt", "--emit", "stdout"}}},
		{ID: "ruby", Name: "Ruby", Ext: ".rb", Run: [][]string{{"ruby", "{file}"}}},
		{ID: "php", Name: "PHP", Ext: ".php", Run: [][]string{{"php", "{file}"}}},
		{ID: "lua", Name: "Lua", Ext: ".lua", Run: [][]string{{"lua", "{file}"}, {"luajit", "{file}"}}, Format: [][]string{{"stylua", "-"}}},
		{ID: "perl", Name: "Perl", Ext: ".pl", Run: [][]string{{"perl", "{file}"}}},
		{ID: "swift", Name: "Swift", Ext: ".swift", Run: [][]string{{"swift", "{file}"}}},
		{ID: "kotlin", Name: "Kotlin", Ext: ".kts", Run: [][]string{{"kotlinc", "-script", "{file}"}, {"kotlin", "{file}"}}},
		{ID: "r", Name: "R", Ext: ".r", Run: [][]string{{"Rscript", "{file}"}}},
		{ID: "sql", Name: "SQL", Ext: ".sql"},
		{ID: "json", Name: "JSON", Ext: ".json"},
		{ID: "yaml", Name: "YAML", Ext: ".yaml"},
		{ID: "toml", Name: "TOML", Ext: ".toml"},
		{ID: "xml", Name: "XML", Ext: ".xml"},
		{ID: "html", Name: "HTML", Ext: ".html"},
		{ID: "css", Name: "CSS", Ext: ".css"},
		{ID: "markdown", Name: "Markdown", Ext: ".md"},
		{ID: "text", Name: "纯文本", Ext: ".txt"},
	}
}

// Find 按 ID 找语言。
func Find(id string) (Lang, bool) {
	for _, l := range Langs() {
		if l.ID == id {
			return l, true
		}
	}
	return Lang{}, false
}

// ByExt 按扩展名找语言；找不到时是纯文本。
func ByExt(ext string) Lang {
	ext = strings.ToLower(ext)
	for _, l := range Langs() {
		if l.Ext == ext || (l.File != "" && filepath.Ext(l.File) == ext) {
			return l
		}
	}
	switch ext {
	case ".mjs", ".cjs", ".jsx":
		l, _ := Find("javascript")
		return l
	case ".tsx":
		l, _ := Find("typescript")
		return l
	case ".yml":
		l, _ := Find("yaml")
		return l
	case ".bash", ".zsh":
		l, _ := Find("shell")
		return l
	case ".h", ".hpp", ".cc":
		l, _ := Find("cpp")
		return l
	case ".htm":
		l, _ := Find("html")
		return l
	}
	l, _ := Find("text")
	return l
}

// pick 在几种办法里挑第一个找得到程序的。
func pick(options [][]string) []string {
	for _, o := range options {
		if len(o) == 0 {
			continue
		}
		if strings.HasPrefix(o[0], "{") {
			return o
		}
		if p, err := exec.LookPath(o[0]); err == nil {
			return append([]string{p}, o[1:]...)
		}
	}
	return nil
}

// Tool 报告这种语言在这台电脑上用什么程序运行；不能运行时为空。
func (l Lang) Tool() string {
	if l.OS != "" && l.OS != runtime.GOOS {
		return ""
	}
	if len(l.Run) == 0 {
		return ""
	}
	if len(l.Build) > 0 {
		if cmd := pick(l.Build); cmd != nil {
			return filepath.Base(cmd[0])
		}
		return ""
	}
	if cmd := pick(l.Run); cmd != nil {
		return filepath.Base(cmd[0])
	}
	return ""
}

// Formatter 报告后端能不能格式化这种语言（Go 是内置的，其余要看装没装对应的程序）。
func (l Lang) Formatter() string {
	if l.ID == "go" {
		return "gofmt"
	}
	if cmd := pick(l.Format); cmd != nil {
		return filepath.Base(cmd[0])
	}
	return ""
}

// Event 是运行过程中的一条消息。
type Event struct {
	Kind string `json:"kind"` // start | stdout | stderr | exit
	Text string `json:"text,omitempty"`
	// exit 时：退出码、用时（毫秒）、是不是被停掉或超时。
	Code    int    `json:"code"`
	Millis  int64  `json:"millis,omitempty"`
	Stopped bool   `json:"stopped,omitempty"`
	Note    string `json:"note,omitempty"`
}

// MaxOutput 是一次运行最多送回的输出，再多就截断并结束。
const MaxOutput = 1 << 20

type limited struct {
	mu    sync.Mutex
	left  int
	kind  string
	emit  func(Event)
	over  *bool
	stop  context.CancelFunc
	carry []byte
}

func (w *limited) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	if w.left <= 0 {
		return n, nil
	}
	if len(p) > w.left {
		p = p[:w.left]
		*w.over = true
		defer w.stop()
	}
	w.left -= len(p)
	// 多字节字符可能被切在两次写入之间：留着不完整的尾巴，等下一段。
	data := append(w.carry, p...)
	cut := len(data)
	for cut > 0 && cut > len(data)-4 && data[cut-1]&0xC0 == 0x80 {
		cut--
	}
	if cut > 0 && data[cut-1]&0xC0 == 0xC0 {
		cut--
	}
	if cut == 0 || cut < len(data)-4 {
		cut = len(data)
	}
	w.carry = append([]byte(nil), data[cut:]...)
	if cut > 0 {
		w.emit(Event{Kind: w.kind, Text: scripts.Decode(data[:cut])})
	}
	return n, nil
}

func (w *limited) flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.carry) > 0 {
		w.emit(Event{Kind: w.kind, Text: scripts.Decode(w.carry)})
		w.carry = nil
	}
}

func substitute(cmd []string, file, out string) []string {
	res := make([]string, len(cmd))
	for i, a := range cmd {
		res[i] = strings.NewReplacer("{file}", file, "{out}", out).Replace(a)
	}
	return res
}

// Run 运行一段代码。workDir 是放临时文件的地方；emit 可能在别的协程里被调用，但不会并发。
func Run(ctx context.Context, lang Lang, code, stdin, workDir string, timeout time.Duration, emit func(Event)) error {
	if lang.OS != "" && lang.OS != runtime.GOOS {
		return fmt.Errorf("%s 只能在 %s 上运行", lang.Name, lang.OS)
	}
	if len(lang.Run) == 0 {
		return fmt.Errorf("%s 不是能运行的语言", lang.Name)
	}
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(workDir, "run-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	name := lang.File
	if name == "" {
		name = "main" + lang.Ext
	}
	file := filepath.Join(dir, name)
	if err := os.WriteFile(file, []byte(code), 0o600); err != nil {
		return err
	}
	out := filepath.Join(dir, exe("main"))

	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var guard sync.Mutex
	send := func(e Event) {
		guard.Lock()
		defer guard.Unlock()
		emit(e)
	}
	started := time.Now()
	over := false
	finish := func(code int, note string) {
		stopped := ctx.Err() != nil
		if over {
			note = "输出太多，已截断并停止"
		} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			note = fmt.Sprintf("超过 %d 秒，已停止", int(timeout.Seconds()))
		} else if stopped {
			note = "已停止"
		}
		send(Event{Kind: "exit", Code: code, Millis: time.Since(started).Milliseconds(), Stopped: stopped, Note: note})
	}
	step := func(args []string, input string) (int, error) {
		cmd := platform.Command(ctx, args[0], args[1:]...)
		cmd.Dir = dir
		if input != "" {
			cmd.Stdin = strings.NewReader(input)
		}
		so := &limited{left: MaxOutput, kind: "stdout", emit: send, over: &over, stop: cancel}
		se := &limited{left: MaxOutput, kind: "stderr", emit: send, over: &over, stop: cancel}
		cmd.Stdout, cmd.Stderr = so, se
		err := cmd.Run()
		so.flush()
		se.flush()
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode(), nil
		}
		if err != nil {
			return -1, err
		}
		return 0, nil
	}

	if len(lang.Build) > 0 {
		build := pick(lang.Build)
		if build == nil {
			return fmt.Errorf("没有找到 %s 的编译器（试过 %s）", lang.Name, names(lang.Build))
		}
		send(Event{Kind: "start", Text: filepath.Base(build[0])})
		exitCode, err := step(substitute(build, file, out), "")
		if err != nil {
			return err
		}
		if exitCode != 0 || ctx.Err() != nil {
			finish(exitCode, "编译没有通过")
			return nil
		}
	}
	run := pick(lang.Run)
	if run == nil {
		return fmt.Errorf("这台电脑上没有找到运行 %s 的程序（试过 %s）", lang.Name, names(lang.Run))
	}
	if len(lang.Build) == 0 {
		send(Event{Kind: "start", Text: filepath.Base(run[0])})
	}
	exitCode, err := step(substitute(run, file, out), stdin)
	if err != nil && ctx.Err() == nil {
		return err
	}
	finish(exitCode, "")
	return nil
}

func names(options [][]string) string {
	var out []string
	for _, o := range options {
		out = append(out, o[0])
	}
	return strings.Join(out, "、")
}

// Format 用后端的办法格式化代码：Go 用标准库，其余用装着的格式化程序。
func Format(ctx context.Context, lang Lang, code string) (string, error) {
	if lang.ID == "go" {
		out, err := format.Source([]byte(code))
		if err != nil {
			return "", fmt.Errorf("代码有语法错误：%v", err)
		}
		return string(out), nil
	}
	cmd := pick(lang.Format)
	if cmd == nil {
		if len(lang.Format) == 0 {
			return "", fmt.Errorf("还不支持格式化 %s", lang.Name)
		}
		return "", fmt.Errorf("格式化 %s 需要先安装 %s", lang.Name, names(lang.Format))
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	c := platform.Command(ctx, cmd[0], cmd[1:]...)
	c.Stdin = strings.NewReader(code)
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, io.Writer(&stderr)
	if err := c.Run(); err != nil {
		msg := strings.TrimSpace(scripts.Decode(stderr.Bytes()))
		if msg == "" {
			msg = err.Error()
		}
		if len(msg) > 400 {
			msg = msg[:400]
		}
		return "", errors.New(msg)
	}
	if stdout.Len() == 0 {
		return code, nil
	}
	return scripts.Decode(stdout.Bytes()), nil
}
