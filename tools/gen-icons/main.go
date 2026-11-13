// gen-icons 生成应用图标和托盘图标：go run ./tools/gen-icons
// 图形用距离场直接算，不依赖任何图片工具，改配色或形状后重新运行即可。
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
)

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

func smoothstep(a, b, x float64) float64 {
	t := clamp01((x - a) / (b - a))
	return t * t * (3 - 2*t)
}

// 圆角矩形的距离场。
func sdRoundRect(x, y, cx, cy, hw, hh, r float64) float64 {
	qx := math.Abs(x-cx) - hw + r
	qy := math.Abs(y-cy) - hh + r
	return math.Min(math.Max(qx, qy), 0) + math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) - r
}

// 半圆（平边朝上）的距离场，带圆角。
func sdPocket(x, y, cx, cy, r, k float64) float64 {
	a := math.Hypot(x-cx, y-cy) - r + k
	b := cy - y + k
	return math.Min(math.Max(a, b), 0) + math.Hypot(math.Max(a, 0), math.Max(b, 0)) - k
}

type rgba struct{ r, g, b, a float64 }

// over 把 src 按 coverage 叠到 dst 上（非预乘）。
func over(dst rgba, sr, sg, sb, sa float64) rgba {
	out := sa + dst.a*(1-sa)
	if out <= 0 {
		return rgba{}
	}
	mix := func(s, d float64) float64 { return (s*sa + d*dst.a*(1-sa)) / out }
	return rgba{mix(sr, dst.r), mix(sg, dst.g), mix(sb, dst.b), out}
}

// 图标画的是哆啦A梦的肚子：蓝底、红项圈、金色铃铛，下面是白色的四次元口袋。
//
// full 为假时四周留出 macOS 图标规范要的边距并带投影；为真时图形撑满画布，
// 用在 Windows 上——那里的图标不留边，留了就比别的应用小一圈。
func appIcon(size int, full bool) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	s := float64(size) / 1024
	zoom := 1.0
	if full {
		zoom = 506.0 / 412.0
	}
	px2 := s * zoom // 设计坐标里的一个单位是多少像素
	small := size <= 48
	for py := range size {
		for px := range size {
			x := 512 + ((float64(px)+0.5)/s-512)/zoom
			y := 512 + ((float64(py)+0.5)/s-512)/zoom
			c := rgba{}

			if !full {
				shadow := sdRoundRect(x, y-14, 512, 512, 412, 412, 186)
				c = over(c, 0.04, 0.08, 0.25, 0.30*(1-smoothstep(-12, 34, shadow)))
			}

			// 底板：哆啦A梦的蓝，上亮下深
			bg := sdRoundRect(x, y, 512, 512, 412, 412, 186)
			cov := clamp01(0.5 - bg*px2)
			t := clamp01((y - 100) / 824)
			c = over(c, 0.16+(0.04-0.16)*t, 0.66+(0.44-0.66)*t, 0.98+(0.88-0.98)*t, cov)
			if cov > 0 && !small {
				sheen := (1 - smoothstep(100, 520, y)) * 0.22
				edge := smoothstep(0, -60, bg)
				c = over(c, 1, 1, 1, cov*sheen*edge)
				rim := 1 - smoothstep(0, 3.2, math.Abs(bg+3))
				c = over(c, 1, 1, 1, cov*rim*(0.5-0.3*t))
			}

			// 口袋：白色半圆
			const cx, cy, pr = 512.0, 468.0, 282.0
			if !small {
				ps := sdPocket(x, y-18, cx, cy, pr, 26)
				c = over(c, 0.02, 0.16, 0.42, cov*0.34*(1-smoothstep(-22, 34, ps)))
			}
			pd := sdPocket(x, y, cx, cy, pr, 26)
			pc := clamp01(0.5-pd*px2) * cov
			shade := clamp01((y - cy) / pr)
			c = over(c, 1-0.06*shade, 1-0.03*shade, 1, pc)
			if pc > 0 && !small {
				// 缝线：沿半圆内侧的虚线，从底部中点向两侧对称
				radius := math.Hypot(x-cx, y-cy)
				angle := math.Atan2(y-cy, x-cx)
				line := 1 - smoothstep(4, 6.5, math.Abs(radius-(pr-44)))
				dash := smoothstep(-0.05, 0.05, math.Cos(math.Abs(angle-math.Pi/2)*34))
				inside := smoothstep(cy+18, cy+30, y)
				c = over(c, 0.10, 0.50, 0.92, pc*line*dash*inside*0.6)
			}

			// 项圈：一条微微下垂的红带，压在口袋上沿之上
			sag := 26 * (1 - math.Pow((x-512)/412, 2))
			collarHalf := 33.0
			if small {
				collarHalf = 44
			}
			cd := math.Abs(y-(318+sag)) - collarHalf
			cc := clamp01(0.5-cd*px2) * cov
			ct := clamp01((y - (318 + sag) + collarHalf) / (2 * collarHalf))
			c = over(c, 0.93-0.13*ct, 0.20-0.06*ct, 0.18-0.05*ct, cc)
			if !small {
				c = over(c, 1, 1, 1, cc*0.20*(1-smoothstep(-collarHalf, -collarHalf+16, cd-0)+0)*smoothstep(0.0, 0.3, 0.3-ct))
			}

			// 铃铛
			const bx, by = 512.0, 378.0
			br := 104.0
			if small {
				br = 132
			}
			if !small {
				bs := math.Hypot(x-bx, y-by-12) - br
				c = over(c, 0.25, 0.10, 0.02, cov*0.30*(1-smoothstep(-14, 26, bs)))
			}
			bd := math.Hypot(x-bx, y-by) - br
			bc := clamp01(0.5-bd*px2) * cov
			// 金色：左上亮、右下深
			lit := clamp01(0.5 + ((bx-x)+(by-y))/(br*2.6))
			c = over(c, 0.96+0.04*lit, 0.66+0.22*lit, 0.04+0.26*lit, bc)
			if bc > 0 && !small {
				dark := func(a float64) { c = over(c, 0.42, 0.24, 0.02, bc*a) }
				// 外圈描边
				dark(0.55 * (1 - smoothstep(0, 5, math.Abs(bd+4))))
				// 腰线：两道线夹一条亮带
				band := y - (by - 22)
				c = over(c, 1, 0.95, 0.62, bc*0.55*(1-smoothstep(9, 12, math.Abs(band))))
				dark(0.6 * (1 - smoothstep(2.6, 5, math.Abs(math.Abs(band)-13))))
				// 发声孔和下面的开缝
				dark(0.9 * clamp01(0.5-(math.Hypot(x-bx, y-(by+26))-17)*px2))
				if y > by+26 {
					dark(0.9 * clamp01(0.5-(math.Abs(x-bx)-5.5)*px2))
				}
				// 高光
				hx, hy := (x-(bx-40))/26, (y-(by-58))/15
				c = over(c, 1, 1, 1, bc*0.75*(1-smoothstep(0.6, 1.1, math.Hypot(hx, hy))))
			}
			if bc > 0 && small {
				// 小尺寸只留一个孔，看得出是铃铛就够了。
				c = over(c, 0.42, 0.24, 0.02, bc*0.85*clamp01(0.5-(math.Hypot(x-bx, y-(by+34))-30)*px2))
			}

			img.SetNRGBA(px, py, color.NRGBA{
				R: uint8(clamp01(c.r)*255 + 0.5), G: uint8(clamp01(c.g)*255 + 0.5),
				B: uint8(clamp01(c.b)*255 + 0.5), A: uint8(clamp01(c.a)*255 + 0.5),
			})
		}
	}
	return img
}

// 托盘图标：单色，macOS 会按菜单栏深浅自动着色。口袋上面顶着一个铃铛。
func trayIcon(size int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	s := float64(size) / 32
	for py := range size {
		for px := range size {
			x, y := (float64(px)+0.5)/s, (float64(py)+0.5)/s
			d := sdPocket(x, y, 16, 15.5, 12, 2)
			alpha := clamp01(0.5 - d*s)
			// 缝线挖空一圈，小尺寸下也看得出是口袋。
			inner := math.Abs(sdPocket(x, y, 16, 15.5, 7.8, 1.2))
			alpha *= 1 - (1-smoothstep(0.7, 1.5, inner))*0.85
			// 铃铛：先在口袋上沿挖出一圈间隙，再画实心圆和发声孔。
			bell := math.Hypot(x-16, y-9.2) - 5.6
			alpha *= smoothstep(1.0, 2.0, bell)
			b := clamp01(0.5 - bell*s)
			b *= 1 - clamp01(0.5-(math.Hypot(x-16, y-10.6)-1.5)*s)
			alpha = math.Max(alpha, b)
			img.SetNRGBA(px, py, color.NRGBA{A: uint8(alpha*255 + 0.5)})
		}
	}
	return img
}

// writeICNS 把同一个图形按各个尺寸画一遍，装成 macOS 的 .icns。
func writeICNS(path string, draw func(size int) image.Image) {
	entries := []struct {
		kind string
		size int
	}{{"icp4", 16}, {"icp5", 32}, {"icp6", 64}, {"ic07", 128}, {"ic08", 256}, {"ic09", 512}, {"ic10", 1024}, {"ic11", 32}, {"ic12", 64}, {"ic13", 256}, {"ic14", 512}}
	var body bytes.Buffer
	cache := map[int][]byte{}
	for _, e := range entries {
		data, ok := cache[e.size]
		if !ok {
			var buf bytes.Buffer
			if err := png.Encode(&buf, draw(e.size)); err != nil {
				log.Fatal(err)
			}
			data = buf.Bytes()
			cache[e.size] = data
		}
		body.WriteString(e.kind)
		_ = binary.Write(&body, binary.BigEndian, uint32(len(data)+8))
		body.Write(data)
	}
	var out bytes.Buffer
	out.WriteString("icns")
	_ = binary.Write(&out, binary.BigEndian, uint32(body.Len()+8))
	out.Write(body.Bytes())
	if err := os.WriteFile(path, out.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
}

func write(path string, img image.Image) {
	f, err := os.Create(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		log.Fatal(err)
	}
}

func main() {
	// Windows 和 Linux 用撑满画布的；macOS 用留边距的 .icns（mygo.config.ts 里的 macos.icon）。
	write("resources/icon.png", appIcon(1024, true))
	writeICNS("resources/icon.icns", func(size int) image.Image { return appIcon(size, false) })
	write("assets/tray.png", trayIcon(32))
	// Windows 的任务栏有深有浅，单色图标可能看不见，所以用彩色的；撑满画布，和别的应用一样大。
	write("assets/tray-color.png", appIcon(32, true))
}
