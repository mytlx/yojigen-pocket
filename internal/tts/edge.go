package tts

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/store"
)

// EdgeProfile 是连接 Edge 在线语音需要的全部“会变”的东西。
//
// 这个接口没有公开文档，微软隔一阵会调整校验方式（口令、版本号、签名算法）。
// 所以这些参数不写死在程序里：内置一份默认值，数据目录里的 edge-tts.json 可以覆盖其中任何一项，
// 设置里还可以填一个在线地址，一键把最新的参数拉下来。参数也救不回来时，可以改用外部的 edge-tts 命令。
type EdgeProfile struct {
	Version  int    `json:"version"`
	Updated  string `json:"updated"`
	Endpoint string `json:"endpoint"` // wss 地址，不带查询参数
	Voices   string `json:"voicesUrl"`
	Token    string `json:"trustedClientToken"`
	Chromium string `json:"chromiumVersion"` // 完整版本号，Sec-MS-GEC-Version 和 User-Agent 都从它来
	Origin   string `json:"origin"`
	// UserAgent 留空时按 Chromium 版本拼。
	UserAgent string `json:"userAgent"`
	// GEC 是签名算法：v2（当前的做法，见 gec.go）、sha256-5min（2026 年以前的做法）或 none（不带签名）。
	GEC string `json:"gec"`
	// GECVersion 是 Sec-MS-GEC-Version 里版本号前面的那一位。
	GECVersion string `json:"gecVersion"`
	MUID       bool   `json:"cookieMuid"` // 握手时带一个随机的 muid Cookie
	Format     string `json:"outputFormat"`
}

// DefaultEdgeProfile 是内置的连接参数。
func DefaultEdgeProfile() EdgeProfile {
	return EdgeProfile{
		Version:    1,
		Updated:    "2026-11-13",
		Endpoint:   "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1",
		Voices:     "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list",
		Token:      "6A5AA1D4EAFF4E9FB37E23D68491D6F4",
		Chromium:   "143.0.3650.75",
		Origin:     "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
		GEC:        "v2",
		GECVersion: "2",
		MUID:       true,
		Format:     "audio-24khz-48kbitrate-mono-mp3",
	}
}

// ProfileFile 是覆盖内置参数的文件。
func ProfileFile(dataDir string) string { return filepath.Join(dataDir, "edge-tts.json") }

// LoadEdgeProfile 读出生效的参数：内置默认值，被数据目录里的文件逐项覆盖。custom 表示用了这个文件。
func LoadEdgeProfile(dataDir string) (p EdgeProfile, custom bool) {
	p = DefaultEdgeProfile()
	raw, err := os.ReadFile(ProfileFile(dataDir))
	if err != nil {
		return p, false
	}
	override := p
	if json.Unmarshal(raw, &override) != nil || override.Endpoint == "" || override.Token == "" {
		return p, false
	}
	return override, true
}

// UpdateEdgeProfile 从一个地址下载参数，校验后存到数据目录。
func UpdateEdgeProfile(ctx context.Context, dataDir, from string) (EdgeProfile, error) {
	from = strings.TrimSpace(from)
	if !strings.HasPrefix(from, "https://") && !strings.HasPrefix(from, "http://") {
		return EdgeProfile{}, errors.New("先填一个 http(s) 的更新地址")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, from, nil)
	if err != nil {
		return EdgeProfile{}, err
	}
	resp, err := HTTPClient.Do(req)
	if err != nil {
		return EdgeProfile{}, shortError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return EdgeProfile{}, fmt.Errorf("更新地址返回了 HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return EdgeProfile{}, err
	}
	p := DefaultEdgeProfile()
	if err := json.Unmarshal(raw, &p); err != nil {
		return EdgeProfile{}, errors.New("下载到的不是合法的参数文件（JSON）")
	}
	if !strings.HasPrefix(p.Endpoint, "wss://") || p.Token == "" || p.Chromium == "" {
		return EdgeProfile{}, errors.New("参数文件缺少 endpoint、trustedClientToken 或 chromiumVersion")
	}
	out, _ := json.MarshalIndent(p, "", "  ")
	if err := os.WriteFile(ProfileFile(dataDir), out, 0o600); err != nil {
		return EdgeProfile{}, err
	}
	return p, nil
}

// ResetEdgeProfile 删掉覆盖文件，回到内置参数。
func ResetEdgeProfile(dataDir string) error {
	err := os.Remove(ProfileFile(dataDir))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func (p EdgeProfile) major() string {
	major, _, _ := strings.Cut(p.Chromium, ".")
	return major
}

func (p EdgeProfile) userAgent() string {
	if p.UserAgent != "" {
		return p.UserAgent
	}
	m := p.major()
	return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + m + ".0.0.0 Safari/537.36 Edg/" + m + ".0.0.0"
}

// clockSkew 是本机时间和服务器时间的差。签名里有时间，本机时间不准时握手会被拒，按服务器的时间修正后再试。
var (
	skewMu    sync.Mutex
	clockSkew time.Duration
)

// gec 按参数里选的算法生成 Sec-MS-GEC。
func (p EdgeProfile) gec(now time.Time) string {
	if p.GEC == "sha256-5min" {
		// 旧算法：时间换成 1601 年起的 100 纳秒数，按 5 分钟取整，接上口令做 SHA-256。
		const winEpoch = 11644473600
		sec := now.Unix() + winEpoch
		sec -= sec % 300
		sum := sha256.Sum256([]byte(fmt.Sprintf("%d%s", sec*10_000_000, p.Token)))
		return strings.ToUpper(hex.EncodeToString(sum[:]))
	}
	return gecV2(now, p.Token)
}

// gecQuery 是地址里的签名参数。
func (p EdgeProfile) gecQuery() string {
	if p.GEC == "none" {
		return ""
	}
	skewMu.Lock()
	now := time.Now().Add(clockSkew)
	skewMu.Unlock()
	version := p.GECVersion
	if version == "" {
		version = "2"
		if p.GEC == "sha256-5min" {
			version = "1"
		}
	}
	return "&Sec-MS-GEC=" + p.gec(now) + "&Sec-MS-GEC-Version=" + version + "-" + p.Chromium
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (p EdgeProfile) dial(ctx context.Context) (*websocket.Conn, *http.Response, error) {
	target := p.Endpoint + "?TrustedClientToken=" + p.Token + "&ConnectionId=" + randomHex(16) + p.gecQuery()
	h := http.Header{}
	h.Set("Pragma", "no-cache")
	h.Set("Cache-Control", "no-cache")
	h.Set("Origin", p.Origin)
	h.Set("User-Agent", p.userAgent())
	h.Set("Accept-Language", "en-US,en;q=0.9")
	if p.MUID {
		h.Set("Cookie", "muid="+strings.ToUpper(randomHex(16))+";")
	}
	client := &http.Client{Transport: HTTPClient.Transport}
	return websocket.Dial(ctx, target, &websocket.DialOptions{HTTPClient: client, HTTPHeader: h})
}

// connect 握手；被拒（403）时按服务器的时间修正时钟再试一次。
func (p EdgeProfile) connect(ctx context.Context) (*websocket.Conn, error) {
	conn, resp, err := p.dial(ctx)
	if err == nil {
		return conn, nil
	}
	if resp != nil && resp.StatusCode == http.StatusForbidden {
		if t, perr := http.ParseTime(resp.Header.Get("Date")); perr == nil {
			skewMu.Lock()
			clockSkew = time.Until(t)
			skewMu.Unlock()
			if conn, _, err2 := p.dial(ctx); err2 == nil {
				return conn, nil
			}
		}
		return nil, errors.New("微软拒绝了连接（HTTP 403），多半是校验方式又变了。可以在设置里更新连接参数，或安装/升级外部的 edge-tts 命令")
	}
	if resp != nil {
		return nil, fmt.Errorf("握手失败（HTTP %d）", resp.StatusCode)
	}
	return nil, shortError(err)
}

func edgeDate() string {
	return time.Now().UTC().Format("Mon Jan 02 2006 15:04:05") + " GMT+0000 (Coordinated Universal Time)"
}

func rateText(rate int) string { return fmt.Sprintf("%+d%%", max(-90, min(rate, 200))) }

// synthesize 合成一段文字（一次连接）。
func (p EdgeProfile) synthesize(ctx context.Context, text, voice string, rate int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	conn, err := p.connect(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(8 << 20)

	config := "X-Timestamp:" + edgeDate() + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
		`{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"` + p.Format + `"}}}}` + "\r\n"
	if err := conn.Write(ctx, websocket.MessageText, []byte(config)); err != nil {
		return nil, shortError(err)
	}
	locale := "en-US"
	if parts := strings.SplitN(voice, "-", 3); len(parts) == 3 {
		locale = parts[0] + "-" + parts[1]
	}
	ssml := "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + locale + "'>" +
		"<voice name='" + html.EscapeString(voice) + "'><prosody pitch='+0Hz' rate='" + rateText(rate) + "' volume='+0%'>" +
		html.EscapeString(text) + "</prosody></voice></speak>"
	msg := "X-RequestId:" + randomHex(16) + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:" + edgeDate() + "Z\r\nPath:ssml\r\n\r\n" + ssml
	if err := conn.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
		return nil, shortError(err)
	}

	var audio bytes.Buffer
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			if audio.Len() > 0 && websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				break
			}
			if ctx.Err() != nil {
				return nil, errors.New("合成超时")
			}
			return nil, fmt.Errorf("连接中断（%v）", err)
		}
		if kind == websocket.MessageText {
			if bytes.Contains(data, []byte("Path:turn.end")) {
				break
			}
			continue
		}
		// 二进制帧：前两个字节是头部长度，头部之后是音频。
		if len(data) < 2 {
			continue
		}
		n := int(binary.BigEndian.Uint16(data))
		if 2+n > len(data) {
			continue
		}
		if bytes.Contains(data[2:2+n], []byte("Path:audio")) {
			audio.Write(data[2+n:])
		}
	}
	_ = conn.Close(websocket.StatusNormalClosure, "")
	if audio.Len() == 0 {
		return nil, errors.New("没有收到音频，可能是这个音色不存在：" + voice)
	}
	return audio.Bytes(), nil
}

// EdgeVoice 返回一种语言用的音色。
func EdgeVoice(cfg store.EdgeTTS, lang string) string {
	if v := strings.TrimSpace(cfg.Voices[lang]); v != "" {
		return v
	}
	defaults := store.DefaultEdgeVoices()
	if v := defaults[lang]; v != "" {
		return v
	}
	if v := strings.TrimSpace(cfg.Voices["en"]); v != "" {
		return v
	}
	return defaults["en"]
}

// Split 把长文本按句子切成不超过 limit 字节的几段。
func Split(text string, limit int) []string { return splitText(text, limit) }

// WriteEdgeProfile 把参数写到数据目录（给用户一份可以改的底稿）。
func WriteEdgeProfile(dataDir string, p EdgeProfile) error {
	out, _ := json.MarshalIndent(p, "", "  ")
	return os.WriteFile(ProfileFile(dataDir), out, 0o600)
}

// splitText 把长文本按句子切成不超过 limit 字节的几段：接口对单次请求的长度有限制。
func splitText(text string, limit int) []string {
	var out []string
	var cur strings.Builder
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			out = append(out, s)
		}
		cur.Reset()
	}
	sentence := func(r rune) bool { return strings.ContainsRune("。！？!?；;\n", r) }
	var piece strings.Builder
	emit := func() {
		p := piece.String()
		piece.Reset()
		if cur.Len()+len(p) > limit {
			flush()
		}
		// 一句话就超长：硬切。
		for len(p) > limit {
			cut := limit
			for cut > 0 && !isRuneStart(p[cut]) {
				cut--
			}
			out = append(out, p[:cut])
			p = p[cut:]
		}
		cur.WriteString(p)
	}
	for _, r := range text {
		piece.WriteRune(r)
		if sentence(r) || (r == '.' || r == ',' || r == '，' || r == ' ') && piece.Len() > limit/2 {
			emit()
		}
	}
	emit()
	flush()
	return out
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

// edgeSynthesize 用 Edge 语音合成：按设置走内置实现或外部命令。
func edgeSynthesize(ctx context.Context, o Options, text, lang string) ([]byte, error) {
	cfg := o.Config.Edge
	voice := EdgeVoice(cfg, lang)
	var builtinErr error
	if cfg.Mode != "command" {
		profile, _ := LoadEdgeProfile(o.DataDir)
		var all bytes.Buffer
		for _, part := range splitText(text, 1800) {
			data, err := profile.synthesize(ctx, part, voice, o.Config.Rate)
			if err != nil {
				builtinErr = err
				break
			}
			all.Write(data)
		}
		if builtinErr == nil && all.Len() > 0 {
			return all.Bytes(), nil
		}
		if cfg.Mode == "builtin" || ctx.Err() != nil {
			return nil, builtinErr
		}
	}
	// 外部命令：pip install edge-tts。校验方式变了的话，升级它就行，不用等这个应用更新。
	data, err := edgeCommand(ctx, cfg, text, voice, o.Config.Rate, o.CacheDir)
	if err == nil {
		return data, nil
	}
	if builtinErr != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, builtinErr
		}
		return nil, fmt.Errorf("%v；外部命令也失败了：%v", builtinErr, err)
	}
	return nil, err
}

// EdgeCommandPath 找外部的 edge-tts 命令；没有时返回空。
// 除了 PATH，也看 pip --user、pipx 和 uv 默认装到的位置：从图形界面启动的应用，PATH 里常常没有它们。
func EdgeCommandPath(cfg store.EdgeTTS) string {
	name := strings.TrimSpace(cfg.Command)
	if name == "" {
		name = "edge-tts"
	}
	if p, err := exec.LookPath(platform.ExpandHome(name)); err == nil {
		return p
	}
	if filepath.Base(name) != name {
		return "" // 写了具体路径又不存在，就不猜了
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	patterns := []string{
		filepath.Join(home, ".local", "bin", name),
		filepath.Join(home, "Library", "Python", "*", "bin", name),
		filepath.Join(home, ".local", "bin", name+".exe"),
		filepath.Join(os.Getenv("APPDATA"), "Python", "Python*", "Scripts", name+".exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Python", "Python*", "Scripts", name+".exe"),
	}
	for _, pattern := range patterns {
		if m, _ := filepath.Glob(pattern); len(m) > 0 {
			return m[len(m)-1]
		}
	}
	return ""
}

func edgeCommand(ctx context.Context, cfg store.EdgeTTS, text, voice string, rate int, cacheDir string) ([]byte, error) {
	bin := EdgeCommandPath(cfg)
	if bin == "" {
		return nil, fmt.Errorf("没有找到 edge-tts 命令: %w", exec.ErrNotFound)
	}
	dir, err := os.MkdirTemp(cacheDir, "edge-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	// 文字写进文件再交给它，不经过命令行，长文本和特殊字符都不会出问题。
	in, out := filepath.Join(dir, "in.txt"), filepath.Join(dir, "out.mp3")
	if err := os.WriteFile(in, []byte(text), 0o600); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := platform.Command(ctx, bin, "--voice", voice, "--rate="+rateText(rate), "--file", in, "--write-media", out)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if i := strings.LastIndex(msg, "\n"); i >= 0 {
			msg = msg[i+1:]
		}
		if msg == "" {
			msg = err.Error()
		}
		return nil, errors.New(msg)
	}
	return os.ReadFile(out)
}

// EdgeVoiceInfo 是一个可选的音色。
type EdgeVoiceInfo struct {
	Name   string `json:"name"`
	Locale string `json:"locale"`
	Gender string `json:"gender"`
	Label  string `json:"label"`
}

// EdgeVoices 从微软拉取全部音色。
func EdgeVoices(ctx context.Context, dataDir string) ([]EdgeVoiceInfo, error) {
	p, _ := LoadEdgeProfile(dataDir)
	target := p.Voices + "?trustedclienttoken=" + p.Token + p.gecQuery()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", p.userAgent())
	req.Header.Set("Accept", "*/*")
	resp, err := HTTPClient.Do(req)
	if err != nil {
		return nil, shortError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("拉取音色列表失败（HTTP %d）", resp.StatusCode)
	}
	var raw []struct {
		ShortName, Locale, Gender, FriendlyName string
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&raw); err != nil {
		return nil, errors.New("音色列表的格式变了")
	}
	out := make([]EdgeVoiceInfo, 0, len(raw))
	for _, v := range raw {
		out = append(out, EdgeVoiceInfo{Name: v.ShortName, Locale: v.Locale, Gender: v.Gender, Label: v.FriendlyName})
	}
	return out, nil
}
