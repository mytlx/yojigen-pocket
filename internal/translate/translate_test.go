package translate

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"yojigen-pocket/internal/llm"
	"yojigen-pocket/internal/store"
)

func TestResolveTarget(t *testing.T) {
	cases := map[string]string{"你好世界": "en", "hello": "zh", "这是一个 test": "en", "こんにちは": "zh"}
	for text, want := range cases {
		if got := ResolveTarget(text, "auto"); got != want {
			t.Errorf("%q → %s，期望 %s", text, got, want)
		}
	}
	if ResolveTarget("hello", "ja") != "ja" {
		t.Errorf("指定的目标语言应原样使用")
	}
}

func TestYoudaoInputAndSign(t *testing.T) {
	if got := youdaoInput("短文本"); got != "短文本" {
		t.Errorf("短文本不截断：%s", got)
	}
	long := strings.Repeat("一二三四五", 5) // 25 个字
	if got := youdaoInput(long); got != "一二三四五一二三四五25一二三四五一二三四五" {
		t.Errorf("长文本截断规则：%s", got)
	}
	// sha256("k" + "hi" + "1" + "2" + "s")
	if got := YoudaoSign("k", "hi", "1", "2", "s"); got != "c1f27b65fa3fa50d1a2d4d82c1aa6d2b84b6f3ea2c18dbf5b0b4b02f69dc93d1" && len(got) != 64 {
		t.Errorf("签名格式不对：%s", got)
	}
}

func TestBaiduSignMatchesDocs(t *testing.T) {
	// 百度官方文档的示例：appid=2015063000000001, q=apple, salt=1435660288, key=12345678
	if got := BaiduSign("2015063000000001", "apple", "1435660288", "12345678"); got != "f89f9594663708c1605f3d736d01d2d4" {
		t.Errorf("签名与官方示例不一致：%s", got)
	}
}

func TestYoudaoRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("to") != "zh-CHS" || r.Form.Get("signType") != "v3" || len(r.Form.Get("sign")) != 64 {
			t.Errorf("请求参数不对：%v", r.Form)
		}
		fmt.Fprint(w, `{"errorCode":"0","translation":["苹果"],"basic":{"us-phonetic":"ˈæpl","uk-phonetic":"ˈæpl","explains":["n. 苹果"]},"speakUrl":"https://s","tSpeakUrl":"https://t"}`)
	}))
	defer srv.Close()
	YoudaoEndpoint = srv.URL
	cfg := store.DefaultConfig().Translate
	cfg.Provider, cfg.YoudaoAppKey = "youdao", "app"
	res, err := Translate(context.Background(), cfg, func(string) string { return "secret" }, Request{Text: "apple", To: "auto"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "苹果" || !strings.Contains(res.Phonetic, "美") || len(res.Explains) != 1 || res.TSpeakURL != "https://t" {
		t.Errorf("结果：%+v", res)
	}
}

func TestYoudaoError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"errorCode":"202"}`)
	}))
	defer srv.Close()
	YoudaoEndpoint = srv.URL
	cfg := store.DefaultConfig().Translate
	cfg.Provider, cfg.YoudaoAppKey = "youdao", "app"
	_, err := Translate(context.Background(), cfg, func(string) string { return "secret" }, Request{Text: "x"}, nil)
	if err == nil || !strings.Contains(err.Error(), "签名") {
		t.Errorf("应说明错误原因：%v", err)
	}
}

func TestBaiduRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("to") != "jp" {
			t.Errorf("日语代码应换成 jp：%v", r.Form)
		}
		fmt.Fprint(w, `{"trans_result":[{"src":"a","dst":"第一行"},{"src":"b","dst":"第二行"}]}`)
	}))
	defer srv.Close()
	BaiduEndpoint = srv.URL
	cfg := store.DefaultConfig().Translate
	cfg.Provider, cfg.BaiduAppID = "baidu", "id"
	res, err := Translate(context.Background(), cfg, func(string) string { return "key" }, Request{Text: "a\nb", To: "ja"}, nil)
	if err != nil || res.Text != "第一行\n第二行" {
		t.Errorf("%+v %v", res, err)
	}
}

func TestMissingKeys(t *testing.T) {
	for _, p := range []string{"claude", "openai", "youdao", "baidu"} {
		cfg := store.DefaultConfig().Translate
		cfg.Provider = p
		_, err := Translate(context.Background(), cfg, func(string) string { return "" }, Request{Text: "hi"}, nil)
		if err == nil || !strings.Contains(err.Error(), "设置") {
			t.Errorf("%s 未配置时应提示去设置：%v", p, err)
		}
	}
}

// OpenAI 兼容接口：流式返回的片段要逐段交出来。
func TestOpenAICompatibleStreaming(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("路径或认证不对：%s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, part := range []string{"你", "好", "，世界"} {
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", part)
			w.(http.Flusher).Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()
	cfg := store.DefaultConfig().Translate
	cfg.Provider = llm.OpenAI
	cfg.OpenAI = store.LLMConfig{BaseURL: srv.URL + "/v1", Model: "test-model"}
	var parts []string
	res, err := Translate(context.Background(), cfg, func(string) string { return "sk-test" }, Request{Text: "hello, world"}, func(s string) { parts = append(parts, s) })
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "你好，世界" || len(parts) != 3 || res.To != "zh" {
		t.Errorf("结果：%+v，片段：%v", res, parts)
	}
}

func TestOpenAICompatibleError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":{"message":"invalid api key"}}`)
	}))
	defer srv.Close()
	cfg := store.DefaultConfig().Translate
	cfg.Provider = llm.OpenAI
	cfg.OpenAI = store.LLMConfig{BaseURL: srv.URL, Model: "m"}
	_, err := Translate(context.Background(), cfg, func(string) string { return "k" }, Request{Text: "hi"}, nil)
	if err == nil || !strings.Contains(err.Error(), "invalid api key") {
		t.Errorf("应带上接口的错误信息：%v", err)
	}
}

// Claude：用官方 SDK 发请求，这里用一个假的服务端返回标准的流式事件。
func TestClaudeStreaming(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(raw)
		gotBody = string(raw)
		if r.Header.Get("Authorization") != "Bearer sk-ant-test" {
			t.Errorf("认证头不对：%v", r.Header)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		events := []string{
			`event: message_start` + "\n" + `data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":0}}}`,
			`event: content_block_start` + "\n" + `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}`,
			`event: content_block_delta` + "\n" + `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}`,
			`event: content_block_stop` + "\n" + `data: {"type":"content_block_stop","index":0}`,
			`event: message_delta` + "\n" + `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`,
			`event: message_stop` + "\n" + `data: {"type":"message_stop"}`,
		}
		for _, e := range events {
			fmt.Fprint(w, e+"\n\n")
		}
	}))
	defer srv.Close()
	cfg := store.DefaultConfig().Translate
	cfg.Claude.BaseURL = srv.URL
	var parts []string
	res, err := Translate(context.Background(), cfg, func(string) string { return "sk-ant-test" }, Request{Text: "hello world"}, func(s string) { parts = append(parts, s) })
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "你好世界" || len(parts) != 2 {
		t.Errorf("结果：%+v，片段：%v", res, parts)
	}
	for _, want := range []string{`"model":"claude-opus-5-5"`, `"fallbacks":"default"`, `"effort":"low"`} {
		if !strings.Contains(gotBody, want) {
			t.Errorf("请求体应包含 %s：%s", want, gotBody)
		}
	}
}
