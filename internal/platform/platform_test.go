package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkDir(t *testing.T) {
	home := DefaultWorkDir()
	if home == "" {
		t.Fatal("DefaultWorkDir 不应为空")
	}

	dir := t.TempDir()
	file := filepath.Join(dir, "demo.exe")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name   string
		target string
		want   string
	}{
		{name: "空目标回退到家目录", target: "", want: home},
		{name: "网页链接回退到家目录", target: "https://example.com/a/b", want: home},
		{name: "Windows UWP shell 路径回退到家目录", target: `shell:AppsFolder\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`, want: home},
		{name: "相对文件名回退到家目录", target: "notepad.exe", want: home},
		{name: "打开文件夹本身不以其为工作目录", target: dir, want: home},
		{name: "打开文件时使用文件所在目录", target: file, want: dir},
		{name: "目标文件尚未存在但父目录存在时使用父目录", target: filepath.Join(dir, "future.txt"), want: dir},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := WorkDir(tc.target); got != tc.want {
				t.Fatalf("WorkDir(%q) = %q, want %q", tc.target, got, tc.want)
			}
		})
	}
}
