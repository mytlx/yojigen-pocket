package tts

import (
	"strings"
	"testing"
	"time"
)

func TestIsWord(t *testing.T) {
	for text, want := range map[string]bool{"make": true, "well-known": true, "don't": true, " hello ": true, "make it": false, "你好": false, "abc123": false, "": false} {
		if got := IsWord(text); got != want {
			t.Errorf("IsWord(%q) = %v，应为 %v", text, got, want)
		}
	}
}

func TestSplitText(t *testing.T) {
	text := strings.Repeat("这是一句话。", 400) // 每句 18 字节
	parts := splitText(text, 1800)
	if len(parts) < 4 {
		t.Fatalf("应该切成多段，得到 %d 段", len(parts))
	}
	for _, p := range parts {
		if len(p) > 1800 {
			t.Fatalf("有一段超长：%d 字节", len(p))
		}
	}
	if strings.Join(parts, "") != text {
		t.Fatal("切开再拼起来应该和原文一样")
	}
	long := strings.Repeat("字", 3000) // 没有标点
	for _, p := range splitText(long, 1800) {
		if len(p) > 1800 || !strings.HasPrefix(p, "字") {
			t.Fatalf("硬切出了问题：%d 字节", len(p))
		}
	}
	if got := splitText("Hello world.", 1800); len(got) != 1 || got[0] != "Hello world." {
		t.Fatalf("短文本不该切：%q", got)
	}
}

func TestGEC(t *testing.T) {
	// 对照值由 edge-tts 的 Python 实现（generate_sec_ms_gec_v2）算出。
	token := DefaultEdgeProfile().Token
	for ts, want := range map[int64]string{
		1700000000: "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
		1763000000: "3689BC1F78238B9A-DD2A2B71647FAA9B316154E46E5EEA92B85708C5C753EC77984ED8A78A848763",
		1794547200: "8166F50C94FC207D-C4C2E11946AC8DC750F7AECB358CDDCD43155A95A934FF3BA716189B46D60BE1",
	} {
		if got := gecV2(time.Unix(ts, 0), token); got != want {
			t.Errorf("gecV2(%d)\n得到 %s\n应为 %s", ts, got, want)
		}
	}
	// 同一个 5 分钟窗口内签名相同。
	if gecV2(time.Unix(1_700_000_000, 0), token) != gecV2(time.Unix(1_700_000_000+60, 0), token) {
		t.Error("同一个 5 分钟窗口内签名应相同")
	}
	old := DefaultEdgeProfile()
	old.GEC = "sha256-5min"
	if v := old.gec(time.Unix(1_700_000_000, 0)); len(v) != 64 || v != strings.ToUpper(v) {
		t.Errorf("旧算法的签名应该是 64 位大写十六进制：%s", v)
	}
}
