package ocr

import (
	"context"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
)

func TestCleanLines(t *testing.T) {
	got := CleanLines([]string{"你 好 ， 世 界", "", "  Hello World  ", "中 文 English 混 排"})
	want := []string{"你好，世界", "Hello World", "中文 English 混排"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("得到 %q", got)
	}
}

// 画一张小字的图片（字高只有十来个像素，还贴着边），用系统识别读回来。
// 不经过放大和留白时这种图基本认不出来。只在 macOS 上跑（Windows 依赖语言包）。
func TestRecognizeSmallTextDarwin(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("只在 macOS 上测试系统识别")
	}
	img := image.NewRGBA(image.Rect(0, 0, 150, 30))
	draw.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{30, 32, 38, 255}), image.Point{}, draw.Src)
	d := &font.Drawer{Dst: img, Src: image.NewUniform(color.RGBA{235, 235, 235, 255}), Face: basicfont.Face7x13, Dot: fixed.P(2, 13)}
	d.DrawString("HELLO POCKET 2026")
	d.Dot = fixed.P(2, 27)
	d.DrawString("SECOND LINE 42")
	path := filepath.Join(t.TempDir(), "text.png")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	f.Close()
	res, err := Recognize(context.Background(), path, Options{Engine: "system", TempDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	upper := strings.ToUpper(res.Text)
	if !strings.Contains(upper, "HELLO POCKET") || !strings.Contains(upper, "SECOND LINE") {
		t.Errorf("识别结果：%q", res.Text)
	}
	if len(res.Lines) != 2 {
		t.Errorf("应是两行：%q", res.Lines)
	}
}

func TestPrepareScalesAndPads(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 200, 50))
	draw.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{10, 20, 30, 255}), image.Point{}, draw.Src)
	dir := t.TempDir()
	path := filepath.Join(dir, "a.png")
	f, _ := os.Create(path)
	_ = png.Encode(f, img)
	f.Close()
	out, cleanup := Prepare(path, dir)
	if out == path {
		t.Fatal("应生成处理后的图片")
	}
	pf, _ := os.Open(out)
	got, _, err := image.Decode(pf)
	pf.Close()
	if err != nil {
		t.Fatal(err)
	}
	if b := got.Bounds(); b.Dx() != 200*3+padding*2 || b.Dy() != 50*3+padding*2 {
		t.Errorf("小图应放大 3 倍并留白：%v", b)
	}
	if r, g, b, _ := got.At(1, 1).RGBA(); r>>8 != 10 || g>>8 != 20 || b>>8 != 30 {
		t.Errorf("留白应和背景同色")
	}
	cleanup()
	if _, err := os.Stat(out); err == nil {
		t.Errorf("用完应删除临时图片")
	}
	if p, _ := Prepare(filepath.Join(dir, "missing.png"), dir); p != filepath.Join(dir, "missing.png") {
		t.Errorf("读不了的图片原样返回")
	}
}

func TestMergeLines(t *testing.T) {
	// 坐标原点在左下角。第一行被拆成左右两段，且顺序是乱的。
	obs := []observation{
		{"第二行", cgRect{0.1, 0.50, 0.3, 0.05}},
		{"右半", cgRect{0.6, 0.801, 0.2, 0.05}},
		{"左半", cgRect{0.1, 0.80, 0.2, 0.05}},
		{"小字注释", cgRect{0.1, 0.77, 0.2, 0.02}},
	}
	got := strings.Join(mergeLines(obs), "|")
	if got != "左半  右半|小字注释|第二行" {
		t.Errorf("得到 %q", got)
	}
}
