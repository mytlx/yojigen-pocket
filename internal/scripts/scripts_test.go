package scripts

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"yojigen-pocket/internal/core"
)

func TestParseDefaults(t *testing.T) {
	c := Parse("/x/打开项目.py", []byte("print(1)\n"))
	if c.Title != "打开项目" || c.Mode != ModeSilent || c.Timeout != 10*time.Second {
		t.Errorf("默认值不对：%+v", c)
	}
}

func TestParseMetadata(t *testing.T) {
	src := `#!/bin/bash
# @pocket.title 翻译
# @pocket.desc 把选中文字翻译成中文
# @pocket.keywords tr, fy，翻译
# @pocket.icon 🌐
# @pocket.mode list
# @pocket.arg1 {"name":"text","default":"{clipboard}","optional":true}
# @pocket.hotkey Ctrl+Alt+T
# @pocket.when code.exe, idea64.exe
# @pocket.timeout 30
# @pocket.refresh 300
# @pocket.fallback true
// @pocket.confirm 确定？
-- @pocket.cwd ~/code
`
	c := Parse("/x/tr.sh", []byte(src))
	if c.Title != "翻译" || c.Desc != "把选中文字翻译成中文" || c.Icon != "🌐" || c.Mode != ModeList {
		t.Errorf("基础字段不对：%+v", c)
	}
	if strings.Join(c.Keywords, "|") != "tr|fy|翻译" {
		t.Errorf("关键词：%v", c.Keywords)
	}
	if len(c.Args) != 1 || c.Args[0].Name != "text" || c.Args[0].Default != "{clipboard}" || !c.Args[0].Optional {
		t.Errorf("参数：%+v", c.Args)
	}
	if c.Hotkey != "Ctrl+Alt+T" || strings.Join(c.When, ",") != "code.exe,idea64.exe" {
		t.Errorf("热键或 when：%+v", c)
	}
	if c.Timeout != 30*time.Second || c.Refresh != 300*time.Second || !c.Fallback {
		t.Errorf("时间或兜底：%+v", c)
	}
	if c.Confirm != "确定？" || c.Cwd != "~/code" {
		t.Errorf("任意注释符都应支持：%+v", c)
	}
	if len(c.Problems) != 0 {
		t.Errorf("不应有问题：%v", c.Problems)
	}
}

func TestParseProblemsKeepCommand(t *testing.T) {
	c := Parse("/x/a.sh", []byte("# @pocket.mode nope\n# @pocket.arg1 {bad\n# @pocket.foo 1\n"))
	if c.Mode != ModeSilent {
		t.Errorf("错误的 mode 应回退默认：%s", c.Mode)
	}
	if len(c.Problems) != 3 || !strings.HasPrefix(c.Problems[1], "第 2 行") {
		t.Errorf("应指出出错的行：%v", c.Problems)
	}
}

func TestParseListJSON(t *testing.T) {
	items := ParseList(`{"items":[{"title":"A","subtitle":"s","actions":[{"type":"open","target":"/tmp"}]},{"title":"https://x.y"},{"subtitle":"无标题被丢弃"}]}`)
	if len(items) != 2 {
		t.Fatalf("条数：%d", len(items))
	}
	if items[0].Actions[0].Type != core.ActionOpen || items[0].Actions[0].Title != "打开" {
		t.Errorf("动作：%+v", items[0].Actions[0])
	}
	if items[1].Actions[0].Type != core.ActionOpen {
		t.Errorf("网址应默认打开：%+v", items[1].Actions[0])
	}
	if arr := ParseList(`[{"title":"B"}]`); len(arr) != 1 || arr[0].Actions[0].Type != core.ActionCopy {
		t.Errorf("数组形式：%+v", arr)
	}
}

func TestParseListText(t *testing.T) {
	items := ParseList("标题一\t副标题\topen:/tmp/x\n标题二\t\tcopy:hello\n/usr/local/bin\n普通文字\n\n")
	if len(items) != 4 {
		t.Fatalf("条数：%d", len(items))
	}
	if a := items[0].Actions[0]; a.Type != core.ActionOpen || a.Target != "/tmp/x" || items[0].Subtitle != "副标题" {
		t.Errorf("第一项：%+v", items[0])
	}
	if a := items[1].Actions[0]; a.Type != core.ActionCopy || a.Text != "hello" {
		t.Errorf("第二项：%+v", a)
	}
	if a := items[2].Actions[0]; a.Type != core.ActionOpen {
		t.Errorf("路径应默认打开：%+v", a)
	}
	if a := items[3].Actions[0]; a.Type != core.ActionCopy || a.Text != "普通文字" {
		t.Errorf("文字应默认复制：%+v", a)
	}
}

func TestDecodeGBK(t *testing.T) {
	if got := Decode([]byte{0xC4, 0xE3, 0xBA, 0xC3}); got != "你好" {
		t.Errorf("GBK 解码：%q", got)
	}
	if got := Decode([]byte("你好")); got != "你好" {
		t.Errorf("UTF-8：%q", got)
	}
}

func writeScript(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRunScript(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("示例脚本用 sh 写")
	}
	r := &Runner{DataDir: t.TempDir(), CacheDir: t.TempDir()}
	p := writeScript(t, "a.sh", "#!/bin/sh\necho \"arg=$1 q=$POCKET_QUERY clip=$POCKET_CLIPBOARD\"\ncat\n")
	c := Parse(p, nil)
	var chunks strings.Builder
	out, err := r.Run(context.Background(), c, Input{Args: []string{"hi"}, Query: "qq", Context: core.Context{Clipboard: "cc"}}, func(s string) { chunks.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.Stdout, "arg=hi q=qq clip=cc") {
		t.Errorf("参数或环境变量：%q", out.Stdout)
	}
	if !strings.Contains(out.Stdout, `"clipboard":"cc"`) {
		t.Errorf("stdin 应是 Context JSON：%q", out.Stdout)
	}
	if chunks.String() != out.Stdout {
		t.Errorf("流式输出应与最终一致")
	}
}

func TestRunFailureUsesStderr(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	r := &Runner{DataDir: t.TempDir(), CacheDir: t.TempDir()}
	c := Parse(writeScript(t, "b.sh", "#!/bin/sh\necho 出错了 >&2\nexit 3\n"), nil)
	out, err := r.Run(context.Background(), c, Input{}, nil)
	if err == nil || err.Error() != "出错了" || out.ExitCode != 3 {
		t.Errorf("err=%v code=%d", err, out.ExitCode)
	}
}

// 超时要连同子进程一起结束，不留孤儿，也不能被子进程握住管道卡死。
func TestRunTimeoutKillsTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	r := &Runner{DataDir: t.TempDir(), CacheDir: t.TempDir()}
	c := Parse(writeScript(t, "c.sh", "#!/bin/sh\nsleep 30 &\nsleep 30\n"), nil)
	c.Timeout = 200 * time.Millisecond
	start := time.Now()
	_, err := r.Run(context.Background(), c, Input{}, nil)
	if err == nil || !strings.Contains(err.Error(), "超时") {
		t.Errorf("应报超时：%v", err)
	}
	if d := time.Since(start); d > 1500*time.Millisecond {
		t.Errorf("应很快结束，实际 %s", d)
	}
}

func TestRunMissingInterpreter(t *testing.T) {
	r := &Runner{DataDir: t.TempDir(), CacheDir: t.TempDir()}
	c := Parse(writeScript(t, "d.unknownext", "x"), nil)
	if _, err := r.Run(context.Background(), c, Input{}, nil); err == nil {
		t.Errorf("应报错")
	}
}
