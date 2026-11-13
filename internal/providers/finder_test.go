package providers

import (
	"testing"
)

func TestFindHelpers(t *testing.T) {
	if got := queryTokens(`报告 "季度 总结" *.pdf`); len(got) != 3 || got[1] != "季度 总结" {
		t.Errorf("拆词：%q", got)
	}
	cases := []struct {
		pattern, name string
		want          bool
	}{
		{"报告", "年度报告.docx", true},
		{"*.PDF", "a.pdf", true},
		{"a?.txt", "ab.txt", true},
		{"a?.txt", "abc.txt", false},
		{"*.pdf", "a.pdf.bak", false},
	}
	for _, c := range cases {
		if got := globMatch(c.pattern, c.name); got != c.want {
			t.Errorf("globMatch(%q, %q) = %v", c.pattern, c.name, got)
		}
	}
	if e := KindExts("image"); len(e) < 8 || KindExts("folder") != nil {
		t.Errorf("类型的扩展名：%v", e)
	}
}
