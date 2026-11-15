package providers

import (
	"strings"
	"sync"

	"yojigen-pocket/internal/match"
)

// CustomKeywords 查一项（features:json、plugins:editors/notes…）有没有用户自己定的关键词。
// 第二个返回值为 false 表示没改过，用默认的。改过但是空列表表示“不要关键词，只按名字找”。
type CustomKeywords func(itemID string) ([]string, bool)

// keywordSet 把关键词列表连同它们的匹配器一起缓存：关键词是用户可以改的，
// 不能像以前那样在启动时准备一次就一直用。
type keywordSet struct {
	cache sync.Map // 关键词连起来的字符串 → []*match.Target
}

func (s *keywordSet) targets(words []string) []*match.Target {
	if len(words) == 0 {
		return nil
	}
	key := strings.Join(words, "\x00")
	if v, ok := s.cache.Load(key); ok {
		return v.([]*match.Target)
	}
	out := make([]*match.Target, 0, len(words))
	for _, w := range words {
		out = append(out, match.Prepare(w))
	}
	s.cache.Store(key, out)
	return out
}

// effective 返回一项实际生效的关键词。
func effective(custom CustomKeywords, itemID string, defaults []string) []string {
	if custom != nil {
		if words, ok := custom(itemID); ok {
			return words
		}
	}
	return defaults
}

func hasKeyword(words []string, first string) bool {
	if first == "" {
		return false
	}
	for _, w := range words {
		if strings.EqualFold(w, first) {
			return true
		}
	}
	return false
}
