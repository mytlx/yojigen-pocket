// Package llm 调用大模型接口：Claude（官方 Go SDK）和 OpenAI 兼容接口（DeepSeek、通义千问、Kimi、Ollama 等）。
// 翻译和截图识别共用这里。请求走系统代理，和网页一致。
package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
	"github.com/egoist/mygo/netproxy"
)

// Provider 是大模型接口的种类。
const (
	Claude = "claude"
	OpenAI = "openai"
)

// Config 是一次调用用到的接口设置。
type Config struct {
	Provider string
	BaseURL  string
	Model    string
	APIKey   string
}

// Request 是一次调用的内容。
type Request struct {
	System   string
	Text     string
	ImagePNG []byte // 有图片时一起发送（截图识别）
}

// ErrNotConfigured 表示还没有填写密钥或模型。
var ErrNotConfigured = errors.New("还没有配置大模型接口：请在「设置 → 翻译与识别」里填写")

// HTTPClient 是所有接口请求共用的客户端，走系统代理。测试时可替换。
var HTTPClient = &http.Client{Transport: netproxy.Transport()}

// Stream 发出请求，并把生成的文字片段逐段交给 onDelta，返回完整文字。
func Stream(ctx context.Context, cfg Config, req Request, onDelta func(string)) (string, error) {
	if cfg.APIKey == "" || cfg.Model == "" {
		return "", ErrNotConfigured
	}
	if onDelta == nil {
		onDelta = func(string) {}
	}
	switch cfg.Provider {
	case Claude:
		return streamClaude(ctx, cfg, req, onDelta)
	case OpenAI:
		return streamOpenAI(ctx, cfg, req, onDelta)
	}
	return "", fmt.Errorf("不支持的接口：%s", cfg.Provider)
}

// supportsEffort 判断模型是否接受 effort 参数（较早的模型会返回 400）。
func supportsEffort(model string) bool {
	for _, p := range []string{"claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "claude-fable-5", "claude-mythos-5",
		"claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"} {
		if strings.HasPrefix(model, p) {
			return true
		}
	}
	return false
}

// supportsFallbacks 判断模型是否支持服务端的拒答兜底。
func supportsFallbacks(model string) bool {
	switch model {
	case "claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5":
		return true
	}
	return false
}

func streamClaude(ctx context.Context, cfg Config, req Request, onDelta func(string)) (string, error) {
	base := cfg.BaseURL
	if base == "" {
		// 写明地址，不让环境变量里的 ANTHROPIC_BASE_URL 意外改掉它。
		base = "https://api.anthropic.com"
	}
	opts := []option.RequestOption{option.WithAPIKey(cfg.APIKey), option.WithHTTPClient(HTTPClient), option.WithBaseURL(base)}
	client := anthropic.NewClient(opts...)

	var blocks []anthropic.BetaContentBlockParamUnion
	if len(req.ImagePNG) > 0 {
		blocks = append(blocks, anthropic.NewBetaImageBlock(anthropic.BetaBase64ImageSourceParam{
			Data:      base64.StdEncoding.EncodeToString(req.ImagePNG),
			MediaType: anthropic.BetaBase64ImageSourceMediaTypeImagePNG,
		}))
	}
	blocks = append(blocks, anthropic.NewBetaTextBlock(req.Text))
	params := anthropic.BetaMessageNewParams{
		Model:     cfg.Model,
		MaxTokens: 16000,
		Messages:  []anthropic.BetaMessageParam{anthropic.NewBetaUserMessage(blocks...)},
	}
	if req.System != "" {
		params.System = []anthropic.BetaTextBlockParam{{Text: req.System}}
	}
	// 翻译和识别是简单任务，用低 effort 换更快的响应。
	if supportsEffort(cfg.Model) {
		params.OutputConfig = anthropic.BetaOutputConfigParam{Effort: anthropic.BetaOutputConfigEffortLow}
	}
	// 服务端兜底：模型拒答时由服务端换一个推荐的模型重答，避免误拒变成不可用。
	if supportsFallbacks(cfg.Model) {
		params.Betas = []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01}
		params.Fallbacks = anthropic.BetaFallbacksParamOfDefault()
	}

	stream := client.Beta.Messages.NewStreaming(ctx, params)
	defer stream.Close()
	message := anthropic.BetaMessage{}
	var out strings.Builder
	for stream.Next() {
		event := stream.Current()
		_ = message.Accumulate(event)
		if delta, ok := event.AsAny().(anthropic.BetaRawContentBlockDeltaEvent); ok {
			if text, ok := delta.Delta.AsAny().(anthropic.BetaTextDelta); ok {
				out.WriteString(text.Text)
				onDelta(text.Text)
			}
		}
	}
	if err := stream.Err(); err != nil {
		return out.String(), describeClaudeError(err)
	}
	if message.StopReason == anthropic.BetaStopReasonRefusal {
		return out.String(), errors.New("模型拒绝了这个请求，换个说法或换个模型再试")
	}
	return out.String(), nil
}

func describeClaudeError(err error) error {
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return errors.New("Claude 密钥无效或没有权限")
		case http.StatusNotFound:
			return errors.New("找不到这个模型，检查模型名称")
		case http.StatusTooManyRequests:
			return errors.New("请求太频繁或额度不足，稍后再试")
		case http.StatusBadRequest:
			return fmt.Errorf("请求被拒绝：%s", apiErr.Error())
		}
		if apiErr.StatusCode >= 500 {
			return errors.New("Claude 服务暂时不可用，稍后再试")
		}
	}
	return fmt.Errorf("调用 Claude 失败：%w", err)
}

func streamOpenAI(ctx context.Context, cfg Config, req Request, onDelta func(string)) (string, error) {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		return "", ErrNotConfigured
	}
	var user any = req.Text
	if len(req.ImagePNG) > 0 {
		user = []map[string]any{
			{"type": "image_url", "image_url": map[string]string{"url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(req.ImagePNG)}},
			{"type": "text", "text": req.Text},
		}
	}
	messages := []map[string]any{}
	if req.System != "" {
		messages = append(messages, map[string]any{"role": "system", "content": req.System})
	}
	messages = append(messages, map[string]any{"role": "user", "content": user})
	body, _ := json.Marshal(map[string]any{"model": cfg.Model, "stream": true, "messages": messages})

	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	resp, err := HTTPClient.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("连接失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &e) == nil && e.Error.Message != "" {
			return "", fmt.Errorf("接口返回 %d：%s", resp.StatusCode, e.Error.Message)
		}
		return "", fmt.Errorf("接口返回 %d：%s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out strings.Builder
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		data, ok := strings.CutPrefix(line, "data:")
		if !ok {
			continue
		}
		data = strings.TrimSpace(data)
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if chunk.Error != nil {
			return out.String(), errors.New(chunk.Error.Message)
		}
		for _, c := range chunk.Choices {
			if c.Delta.Content != "" {
				out.WriteString(c.Delta.Content)
				onDelta(c.Delta.Content)
			}
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		return out.String(), err
	}
	return out.String(), ctx.Err()
}
