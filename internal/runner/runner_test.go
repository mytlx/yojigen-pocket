package runner

import (
	"context"
	"strings"
	"testing"
	"time"
)

func collect(t *testing.T, lang, code, stdin string, timeout time.Duration) (stdout, stderr string, exit Event) {
	t.Helper()
	l, ok := Find(lang)
	if !ok {
		t.Fatalf("没有 %s", lang)
	}
	if l.Tool() == "" {
		t.Skipf("这台电脑上没有 %s", lang)
	}
	err := Run(context.Background(), l, code, stdin, t.TempDir(), timeout, func(e Event) {
		switch e.Kind {
		case "stdout":
			stdout += e.Text
		case "stderr":
			stderr += e.Text
		case "exit":
			exit = e
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	return
}

func TestRunGo(t *testing.T) {
	out, _, exit := collect(t, "go", "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"你好\", 1+2) }\n", "", time.Minute)
	if strings.TrimSpace(out) != "你好 3" || exit.Code != 0 || exit.Kind != "exit" {
		t.Fatalf("输出 %q，退出 %+v", out, exit)
	}
}

func TestRunShell(t *testing.T) {
	out, errOut, exit := collect(t, "shell", "read name\necho \"hi $name\"\necho oops >&2\nexit 3\n", "pocket\n", 20*time.Second)
	if strings.TrimSpace(out) != "hi pocket" || strings.TrimSpace(errOut) != "oops" || exit.Code != 3 {
		t.Fatalf("stdout %q stderr %q 退出 %+v", out, errOut, exit)
	}
}

func TestRunTimeout(t *testing.T) {
	start := time.Now()
	_, _, exit := collect(t, "shell", "echo start\nsleep 30\n", "", 600*time.Millisecond)
	if !exit.Stopped || !strings.Contains(exit.Note, "已停止") || time.Since(start) > 8*time.Second {
		t.Fatalf("超时应该被停掉：%+v（用了 %s）", exit, time.Since(start))
	}
}

func TestFormatGo(t *testing.T) {
	l, _ := Find("go")
	out, err := Format(context.Background(), l, "package main\nfunc main(){\nprintln( 1 )}\n")
	if err != nil || !strings.Contains(out, "\tprintln(1)\n") {
		t.Fatalf("格式化结果：%q %v", out, err)
	}
	if _, err := Format(context.Background(), l, "package main\nfunc {"); err == nil {
		t.Fatal("语法错误应该报出来")
	}
}

func TestLangs(t *testing.T) {
	seen := map[string]bool{}
	for _, l := range Langs() {
		if seen[l.ID] || l.Name == "" || l.Ext == "" {
			t.Errorf("语言定义有问题：%+v", l)
		}
		seen[l.ID] = true
	}
	if ByExt(".YML").ID != "yaml" || ByExt(".tsx").ID != "typescript" || ByExt(".xyz").ID != "text" {
		t.Error("按扩展名找语言不对")
	}
	if l, _ := Find("sql"); l.Tool() != "" {
		t.Error("SQL 不该是能运行的")
	}
}
