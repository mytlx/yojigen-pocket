package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/store"
)

// 桌面宠物：一个独立的、透明的、置顶的小窗口。默认关闭；关着的时候不建窗口、不开定时器，
// 3D 的代码也只在这个窗口的页面里，别的页面不会加载它。养成的数值由页面自己算，后端只管存档。

const (
	petBaseW  = 230
	petBaseH  = 260
	petPanelW = 320
	petPanelH = 470
)

func (a *App) petSize(panel bool) (int, int) {
	scale := a.config.Get().Pet.Scale
	w, h := int(petBaseW*scale), int(petBaseH*scale)
	if panel {
		return max(w, petPanelW), h + petPanelH - petBaseH
	}
	return w, h
}

// syncPet 让宠物窗口和设置保持一致：开着就要有窗口，关了就把窗口关掉。
func (a *App) syncPet() {
	cfg := a.config.Get().Pet
	if !cfg.Enabled {
		if a.pet != nil && !a.pet.IsDestroyed() {
			a.pet.Close()
		}
		a.pet = nil
		return
	}
	if a.pet != nil && !a.pet.IsDestroyed() {
		a.pet.SetAlwaysOnTop(cfg.AlwaysOnTop)
		w, h := a.petSize(false)
		if cw, ch := a.pet.Size(); cw != w && ch <= int(petBaseH*2) {
			a.pet.SetSize(w, h)
		}
		return
	}
	w, h := a.petSize(false)
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: "桌面宠物", URL: "/pet.html", Width: w, Height: h, Hidden: true,
		Frameless: true, Transparent: true, AlwaysOnTop: cfg.AlwaysOnTop, SkipTaskbar: true, DisableShadow: true,
		MinWidth: 80, MinHeight: 80, StateKey: "pet",
	})
	a.pet = win
	win.SetResizable(false)
	win.OnReadyToShow(func() {
		// 第一次出现时放在主屏右下角。
		if x, y := win.Position(); x == 0 && y == 0 {
			wa := mygo.Screen.PrimaryDisplay().WorkArea
			win.SetPosition(wa.X+wa.Width-w-60, wa.Y+wa.Height-h-10)
		}
		win.SetSize(w, h)
		win.ShowInactive()
	})
	win.OnClosed(func() {
		if a.pet == win {
			a.pet = nil
		}
	})
}

// setPetEnabled 打开或关闭宠物（设置、命令和托盘菜单都走这里）。
func (a *App) setPetEnabled(on bool) error {
	if err := a.config.Update(func(c *store.Config) { c.Pet.Enabled = on }); err != nil {
		return err
	}
	a.configApplied()
	a.windowsChanged() // 托盘菜单里的勾跟着变
	return nil
}

// Pet 是宠物窗口的服务。
type Pet struct{ a *App }

// PetInfo 是宠物页面打开时需要的东西。
type PetInfo struct {
	Config store.PetConfig `json:"config"`
	State  string          `json:"state"` // 存档（JSON）；第一次是空的
	Area   mygo.Rectangle  `json:"area"`  // 宠物可以走动的范围（所在屏幕的工作区）
	X      int             `json:"x"`
	Y      int             `json:"y"`
	Width  int             `json:"width"`
	Height int             `json:"height"`
}

func (p *Pet) file() string { return filepath.Join(p.a.paths.Data, "pet.json") }

func (p *Pet) win(ctx context.Context) *mygo.Window {
	w := mygo.CallerWindow(ctx)
	if w == nil || p.a.pet == nil || w.ID() != p.a.pet.ID() {
		return nil
	}
	return w
}

// Info 返回设置、存档和窗口所在的屏幕范围。
func (p *Pet) Info(ctx context.Context) PetInfo {
	info := PetInfo{Config: p.a.config.Get().Pet}
	if raw, err := os.ReadFile(p.file()); err == nil && json.Valid(raw) {
		info.State = string(raw)
	}
	if w := p.win(ctx); w != nil {
		info.X, info.Y = w.Position()
		info.Width, info.Height = w.Size()
		info.Area = mygo.Screen.DisplayMatching(mygo.Rectangle{X: info.X, Y: info.Y, Width: info.Width, Height: info.Height}).WorkArea
	}
	return info
}

// Save 保存存档。
func (p *Pet) Save(state string) error {
	if len(state) > 256<<10 || !json.Valid([]byte(state)) {
		return errors.New("存档格式不对")
	}
	return os.WriteFile(p.file(), []byte(state), 0o600)
}

// Move 把宠物窗口挪动一点（它自己走路时用），不会走出屏幕。返回新的位置，以及有没有碰到边。
func (p *Pet) Move(ctx context.Context, dx, dy int) []int {
	w := p.win(ctx)
	if w == nil {
		return nil
	}
	x, y := w.Position()
	ww, wh := w.Size()
	wa := mygo.Screen.DisplayMatching(mygo.Rectangle{X: x, Y: y, Width: ww, Height: wh}).WorkArea
	nx := min(max(x+dx, wa.X-ww/4), wa.X+wa.Width-ww+ww/4)
	ny := min(max(y+dy, wa.Y), wa.Y+wa.Height-wh)
	hit := 0
	if nx != x+dx {
		hit = 1
	}
	if nx != x || ny != y {
		w.SetPosition(nx, ny)
	}
	return []int{nx, ny, hit}
}

// Land 让宠物落到屏幕底部（被拖到半空松手之后）。返回离底部还有多远。
func (p *Pet) Land(ctx context.Context) int {
	w := p.win(ctx)
	if w == nil {
		return 0
	}
	x, y := w.Position()
	ww, wh := w.Size()
	wa := mygo.Screen.DisplayMatching(mygo.Rectangle{X: x, Y: y, Width: ww, Height: wh}).WorkArea
	return wa.Y + wa.Height - wh - y
}

// SetPanel 打开或收起菜单面板：窗口变大或变回去，脚底的位置不动。
func (p *Pet) SetPanel(ctx context.Context, open bool) {
	w := p.win(ctx)
	if w == nil {
		return
	}
	x, y := w.Position()
	ow, oh := w.Size()
	nw, nh := p.a.petSize(open)
	if nw == ow && nh == oh {
		return
	}
	w.SetBounds(mygo.Rectangle{X: x - (nw-ow)/2, Y: y - (nh - oh), Width: nw, Height: nh})
}

// SetConfig 改宠物的设置（名字、大小、是否置顶）。
func (p *Pet) SetConfig(c store.PetConfig) error {
	err := p.a.config.Update(func(cfg *store.Config) {
		c.Enabled = cfg.Pet.Enabled
		cfg.Pet = c
	})
	if err == nil {
		p.a.configApplied()
	}
	return err
}

// Hide 关掉宠物。存档还在，下次打开接着养。
func (p *Pet) Hide() error { return p.a.setPetEnabled(false) }

// SetEnabled 打开或关闭宠物（设置页用）。
func (p *Pet) SetEnabled(on bool) error { return p.a.setPetEnabled(on) }
