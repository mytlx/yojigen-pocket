package providers

import (
	"context"
	"io"
	"os/exec"
	"strings"
	"sync"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/scripts"
)

// Shell 是命令行模式：输入 > 加命令，输出显示在文本视图里。
type Shell struct{}

// Info 实现 core.Provider。
func (Shell) Info() core.Info {
	return core.Info{ID: "shell", Title: "命令行", Icon: "svg:terminal"}
}

// globalShellScore 是命令行在全局搜索里的分数：排在真正对得上名字的应用、功能和命令后面。
const globalShellScore = 0.4

// Search 实现 core.Provider。
//
// 用前缀（> ls）进来时，输入什么就是什么命令。打开了“全局搜索”时不能这样：否则不管输入什么，
// 都会多出一条满分的“把它当命令执行”，压在应用前面。这时只有第一个词确实是一个能运行的程序才给出这一条，
// 而且排在后面。
func (Shell) Search(_ context.Context, req *core.Request) []core.Item {
	line := strings.TrimSpace(req.Text)
	if !req.Scoped {
		if line == "" || !isRunnable(req.First) {
			return nil
		}
	}
	if line == "" {
		return []core.Item{{
			ID: "shell:hint", Title: "输入要执行的命令", Subtitle: "输出会显示在这里；回车执行", Icon: "svg:terminal",
			Source: "shell", Ephem: true, Score: 1,
			Actions: []core.Action{{Type: core.ActionFunc, Title: "继续输入", KeepOpen: true, Fn: func(context.Context, *core.Run) error { return nil }}},
		}}
	}
	score := 1.0
	if !req.Scoped {
		score = globalShellScore
	}
	return []core.Item{{
		ID: "shell:run", Title: line, Subtitle: "执行并查看输出", Icon: "svg:terminal",
		Source: "shell", Ephem: true, Score: score,
		Actions: []core.Action{
			{Type: core.ActionFunc, Title: "执行并查看输出", Fn: func(ctx context.Context, r *core.Run) error {
				return runShellInView(ctx, r, line)
			}},
			{Type: core.ActionShell, Title: "后台执行", Command: line},
			{Type: core.ActionCopy, Title: "复制命令", Text: line, KeepOpen: true},
		},
	}}
}

// isRunnable 报告一个词是不是 PATH 里能运行的程序。
func isRunnable(word string) bool {
	if word == "" || strings.ContainsAny(word, `/\`) {
		return false
	}
	_, err := exec.LookPath(word)
	return err == nil
}

// chunkWriter 把进程输出转发给界面。
type chunkWriter struct {
	mu sync.Mutex
	r  *core.Run
}

func (w *chunkWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.r.Append(scripts.DecodeText(p))
	return len(p), nil
}

var _ io.Writer = (*chunkWriter)(nil)

func runShellInView(ctx context.Context, r *core.Run, line string) error {
	r.Show(&core.View{Type: "text", Title: line, Icon: "svg:terminal", Stream: true})
	cmd := platform.ShellCommand(ctx, line)
	w := &chunkWriter{r: r}
	cmd.Stdout, cmd.Stderr = w, w
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil
	}
	if err != nil {
		r.Append("\n[" + err.Error() + "]\n")
	}
	r.Emit(core.ExecEvent{Kind: "done"})
	return nil
}
