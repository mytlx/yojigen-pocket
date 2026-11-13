package seed

import (
	"os"
	"path/filepath"
	"testing"

	"yojigen-pocket/internal/scripts"
)

func TestInstall(t *testing.T) {
	home := t.TempDir()
	if err := Install(home); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"README.md", "ui/theme.css", "ui/user.css", "ui/user.js", "plugins/color-tool/plugin.json"} {
		if _, err := os.Stat(filepath.Join(home, p)); err != nil {
			t.Errorf("缺少 %s", p)
		}
	}
	// 用户改过的文件不能被覆盖。
	theme := filepath.Join(home, "ui/theme.css")
	if err := os.WriteFile(theme, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Install(home); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(theme); string(raw) != "mine" {
		t.Errorf("不应覆盖已有文件")
	}
}

// 随程序附带的示例脚本，元数据不能写错。
func TestSeedScriptsParse(t *testing.T) {
	for _, dir := range []string{"files/darwin/commands/示例", "files/windows/commands/示例"} {
		entries, err := files.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 4 {
			t.Errorf("%s 应有 4 个示例，实际 %d", dir, len(entries))
		}
		for _, e := range entries {
			raw, err := files.ReadFile(dir + "/" + e.Name())
			if err != nil {
				t.Fatal(err)
			}
			c := scripts.Parse(e.Name(), raw)
			if len(c.Problems) > 0 {
				t.Errorf("%s: %v", e.Name(), c.Problems)
			}
			if c.Desc == "" || c.Icon == "" || c.Mode == scripts.ModeSilent {
				t.Errorf("%s 作为示例应写明说明、图标和输出模式：%+v", e.Name(), c)
			}
		}
	}
}
