package core

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/store"
)

// Batch 是一轮查询的一批结果。每批都是合并、排序后的完整列表。
type Batch struct {
	Mode  string `json:"mode"` // home | results
	Items []Item `json:"items"`
	Done  bool   `json:"done"`
	Error string `json:"error,omitempty"` // 配置文件错误等
}

// QueryRequest 是界面发来的查询。
type QueryRequest struct {
	Text      string `json:"text"`
	Scope     string `json:"scope,omitempty"`
	PayloadID string `json:"payload,omitempty"` // 带入内容的编号，内容本身留在后端

	Payload *Payload `json:"-"`
}

// ExecRequest 是界面发来的执行请求。
type ExecRequest struct {
	Item      string            `json:"item"`
	Action    int               `json:"action"`
	Query     string            `json:"query,omitempty"`
	Args      map[string]string `json:"args,omitempty"`
	Confirmed bool              `json:"confirmed,omitempty"`
}

// Engine 负责查询路由、结果合并排序，以及动作执行。
type Engine struct {
	host      Host
	config    *store.ConfigStore
	usage     *store.Usage
	providers []Provider

	regMu    sync.RWMutex
	registry map[string]Item

	context atomic.Pointer[Context]

	// IconURL 把本地文件转成界面能加载的地址。kind 是 file（系统图标）或 image（图片本身）。
	IconURL func(kind, path string) string
}

const registryLimit = 5000

// NewEngine 创建引擎。
func NewEngine(host Host, config *store.ConfigStore, usage *store.Usage, providers ...Provider) *Engine {
	e := &Engine{host: host, config: config, usage: usage, providers: providers, registry: map[string]Item{}}
	e.context.Store(&Context{})
	return e
}

// Usage 返回使用记录。
func (e *Engine) Usage() *store.Usage { return e.usage }

// Providers 返回全部数据源。
func (e *Engine) Providers() []Provider { return e.providers }

// SetContext 更新唤出时抓取的上下文。
func (e *Engine) SetContext(c Context) { e.context.Store(&c) }

// Context 返回当前上下文。
func (e *Engine) Context() Context { return *e.context.Load() }

// provider 返回 ID 对应的数据源。
func (e *Engine) provider(id string) Provider {
	for _, p := range e.providers {
		if p.Info().ID == id {
			return p
		}
	}
	return nil
}

func splitFirst(text string) (first, rest string) {
	text = strings.TrimSpace(text)
	i := strings.IndexFunc(text, unicode.IsSpace)
	if i < 0 {
		return text, ""
	}
	return text[:i], strings.TrimSpace(text[i:])
}

func newRequest(text, scope string, scoped bool, c Context) *Request {
	first, rest := splitFirst(text)
	return &Request{Text: text, Query: match.NewQuery(text), First: first, Rest: rest, Scope: scope, Scoped: scoped, Context: c}
}

// route 决定这次查询由哪些数据源处理。
func (e *Engine) route(cfg *store.Config, q QueryRequest) ([]Provider, *Request) {
	c := e.Context()
	if q.Scope != "" {
		id, _, _ := strings.Cut(q.Scope, ":")
		if p := e.provider(id); p != nil {
			return []Provider{p}, newRequest(q.Text, q.Scope, true, c)
		}
		return nil, newRequest(q.Text, q.Scope, true, c)
	}
	text := strings.TrimLeft(q.Text, " \t　")
	// 前缀模式：符号前缀不需要空格（=1+1），字母前缀需要空格（f 报告）。
	for _, p := range e.providers {
		info := p.Info()
		m, ok := cfg.Modules[info.ID]
		if !ok || !m.Enabled || m.Prefix == "" {
			continue
		}
		symbol := !unicode.IsLetter([]rune(m.Prefix)[0])
		switch {
		case symbol && strings.HasPrefix(text, m.Prefix):
			rest := strings.TrimLeft(text[len(m.Prefix):], " ")
			return []Provider{p}, newRequest(rest, "", true, c)
		case strings.HasPrefix(text, m.Prefix+" "):
			rest := strings.TrimLeft(text[len(m.Prefix):], " ")
			return []Provider{p}, newRequest(rest, "", true, c)
		}
	}
	var out []Provider
	for _, p := range e.providers {
		if m, ok := cfg.Modules[p.Info().ID]; ok && m.Enabled && m.Global {
			out = append(out, p)
		}
	}
	return out, newRequest(text, "", false, c)
}

// Query 执行一轮查询：先出本地数据源的结果，外部数据源的结果到一批合并一批。
func (e *Engine) Query(ctx context.Context, q QueryRequest, emit func(Batch) error) error {
	cfg := e.config.Get()
	loadErr := e.config.LoadError()
	if q.Scope == "" && q.Payload != nil {
		return e.queryPayload(ctx, cfg, q, loadErr, emit)
	}
	if q.Scope == "" && strings.TrimSpace(q.Text) == "" {
		items := e.home(cfg)
		e.register(items)
		return emit(Batch{Mode: "home", Items: e.forUI(items), Done: true, Error: loadErr})
	}

	providers, req := e.route(cfg, q)
	return e.run(ctx, cfg, providers, req, q.Scope, loadErr, nil, emit)
}

// queryPayload 处理带入了一块内容的查询。
//
// 块后面没有输入时：短文字照常当搜索词匹配应用、文件等（复制了文件名，就能看到这个文件），
// 再加上「能处理这块内容的功能」；网页搜索仍在最后。
// 块后面有输入时：输入的是功能名，只列出能处理这块内容的功能。
func (e *Engine) queryPayload(ctx context.Context, cfg *store.Config, q QueryRequest, loadErr string, emit func(Batch) error) error {
	p := q.Payload
	typed := strings.TrimSpace(q.Text)
	c := e.Context()
	req := newRequest(typed, "", false, c)

	var actions []Item
	for _, prov := range e.providers {
		pp, ok := prov.(PayloadProvider)
		if !ok {
			continue
		}
		if m, ok := cfg.Modules[prov.Info().ID]; !ok || !m.Enabled {
			continue
		}
		actions = append(actions, pp.SearchPayload(ctx, req, p)...)
	}

	if typed != "" {
		items := e.rank(cfg, req, actions)
		e.register(items)
		return emit(Batch{Mode: "results", Items: e.forUI(items), Done: true, Error: loadErr})
	}

	// 常用的功能稍微靠前。
	for i := range actions {
		if !actions[i].Ephem {
			actions[i].Score += e.usage.Boost("", actions[i].ID, cfg.HalfLifeDays)
		}
	}
	slices.SortStableFunc(actions, func(a, b Item) int {
		switch {
		case a.Score > b.Score:
			return -1
		case a.Score < b.Score:
			return 1
		}
		return 0
	})
	disabled := map[string]bool{}
	for _, id := range cfg.Disabled {
		disabled[id] = true
	}
	taken := map[string]bool{}
	decorated := make([]Item, 0, len(actions))
	for _, it := range actions {
		if disabled[it.ID] || taken[it.ID] {
			continue
		}
		taken[it.ID] = true
		it.Pinned = !it.Ephem && e.usage.IsPinned(it.ID)
		decorated = append(decorated, e.decorate(cfg, it))
	}
	compose := func(recognized []Item) []Item {
		out := make([]Item, 0, len(recognized)+len(decorated))
		var bottom []Item
		for _, it := range recognized {
			switch {
			case taken[it.ID]: // 同一个功能，保留带着内容的那一条
			case it.Bottom:
				bottom = append(bottom, it)
			default:
				out = append(out, it)
			}
		}
		out = append(out, decorated...)
		return append(out, bottom...)
	}

	text := p.QueryText()
	if text == "" {
		items := compose(nil)
		e.register(items)
		return emit(Batch{Mode: "results", Items: e.forUI(items), Done: true, Error: loadErr})
	}
	// 短文字：所有全局数据源都参与；长文字或多行文字：只留网页搜索。
	var providers []Provider
	for _, prov := range e.providers {
		id := prov.Info().ID
		m, ok := cfg.Modules[id]
		if !ok || !m.Enabled || !m.Global {
			continue
		}
		if p.Short() || id == "web" {
			providers = append(providers, prov)
		}
	}
	return e.run(ctx, cfg, providers, newRequest(text, "", false, c), "", loadErr, compose, emit)
}

// run 执行查询：先出本地数据源的结果，外部数据源的结果到一批合并一批。
// post 不为空时，对排好序的结果再加工一次。
func (e *Engine) run(ctx context.Context, cfg *store.Config, providers []Provider, req *Request, scope, loadErr string, post func([]Item) []Item, emit func(Batch) error) error {
	var local, async []Provider
	for _, p := range providers {
		if isAsync(p, scope) {
			async = append(async, p)
		} else {
			local = append(local, p)
		}
	}

	var (
		mu  sync.Mutex
		all []Item
	)
	collect := func(p Provider) {
		items := p.Search(ctx, req)
		mu.Lock()
		all = append(all, items...)
		mu.Unlock()
	}
	var wg sync.WaitGroup
	for _, p := range local {
		wg.Go(func() { collect(p) })
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil
	}

	// 全局搜索时，作用域型数据源（如剪贴板）给一个入口。
	if !req.Scoped {
		all = append(all, e.entrances(cfg, req)...)
	}

	flush := func(done bool) error {
		mu.Lock()
		snapshot := slices.Clone(all)
		mu.Unlock()
		items := e.rank(cfg, req, snapshot)
		if post != nil {
			items = post(items)
		}
		e.register(items)
		return emit(Batch{Mode: "results", Items: e.forUI(items), Done: done, Error: loadErr})
	}
	if err := flush(len(async) == 0); err != nil || len(async) == 0 {
		return err
	}

	results := make(chan struct{}, len(async))
	for _, p := range async {
		go func() {
			defer func() { results <- struct{}{} }()
			delay := p.Info().Delay
			if s, ok := p.(AsyncScoper); ok && scope != "" {
				if d, ok := s.ScopeDelay(scope); ok {
					delay = d
				}
			}
			if delay > 0 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(delay):
				}
			}
			collect(p)
		}()
	}
	for range async {
		select {
		case <-ctx.Done():
			return nil
		case <-results:
		}
		if err := flush(false); err != nil {
			return err
		}
	}
	return flush(true)
}

func isAsync(p Provider, scope string) bool {
	if s, ok := p.(AsyncScoper); ok && scope != "" {
		if _, ok := s.ScopeDelay(scope); ok {
			return true
		}
	}
	return p.Info().Async
}

// entrances 生成作用域型数据源的入口项。
func (e *Engine) entrances(cfg *store.Config, req *Request) []Item {
	var out []Item
	for _, p := range e.providers {
		en, ok := p.(Entrance)
		if !ok {
			continue
		}
		if m, ok := cfg.Modules[p.Info().ID]; !ok || !m.Enabled {
			continue
		}
		if it, ok := EntranceItem(p, en.Entrance()); ok {
			if r := match.Prepare(it.Title).Match(req.Query); r.OK && r.Score > 0 {
				it.Score, it.Highlights = r.Score, r.Positions
				out = append(out, it)
			}
		}
	}
	return out
}

// EntranceItem 构造作用域入口项。
func EntranceItem(p Provider, s Scope) (Item, bool) {
	info := p.Info()
	sc := s
	return Item{
		ID:          "scope:" + s.ID,
		Title:       s.Title,
		Subtitle:    info.Title,
		Icon:        s.Icon,
		Source:      info.ID,
		SourceLabel: info.Title,
		Scope:       &sc,
		Actions:     []Action{{Type: ActionScope, Title: "打开", Scope: &sc}},
		Dedup:       "scope:" + s.ID,
	}, true
}

// rank 打分、去重、排序。
// sourceBias 是同等匹配程度下的先后：找应用是最常见的用途，名字同样对得上时应用排在命令前面。
// 它比匹配档位之间的差距小，所以“完全匹配的命令”仍然排在“只是沾边的应用”前面。
var sourceBias = map[string]float64{"apps": 0.06}

func (e *Engine) rank(cfg *store.Config, req *Request, items []Item) []Item {
	disabled := map[string]bool{}
	for _, id := range cfg.Disabled {
		disabled[id] = true
	}
	type scored struct {
		item  Item
		score float64
	}
	byDedup := map[string]int{}
	out := make([]scored, 0, len(items))
	for _, it := range items {
		if disabled[it.ID] {
			continue
		}
		weight := 1.0
		if m, ok := cfg.Modules[it.Source]; ok && m.Weight > 0 {
			weight = m.Weight
		}
		s := it.Score*weight + sourceBias[it.Source]
		if !it.Ephem && !req.Scoped {
			s += e.usage.Boost(req.Text, it.ID, cfg.HalfLifeDays)
		}
		it.Pinned = !it.Ephem && e.usage.IsPinned(it.ID)
		if it.Pinned {
			s += 0.2
		}
		if it.Exact {
			s += 10
		}
		if it.Bottom {
			s = -1 + it.Score*0.1
		}
		if it.Dedup != "" {
			if i, ok := byDedup[it.Dedup]; ok {
				if out[i].score >= s {
					continue
				}
				out[i] = scored{it, s}
				continue
			}
			byDedup[it.Dedup] = len(out)
		}
		out = append(out, scored{it, s})
	}
	slices.SortStableFunc(out, func(a, b scored) int {
		switch {
		case a.score > b.score:
			return -1
		case a.score < b.score:
			return 1
		}
		return strings.Compare(a.item.Title, b.item.Title)
	})
	limit := cfg.MaxResults
	if req.Scoped {
		limit = max(limit, 300) // 进入作用域后是在浏览，不必截得太短
	}
	if len(out) > limit {
		out = out[:limit]
	}
	result := make([]Item, len(out))
	for i, s := range out {
		result[i] = e.decorate(cfg, s.item)
	}
	return result
}

const homeSize = 16

// home 生成首页：置顶在前，其后是最常用的。
func (e *Engine) home(cfg *store.Config) []Item {
	seen := map[string]bool{}
	var out []Item
	add := func(en store.Entry, pinned bool) {
		if seen[en.ID] || len(out) >= homeSize || slices.Contains(cfg.Disabled, en.ID) {
			return
		}
		it, ok := e.resolve(en.ID)
		if !ok {
			return
		}
		seen[en.ID] = true
		it.Pinned = pinned
		out = append(out, e.decorate(cfg, it))
	}
	for _, en := range e.usage.Pins() {
		add(en, true)
	}
	for _, en := range e.usage.Top(homeSize*2, cfg.HalfLifeDays) {
		add(en, false)
	}
	// 第一次使用时给一组常用入口，不至于空荡荡。
	if len(out) < 8 {
		for _, id := range []string{"scope:clipboard", "self:settings", "self:new-command", "self:open-home", "scope:snippets"} {
			add(store.Entry{ID: id}, false)
		}
	}
	return out
}

// resolve 按 ID 找回结果项：先查注册表，再问数据源。
func (e *Engine) resolve(id string) (Item, bool) {
	if strings.HasPrefix(id, "scope:") {
		scope := strings.TrimPrefix(id, "scope:")
		pid, _, _ := strings.Cut(scope, ":")
		if p := e.provider(pid); p != nil {
			if en, ok := p.(Entrance); ok {
				if it, ok := EntranceItem(p, en.Entrance()); ok {
					return it, true
				}
			}
		}
	}
	pid, _, _ := strings.Cut(id, ":")
	for _, p := range e.providers {
		if p.Info().ID != pid {
			continue
		}
		if r, ok := p.(Resolver); ok {
			if it, ok := r.Resolve(id); ok {
				return it, true
			}
		}
	}
	e.regMu.RLock()
	it, ok := e.registry[id]
	e.regMu.RUnlock()
	return it, ok
}

// Resolve 对外暴露 resolve，附带通用动作。
func (e *Engine) Resolve(id string) (Item, bool) {
	it, ok := e.resolve(id)
	if !ok {
		return Item{}, false
	}
	return e.decorate(e.config.Get(), it), true
}

// decorate 给结果项补上通用动作和热键信息。
func (e *Engine) decorate(cfg *store.Config, it Item) Item {
	if it.SourceLabel == "" {
		if p := e.provider(it.Source); p != nil {
			it.SourceLabel = p.Info().Title
		}
	}
	if hk, ok := cfg.Hotkeys[it.ID]; ok && hk != "" {
		it.Hotkey = hk
	}
	rawIcon := it.Icon
	it.Icon = e.NormalizeIcon(it.Icon)
	if it.Scope != nil {
		scope := *it.Scope
		scope.Icon = e.NormalizeIcon(scope.Icon)
		it.Scope = &scope
	}
	actions := slices.Clone(it.Actions)
	for i := range actions {
		if actions[i].Scope != nil {
			scope := *actions[i].Scope
			scope.Icon = e.NormalizeIcon(scope.Icon)
			actions[i].Scope = &scope
		}
	}
	if it.Path != "" {
		path := it.Path
		actions = append(actions, Action{Type: ActionFunc, Title: "编辑源文件", Shortcut: "mod+e", KeepOpen: false,
			Fn: func(_ context.Context, r *Run) error {
				r.Host.HidePanel()
				return r.Host.EditFile(path)
			}})
	}
	if !it.Ephem {
		id := it.ID
		pinned := e.usage.IsPinned(id)
		title := "固定到首页"
		if pinned {
			title = "取消固定"
		}
		snapshot := store.Entry{ID: it.ID, Title: it.Title, Subtitle: it.Subtitle, Icon: rawIcon, Source: it.Source}
		actions = append(actions, Action{Type: ActionFunc, Title: title, Shortcut: "mod+shift+p", KeepOpen: true,
			Fn: func(_ context.Context, r *Run) error {
				if r.Engine.usage.TogglePin(snapshot) {
					r.Toast("已固定到首页")
				} else {
					r.Toast("已取消固定")
				}
				r.Refresh()
				return nil
			}})
		actions = append(actions, Action{Type: ActionFunc, Title: "设置快捷键…", KeepOpen: false,
			Fn: func(_ context.Context, r *Run) error {
				r.Host.HidePanel()
				r.Host.OpenSettings("commands", id)
				return nil
			}})
		if it.Source != "self" {
			actions = append(actions, Action{Type: ActionFunc, Title: "隐藏这一项", KeepOpen: true,
				Confirm: "隐藏后不再出现在搜索结果中，可在设置 → 指令里恢复。",
				Fn: func(_ context.Context, r *Run) error {
					err := r.Engine.config.Update(func(c *store.Config) {
						if !slices.Contains(c.Disabled, id) {
							c.Disabled = append(c.Disabled, id)
						}
					})
					if err != nil {
						return err
					}
					r.Refresh()
					return nil
				}})
		}
	}
	actions = append(actions, Action{Type: ActionCopy, Title: "复制标题", Text: it.Title, KeepOpen: true})
	it.Actions = actions
	return it
}

func (e *Engine) register(items []Item) {
	e.regMu.Lock()
	defer e.regMu.Unlock()
	if len(e.registry)+len(items) > registryLimit {
		e.registry = make(map[string]Item, len(items))
	}
	for _, it := range items {
		e.registry[it.ID] = it
	}
}

// Execute 执行一个动作，过程中的事件通过 emit 回传。
func (e *Engine) Execute(ctx context.Context, req ExecRequest, emit func(ExecEvent)) error {
	e.regMu.RLock()
	it, ok := e.registry[req.Item]
	e.regMu.RUnlock()
	if !ok {
		if it, ok = e.Resolve(req.Item); !ok {
			return fmt.Errorf("找不到这一项：%s", req.Item)
		}
	}
	if req.Action < 0 || req.Action >= len(it.Actions) {
		return errors.New("这一项没有对应的动作")
	}
	act := it.Actions[req.Action]
	if act.Confirm != "" && !req.Confirmed {
		emit(ExecEvent{Kind: "confirm", Text: act.Confirm})
		return nil
	}
	if !it.Ephem && req.Action == 0 {
		e.usage.Record(req.Query, store.Entry{ID: it.ID, Title: it.Title, Subtitle: it.Subtitle, Icon: it.Icon, Source: it.Source})
	}
	r := &Run{Item: it, Action: act, Query: req.Query, Args: req.Args, Host: e.host, Engine: e, emit: emit, keepOpen: act.KeepOpen}
	err := e.perform(ctx, r)
	if err == nil && !r.keepOpen {
		r.Hide()
	}
	return err
}

// ExecuteByID 以默认动作执行一个命令（直达热键、URI 等入口）。
func (e *Engine) ExecuteByID(ctx context.Context, id string, emit func(ExecEvent)) error {
	it, ok := e.Resolve(id)
	if !ok {
		return fmt.Errorf("找不到命令：%s", id)
	}
	e.register([]Item{it})
	return e.Execute(ctx, ExecRequest{Item: id, Action: 0, Confirmed: true}, emit)
}

func (e *Engine) perform(ctx context.Context, r *Run) error {
	a, h := r.Action, r.Host
	switch a.Type {
	case ActionOpen:
		return h.OpenTarget(a.Target)
	case ActionReveal:
		h.Reveal(a.Target)
	case ActionCopy:
		switch {
		case a.Image != "":
			return h.CopyImageFile(a.Image)
		case len(a.Files) > 0:
			return h.CopyFiles(a.Files)
		default:
			h.CopyText(a.Text)
		}
		if a.KeepOpen {
			r.Toast("已复制")
		}
	case ActionPaste:
		if a.Image != "" {
			if err := h.CopyImageFile(a.Image); err != nil {
				return err
			}
		} else if len(a.Files) > 0 {
			if err := h.CopyFiles(a.Files); err != nil {
				return err
			}
		} else {
			h.CopyText(a.Text)
		}
		r.Hide()
		if err := h.PasteToFront(); err != nil {
			h.Notify("已复制到剪贴板", "无法自动粘贴："+err.Error())
		}
	case ActionTyping:
		r.Hide()
		return h.TypeToFront(a.Text)
	case ActionRun:
		return e.ExecuteByID(ctx, a.Command, r.emit)
	case ActionView:
		if a.View != nil {
			r.Show(a.View)
		}
	case ActionNotify:
		h.Notify(a.Title, a.Text)
	case ActionScope:
		if a.Scope != nil {
			r.EnterScope(a.Scope)
		}
	case ActionFunc:
		if a.Fn != nil {
			return a.Fn(ctx, r)
		}
	case ActionShell:
		if a.Command == "" {
			return errors.New("shell 动作需要命令行")
		}
		cmd := platform.ShellCommand(context.WithoutCancel(ctx), a.Command)
		cmd.Dir = platform.ExpandHome(a.Cwd)
		r.Hide()
		go func() {
			if out, err := cmd.CombinedOutput(); err != nil {
				h.Notify("命令执行失败", firstLine(string(out), err.Error()))
			}
		}()
	default:
		return fmt.Errorf("不支持的动作类型：%s", a.Type)
	}
	return nil
}

func firstLine(s, fallback string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return fallback
	}
	line, _, _ := strings.Cut(s, "\n")
	return line
}

// NormalizeIcon 把各种写法的图标统一成界面能识别的形式：svg:名称、text:字符，或一个地址。
func (e *Engine) NormalizeIcon(icon string) string {
	switch {
	case icon == "":
		return ""
	case strings.HasPrefix(icon, "svg:"), strings.HasPrefix(icon, "text:"),
		strings.HasPrefix(icon, "http:"), strings.HasPrefix(icon, "https:"),
		strings.HasPrefix(icon, "data:"), strings.HasPrefix(icon, "pocketicon:"):
		return icon
	case strings.HasPrefix(icon, "file:") && e.IconURL != nil:
		return e.IconURL("file", strings.TrimPrefix(icon, "file:"))
	case strings.HasPrefix(icon, "image:") && e.IconURL != nil:
		return e.IconURL("image", platform.ExpandHome(strings.TrimPrefix(icon, "image:")))
	}
	if isImagePath(icon) && e.IconURL != nil {
		return e.IconURL("image", platform.ExpandHome(icon))
	}
	return "text:" + icon
}

func isImagePath(s string) bool {
	if !strings.ContainsAny(s, `/\\`) {
		return false
	}
	lower := strings.ToLower(s)
	for _, ext := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".icns"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

const maxPreviewText = 4000

// forUI 生成发给界面的副本：完整内容留在后端，界面只需要显示用的字段。
// 这样一次查询不会把上千条剪贴板的全文都序列化一遍，动作也只能由后端按 ID 执行。
func (e *Engine) forUI(items []Item) []Item {
	out := make([]Item, len(items))
	for i, it := range items {
		actions := make([]Action, len(it.Actions))
		for j, a := range it.Actions {
			actions[j] = Action{Type: a.Type, Title: a.Title, Shortcut: a.Shortcut}
		}
		it.Actions = actions
		if it.Preview != nil {
			p := *it.Preview
			if p.URL != "" {
				p.URL = e.NormalizeIcon(p.URL)
			}
			if r := []rune(p.Text); len(r) > maxPreviewText && p.Type != "file" {
				p.Text = string(r[:maxPreviewText]) + "…"
			}
			it.Preview = &p
		}
		out[i] = it
	}
	return out
}
