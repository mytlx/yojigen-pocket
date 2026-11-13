package providers

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestDetail(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, data []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	attr := func(d *FileDetail, label string) string {
		for _, a := range d.Attrs {
			if a.Label == label {
				return a.Value
			}
		}
		return ""
	}

	d := Detail(write("a.go", []byte("package main\n\nfunc main() {}\n")))
	if d.Kind != "code" || d.Lang != "go" || !strings.Contains(d.Text, "func main") || attr(d, "行数") != "4" || attr(d, "编码") != "UTF-8" {
		t.Errorf("Go 源码：%+v", d)
	}
	gbk, _ := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("中文的记事本文件\r\n第二行"))
	d = Detail(write("gbk.txt", gbk))
	if d.Kind != "text" || d.Text != "中文的记事本文件\n第二行" || attr(d, "编码") != "GB18030" {
		t.Errorf("GBK 文本：kind=%s text=%q 编码=%s", d.Kind, d.Text, attr(d, "编码"))
	}
	d = Detail(write("u16.txt", append([]byte{0xFF, 0xFE}, []byte{'h', 0, 'i', 0, 0x2D, 0x4E}...)))
	if d.Kind != "text" || d.Text != "hi中" {
		t.Errorf("UTF-16 文本：kind=%s text=%q", d.Kind, d.Text)
	}
	d = Detail(write("notes.md", []byte("# 标题\n正文")))
	if d.Kind != "markdown" {
		t.Errorf("Markdown：kind=%s", d.Kind)
	}
	d = Detail(write("data.bin", []byte{0, 1, 2, 3, 0, 0, 9, 9}))
	if d.Kind != "none" || d.TypeName != "BIN 文件" || attr(d, "大小") == "" || attr(d, "修改时间") == "" {
		t.Errorf("二进制文件应该没有预览但有完整的属性：%+v", d)
	}
	// 1×1 的 PNG
	png := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 'I', 'H', 'D', 'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89}
	d = Detail(write("dot.png", png))
	if d.Kind != "image" || attr(d, "尺寸") != "1 × 1 像素" {
		t.Errorf("图片：kind=%s 尺寸=%q", d.Kind, attr(d, "尺寸"))
	}
	for name, kind := range map[string]string{"movie.mp4": "video", "song.mp3": "audio", "doc.pdf": "pdf"} {
		if d := Detail(write(name, []byte{0, 0, 0, 1})); d.Kind != kind {
			t.Errorf("%s 应该是 %s，得到 %s", name, kind, d.Kind)
		}
	}
	// 压缩包列出里面的文件
	zp := filepath.Join(dir, "pack.zip")
	f, _ := os.Create(zp)
	zw := zip.NewWriter(f)
	for _, n := range []string{"a.txt", "sub/b.txt"} {
		w, _ := zw.Create(n)
		_, _ = w.Write([]byte("hello"))
	}
	_ = zw.Close()
	_ = f.Close()
	d = Detail(zp)
	if d.Kind != "archive" || d.Total != 2 || !strings.HasPrefix(d.Entries[0], "a.txt") {
		t.Errorf("压缩包：%+v", d)
	}
	d = Detail(dir)
	if d.Kind != "folder" || d.Total < 8 || !strings.Contains(attr(d, "包含"), "项") {
		t.Errorf("文件夹：kind=%s total=%d", d.Kind, d.Total)
	}
	if d := Detail(filepath.Join(dir, "没有这个文件")); d.Error == "" {
		t.Error("不存在的文件应该给出错误")
	}
	if !MediaAllowed("/x/a.MP4") || MediaAllowed("/x/a.go") || MediaAllowed("/etc/passwd") {
		t.Error("媒体服务只应该放行能预览的类型")
	}
}
