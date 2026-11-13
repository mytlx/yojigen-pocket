package providers

import (
	"context"
	"strconv"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
)

// WindowEntry 是一个已分离的功能窗口。
type WindowEntry struct {
	ID    int
	Title string
	Icon  string
}

// Windows 让已分离的功能窗口可以从搜索里切换过去。
type Windows struct {
	List  func() []WindowEntry
	Focus func(id int)
}

// Info 实现 core.Provider。
func (w *Windows) Info() core.Info {
	return core.Info{ID: "windows", Title: "窗口", Icon: "svg:app-window"}
}

var windowKeywords = []*match.Target{match.Prepare("window"), match.Prepare("窗口"), match.Prepare("切换")}

// Search 实现 core.Provider。
func (w *Windows) Search(_ context.Context, req *core.Request) []core.Item {
	list := w.List()
	if len(list) == 0 {
		return nil
	}
	all := false
	for _, k := range windowKeywords {
		if r := k.Match(req.Query); r.OK && r.Score >= 0.85 {
			all = true
		}
	}
	var out []core.Item
	for _, e := range list {
		entry := e
		r := match.Prepare(e.Title).Match(req.Query)
		if !all && (!r.OK || r.Score <= 0) {
			continue
		}
		score := 0.9
		if r.OK && r.Score > 0 {
			score = r.Score + 0.05 // 已经开着的窗口比再开一个更可能是想要的
		}
		out = append(out, core.Item{
			ID: "windows:" + strconv.Itoa(e.ID), Title: e.Title, Subtitle: "切换到这个独立窗口", Icon: e.Icon,
			Source: "windows", Ephem: true, Score: score, Highlights: r.Positions,
			Actions: []core.Action{{Type: core.ActionFunc, Title: "切换过去", Fn: func(_ context.Context, run *core.Run) error {
				run.Hide()
				w.Focus(entry.ID)
				return nil
			}}},
		})
	}
	return out
}
