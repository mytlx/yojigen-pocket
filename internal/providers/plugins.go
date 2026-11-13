package providers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
)

// Manifest 是 plugins/<id>/plugin.json。
type Manifest struct {
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	Icon        string   `json:"icon,omitempty"`
	Keywords    []string `json:"keywords,omitempty"`
	Main        string   `json:"main,omitempty"`
	Height      int      `json:"height,omitempty"`
}

type plugin struct {
	Manifest
	id       string
	dir      string
	problem  string
	target   *match.Target
	keywords []*match.Target
}

// PluginInfo 是设置页显示的插件信息。
type PluginInfo struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Icon        string `json:"icon,omitempty"`
	Dir         string `json:"dir"`
	Problem     string `json:"problem,omitempty"`
}

// Plugins 是网页插件：plugins 目录下每个文件夹一个，界面是普通网页。
// 插件运行在 iframe 里，只能通过 window.pocket 使用受限的能力。
type Plugins struct {
	Dir string
	URL func(id, path string) string

	mu   sync.RWMutex
	list []*plugin
}

// Info 实现 core.Provider。
func (p *Plugins) Info() core.Info {
	return core.Info{ID: "plugins", Title: "插件", Icon: "svg:puzzle"}
}

var pluginIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

// Reload 重新扫描插件目录。
func (p *Plugins) Reload() {
	entries, err := os.ReadDir(p.Dir)
	if err != nil {
		return
	}
	var list []*plugin
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		dir := filepath.Join(p.Dir, e.Name())
		raw, err := os.ReadFile(filepath.Join(dir, "plugin.json"))
		if err != nil {
			continue
		}
		x := &plugin{id: strings.ToLower(e.Name()), dir: dir}
		if !pluginIDRe.MatchString(x.id) {
			x.problem = "文件夹名只能包含小写字母、数字和连字符"
			x.Title = e.Name()
		} else if err := json.Unmarshal(raw, &x.Manifest); err != nil {
			x.problem = "plugin.json 不是合法的 JSON：" + err.Error()
			x.Title = e.Name()
		}
		if x.Title == "" {
			x.Title = e.Name()
		}
		if x.Main == "" {
			x.Main = "index.html"
		}
		x.target = match.Prepare(x.Title)
		x.keywords = append(x.keywords, match.Prepare(x.id))
		for _, k := range x.Keywords {
			x.keywords = append(x.keywords, match.Prepare(k))
		}
		list = append(list, x)
	}
	slices.SortFunc(list, func(a, b *plugin) int { return strings.Compare(a.id, b.id) })
	p.mu.Lock()
	p.list = list
	p.mu.Unlock()
}

// List 返回全部插件（设置页用）。
func (p *Plugins) List() []PluginInfo {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]PluginInfo, 0, len(p.list))
	for _, x := range p.list {
		out = append(out, PluginInfo{ID: x.id, Title: x.Title, Description: x.Description, Icon: pluginIcon(x), Dir: x.dir, Problem: x.problem})
	}
	return out
}

// DirOf 返回插件的文件夹（协议处理器用）。没有问题的插件才返回。
func (p *Plugins) DirOf(id string) (string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, x := range p.list {
		if x.id == id && x.problem == "" {
			return x.dir, true
		}
	}
	return "", false
}

func pluginIcon(x *plugin) string {
	if x.Icon == "" {
		return "svg:puzzle"
	}
	if strings.ContainsAny(x.Icon, `/\.`) && !strings.HasPrefix(x.Icon, "http") && !strings.HasPrefix(x.Icon, "data:") {
		return "image:" + filepath.Join(x.dir, x.Icon)
	}
	return x.Icon
}

// Search 实现 core.Provider。
func (p *Plugins) Search(_ context.Context, req *core.Request) []core.Item {
	p.mu.RLock()
	defer p.mu.RUnlock()
	var out []core.Item
	for _, x := range p.list {
		r := match.Best(req.Query, x.target, x.keywords...)
		if r.OK && r.Score > 0 {
			it := p.item(x)
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
		}
	}
	return out
}

// Resolve 实现 core.Resolver。
func (p *Plugins) Resolve(id string) (core.Item, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	for _, x := range p.list {
		if "plugins:"+x.id == id {
			return p.item(x), true
		}
	}
	return core.Item{}, false
}

func (p *Plugins) item(x *plugin) core.Item {
	sub := x.Description
	if sub == "" {
		sub = "网页插件"
	}
	it := core.Item{
		ID: "plugins:" + x.id, Title: x.Title, Subtitle: sub, Icon: pluginIcon(x), Source: "plugins",
		Path: filepath.Join(x.dir, x.Main),
	}
	if x.problem != "" {
		it.Error, it.Subtitle = true, x.problem
		it.Actions = []core.Action{{Type: core.ActionReveal, Title: "在文件夹中显示", Target: x.dir}}
		return it
	}
	view := &core.View{Type: "panel", Title: x.Title, Icon: pluginIcon(x), URL: p.URL(x.id, x.Main), Height: x.Height, Plugin: x.id}
	it.Actions = []core.Action{
		{Type: core.ActionView, Title: "打开", View: view},
		{Type: core.ActionReveal, Title: "在文件夹中显示", Target: x.dir},
	}
	return it
}

// CatalogItems 实现 core.Lister。
func (p *Plugins) CatalogItems() []core.Item {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]core.Item, 0, len(p.list))
	for _, x := range p.list {
		out = append(out, p.item(x))
	}
	return out
}
