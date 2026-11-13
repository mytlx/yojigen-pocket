// Package tts 把文字变成语音文件。
//
// 单个英文单词优先用词典的真人发音（有道、谷歌），句子和长文本用 Edge 的在线语音；
// 也可以接 OpenAI 兼容的语音接口，或本地部署的 Kokoro。都不行时由调用方退回系统语音。
package tts

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/egoist/mygo/netproxy"

	"yojigen-pocket/internal/store"
)

// 引擎的名字。
const (
	Youdao = "youdao"
	Google = "google"
	Edge   = "edge"
	OpenAI = "openai"
	Kokoro = "kokoro"
	System = "system"
)

// KeyOpenAI 是语音接口密钥在系统钥匙串里的名字。和翻译的密钥分开存。
const KeyOpenAI = "speech.openai"

// MaxChars 是一次朗读最多处理的字数，再长的截掉。
const MaxChars = 6000

// HTTPClient 走系统代理。
var HTTPClient = &http.Client{Transport: netproxy.Transport(), Timeout: 40 * time.Second}

// Options 是合成需要的环境。
type Options struct {
	Config    store.SpeechConfig
	CacheDir  string // 合成结果缓存在这里
	DataDir   string // Edge 的连接参数文件放在这里
	OpenAIKey string
}

// Result 是合成结果。Path 为空表示没有合成出文件，调用方应该用系统语音朗读。
type Result struct {
	Path   string
	Engine string
	// Note 是给用户看的说明：首选的引擎失败、退到别的引擎时说明原因。
	Note string
}

// IsWord 判断是不是单个英文单词（可以带连字符和撇号）。
func IsWord(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > 40 {
		return false
	}
	letters := 0
	for _, r := range text {
		switch {
		case r < unicode.MaxASCII && unicode.IsLetter(r):
			letters++
		case r == '-' || r == '\'' || r == '’':
		default:
			return false
		}
	}
	return letters > 0
}

func cacheFile(dir string, parts ...string) string {
	sum := sha1.Sum([]byte(strings.Join(parts, "\x00")))
	return filepath.Join(dir, hex.EncodeToString(sum[:12])+".mp3")
}

// prune 只留最近的一些缓存文件。
func prune(dir string, keep int) {
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) <= keep {
		return
	}
	type file struct {
		name string
		mod  time.Time
	}
	var files []file
	for _, e := range entries {
		if info, err := e.Info(); err == nil && !e.IsDir() {
			files = append(files, file{e.Name(), info.ModTime()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
	for _, f := range files[min(keep, len(files)):] {
		_ = os.Remove(filepath.Join(dir, f.name))
	}
}

// Synthesize 按设置选引擎合成语音。lang 是 zh、en、ja 这样的语言代码。
func Synthesize(ctx context.Context, o Options, text, lang string) (Result, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return Result{}, errors.New("没有要朗读的内容")
	}
	if r := []rune(text); len(r) > MaxChars {
		text = string(r[:MaxChars])
	}
	dir := filepath.Join(o.CacheDir, "tts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Result{}, err
	}
	defer prune(dir, 200)
	cfg := o.Config
	var notes []string

	// 单个英文单词：词典发音。
	if lang == "en" && IsWord(text) && cfg.Word != "sentence" {
		order := []string{Youdao, Google}
		if cfg.Word == Google {
			order = []string{Google, Youdao}
		}
		for _, engine := range order {
			out := cacheFile(dir, engine, cfg.Accent, strings.ToLower(text))
			if cached(out) {
				return Result{Path: out, Engine: engine}, nil
			}
			data, err := wordAudio(ctx, engine, text, cfg.Accent)
			if err == nil {
				if err = os.WriteFile(out, data, 0o600); err == nil {
					return Result{Path: out, Engine: engine}, nil
				}
			}
			if ctx.Err() != nil {
				return Result{}, ctx.Err()
			}
			notes = append(notes, engineTitle(engine)+"："+err.Error())
		}
	}

	engine := cfg.Sentence
	if engine == "" {
		engine = Edge
	}
	if engine != System {
		out := cacheFile(dir, engine, voiceFor(cfg, engine, lang), fmt.Sprint(cfg.Rate), text)
		if cached(out) {
			return Result{Path: out, Engine: engine, Note: strings.Join(notes, "；")}, nil
		}
		var data []byte
		var err error
		switch engine {
		case Edge:
			data, err = edgeSynthesize(ctx, o, text, lang)
		case OpenAI:
			if o.OpenAIKey == "" {
				err = errors.New("还没有填语音接口的密钥")
			} else {
				data, err = apiSpeech(ctx, cfg.OpenAI, o.OpenAIKey, text, cfg.Rate)
			}
		case Kokoro:
			data, err = apiSpeech(ctx, cfg.Kokoro, "", text, cfg.Rate)
		default:
			err = fmt.Errorf("不认识的发音引擎「%s」", engine)
		}
		if err == nil {
			if err = os.WriteFile(out, data, 0o600); err == nil {
				return Result{Path: out, Engine: engine, Note: strings.Join(notes, "；")}, nil
			}
		}
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		notes = append(notes, engineTitle(engine)+"："+err.Error())
	}
	note := ""
	if len(notes) > 0 {
		note = strings.Join(notes, "；") + "。已改用系统语音。"
	}
	return Result{Engine: System, Note: note}, nil
}

func cached(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.Size() < 256 {
		return false
	}
	now := time.Now()
	_ = os.Chtimes(path, now, now) // 最近用过的不被清掉
	return true
}

func engineTitle(engine string) string {
	switch engine {
	case Youdao:
		return "有道发音"
	case Google:
		return "谷歌发音"
	case Edge:
		return "Edge 语音"
	case OpenAI:
		return "语音接口"
	case Kokoro:
		return "Kokoro"
	}
	return engine
}

func voiceFor(cfg store.SpeechConfig, engine, lang string) string {
	switch engine {
	case Edge:
		return EdgeVoice(cfg.Edge, lang)
	case OpenAI:
		return cfg.OpenAI.Model + "/" + cfg.OpenAI.Voice
	case Kokoro:
		return cfg.Kokoro.Model + "/" + cfg.Kokoro.Voice
	}
	return ""
}

// wordAudio 从词典网站取一个单词的发音。
func wordAudio(ctx context.Context, engine, word, accent string) ([]byte, error) {
	var target string
	switch engine {
	case Youdao:
		kind := "2" // 美音
		if accent == "uk" {
			kind = "1"
		}
		target = "https://dict.youdao.com/dictvoice?type=" + kind + "&audio=" + url.QueryEscape(word)
	case Google:
		tl := "en-US"
		if accent == "uk" {
			tl = "en-GB"
		}
		target = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=" + tl + "&q=" + url.QueryEscape(word)
	default:
		return nil, errors.New("不认识的单词发音来源")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
	resp, err := HTTPClient.Do(req)
	if err != nil {
		return nil, shortError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("返回了 HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, shortError(err)
	}
	if len(data) < 512 || !looksLikeAudio(data) {
		return nil, errors.New("没有这个词的发音")
	}
	return data, nil
}

// looksLikeAudio 看开头是不是 MP3 / WAV / Ogg（有的站查不到词时返回一个网页）。
func looksLikeAudio(b []byte) bool {
	switch {
	case bytes.HasPrefix(b, []byte("ID3")), bytes.HasPrefix(b, []byte("RIFF")), bytes.HasPrefix(b, []byte("OggS")), bytes.HasPrefix(b, []byte("fLaC")):
		return true
	case len(b) > 1 && b[0] == 0xFF && b[1]&0xE0 == 0xE0: // MPEG 帧同步
		return true
	}
	return false
}

// apiSpeech 调 OpenAI 兼容的 /audio/speech。Kokoro-FastAPI 也是这个接口，只是不用密钥。
func apiSpeech(ctx context.Context, api store.SpeechAPI, key, text string, rate int) ([]byte, error) {
	base := strings.TrimRight(strings.TrimSpace(api.BaseURL), "/")
	if base == "" {
		return nil, errors.New("还没有填接口地址")
	}
	body := map[string]any{"model": api.Model, "input": text, "voice": api.Voice, "response_format": "mp3"}
	if rate != 0 {
		body["speed"] = 1 + float64(rate)/100
	}
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/audio/speech", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := HTTPClient
	if isLoopback(base) {
		client = &http.Client{Timeout: 60 * time.Second} // 本机服务不走代理
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, shortError(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, shortError(err)
	}
	if resp.StatusCode != http.StatusOK {
		msg := strings.TrimSpace(string(data))
		if len(msg) > 200 {
			msg = msg[:200]
		}
		return nil, fmt.Errorf("返回了 HTTP %d %s", resp.StatusCode, msg)
	}
	if len(data) < 256 {
		return nil, errors.New("接口没有返回音频")
	}
	return data, nil
}

func isLoopback(base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	h := u.Hostname()
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// shortError 把网络错误说得短一点。
func shortError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		if ue.Timeout() {
			return errors.New("连接超时")
		}
		return errors.New("连不上（" + ue.Err.Error() + "）")
	}
	return err
}
