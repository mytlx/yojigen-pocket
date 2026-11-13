package scripts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/platform"
)

const maxOutput = 5 << 20 // stdout 上限 5 MB，防止误输出撑爆界面

// Runner 负责启动脚本进程。
type Runner struct {
	DataDir      string
	CacheDir     string
	Interpreters func() map[string]string // 配置里的扩展名映射
}

// Input 是一次执行的输入。
type Input struct {
	Args    []string
	Query   string
	Context core.Context
}

// Output 是一次执行的结果。
type Output struct {
	Stdout   string
	Stderr   string
	ExitCode int
	Duration time.Duration
}

// ErrInterpreterMissing 表示找不到运行脚本需要的解释器。
var ErrInterpreterMissing = errors.New("找不到解释器")

var shebangRe = regexp.MustCompile(`^#!\s*(\S.*)$`)

// resolve 决定如何启动脚本：@pocket.interpreter → 配置映射 → shebang → 扩展名默认。
func (r *Runner) resolve(c *Command) ([]string, error) {
	ext := strings.ToLower(filepath.Ext(c.Path))
	if c.Interpreter != "" {
		return strings.Fields(c.Interpreter), nil
	}
	if r.Interpreters != nil {
		if s := r.Interpreters()[ext]; s != "" {
			return strings.Fields(s), nil
		}
	}
	if ext == ".exe" {
		return nil, nil
	}
	if ext == ".lnk" {
		return platform.Interpreter(ext), nil
	}
	if f, err := os.Open(c.Path); err == nil {
		defer f.Close()
		buf := make([]byte, 256)
		n, _ := f.Read(buf)
		line, _, _ := strings.Cut(string(buf[:n]), "\n")
		if m := shebangRe.FindStringSubmatch(strings.TrimRight(line, "\r")); m != nil && ext != ".ps1" {
			if fields := strings.Fields(m[1]); len(fields) > 0 && usableShebang(fields[0]) {
				return fields, nil
			}
		}
	}
	if it := platform.Interpreter(ext); it != nil {
		return it, nil
	}
	if ext == "" {
		return nil, nil // 可执行文件直接运行
	}
	return nil, fmt.Errorf("%w（%s）", ErrInterpreterMissing, ext)
}

// usableShebang 排除在当前系统上不存在的 shebang（Windows 上 /usr/bin/env 不存在）。
func usableShebang(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// Env 构造脚本的环境变量。
func (r *Runner) Env(c *Command, in Input) []string {
	dataDir := filepath.Join(r.DataDir, "commands", c.Name)
	_ = os.MkdirAll(dataDir, 0o755)
	return append(os.Environ(),
		"POCKET_QUERY="+in.Query,
		"POCKET_CLIPBOARD="+in.Context.Clipboard,
		"POCKET_SELECTION="+in.Context.Selection,
		"POCKET_FG_PROCESS="+in.Context.FgProcess,
		"POCKET_FG_TITLE="+in.Context.FgTitle,
		"POCKET_COMMAND="+c.Name,
		"POCKET_DATA_DIR="+dataDir,
		"POCKET_CACHE_DIR="+r.CacheDir,
		"PYTHONUTF8=1",
		"PYTHONIOENCODING=utf-8",
	)
}

// limitWriter 累积输出并限制总量，同时把每段内容转发给回调。
type limitWriter struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	truncated bool
	onChunk   func(string)
}

func (w *limitWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	room := maxOutput - w.buf.Len()
	if room <= 0 {
		w.truncated = true
		return n, nil
	}
	if len(p) > room {
		p = p[:room]
		w.truncated = true
	}
	w.buf.Write(p)
	if w.onChunk != nil {
		w.onChunk(Decode(p))
	}
	return n, nil
}

// Run 执行脚本。超时或取消时连同子进程一起结束。
func (r *Runner) Run(ctx context.Context, c *Command, in Input, onStdout func(string)) (Output, error) {
	interp, err := r.resolve(c)
	if err != nil {
		return Output{}, err
	}
	if c.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.Timeout)
		defer cancel()
	}
	argv := append(append([]string{}, interp...), c.Path)
	argv = append(argv, in.Args...)
	cmd := platform.Command(ctx, argv[0], argv[1:]...)
	cmd.Env = r.Env(c, in)
	cmd.Dir = filepath.Dir(c.Path)
	if c.Cwd != "" {
		cmd.Dir = platform.ExpandHome(c.Cwd)
	}
	stdin, _ := json.Marshal(map[string]any{"query": in.Query, "args": in.Args, "context": in.Context})
	cmd.Stdin = bytes.NewReader(stdin)
	stdout := &limitWriter{onChunk: onStdout}
	stderr := &limitWriter{}
	cmd.Stdout, cmd.Stderr = stdout, stderr

	start := time.Now()
	runErr := cmd.Run()
	out := Output{Stdout: Decode(stdout.buf.Bytes()), Stderr: Decode(stderr.buf.Bytes()), Duration: time.Since(start)}
	if stdout.truncated {
		out.Stdout += "\n…（输出超过 5 MB，已截断）"
	}
	if cmd.ProcessState != nil {
		out.ExitCode = cmd.ProcessState.ExitCode()
	}
	switch {
	case ctx.Err() == context.DeadlineExceeded:
		return out, fmt.Errorf("执行超时（%s）", c.Timeout)
	case ctx.Err() != nil:
		return out, ctx.Err()
	case runErr != nil:
		return out, errors.New(failureText(out, runErr))
	}
	return out, nil
}

func failureText(out Output, err error) string {
	for _, line := range strings.Split(out.Stderr, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return err.Error()
}
