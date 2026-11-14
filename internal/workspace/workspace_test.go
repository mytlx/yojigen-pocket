package workspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStore(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(filepath.Dir(dir), "outside.md")
	s := &Store{Dir: filepath.Join(dir, "notes"), Exts: []string{".md"}}

	p, err := s.CreateFile("", "2026-11-14 笔记.md", "# 你好")
	if err != nil || p != "2026-11-14 笔记.md" {
		t.Fatalf("新建：%q %v", p, err)
	}
	p2, _ := s.CreateFile("", "2026-11-14 笔记.md", "")
	p3, _ := s.CreateFile("", "2026-11-14 笔记.md", "")
	if p2 != "2026-11-14 笔记 2.md" || p3 != "2026-11-14 笔记 3.md" {
		t.Fatalf("重名应该自动加序号：%q %q", p2, p3)
	}
	folder, err := s.CreateFolder("", "工作")
	if err != nil || folder != "工作" {
		t.Fatalf("新建文件夹：%q %v", folder, err)
	}
	moved, err := s.Move(p2, folder)
	if err != nil || moved != "工作/2026-11-14 笔记 2.md" {
		t.Fatalf("移动：%q %v", moved, err)
	}
	renamed, err := s.Rename(moved, "周报.md")
	if err != nil || renamed != "工作/周报.md" {
		t.Fatalf("改名：%q %v", renamed, err)
	}
	if err := s.Write(renamed, "正文"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Read(renamed); got != "正文" {
		t.Fatalf("读回来不对：%q", got)
	}
	if _, err := s.Rename(renamed, "../逃出去.md"); err == nil {
		t.Fatal("名字里带路径应该被拒绝")
	}
	if _, err := s.Rename(p, "2026-11-14 笔记 3.md"); err == nil {
		t.Fatal("改成已有的名字应该报错，不能覆盖")
	}
	if _, err := s.Rename(p, "换类型.exe"); err == nil {
		t.Fatal("不允许的扩展名应该被拒绝")
	}
	if _, err := s.Move(folder, folder); err == nil {
		t.Fatal("文件夹不能移到自己里面")
	}

	// 路径再怎么写也出不了这个目录。
	for _, bad := range []string{"../outside.md", "工作/../../outside.md", "/etc/passwd", `..\outside.md`} {
		_ = s.Write(bad, "x")
		if _, err := os.Stat(outside); err == nil {
			t.Fatalf("写到了目录外面：%q", bad)
		}
	}
	if _, err := s.Read("/etc/hosts"); err == nil {
		t.Fatal("读到了目录外面的文件")
	}

	_ = os.WriteFile(filepath.Join(s.Dir, "别的.txt"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(s.Dir, ".隐藏.md"), []byte("x"), 0o644)
	tree, err := s.Tree()
	if err != nil {
		t.Fatal(err)
	}
	if len(tree) != 3 || !tree[0].IsDir || tree[0].Name != "工作" || len(tree[0].Children) != 1 || tree[0].Children[0].Path != "工作/周报.md" {
		t.Fatalf("目录树不对（文件夹在前、只列 .md、不列隐藏文件）：%+v", tree)
	}
	abs, err := s.Abs(renamed)
	if err != nil || abs != filepath.Join(s.Dir, "工作", "周报.md") {
		t.Fatalf("绝对路径：%q %v", abs, err)
	}
	if err := s.Remove(folder); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(renamed); err == nil {
		t.Fatal("删掉的文件不该还读得到")
	}
}
