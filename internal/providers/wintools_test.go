package providers

import (
	"testing"
)

func TestWinToolsFind(t *testing.T) {
	w := NewWinTools()
	first := func(q string) string {
		r := w.Find(q)
		if len(r) == 0 {
			return ""
		}
		return r[0].Name
	}
	for q, want := range map[string]string{
		"services":  "services.msc", // 原名
		"服务":        "services.msc", // 中文名
		"fw":        "services.msc", // 拼音首字母
		"sysdm":     "sysdm.cpl",
		"环境变量":      "环境变量",
		"compmgmt":  "compmgmt.msc",
		"main.cpl":  "main.cpl",
		"zhucebiao": "regedit", // 全拼
	} {
		if got := first(q); got != want {
			t.Errorf("搜 %q：第一个是 %q，应为 %q", q, got, want)
		}
	}
	// 说明里的词也搜得到，但排在名字命中的后面。
	if r := w.Find("分区"); len(r) == 0 || r[0].Name != "diskmgmt.msc" {
		t.Errorf("按说明搜“分区”应该找到磁盘管理：%v", r)
	}
	if n := len(w.Find("")); n < 60 {
		t.Errorf("不输入时应该列出全部，只有 %d 个", n)
	}
	names := map[string]bool{}
	for _, tool := range w.Find("") {
		if names[tool.Name] {
			t.Errorf("重复的名字：%s", tool.Name)
		}
		names[tool.Name] = true
	}
}
