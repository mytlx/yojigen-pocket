package providers

import (
	"context"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
)

// SelfCommand 是一条自身管理命令。
type SelfCommand struct {
	ID       string
	Title    string
	Subtitle string
	Icon     string
	Keywords []string
	Confirm  string
	Run      func(ctx context.Context, r *core.Run) error
	KeepOpen bool

	target *match.Target
	kw     []*match.Target
}

// Self 是自身管理命令：设置、重载、打开配置目录、新建命令……
type Self struct {
	list []*SelfCommand
}

// NewSelf 创建自身管理命令集合。
func NewSelf(list []*SelfCommand) *Self {
	for _, c := range list {
		c.target = match.Prepare(c.Title)
		for _, k := range c.Keywords {
			c.kw = append(c.kw, match.Prepare(k))
		}
	}
	return &Self{list: list}
}

// Info 实现 core.Provider。
func (s *Self) Info() core.Info { return core.Info{ID: "self", Title: "Pocket", Icon: "svg:pocket"} }

// Search 实现 core.Provider。
func (s *Self) Search(_ context.Context, req *core.Request) []core.Item {
	var out []core.Item
	for _, c := range s.list {
		if req.Text == "" {
			it := s.item(c)
			it.Score = 1
			out = append(out, it)
			continue
		}
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
func (s *Self) Resolve(id string) (core.Item, bool) {
	for _, c := range s.list {
		if "self:"+c.ID == id {
			return s.item(c), true
		}
	}
	return core.Item{}, false
}

func (s *Self) item(c *SelfCommand) core.Item {
	return core.Item{
		ID:       "self:" + c.ID,
		Title:    c.Title,
		Subtitle: c.Subtitle,
		Icon:     c.Icon,
		Source:   "self",
		Actions:  []core.Action{{Type: core.ActionFunc, Title: "执行", Confirm: c.Confirm, KeepOpen: c.KeepOpen, Fn: c.Run}},
	}
}

// CatalogItems 实现 core.Lister。
func (s *Self) CatalogItems() []core.Item {
	out := make([]core.Item, 0, len(s.list))
	for _, c := range s.list {
		out = append(out, s.item(c))
	}
	return out
}
