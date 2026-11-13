package providers

import (
	"context"
	"strings"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/platform"
)

// sysCommand 是一条系统操作。
type sysCommand struct {
	id       string
	title    string
	icon     string
	keywords []string
	confirm  string
	line     string // 用 shell 执行的命令行
	argv     []string
	target   *match.Target
	kw       []*match.Target
}

// System 是系统操作：锁屏、睡眠、关机、清空回收站、打开设置页。
type System struct {
	list []*sysCommand
}

// NewSystem 创建系统操作集合。具体命令按操作系统区分，见 system_*.go。
func NewSystem() *System {
	s := &System{list: systemCommands()}
	for _, c := range s.list {
		c.target = match.Prepare(c.title)
		for _, k := range c.keywords {
			c.kw = append(c.kw, match.Prepare(k))
		}
	}
	return s
}

// Info 实现 core.Provider。
func (s *System) Info() core.Info { return core.Info{ID: "system", Title: "系统", Icon: "svg:power"} }

// Search 实现 core.Provider。
func (s *System) Search(_ context.Context, req *core.Request) []core.Item {
	var out []core.Item
	for _, c := range s.list {
		r := match.Best(req.Query, c.target, c.kw...)
		if r.OK && r.Score > 0 {
			it := s.item(c)
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
		}
	}
	return out
}

// Resolve 实现 core.Resolver。
func (s *System) Resolve(id string) (core.Item, bool) {
	for _, c := range s.list {
		if "system:"+c.id == id {
			return s.item(c), true
		}
	}
	return core.Item{}, false
}

func (s *System) item(c *sysCommand) core.Item {
	cmd := c
	return core.Item{
		ID:       "system:" + c.id,
		Title:    c.title,
		Subtitle: strings.Join(c.keywords, " · "),
		Icon:     c.icon,
		Source:   "system",
		Actions: []core.Action{{
			Type: core.ActionFunc, Title: "执行", Confirm: c.confirm,
			Fn: func(ctx context.Context, r *core.Run) error {
				r.Hide()
				bg := context.WithoutCancel(ctx)
				if len(cmd.argv) > 0 {
					return platform.Command(bg, cmd.argv[0], cmd.argv[1:]...).Start()
				}
				return platform.ShellCommand(bg, cmd.line).Start()
			},
		}},
	}
}

// CatalogItems 实现 core.Lister。
func (s *System) CatalogItems() []core.Item {
	out := make([]core.Item, 0, len(s.list))
	for _, c := range s.list {
		out = append(out, s.item(c))
	}
	return out
}
