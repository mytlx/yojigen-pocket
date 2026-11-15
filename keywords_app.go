package main

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"yojigen-pocket/internal/providers"
	"yojigen-pocket/internal/store"
)

// 关键词和前缀：用户可以改、可以给一项配多个；这里负责保存，并找出“同一个词被几项共用”的情况。

// KeywordConflict 是一个被别的项也用了的关键词。
type KeywordConflict struct {
	Keyword string   `json:"keyword"`
	With    []string `json:"with"` // 另外那几项的名字
}

// moduleMeta 是内置模块在道具库里的名字和图标。
var moduleMeta = map[string]struct{ title, icon string }{
	"apps": {"应用搜索", "svg:app"}, "files": {"文件搜索", "svg:file"}, "clipboard": {"剪贴板历史", "svg:clipboard"},
	"snippets": {"文本片段", "svg:snippet"}, "calc": {"计算器", "svg:calculator"}, "paths": {"路径浏览", "svg:folder"},
	"shell": {"命令行", "svg:terminal"}, "web": {"网页搜索", "svg:globe"}, "tools": {"快捷小工具", "svg:wrench"},
}

var moduleOrder = []string{"apps", "files", "clipboard", "snippets", "calc", "paths", "shell", "web", "tools"}

// customKeywords 实现 providers.CustomKeywords：查配置里有没有给这一项单独定关键词。
func (a *App) customKeywords(id string) ([]string, bool) {
	words, ok := a.config.Get().Keywords[id]
	return words, ok
}

type keywordOwner struct{ key, title string }

// keywordOwners 列出每个关键词（小写）都被谁用着。停用的项不算。
//
// 同一样东西的两个入口算一个：剪贴板历史既是内置模块（前缀 cb）又有功能页（关键词 cb），
// 它们本来就是一回事，不算冲突。
func (a *App) keywordOwners(cfg *store.Config) map[string][]keywordOwner {
	owners := map[string][]keywordOwner{}
	add := func(word, key, title string) {
		w := strings.ToLower(strings.TrimSpace(word))
		if w == "" {
			return
		}
		if slices.ContainsFunc(owners[w], func(o keywordOwner) bool { return o.key == key }) {
			return
		}
		owners[w] = append(owners[w], keywordOwner{key, title})
	}
	disabled := func(id string) bool { return slices.Contains(cfg.Disabled, id) }

	for _, id := range moduleOrder {
		if m := cfg.Modules[id]; m.Enabled {
			for _, p := range m.Prefixes() {
				add(p, "module:"+id, moduleMeta[id].title)
			}
		}
	}
	for _, it := range a.features.CatalogItems() {
		// 只算功能页。功能下的命令（“截图识别并复制”这些）的关键词只是帮助搜到它，
		// 不会因为完全对上就排到最前，和别人重了也不碍事。
		if disabled(it.ID) || a.features.Def(strings.TrimPrefix(it.ID, "features:")) == nil {
			continue
		}
		key := a.ownerKey(it.ID)
		for _, w := range a.features.KeywordsOf(it.ID) {
			add(w, key, it.Title)
		}
	}
	for _, it := range a.plugins.CatalogItems() {
		if disabled(it.ID) {
			continue
		}
		for _, w := range a.plugins.KeywordsOf(it.ID) {
			add(w, it.ID, it.Title)
		}
	}
	for _, it := range a.commands.CatalogItems() {
		if disabled(it.ID) {
			continue
		}
		for _, w := range a.commands.KeywordsOf(it.ID) {
			add(w, it.ID, it.Title)
		}
	}
	for _, e := range cfg.Web {
		add(e.Key, "web:"+e.Key, e.Title)
	}
	return owners
}

// ownerKey 把“功能页”和它对应的内置模块归成同一个主人。
func (a *App) ownerKey(id string) string {
	if d := a.features.Def(strings.TrimPrefix(id, "features:")); d != nil && d.Scope != nil {
		return "module:" + d.Scope.ID
	}
	return id
}

func conflictsOf(owners map[string][]keywordOwner, key string, words []string) []KeywordConflict {
	var out []KeywordConflict
	for _, w := range words {
		var with []string
		for _, o := range owners[strings.ToLower(strings.TrimSpace(w))] {
			if o.key != key {
				with = append(with, o.title)
			}
		}
		if len(with) > 0 {
			out = append(out, KeywordConflict{Keyword: w, With: with})
		}
	}
	return out
}

// cleanKeywords 整理用户填的关键词：去掉空白和重复的，检查写法。
func cleanKeywords(words []string) ([]string, error) {
	var out []string
	for _, w := range words {
		w = strings.TrimSpace(w)
		if w == "" {
			continue
		}
		if strings.IndexFunc(w, unicode.IsSpace) >= 0 {
			return nil, fmt.Errorf("关键词里不能有空格：%s", w)
		}
		if utf8.RuneCountInString(w) > 32 {
			return nil, fmt.Errorf("关键词太长了：%s", w)
		}
		if !slices.ContainsFunc(out, func(x string) bool { return strings.EqualFold(x, w) }) {
			out = append(out, w)
		}
	}
	if len(out) > 16 {
		return nil, errors.New("关键词最多 16 个")
	}
	return out, nil
}

func sameWords(a, b []string) bool {
	return slices.EqualFunc(a, b, func(x, y string) bool { return strings.EqualFold(x, y) })
}

// defaultKeywords 返回一项自带的关键词；第二个返回值表示这一项的关键词能不能在这里改。
func (a *App) defaultKeywords(id string) ([]string, bool) {
	switch {
	case strings.HasPrefix(id, "module:"):
		name := strings.TrimPrefix(id, "module:")
		if _, ok := moduleMeta[name]; !ok {
			return nil, false
		}
		return store.DefaultConfig().Modules[name].Prefixes(), true
	case strings.HasPrefix(id, "features:"):
		name := strings.TrimPrefix(id, "features:")
		if a.features.Def(name) == nil && !slices.ContainsFunc(a.features.Commands, func(c *providers.FeatureCommand) bool { return c.ID == name }) {
			return nil, false
		}
		return a.features.DefaultKeywordsOf(id), true
	case strings.HasPrefix(id, "plugins:"):
		rest := strings.TrimPrefix(id, "plugins:")
		plug, tool, _ := strings.Cut(rest, "/")
		if _, ok := a.plugins.ToolOf(plug, tool); !ok {
			return nil, false
		}
		return a.plugins.DefaultKeywordsOf(id), true
	}
	return nil, false
}

// setKeywords 保存一项的关键词（内置模块就是它的前缀）。reset 为 true 时恢复成自带的。
func (a *App) setKeywords(id string, words []string, reset bool) error {
	defaults, ok := a.defaultKeywords(id)
	if !ok {
		return errors.New("这一项的关键词不能在这里改")
	}
	if reset {
		words = defaults
	}
	words, err := cleanKeywords(words)
	if err != nil {
		return err
	}
	err = a.config.Update(func(cfg *store.Config) {
		if name, isModule := strings.CutPrefix(id, "module:"); isModule {
			m := cfg.Modules[name]
			m.Prefix = strings.Join(words, " ")
			cfg.Modules[name] = m
			return
		}
		// 和自带的一样就不用记：以后自带的关键词有变化时能跟着变。
		if sameWords(words, defaults) {
			delete(cfg.Keywords, id)
			return
		}
		if cfg.Keywords == nil {
			cfg.Keywords = map[string][]string{}
		}
		if words == nil {
			words = []string{} // 明确写成空列表：表示“不要关键词”，和“没改过”区分开
		}
		cfg.Keywords[id] = words
	})
	if err == nil {
		a.configApplied()
		ResultsChanged.Broadcast(struct{}{})
	}
	return err
}
