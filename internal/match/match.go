// Package match 实现模糊匹配：子序列匹配 + 拼音（全拼、首字母、中英混合）+ 词首缩写。
//
// 每个候选文本预先 Prepare 成 Target（含拼音），之后每次输入只做一次小规模 DP。
// 匹配分被划入几个固定档位（完全相等 > 全覆盖 > 前缀 > 缩写 > 词首连续 > 连续 > 散落），
// 这样排序结果可预测，也方便写黄金测试。
package match

import (
	"sync"
	"unicode"

	"github.com/mozillazg/go-pinyin"
)

type token struct {
	r         rune     // 归一化后的字符
	alts      []string // 汉字的全部读音
	wordStart bool
}

// Target 是预处理后的候选文本。可并发只读使用。
type Target struct {
	tokens []token
	mask   uint64 // 文本（含拼音）中出现过的字符集合，用于快速排除
	norm   []rune
}

// Query 是预处理后的输入。
type Query struct {
	runes []rune
	mask  uint64
}

// Result 是一次匹配的结果。Positions 是命中字符在原文中的下标（按 rune）。
type Result struct {
	OK        bool
	Score     float64
	Positions []int
}

var pinyinArgs = func() pinyin.Args {
	a := pinyin.NewArgs()
	a.Style = pinyin.Normal
	a.Heteronym = true
	return a
}()

var pinyinCache sync.Map // rune -> []string

func readings(r rune) []string {
	if v, ok := pinyinCache.Load(r); ok {
		return v.([]string)
	}
	var out []string
	if unicode.Is(unicode.Han, r) {
		seen := map[string]bool{}
		for _, p := range pinyin.SinglePinyin(r, pinyinArgs) {
			if p != "" && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	pinyinCache.Store(r, out)
	return out
}

// normalize 把全角转半角，并转成小写。
func normalize(r rune) rune {
	switch {
	case r == 0x3000:
		r = ' '
	case r >= 0xFF01 && r <= 0xFF5E:
		r -= 0xFEE0
	}
	return unicode.ToLower(r)
}

func isSep(r rune) bool {
	switch r {
	case ' ', '\t', '-', '_', '.', '/', '\\', ':', ',', '(', ')', '[', ']', '+', '&', '|', '，', '。', '·', '、', '：':
		return true
	}
	return false
}

func maskBit(r rune) uint64 {
	switch {
	case r >= 'a' && r <= 'z':
		return 1 << uint(r-'a')
	case r >= '0' && r <= '9':
		return 1 << (26 + uint(r-'0'))
	case r < 128:
		return 1 << 36
	}
	// 其他字符散列到高位。
	return 1 << (37 + uint(r)%27)
}

// Prepare 预处理候选文本。
func Prepare(text string) *Target {
	raw := []rune(text)
	t := &Target{tokens: make([]token, len(raw)), norm: make([]rune, len(raw))}
	for i, r := range raw {
		n := normalize(r)
		tk := token{r: n}
		if alts := readings(r); len(alts) > 0 {
			tk.alts = alts
			tk.wordStart = true
			for _, a := range alts {
				for _, c := range a {
					t.mask |= maskBit(c)
				}
			}
		}
		switch {
		case i == 0:
			tk.wordStart = true
		case isSep(raw[i-1]) && !isSep(r):
			tk.wordStart = true
		case unicode.IsUpper(r) && unicode.IsLower(raw[i-1]):
			tk.wordStart = true
		case unicode.IsDigit(r) && !unicode.IsDigit(raw[i-1]):
			tk.wordStart = true
		case !unicode.Is(unicode.Han, r) && unicode.Is(unicode.Han, raw[i-1]):
			tk.wordStart = true
		}
		t.mask |= maskBit(n)
		t.tokens[i] = tk
		t.norm[i] = n
	}
	return t
}

// NewQuery 预处理输入。空白会被忽略，这样 "vs code" 能命中 "VSCode"。
func NewQuery(s string) Query {
	q := Query{}
	for _, r := range s {
		n := normalize(r)
		if n == ' ' || n == '\t' {
			continue
		}
		q.runes = append(q.runes, n)
		q.mask |= maskBit(n)
	}
	return q
}

// Empty 判断输入是否为空。
func (q Query) Empty() bool { return len(q.runes) == 0 }

const (
	scoreChar        = 1.0
	scoreSyllable    = 2.0 // 全拼每个字母的分值，鼓励完整音节
	bonusConsecutive = 0.6
	bonusWordStart   = 0.8
	bonusFirst       = 0.6
	gapLeading       = 0.03
	gapInner         = 0.05
	minScatter       = 0.25
)

// dpPool 复用 DP 缓冲，避免每个候选项都分配。
var dpPool = sync.Pool{New: func() any { return new(dpBuf) }}

type dpBuf struct {
	score []float32
	step  []int32 // 记录每个状态的选择，用于回溯命中位置
}

const unreachable = float32(-1e9)

// Match 对候选文本做匹配。
func (t *Target) Match(q Query) Result {
	if t == nil || q.Empty() || len(t.tokens) == 0 {
		return Result{}
	}
	if q.mask&^t.mask != 0 {
		return Result{}
	}
	n, m := len(q.runes), len(t.tokens)

	// 完全相等：直接最高分。
	if n == m {
		same := true
		for i := range q.runes {
			if q.runes[i] != t.norm[i] {
				same = false
				break
			}
		}
		if same {
			pos := make([]int, m)
			for i := range pos {
				pos[i] = i
			}
			return Result{OK: true, Score: 1, Positions: pos}
		}
	}

	buf := dpPool.Get().(*dpBuf)
	defer dpPool.Put(buf)
	size := (n + 1) * (m + 1) * 2
	if cap(buf.score) < size {
		buf.score = make([]float32, size)
		buf.step = make([]int32, size)
	}
	score, step := buf.score[:size], buf.step[:size]
	idx := func(i, j, c int) int { return ((i*(m+1) + j) * 2) + c }

	for j := m; j >= 0; j-- {
		for i := n; i >= 0; i-- {
			for c := 0; c <= 1; c++ {
				at := idx(i, j, c)
				if i == n {
					score[at], step[at] = 0, 0
					continue
				}
				if j == m {
					score[at], step[at] = unreachable, 0
					continue
				}
				tk := &t.tokens[j]
				best, bestStep := unreachable, int32(0)

				// 跳过这个字符。
				if s := score[idx(i, j+1, 0)]; s > unreachable/2 {
					gap := float32(gapInner)
					if i == 0 {
						gap = gapLeading
					}
					if s-gap > best {
						best, bestStep = s-gap, 0
					}
				}
				bonus := float32(0)
				if tk.wordStart {
					bonus += bonusWordStart
				}
				if j == 0 {
					bonus += bonusFirst
				}
				if c == 1 {
					bonus += bonusConsecutive
				}
				// 字面匹配。
				if tk.r == q.runes[i] {
					if s := score[idx(i+1, j+1, 1)]; s > unreachable/2 {
						if v := s + scoreChar + bonus; v > best {
							best, bestStep = v, 1
						}
					}
				}
				// 拼音匹配：消耗 k 个输入字符。
				for _, alt := range tk.alts {
					l := 0
					for l < len(alt) && i+l < n && rune(alt[l]) == q.runes[i+l] {
						l++
					}
					if l == 0 {
						continue
					}
					try := func(k int, per float32) {
						if s := score[idx(i+k, j+1, 1)]; s > unreachable/2 {
							if v := s + float32(k)*per + bonus; v > best {
								best, bestStep = v, int32(k)
							}
						}
					}
					try(1, scoreChar) // 首字母
					if l == len(alt) {
						try(l, scoreSyllable) // 完整音节
					} else if i+l == n {
						try(l, scoreSyllable) // 输入到此结束，允许半个音节（weix → 微信）
					}
				}
				score[at], step[at] = best, bestStep
			}
		}
	}

	raw := score[idx(0, 0, 0)]
	if raw <= unreachable/2 {
		return Result{}
	}
	// 回溯命中位置。
	var pos []int
	for i, j, c := 0, 0, 0; i < n && j < m; {
		k := step[idx(i, j, c)]
		if k == 0 {
			j++
			c = 0
			continue
		}
		pos = append(pos, j)
		i += int(k)
		j++
		c = 1
	}
	return Result{OK: true, Score: t.classify(n, float64(raw), pos), Positions: pos}
}

// classify 把 DP 结果归入固定档位。
func (t *Target) classify(n int, raw float64, pos []int) float64 {
	if len(pos) == 0 {
		return 0
	}
	m := len(t.tokens)
	maxRaw := float64(n)*(scoreChar+bonusConsecutive+bonusWordStart) + bonusFirst
	dp := raw / maxRaw
	if dp > 1 {
		dp = 1
	}
	if dp < 0 {
		dp = 0
	}
	coverage := float64(len(pos)) / float64(m)
	contiguous := true
	for i := 1; i < len(pos); i++ {
		if pos[i] != pos[i-1]+1 {
			contiguous = false
			break
		}
	}
	first := pos[0]
	acronym := true
	matched := make(map[int]bool, len(pos))
	for _, p := range pos {
		matched[p] = true
		if !t.tokens[p].wordStart {
			acronym = false
		}
	}
	if acronym {
		for j := first; j <= pos[len(pos)-1]; j++ {
			if t.tokens[j].wordStart && !matched[j] {
				acronym = false
				break
			}
		}
	}
	switch {
	case contiguous && first == 0 && len(pos) == m:
		return 0.97 + 0.02*dp
	case contiguous && first == 0:
		return 0.90 + 0.05*coverage
	case acronym && first == 0:
		return 0.86 + 0.03*coverage
	case contiguous && t.tokens[first].wordStart:
		return 0.78 + 0.05*coverage
	case acronym:
		return 0.74 + 0.03*coverage
	case contiguous:
		return 0.68 + 0.05*coverage
	}
	// 散落匹配：跨度太大基本是巧合，直接丢弃，避免结果里全是噪音。
	span := pos[len(pos)-1] - first + 1
	if dp < minScatter || span > max(8, n*4) {
		return 0
	}
	return 0.25 + 0.4*dp
}

// Best 对标题和关键词一起匹配，返回最好的结果。
// 只有标题命中时才带高亮位置；关键词命中略微降权。
func Best(q Query, title *Target, keywords ...*Target) Result {
	best := Result{}
	if title != nil {
		if r := title.Match(q); r.OK && r.Score > 0 {
			best = r
		}
	}
	for _, kw := range keywords {
		if r := kw.Match(q); r.OK && r.Score > 0 {
			if s := r.Score * 0.94; s > best.Score {
				best = Result{OK: true, Score: s}
			}
		}
	}
	return best
}
