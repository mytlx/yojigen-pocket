package match

import (
	"fmt"
	"slices"
	"testing"
)

func score(q, text string) float64 {
	r := Prepare(text).Match(NewQuery(q))
	if !r.OK {
		return 0
	}
	return r.Score
}

func TestHits(t *testing.T) {
	cases := []struct{ q, text string }{
		{"微信", "微信"},
		{"weixin", "微信"},
		{"weix", "微信"},
		{"wx", "微信"},
		{"微x", "微信"},
		{"wei信", "微信"},
		{"vsc", "Visual Studio Code"},
		{"gpa", "git-pull-all"},
		{"gpa", "gitPullAll"},
		{"chrome", "Google Chrome"},
		{"CHROME", "google chrome"},
		{"ｃｈｒ", "Chrome"},
		{"vs code", "VSCode"},
		{"shezhi", "系统设置"},
		{"xtsz", "系统设置"},
		{"sz", "系统设置"},
		{"yinyue", "网易云音乐"},
		{"wyy", "网易云音乐"},
		{"chongqing", "重庆"}, // 多音字
		{"zhongqing", "重庆"},
	}
	for _, c := range cases {
		if score(c.q, c.text) == 0 {
			t.Errorf("%q 应命中 %q", c.q, c.text)
		}
	}
}

func TestMisses(t *testing.T) {
	cases := []struct{ q, text string }{
		{"xyz", "Chrome"},
		{"chromex", "Chrome"},
		{"wxx", "微信"},
		{"abc", "a very long title with b far far away and at last some c"},
	}
	for _, c := range cases {
		if s := score(c.q, c.text); s != 0 {
			t.Errorf("%q 不应命中 %q（得分 %.3f）", c.q, c.text, s)
		}
	}
}

// 档位顺序：完全相等 > 前缀 > 缩写 > 词首连续 > 连续 > 散落。
func TestTiers(t *testing.T) {
	order := []struct{ q, text string }{
		{"code", "code"},
		{"code", "Code Runner"},
		{"vsc", "Visual Studio Code"},
		{"code", "Visual Studio Code"},
		{"ode", "Visual Studio Code"},
		{"vsd", "Visual Studio Code"},
	}
	prev := 2.0
	for _, c := range order {
		s := score(c.q, c.text)
		if s == 0 || s >= prev {
			t.Errorf("%q / %q 得分 %.3f，应低于上一档 %.3f", c.q, c.text, s, prev)
		}
		prev = s
	}
}

func TestPositions(t *testing.T) {
	r := Prepare("Visual Studio Code").Match(NewQuery("vsc"))
	if !slices.Equal(r.Positions, []int{0, 7, 14}) {
		t.Errorf("缩写高亮位置不对：%v", r.Positions)
	}
	r = Prepare("微信").Match(NewQuery("wx"))
	if !slices.Equal(r.Positions, []int{0, 1}) {
		t.Errorf("拼音高亮位置不对：%v", r.Positions)
	}
	r = Prepare("Google Chrome").Match(NewQuery("chrome"))
	if !slices.Equal(r.Positions, []int{7, 8, 9, 10, 11, 12}) {
		t.Errorf("子串高亮位置不对：%v", r.Positions)
	}
}

func TestBestPrefersTitle(t *testing.T) {
	q := NewQuery("code")
	byTitle := Best(q, Prepare("code"))
	byKeyword := Best(q, Prepare("Visual Studio"), Prepare("code"))
	if byKeyword.Score >= byTitle.Score {
		t.Errorf("关键词命中应低于标题命中：%.3f >= %.3f", byKeyword.Score, byTitle.Score)
	}
	if byKeyword.Positions != nil {
		t.Errorf("关键词命中不应高亮标题")
	}
}

func BenchmarkMatch10k(b *testing.B) {
	targets := make([]*Target, 10000)
	for i := range targets {
		switch i % 3 {
		case 0:
			targets[i] = Prepare(fmt.Sprintf("Visual Studio Code %d", i))
		case 1:
			targets[i] = Prepare(fmt.Sprintf("网易云音乐播放器 %d", i))
		default:
			targets[i] = Prepare(fmt.Sprintf("git-pull-all-repositories-%d", i))
		}
	}
	q := NewQuery("wyy")
	for b.Loop() {
		for _, t := range targets {
			t.Match(q)
		}
	}
}
