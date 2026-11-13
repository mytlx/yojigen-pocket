package platform

import "testing"

func TestAppNames(t *testing.T) {
	zh, en := AppNames("/System/Applications/Clock.app")
	if zh != "时钟" || en != "Clock" {
		t.Fatalf("Clock.app：得到 %q / %q", zh, en)
	}
	if zh, en := AppNames("/不存在.app"); zh != "" || en != "" {
		t.Fatalf("不存在的应用应该返回空，得到 %q / %q", zh, en)
	}
}
