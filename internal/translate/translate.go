// Package translate 实现翻译：大模型（Claude、OpenAI 兼容接口）、有道智云、百度翻译。
package translate

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"yojigen-pocket/internal/llm"
	"yojigen-pocket/internal/store"
)

// Language 是一种可选的语言。
type Language struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// Languages 是界面上可选的语言。
var Languages = []Language{
	{"auto", "自动检测"}, {"zh", "中文"}, {"zh-TW", "繁体中文"}, {"en", "英语"}, {"ja", "日语"}, {"ko", "韩语"},
	{"fr", "法语"}, {"de", "德语"}, {"es", "西班牙语"}, {"ru", "俄语"}, {"pt", "葡萄牙语"}, {"it", "意大利语"},
}

func languageName(code string) string {
	for _, l := range Languages {
		if l.Code == code {
			return l.Name
		}
	}
	return code
}

// Request 是一次翻译请求。
type Request struct {
	Text     string `json:"text"`
	From     string `json:"from"`
	To       string `json:"to"`
	Provider string `json:"provider,omitempty"` // 留空用设置里的
}

// Result 是翻译结果。
type Result struct {
	Text      string   `json:"text"`
	From      string   `json:"from"`
	To        string   `json:"to"`
	Provider  string   `json:"provider"`
	Phonetic  string   `json:"phonetic,omitempty"`  // 单词的音标（有道）
	Explains  []string `json:"explains,omitempty"`  // 单词释义（有道）
	SpeakURL  string   `json:"speakUrl,omitempty"`  // 原文发音（有道）
	TSpeakURL string   `json:"tSpeakUrl,omitempty"` // 译文发音（有道）
}

// Keys 读取保存在凭据管理器里的密钥。
type Keys func(name string) string

// 凭据管理器里的密钥名称。
const (
	KeyClaude       = "translate.claude"
	KeyOpenAI       = "translate.openai"
	KeyYoudaoSecret = "translate.youdao"
	KeyBaidu        = "translate.baidu"
)

// ResolveTarget 处理「自动」目标语言：中文译成英文，其他译成中文。
func ResolveTarget(text, to string) string {
	if to != "" && to != "auto" {
		return to
	}
	if IsMostlyChinese(text) {
		return "en"
	}
	return "zh"
}

// IsMostlyChinese 判断文字是否以汉字为主。
func IsMostlyChinese(text string) bool {
	han, letters := 0, 0
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r):
			han++
			letters++
		case unicode.IsLetter(r):
			letters++
		}
	}
	return letters > 0 && float64(han)/float64(letters) >= 0.3
}

// Translate 翻译文字。大模型接口会把译文逐段交给 onDelta。
func Translate(ctx context.Context, cfg store.TranslateConfig, keys Keys, req Request, onDelta func(string)) (Result, error) {
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return Result{}, errors.New("没有要翻译的内容")
	}
	provider := req.Provider
	if provider == "" {
		provider = cfg.Provider
	}
	from := req.From
	if from == "" {
		from = "auto"
	}
	to := ResolveTarget(text, req.To)
	res := Result{From: from, To: to, Provider: provider}
	var err error
	switch provider {
	case llm.Claude:
		res.Text, err = translateLLM(ctx, llm.Config{Provider: llm.Claude, BaseURL: cfg.Claude.BaseURL, Model: cfg.Claude.Model, APIKey: keys(KeyClaude)}, text, from, to, onDelta)
	case llm.OpenAI:
		res.Text, err = translateLLM(ctx, llm.Config{Provider: llm.OpenAI, BaseURL: cfg.OpenAI.BaseURL, Model: cfg.OpenAI.Model, APIKey: keys(KeyOpenAI)}, text, from, to, onDelta)
	case "youdao":
		err = youdao(ctx, cfg.YoudaoAppKey, keys(KeyYoudaoSecret), text, from, to, &res)
	case "baidu":
		err = baidu(ctx, cfg.BaiduAppID, keys(KeyBaidu), text, from, to, &res)
	default:
		err = fmt.Errorf("不支持的翻译服务：%s", provider)
	}
	return res, err
}

const llmSystem = `你是专业翻译。把用户发来的全部内容翻译成%s。
只输出译文本身：不要解释，不要加引号，不要说"以下是译文"。保留原文的换行、列表和代码格式，代码和专有名词按惯例处理。%s`

func translateLLM(ctx context.Context, cfg llm.Config, text, from, to string, onDelta func(string)) (string, error) {
	hint := ""
	if from != "auto" {
		hint = "原文是" + languageName(from) + "。"
	}
	out, err := llm.Stream(ctx, cfg, llm.Request{System: fmt.Sprintf(llmSystem, languageName(to), hint), Text: text}, onDelta)
	return strings.TrimSpace(out), err
}

// HTTPClient 是有道和百度接口用的客户端（走系统代理）。测试时可替换。
var HTTPClient = llm.HTTPClient

// 接口地址，测试时可替换。
var (
	YoudaoEndpoint = "https://openapi.youdao.com/api"
	BaiduEndpoint  = "https://fanyi-api.baidu.com/api/trans/vip/translate"
)

func youdaoLang(code string) string {
	switch code {
	case "zh":
		return "zh-CHS"
	case "zh-TW":
		return "zh-CHT"
	}
	return code
}

func baiduLang(code string) string {
	switch code {
	case "zh-TW":
		return "cht"
	case "ja":
		return "jp"
	case "ko":
		return "kor"
	case "fr":
		return "fra"
	case "es":
		return "spa"
	}
	return code
}

// youdaoInput 是有道签名里对原文的截断规则：超过 20 个字时取前 10 个、长度、后 10 个。
func youdaoInput(q string) string {
	r := []rune(q)
	if len(r) <= 20 {
		return q
	}
	return string(r[:10]) + strconv.Itoa(len(r)) + string(r[len(r)-10:])
}

// YoudaoSign 计算有道智云 v3 签名。
func YoudaoSign(appKey, q, salt, curtime, secret string) string {
	h := sha256.Sum256([]byte(appKey + youdaoInput(q) + salt + curtime + secret))
	return hex.EncodeToString(h[:])
}

func newSalt() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1<<40))
	return n.String()
}

func youdao(ctx context.Context, appKey, secret, text, from, to string, res *Result) error {
	if appKey == "" || secret == "" {
		return errors.New("还没有配置有道智云的应用 ID 和密钥：请在「设置 → 翻译与识别」里填写")
	}
	salt := newSalt()
	curtime := strconv.FormatInt(time.Now().Unix(), 10)
	form := url.Values{
		"q": {text}, "from": {youdaoLang(from)}, "to": {youdaoLang(to)}, "appKey": {appKey},
		"salt": {salt}, "sign": {YoudaoSign(appKey, text, salt, curtime, secret)}, "signType": {"v3"}, "curtime": {curtime},
	}
	var body struct {
		ErrorCode   string   `json:"errorCode"`
		Translation []string `json:"translation"`
		Basic       *struct {
			Phonetic   string   `json:"phonetic"`
			UsPhonetic string   `json:"us-phonetic"`
			UkPhonetic string   `json:"uk-phonetic"`
			Explains   []string `json:"explains"`
		} `json:"basic"`
		SpeakURL  string `json:"speakUrl"`
		TSpeakURL string `json:"tSpeakUrl"`
	}
	if err := postForm(ctx, YoudaoEndpoint, form, &body); err != nil {
		return err
	}
	if body.ErrorCode != "0" {
		return fmt.Errorf("有道接口返回错误码 %s（%s）", body.ErrorCode, youdaoError(body.ErrorCode))
	}
	res.Text = strings.Join(body.Translation, "\n")
	res.SpeakURL, res.TSpeakURL = body.SpeakURL, body.TSpeakURL
	if b := body.Basic; b != nil {
		switch {
		case b.UsPhonetic != "" && b.UkPhonetic != "":
			res.Phonetic = "英 /" + b.UkPhonetic + "/  美 /" + b.UsPhonetic + "/"
		case b.Phonetic != "":
			res.Phonetic = "/" + b.Phonetic + "/"
		}
		res.Explains = b.Explains
	}
	return nil
}

func youdaoError(code string) string {
	switch code {
	case "108":
		return "应用 ID 无效"
	case "202":
		return "签名校验失败，检查密钥"
	case "401":
		return "账户已欠费"
	case "411":
		return "访问频率受限"
	case "113":
		return "原文不能为空"
	}
	return "见有道智云文档"
}

// BaiduSign 计算百度翻译签名。
func BaiduSign(appID, q, salt, key string) string {
	h := md5.Sum([]byte(appID + q + salt + key))
	return hex.EncodeToString(h[:])
}

func baidu(ctx context.Context, appID, key, text, from, to string, res *Result) error {
	if appID == "" || key == "" {
		return errors.New("还没有配置百度翻译的 APP ID 和密钥：请在「设置 → 翻译与识别」里填写")
	}
	salt := newSalt()
	form := url.Values{
		"q": {text}, "from": {baiduLang(from)}, "to": {baiduLang(to)}, "appid": {appID},
		"salt": {salt}, "sign": {BaiduSign(appID, text, salt, key)},
	}
	var body struct {
		ErrorCode   string `json:"error_code"`
		ErrorMsg    string `json:"error_msg"`
		TransResult []struct {
			Dst string `json:"dst"`
		} `json:"trans_result"`
	}
	if err := postForm(ctx, BaiduEndpoint, form, &body); err != nil {
		return err
	}
	if body.ErrorCode != "" && body.ErrorCode != "52000" {
		return fmt.Errorf("百度翻译返回错误 %s：%s", body.ErrorCode, body.ErrorMsg)
	}
	lines := make([]string, len(body.TransResult))
	for i, t := range body.TransResult {
		lines[i] = t.Dst
	}
	res.Text = strings.Join(lines, "\n")
	return nil
}

func postForm(ctx context.Context, endpoint string, form url.Values, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("连接失败：%w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("接口返回 %d", resp.StatusCode)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("接口返回的内容无法解析：%w", err)
	}
	return nil
}

// Truncate 限制发给接口的文字长度。
func Truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
