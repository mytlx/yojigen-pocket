package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/tts"
)

// Speech 是发音服务。它有自己的设置（config.speech）和密钥，和翻译用哪个服务无关。
type Speech struct{ a *App }

// SpeechPlan 是一次朗读的安排：长文本切成几段，界面一段一段地合成和播放，第一段很快就能出声。
type SpeechPlan struct {
	Segments []string `json:"segments"`
}

// SpeechResult 是一段的合成结果。URL 为空表示要用系统语音读（调 SpeakSystem）。
type SpeechResult struct {
	URL    string `json:"url,omitempty"`
	Engine string `json:"engine"`
	Note   string `json:"note,omitempty"`
}

// segmentBytes 是一段的大小：够短，合成两三秒就回来；够长，句子之间不会老是断开。
const segmentBytes = 420

// Plan 把要朗读的文字切成段。
func (s *Speech) Plan(text, lang string) SpeechPlan {
	text = strings.TrimSpace(text)
	if r := []rune(text); len(r) > tts.MaxChars {
		text = string(r[:tts.MaxChars])
	}
	if text == "" {
		return SpeechPlan{}
	}
	if s.a.config.Get().Speech.Sentence == tts.System && !(lang == "en" && tts.IsWord(text)) {
		return SpeechPlan{Segments: []string{text}} // 系统语音自己能读长文本，不用切
	}
	return SpeechPlan{Segments: tts.Split(text, segmentBytes)}
}

func (s *Speech) options() tts.Options {
	return tts.Options{
		Config: s.a.config.Get().Speech, CacheDir: s.a.paths.Cache, DataDir: s.a.paths.Data,
		OpenAIKey: s.a.secret(tts.KeyOpenAI),
	}
}

// Synthesize 合成一段。
func (s *Speech) Synthesize(ctx context.Context, text, lang string) (SpeechResult, error) {
	r, err := tts.Synthesize(ctx, s.options(), text, lang)
	if err != nil {
		return SpeechResult{}, err
	}
	out := SpeechResult{Engine: r.Engine, Note: r.Note}
	if r.Path != "" {
		if out.URL = s.a.media.url(r.Path); out.URL == "" {
			out.Engine = tts.System // 本地媒体服务没起来，播不了文件
		}
	}
	return out, nil
}

// SpeakSystem 用系统语音朗读，读完或被 Stop 打断后返回。
func (s *Speech) SpeakSystem(text, lang string) error {
	return speakSystem(text, lang, s.a.config.Get().Speech.Rate)
}

// Stop 停止系统语音。
func (s *Speech) Stop() { stopSpeaking() }

// Test 用指定的引擎合成一句试听。engine：youdao | google | edge | openai | kokoro | system。
func (s *Speech) Test(ctx context.Context, engine string) (SpeechResult, error) {
	o := s.options()
	text, lang := "你好，这是 Yojigen Pocket 的发音试听。Hello, this is a pronunciation test.", "zh"
	switch engine {
	case tts.Youdao, tts.Google:
		o.Config.Word, text, lang = engine, "pocket", "en"
	case tts.System:
		go func() { _ = speakSystem(text, lang, o.Config.Rate) }()
		return SpeechResult{Engine: tts.System}, nil
	default:
		o.Config.Sentence = engine
		if engine == tts.Edge {
			o.Config.Edge.Mode = s.a.config.Get().Speech.Edge.Mode
		}
	}
	r, err := tts.Synthesize(ctx, o, text, lang)
	if err != nil {
		return SpeechResult{}, err
	}
	if r.Engine != engine {
		// 试听要的就是这个引擎行不行，退到了别的引擎就是不行。
		note := strings.TrimSuffix(r.Note, "已改用系统语音。")
		if note == "" {
			note = "没有成功"
		}
		return SpeechResult{}, errors.New(note)
	}
	return SpeechResult{URL: s.a.media.url(r.Path), Engine: r.Engine}, nil
}

// SpeechStatus 是设置页显示的状态。
type SpeechStatus struct {
	ProfileCustom  bool   `json:"profileCustom"`  // 正在用数据目录里的参数文件
	ProfileUpdated string `json:"profileUpdated"` // 参数的日期
	ProfileFile    string `json:"profileFile"`
	Chromium       string `json:"chromium"`
	GEC            string `json:"gec"`
	Command        string `json:"command"` // 找到的外部命令；没有时为空
	KeySet         bool   `json:"keySet"`
}

// Status 返回 Edge 连接参数、外部命令和密钥的状态。
func (s *Speech) Status() SpeechStatus {
	p, custom := tts.LoadEdgeProfile(s.a.paths.Data)
	return SpeechStatus{
		ProfileCustom: custom, ProfileUpdated: p.Updated, ProfileFile: tts.ProfileFile(s.a.paths.Data), Chromium: p.Chromium, GEC: p.GEC,
		Command: tts.EdgeCommandPath(s.a.config.Get().Speech.Edge), KeySet: s.a.secret(tts.KeyOpenAI) != "",
	}
}

// UpdateProfile 从设置里的地址下载最新的连接参数。
func (s *Speech) UpdateProfile(ctx context.Context) (SpeechStatus, error) {
	if _, err := tts.UpdateEdgeProfile(ctx, s.a.paths.Data, s.a.config.Get().Speech.Edge.ProfileURL); err != nil {
		return s.Status(), err
	}
	return s.Status(), nil
}

// ResetProfile 回到内置的连接参数。
func (s *Speech) ResetProfile() (SpeechStatus, error) {
	err := tts.ResetEdgeProfile(s.a.paths.Data)
	return s.Status(), err
}

// EditProfile 用编辑器打开参数文件；还没有时先按当前生效的参数写一份。
func (s *Speech) EditProfile() error {
	file := tts.ProfileFile(s.a.paths.Data)
	if _, err := os.Stat(file); err != nil {
		if err := tts.WriteEdgeProfile(s.a.paths.Data, tts.DefaultEdgeProfile()); err != nil {
			return err
		}
	}
	return (&Settings{a: s.a}).EditFile(file)
}

// InstallCommand 安装或升级外部的 edge-tts 命令，返回安装过程的输出。
// 依次尝试 uv、pipx、pip：哪个有就用哪个。
func (s *Speech) InstallCommand(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	type attempt struct {
		name string
		args []string
	}
	var attempts []attempt
	if p := platform.LookFirst("uv"); p != "" {
		attempts = append(attempts, attempt{p, []string{"tool", "install", "--upgrade", "edge-tts"}})
	}
	if p := platform.LookFirst("pipx"); p != "" {
		attempts = append(attempts, attempt{p, []string{"install", "--force", "edge-tts"}})
	}
	pythons := []string{"python3", "python"}
	if runtime.GOOS == "windows" {
		pythons = []string{"py", "python", "python3"}
	}
	if p := platform.LookFirst(pythons...); p != "" {
		attempts = append(attempts, attempt{p, []string{"-m", "pip", "install", "--user", "--upgrade", "edge-tts"}})
	}
	if len(attempts) == 0 {
		return "", errors.New("没有找到 Python（也没有 uv 或 pipx）。先装 Python，或者自己安装 edge-tts 后把命令路径填到设置里")
	}
	var log bytes.Buffer
	for _, at := range attempts {
		log.WriteString("$ " + filepath.Base(at.name) + " " + strings.Join(at.args, " ") + "\n")
		cmd := platform.Command(ctx, at.name, at.args...)
		cmd.Stdout, cmd.Stderr = &log, &log
		err := cmd.Run()
		log.WriteString("\n")
		if err == nil && tts.EdgeCommandPath(s.a.config.Get().Speech.Edge) != "" {
			return tail(log.String(), 4000), nil
		}
		if ctx.Err() != nil {
			return tail(log.String(), 4000), errors.New("安装超时")
		}
	}
	if tts.EdgeCommandPath(s.a.config.Get().Speech.Edge) != "" {
		return tail(log.String(), 4000), nil
	}
	return tail(log.String(), 4000), errors.New("没有装成功，看下面的输出")
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[len(s)-n:]
	for len(s) > 0 && !utf8.RuneStart(s[0]) {
		s = s[1:]
	}
	return "…" + s
}

// Voices 从微软拉取 Edge 的全部音色。
func (s *Speech) Voices(ctx context.Context) ([]tts.EdgeVoiceInfo, error) {
	return tts.EdgeVoices(ctx, s.a.paths.Data)
}

// SetKey 保存语音接口的密钥（存在系统钥匙串里）；传空字符串是删除。
func (s *Speech) SetKey(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return mygo.Secrets.Delete(tts.KeyOpenAI)
	}
	return mygo.Secrets.Set(tts.KeyOpenAI, []byte(value))
}
