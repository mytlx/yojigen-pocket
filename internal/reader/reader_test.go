package reader

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestDecodeText(t *testing.T) {
	gbk, _ := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("第一章 开始"))
	if got := DecodeText(gbk); got != "第一章 开始" {
		t.Errorf("GBK：%q", got)
	}
	if got := DecodeText(append([]byte{0xEF, 0xBB, 0xBF}, "你好"...)); got != "你好" {
		t.Errorf("UTF-8 BOM：%q", got)
	}
	if got := DecodeText([]byte{0xFF, 0xFE, 0x60, 0x4F, 0x7D, 0x59}); got != "你好" {
		t.Errorf("UTF-16LE：%q", got)
	}
}

func TestSplitChapters(t *testing.T) {
	text := NormalizeText("书名\r\n作者：某人\r\n\r\n\r\n第一章 出发\n内容一\n第二章 路上\n内容二\n  第十二章 到达\n内容三\n尾声\n完")
	ch := SplitChapters(text)
	titles := []string{}
	for _, c := range ch {
		titles = append(titles, c.Title)
	}
	want := "开始|第一章 出发|第二章 路上|第十二章 到达|尾声"
	if strings.Join(titles, "|") != want {
		t.Errorf("章节：%v", titles)
	}
	if !strings.Contains(text[ch[2].Start:ch[2].End], "内容二") {
		t.Errorf("章节内容范围不对")
	}
	if strings.Contains(text, "\n\n\n") {
		t.Errorf("多余的空行应合并")
	}
}

func TestSplitWithoutChapters(t *testing.T) {
	var b strings.Builder
	for b.Len() < 300<<10 {
		b.WriteString("这是一段没有章节标题的长文字。\n")
	}
	ch := SplitChapters(b.String())
	if len(ch) < 2 {
		t.Fatalf("长文本应被切分：%d", len(ch))
	}
	for i := 1; i < len(ch); i++ {
		if ch[i].Start != ch[i-1].End {
			t.Errorf("分段要首尾相接")
		}
	}
	if ch[len(ch)-1].End != b.Len() {
		t.Errorf("最后一段应到结尾")
	}
}

func TestLibraryImportAndProgress(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "测试小说.txt")
	gbk, _ := simplifiedchinese.GBK.NewEncoder().Bytes([]byte("第一章 一\n甲\n第二章 二\n乙\n"))
	if err := os.WriteFile(src, gbk, 0o644); err != nil {
		t.Fatal(err)
	}
	lib := Open(filepath.Join(dir, "lib"))
	book, err := lib.Import(src)
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "测试小说" || book.Chapters != 2 {
		t.Errorf("书：%+v", book)
	}
	again, _ := lib.Import(src)
	if again.ID != book.ID || len(lib.Books()) != 1 {
		t.Errorf("重复导入不应新增")
	}
	ch, err := lib.Chapter(book.ID, 1)
	if err != nil || ch.Title != "第二章 二" || ch.Text != "乙" || ch.Total != 2 {
		t.Errorf("章节：%+v %v", ch, err)
	}
	if err := lib.SaveProgress(book.ID, 1, 0.5); err != nil {
		t.Fatal(err)
	}
	reopened := Open(filepath.Join(dir, "lib"))
	got := reopened.Books()[0]
	if got.Chapter != 1 || got.Percent != 75 {
		t.Errorf("进度应保存：%+v", got)
	}
	if err := reopened.Remove(book.ID); err != nil || len(reopened.Books()) != 0 {
		t.Errorf("删除：%v", err)
	}
}

func TestImportEPUB(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(name, body string) {
		w, _ := zw.Create(name)
		_, _ = w.Write([]byte(body))
	}
	write("mimetype", "application/epub+zip")
	write("META-INF/container.xml", `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
	write("OEBPS/content.opf", `<package><metadata><dc:title>示例书</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="text/c2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`)
	write("OEBPS/c1.xhtml", `<html><head><title>x</title><style>p{}</style></head><body><h1>第一章</h1><p>春天&amp;花开</p></body></html>`)
	write("OEBPS/text/c2.xhtml", `<html><body><h2>第二章</h2><p>夏天</p><p>雨</p></body></html>`)
	_ = zw.Close()
	dir := t.TempDir()
	src := filepath.Join(dir, "a.epub")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	lib := Open(filepath.Join(dir, "lib"))
	book, err := lib.Import(src)
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "示例书" || book.Chapters != 2 || book.Format != "epub" {
		t.Errorf("书：%+v", book)
	}
	ch, _ := lib.Chapter(book.ID, 0)
	if ch.Title != "第一章" || !strings.Contains(ch.Text, "春天&花开") || strings.Contains(ch.Text, "p{}") {
		t.Errorf("章节：%+v", ch)
	}
	ch2, _ := lib.Chapter(book.ID, 1)
	if !strings.Contains(ch2.Text, "夏天\n") {
		t.Errorf("段落应换行：%q", ch2.Text)
	}
}
