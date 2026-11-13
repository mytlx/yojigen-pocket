package providers

import "testing"

func TestEvaluate(t *testing.T) {
	cases := map[string]string{
		"1+2*3":        "7",
		"(1+2)*3":      "9",
		"0.1+0.2":      "0.3",
		"2^10":         "1024",
		"2**3":         "8",
		"-2^2":         "-4",
		"10/4":         "2.5",
		"10%3":         "1",
		"50%":          "0.5",
		"200*50%":      "100",
		"sqrt(16)":     "4",
		"max(1,5,3)":   "5",
		"pow(2,8)":     "256",
		"1,000+1":      "1001",
		"3×4":          "12",
		"8÷2":          "4",
		"0xff":         "255",
		"0b101":        "5",
		"1e3":          "1000",
		"pi":           "3.1415926536",
		"10 km to m":   "10000 m",
		"1 mi to km":   "1.609344 km",
		"1gb to mb":    "1000 mb",
		"1 gib to mib": "1024 mib",
		"2 小时 转 分钟":    "120 分钟",
		"100 c to f":   "212 f",
		"32 f to c":    "0 c",
		"255 to hex":   "0xff",
		"5 to bin":     "0b101",
		"1 斤 to g":     "500 g",
	}
	for in, want := range cases {
		got, err := Evaluate(in)
		if err != nil {
			t.Errorf("%q: %v", in, err)
			continue
		}
		if got[0].Text != want {
			t.Errorf("%q = %q，期望 %q", in, got[0].Text, want)
		}
	}
}

func TestEvaluateErrors(t *testing.T) {
	for _, in := range []string{"1/0", "1+", "(1", "foo(1)", "1 2", "10%0", "sqrt(-1)"} {
		if got, err := Evaluate(in); err == nil {
			t.Errorf("%q 应报错，得到 %v", in, got)
		}
	}
}

func TestLooksLikeMath(t *testing.T) {
	yes := []string{"1+1", "2*3", "sqrt(2)", "0xff", "10 km to m", "(1)", "5-3"}
	no := []string{"chrome", "2026", "hello world", "iphone 15", "2026-11-06", "win11", "c++"}
	for _, s := range yes {
		if !LooksLikeMath(s) {
			t.Errorf("%q 应判为算式", s)
		}
	}
	for _, s := range no {
		if LooksLikeMath(s) {
			t.Errorf("%q 不应判为算式", s)
		}
	}
}

func TestNonDecimalShowsBases(t *testing.T) {
	got, err := Evaluate("0x10+1")
	if err != nil || len(got) != 3 || got[1].Text != "0x11" || got[2].Text != "0b10001" {
		t.Errorf("%+v %v", got, err)
	}
}

func TestEvaluateLines(t *testing.T) {
	got := EvaluateLines([]string{
		"price = 199",
		"price * 3 * 0.85  # 打八五折",
		"ans + 10",
		"",
		"// 整行注释",
		"1 +",
		"10 km to mi",
		"sum",
		"pi = 3",
	})
	want := []string{"199", "507.45", "517.45", "", "", "", "6.2137119224 mi", "1223.9", ""}
	for i, w := range want {
		if got[i].Text != w {
			t.Errorf("第 %d 行：得到 %q，应为 %q（错误：%s）", i+1, got[i].Text, w, got[i].Error)
		}
	}
	if got[0].Name != "price" {
		t.Errorf("赋值行应该带变量名，得到 %q", got[0].Name)
	}
	if got[5].Error == "" || got[8].Error == "" {
		t.Errorf("不完整的算式和给保留名赋值都应该报错：%q / %q", got[5].Error, got[8].Error)
	}
	// 出错的行不影响后面的行，也不计入合计。
	if out := EvaluateLines([]string{"2", "x x", "3", "sum", "sum"}); out[3].Text != "5" || out[4].Text != "5" {
		t.Errorf("合计应为 5（看合计的那一行自己不算进去），得到 %q / %q", out[3].Text, out[4].Text)
	}
}
