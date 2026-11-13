package ocr

import (
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"os"
	"slices"
	"strings"

	"golang.org/x/image/draw"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

const (
	targetLongSide = 2200 // 放大到长边大约这么多像素
	maxScale       = 3.0
	padding        = 28 // 四周留白：文字贴着图片边缘时识别率很差
)

// Prepare 为识别做预处理：把小图放大（小字放大后识别率明显更高），四周加一圈和背景同色的留白。
// 返回处理后的图片路径和清理函数；图片解不开（例如 HEIC）时原样返回。
func Prepare(path, dir string) (string, func()) {
	noop := func() {}
	f, err := os.Open(path)
	if err != nil {
		return path, noop
	}
	src, _, err := image.Decode(f)
	f.Close()
	if err != nil {
		return path, noop
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w < 4 || h < 4 {
		return path, noop
	}
	scale := min(float64(targetLongSide)/float64(max(w, h)), maxScale)
	if scale < 1.15 {
		scale = 1
	}
	nw, nh := int(float64(w)*scale+0.5), int(float64(h)*scale+0.5)
	dst := image.NewRGBA(image.Rect(0, 0, nw+padding*2, nh+padding*2))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(background(src)), image.Point{}, draw.Src)
	inner := image.Rect(padding, padding, padding+nw, padding+nh)
	if scale == 1 {
		draw.Draw(dst, inner, src, b.Min, draw.Over)
	} else {
		draw.CatmullRom.Scale(dst, inner, src, b, draw.Over, nil)
	}
	if dir == "" {
		dir = os.TempDir()
	}
	_ = os.MkdirAll(dir, 0o700)
	out, err := os.CreateTemp(dir, "prepared-*.png")
	if err != nil {
		return path, noop
	}
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(out, dst); err != nil {
		out.Close()
		os.Remove(out.Name())
		return path, noop
	}
	out.Close()
	return out.Name(), func() { os.Remove(out.Name()) }
}

// background 取四个角里出现最多的颜色当背景色（深色截图就留深色的边）。
func background(img image.Image) color.Color {
	b := img.Bounds()
	corners := []color.Color{
		img.At(b.Min.X, b.Min.Y), img.At(b.Max.X-1, b.Min.Y),
		img.At(b.Min.X, b.Max.Y-1), img.At(b.Max.X-1, b.Max.Y-1),
	}
	count := map[color.RGBA]int{}
	best, bestN := color.RGBA{255, 255, 255, 255}, 0
	for _, c := range corners {
		r, g, bl, a := c.RGBA()
		if a == 0 {
			continue // 透明的角当白色
		}
		k := color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(bl >> 8), 255}
		count[k]++
		if count[k] > bestN {
			best, bestN = k, count[k]
		}
	}
	return best
}

// mergeLines 把识别出的文字块按阅读顺序排好，同一行上的块合并成一行。
// Vision 常把同一行里隔得远的几段拆成几条结果，顺序也不一定从上到下。
func mergeLines(obs []observation) []string {
	if len(obs) == 0 {
		return nil
	}
	sorted := slices.Clone(obs)
	centerY := func(o observation) float64 { return o.box.Y + o.box.H/2 }
	// 坐标原点在左下角：Y 越大越靠上。
	slices.SortStableFunc(sorted, func(a, b observation) int {
		switch {
		case centerY(a) > centerY(b):
			return -1
		case centerY(a) < centerY(b):
			return 1
		}
		return 0
	})
	var rows [][]observation
	for _, o := range sorted {
		placed := false
		if n := len(rows); n > 0 {
			row := rows[n-1]
			ref := row[0]
			// 中心的高度差小于行高的一半，并且水平方向不重叠，算同一行。
			if abs(centerY(ref)-centerY(o)) < min(ref.box.H, o.box.H)*0.5 && !overlapsX(row, o) {
				rows[n-1] = append(row, o)
				placed = true
			}
		}
		if !placed {
			rows = append(rows, []observation{o})
		}
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		slices.SortFunc(row, func(a, b observation) int {
			if a.box.X < b.box.X {
				return -1
			}
			return 1
		})
		parts := make([]string, len(row))
		for i, o := range row {
			parts[i] = strings.TrimSpace(o.text)
		}
		out = append(out, strings.Join(parts, "  "))
	}
	return out
}

func overlapsX(row []observation, o observation) bool {
	for _, r := range row {
		if o.box.X < r.box.X+r.box.W && r.box.X < o.box.X+o.box.W {
			return true
		}
	}
	return false
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
