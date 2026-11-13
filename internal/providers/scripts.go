package providers

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/scripts"
)

type command struct {
	*scripts.Command
	id       string
	target   *match.Target
	keywords []*match.Target
}

type listCache struct {
	items []core.Item
	at    time.Time
}

// Scripts 把命令目录里的脚本变成可搜索、可执行的命令。
type Scripts struct {
	Dir    string
	Runner *scripts.Runner
	Host   func() core.Host

	mu    sync.RWMutex
	list  []*command
	cache map[string]*listCache
	fails map[string]int
}

// Info 实现 core.Provider。
func (s *Scripts) Info() core.Info {
	return core.Info{ID: "scripts", Title: "脚本", Icon: "svg:terminal"}
}

// Reload 重新扫描命令目录。
func (s *Scripts) Reload() {
	var list []*command
	seen := map[string]bool{}
	_ = filepath.WalkDir(s.Dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != s.Dir && (strings.HasPrefix(d.Name(), ".") || d.Name() == "node_modules" || d.Name() == "__pycache__") {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || !scripts.Runnable(p, info) {
			return nil
		}
		raw, err := readHead(p, 16<<10)
		if err != nil {
			return nil
		}
		c := scripts.Parse(p, raw)
		// 用相对路径作 ID，子文件夹里的同名脚本不会冲突。
		rel, _ := filepath.Rel(s.Dir, p)
		rel = filepath.ToSlash(strings.TrimSuffix(rel, filepath.Ext(rel)))
		if seen[rel] {
			return nil
		}
		seen[rel] = true
		cmd := &command{Command: c, id: "scripts:" + rel, target: match.Prepare(c.Title)}
		cmd.keywords = append(cmd.keywords, match.Prepare(c.Name))
		for _, k := range c.Keywords {
			cmd.keywords = append(cmd.keywords, match.Prepare(k))
		}
		list = append(list, cmd)
		return nil
	})
	slices.SortFunc(list, func(a, b *command) int { return strings.Compare(a.id, b.id) })
	s.mu.Lock()
	s.list = list
	s.cache = map[string]*listCache{}
	s.mu.Unlock()
}

func readHead(path string, n int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, n)
	m, _ := f.Read(buf)
	return buf[:m], nil
}

// CommandInfo 是设置页显示的脚本信息。
type CommandInfo struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Desc     string   `json:"desc,omitempty"`
	Path     string   `json:"path"`
	Mode     string   `json:"mode"`
	Icon     string   `json:"icon,omitempty"`
	Hotkey   string   `json:"hotkey,omitempty"`
	Problems []string `json:"problems,omitempty"`
}

// Commands 返回全部脚本（设置页用）。
func (s *Scripts) Commands() []CommandInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]CommandInfo, 0, len(s.list))
	for _, c := range s.list {
		out = append(out, CommandInfo{ID: c.id, Title: c.Title, Desc: c.Desc, Path: c.Path, Mode: c.Mode, Icon: c.Icon, Hotkey: c.Hotkey, Problems: c.Problems})
	}
	return out
}

// Hotkeys 返回脚本元数据里声明的热键。
func (s *Scripts) Hotkeys() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]string{}
	for _, c := range s.list {
		if c.Hotkey != "" {
			out[c.id] = c.Hotkey
		}
	}
	return out
}

func whenMatches(c *command, fg string) bool {
	if len(c.When) == 0 {
		return true
	}
	return slices.Contains(c.When, strings.ToLower(fg))
}

func (s *Scripts) find(id string) *command {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, c := range s.list {
		if c.id == id {
			return c
		}
	}
	return nil
}

// ScopeDelay 实现 core.AsyncScoper：filter 模式防抖 120 ms，list 模式首次要运行脚本。
func (s *Scripts) ScopeDelay(scope string) (time.Duration, bool) {
	if c := s.find(scope); c != nil && c.Mode == scripts.ModeFilter {
		return 120 * time.Millisecond, true
	}
	return 0, true
}

// Search 实现 core.Provider。
func (s *Scripts) Search(ctx context.Context, req *core.Request) []core.Item {
	if req.Scope != "" {
		return s.searchScope(ctx, req)
	}
	s.mu.RLock()
	list := s.list
	s.mu.RUnlock()
	var out []core.Item
	first := strings.ToLower(req.First)
	for _, c := range list {
		if !whenMatches(c, req.Context.FgProcess) {
			continue
		}
		// 关键词完全命中，后面的内容作为参数：tr hello world。
		if req.Rest != "" && keywordHit(c, first) {
			it := s.item(c, req.Rest)
			it.Exact, it.Score = true, 1
			it.Subtitle = "参数：" + req.Rest
			out = append(out, it)
			continue
		}
		r := match.Best(req.Query, c.target, c.keywords...)
		if r.OK && r.Score > 0 {
			it := s.item(c, "")
			it.Score, it.Highlights = r.Score, r.Positions
			out = append(out, it)
			continue
		}
		if c.Fallback && !req.Scoped {
			it := s.item(c, req.Text)
			it.Bottom, it.Score = true, 1
			it.Subtitle = "用“" + truncate(req.Text, 40) + "”运行"
			out = append(out, it)
		}
	}
	return out
}

func keywordHit(c *command, first string) bool {
	if strings.EqualFold(c.Name, first) {
		return true
	}
	for _, k := range c.Keywords {
		if strings.EqualFold(k, first) {
			return true
		}
	}
	return false
}

// Resolve 实现 core.Resolver。
func (s *Scripts) Resolve(id string) (core.Item, bool) {
	c := s.find(id)
	if c == nil {
		return core.Item{}, false
	}
	return s.item(c, ""), true
}

func (s *Scripts) item(c *command, inline string) core.Item {
	cmd := c
	sub := c.Desc
	if sub == "" {
		sub = c.Path
	}
	it := core.Item{
		ID:       c.id,
		Title:    c.Title,
		Subtitle: sub,
		Icon:     iconOr(c.Icon, "svg:terminal"),
		Source:   "scripts",
		Path:     c.Path,
		Hotkey:   c.Hotkey,
	}
	if len(c.Problems) > 0 {
		it.Error = true
		it.Subtitle = c.Problems[0]
	}
	primary := core.Action{Type: core.ActionFunc, Title: "运行", Confirm: c.Confirm, Fn: func(ctx context.Context, r *core.Run) error {
		return s.run(ctx, r, cmd, inline)
	}}
	if c.Mode == scripts.ModeList || c.Mode == scripts.ModeFilter {
		scope := s.scopeOf(c)
		it.Scope = &scope
		if inline == "" {
			primary.Title = "打开"
		}
	}
	it.Actions = []core.Action{primary}
	return it
}

func (s *Scripts) scopeOf(c *command) core.Scope {
	return core.Scope{ID: c.id, Title: c.Title, Icon: iconOr(c.Icon, "svg:terminal"), Placeholder: "在「" + c.Title + "」中搜索…"}
}

// buildArgs 把内联输入和表单值组合成命令行参数。缺少必填参数时返回需要填写的表单字段。
func (s *Scripts) buildArgs(c *command, r *core.Run, inline string, ctxInfo core.Context) ([]string, []core.Field) {
	if len(c.Args) == 0 {
		if inline != "" {
			return []string{inline}, nil
		}
		return nil, nil
	}
	expand := func(v string) string {
		selection := ctxInfo.Selection
		if selection == "" {
			selection = ctxInfo.Clipboard // 没有选中文字时，退回剪贴板
		}
		return strings.NewReplacer("{clipboard}", ctxInfo.Clipboard, "{selection}", selection, "{query}", r.Query).Replace(v)
	}
	args := make([]string, len(c.Args))
	var missing bool
	fields := make([]core.Field, len(c.Args))
	for i, a := range c.Args {
		val := ""
		if r.Args != nil {
			val = r.Args[a.Name]
		} else if i == 0 && inline != "" {
			val = inline
		}
		if val == "" && a.Default != "" {
			val = expand(a.Default)
		}
		args[i] = val
		if val == "" && !a.Optional {
			missing = true
		}
		fields[i] = core.Field{Name: a.Name, Label: a.Name, Type: a.Type, Placeholder: a.Placeholder, Options: a.Options, Optional: a.Optional, Default: val}
	}
	if missing && r.Args == nil {
		return nil, fields
	}
	return args, nil
}

// run 按输出模式执行脚本。
func (s *Scripts) run(ctx context.Context, r *core.Run, c *command, inline string) error {
	ctxInfo := r.Engine.Context()
	if clip := r.Host.ReadClipboardText(); clip != "" {
		ctxInfo.Clipboard = clip
	}
	if c.Mode == scripts.ModeList || c.Mode == scripts.ModeFilter {
		scope := s.scopeOf(c)
		r.EnterScope(&scope)
		if inline != "" {
			r.SetInput(inline)
		}
		return nil
	}
	args, form := s.buildArgs(c, r, inline, ctxInfo)
	if form != nil {
		r.Show(&core.View{Type: "form", Title: c.Title, Icon: iconOr(c.Icon, "svg:terminal"), Fields: form, Item: c.id})
		return nil
	}
	in := scripts.Input{Args: args, Query: r.Query, Context: ctxInfo}
	host := r.Host
	switch c.Mode {
	case scripts.ModeText, scripts.ModeDetail:
		kind := "text"
		if c.Mode == scripts.ModeDetail {
			kind = "markdown"
		}
		r.Show(&core.View{Type: kind, Title: c.Title, Icon: iconOr(c.Icon, "svg:terminal"), Stream: true})
		_, err := s.Runner.Run(ctx, c.Command, in, func(chunk string) { r.Append(chunk) })
		if err != nil && ctx.Err() == nil {
			r.Fail(err.Error())
		}
		r.Emit(core.ExecEvent{Kind: "done"})
		return nil
	case scripts.ModePanel:
		out, err := s.Runner.Run(ctx, c.Command, in, nil)
		if err != nil {
			return err
		}
		content := strings.TrimSpace(out.Stdout)
		v := &core.View{Type: "panel", Title: c.Title, Icon: iconOr(c.Icon, "svg:terminal")}
		if strings.HasPrefix(content, "http://") || strings.HasPrefix(content, "https://") {
			v.URL = content
		} else {
			v.HTML = out.Stdout
		}
		r.Show(v)
		return nil
	}
	// silent / toast：先隐藏窗口，放到后台执行，完成后用通知告知。
	r.Hide()
	bg := context.WithoutCancel(ctx)
	mode, title := c.Mode, c.Title
	cmd := c.Command
	go func() {
		out, err := s.Runner.Run(bg, cmd, in, nil)
		if err != nil {
			host.Notify(title+" 执行失败", err.Error())
			return
		}
		if mode == scripts.ModeToast {
			if line := lastLine(out.Stdout); line != "" {
				host.Notify(title, line)
			}
		}
	}()
	return nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func (s *Scripts) searchScope(ctx context.Context, req *core.Request) []core.Item {
	c := s.find(req.Scope)
	if c == nil {
		return nil
	}
	in := scripts.Input{Query: req.Text, Context: req.Context}
	if c.Mode == scripts.ModeFilter {
		in.Args = []string{req.Text}
		out, err := s.Runner.Run(ctx, c.Command, in, nil)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return []core.Item{errorItem(c, err)}
		}
		return s.decorateList(c, scripts.ParseList(out.Stdout), nil, req)
	}

	// list 模式：运行一次，之后在结果里过滤。
	refresh := c.Refresh
	if refresh == 0 {
		refresh = 5 * time.Second
	}
	s.mu.RLock()
	cached := s.cache[c.id]
	s.mu.RUnlock()
	var items []core.Item
	if cached != nil && time.Since(cached.at) < refresh {
		items = cached.items
	} else {
		out, err := s.Runner.Run(ctx, c.Command, in, nil)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return []core.Item{errorItem(c, err)}
		}
		items = scripts.ParseList(out.Stdout)
		s.mu.Lock()
		if s.cache == nil {
			s.cache = map[string]*listCache{}
		}
		s.cache[c.id] = &listCache{items: items, at: time.Now()}
		s.mu.Unlock()
	}
	return s.decorateList(c, items, &req.Query, req)
}

func errorItem(c *command, err error) core.Item {
	return core.Item{
		ID: c.id + "#error", Title: c.Title + " 执行失败", Subtitle: err.Error(), Icon: "svg:alert",
		Source: "scripts", Error: true, Ephem: true, Score: 1, Path: c.Path,
		Actions: []core.Action{{Type: core.ActionCopy, Title: "复制错误信息", Text: err.Error(), KeepOpen: true}},
	}
}

// decorateList 给脚本输出的结果项补齐 ID、来源和匹配分。filter 不为空时按输入过滤。
func (s *Scripts) decorateList(c *command, items []core.Item, filter *match.Query, req *core.Request) []core.Item {
	out := make([]core.Item, 0, len(items))
	for i, it := range items {
		it.Source = "scripts"
		it.Ephem = true
		it.Icon = iconOr(it.Icon, iconOr(c.Icon, "svg:terminal"))
		id := it.ID
		if id == "" {
			id = fmt.Sprintf("%s|%s", it.Title, it.Subtitle)
		}
		it.ID = c.id + "#" + id
		it.Score = 1 - float64(i)*0.0001 // 保持脚本给的顺序
		if filter != nil && !filter.Empty() {
			r := match.Best(*filter, match.Prepare(it.Title), match.Prepare(it.Subtitle))
			if !r.OK || r.Score <= 0 {
				continue
			}
			it.Score, it.Highlights = r.Score, r.Positions
		}
		out = append(out, it)
	}
	if len(out) == 0 && req.Text == "" {
		return []core.Item{{ID: c.id + "#empty", Title: "没有结果", Subtitle: "脚本没有输出内容", Icon: iconOr(c.Icon, "svg:terminal"),
			Source: "scripts", Ephem: true, Score: 1,
			Actions: []core.Action{{Type: core.ActionFunc, Title: "返回", KeepOpen: true, Fn: func(context.Context, *core.Run) error { return nil }}}}}
	}
	return out
}

// templates 是「新建脚本」用的模板。
var templates = map[string]struct{ ext, body string }{
	"bash": {".sh", `#!/bin/bash
# @pocket.title %s
# @pocket.desc 一句话说明这个命令做什么
# @pocket.keywords %s
# @pocket.icon ⚡
# @pocket.mode toast

echo "你好，这是 %s"
`},
	"python": {".py", `#!/usr/bin/env python3
# @pocket.title %s
# @pocket.desc 一句话说明这个命令做什么
# @pocket.keywords %s
# @pocket.icon 🐍
# @pocket.mode list

import json

print(json.dumps({"items": [
    {"title": "%s", "subtitle": "回车复制标题"},
]}, ensure_ascii=False))
`},
	"node": {".js", `#!/usr/bin/env node
// @pocket.title %s
// @pocket.desc 一句话说明这个命令做什么
// @pocket.keywords %s
// @pocket.icon 🟩
// @pocket.mode text

console.log("你好，这是 %s");
`},
	"powershell": {".ps1", `# @pocket.title %s
# @pocket.desc 一句话说明这个命令做什么
# @pocket.keywords %s
# @pocket.icon 💠
# @pocket.mode toast

Write-Output "你好，这是 %s"
`},
}

// CreateCommand 从模板新建脚本，返回文件路径。
func (s *Scripts) CreateCommand(language, name string) (string, error) {
	tpl, ok := templates[language]
	if !ok {
		return "", fmt.Errorf("不支持的语言：%s", language)
	}
	title := strings.TrimSpace(name)
	file := strings.TrimLeft(strings.TrimSpace(badName.ReplaceAllString(title, "-")), ".")
	if file == "" {
		return "", fmt.Errorf("命令需要一个名字")
	}
	path := filepath.Join(s.Dir, file+tpl.ext)
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("已经有同名的文件了：%s", filepath.Base(path))
	}
	body := fmt.Sprintf(tpl.body, title, file, title)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		return "", err
	}
	s.Reload()
	return path, nil
}

// CatalogItems 实现 core.Lister。
func (s *Scripts) CatalogItems() []core.Item {
	s.mu.RLock()
	list := s.list
	s.mu.RUnlock()
	out := make([]core.Item, 0, len(list))
	for _, c := range list {
		it := s.item(c, "")
		it.Subtitle = c.Desc
		if len(c.Problems) > 0 {
			it.Subtitle = c.Problems[0]
		}
		out = append(out, it)
	}
	return out
}

// KeywordsOf 返回脚本的触发词。
func (s *Scripts) KeywordsOf(id string) []string {
	if c := s.find(id); c != nil {
		return c.Keywords
	}
	return nil
}
