package store

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sync"
)

// Appearance 是外观设置。
type Appearance struct {
	Theme       string `json:"theme"`       // system | light | dark
	Accent      string `json:"accent"`      // #rrggbb，或 system 跟随系统
	Material    string `json:"material"`    // glass | clear | hud | none
	Tint        int    `json:"tint"`        // 玻璃上的底色浓度 0-100，越高越清晰
	Width       int    `json:"width"`       // 主窗口宽度
	Rows        int    `json:"rows"`        // 列表可见行数
	Density     string `json:"density"`     // compact | normal | comfortable
	FontSize    int    `json:"fontSize"`    // 基础字号
	ShowSource  bool   `json:"showSource"`  // 结果行显示来源标记
	ShowPreview bool   `json:"showPreview"` // 有内容时显示右侧预览
	ShowMeta    bool   `json:"showMeta"`    // 预览文件时显示属性
}

// Module 是一个功能模块（数据源）的开关和触发方式。
type Module struct {
	Enabled bool    `json:"enabled"`
	Prefix  string  `json:"prefix"`
	Global  bool    `json:"global"` // 是否参与无前缀的全局搜索
	Weight  float64 `json:"weight"`
}

// WebEntry 是一条网页搜索或网址别名。URL 中的 {q} 会替换成输入内容。
type WebEntry struct {
	Key      string `json:"key"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	Icon     string `json:"icon,omitempty"`
	Fallback bool   `json:"fallback,omitempty"` // 无匹配时作为兜底候选
}

// ClipboardConfig 是剪贴板历史设置。
type ClipboardConfig struct {
	MaxItems   int      `json:"maxItems"`
	MaxDays    int      `json:"maxDays"`
	Images     bool     `json:"images"`
	IgnoreApps []string `json:"ignoreApps"` // 这些应用复制的内容不记录
}

// FilesConfig 是文件搜索设置。
type FilesConfig struct {
	Roots          []string `json:"roots"`          // 内置索引扫描的目录
	EverythingPath string   `json:"everythingPath"` // Windows：es.exe 路径，留空自动查找
	FindPreview    bool     `json:"findPreview"`    // 高级搜索：显示预览区
	FindMeta       bool     `json:"findMeta"`       // 高级搜索：显示属性区
	FindScope      string   `json:"findScope"`      // 高级搜索的范围：home | all（macOS）
}

// Keys 是窗口内的快捷键（accelerator 写法，CmdOrCtrl 表示 macOS 的 ⌘、其他系统的 Ctrl）。
type Keys struct {
	Detach string `json:"detach"` // 把功能页分离成独立窗口
}

// LLMConfig 是一个大模型接口的设置。密钥不写在这里，存在系统的凭据管理器里。
type LLMConfig struct {
	BaseURL string `json:"baseUrl,omitempty"`
	Model   string `json:"model"`
}

// TranslateConfig 是翻译设置。
type TranslateConfig struct {
	Provider     string    `json:"provider"` // claude | openai | youdao | baidu
	From         string    `json:"from"`
	To           string    `json:"to"`
	Voice        string    `json:"voice"` // 已不用：发音有了自己的设置（Speech）
	AutoSpeak    bool      `json:"autoSpeak"`
	Claude       LLMConfig `json:"claude"`
	OpenAI       LLMConfig `json:"openai"`
	YoudaoAppKey string    `json:"youdaoAppKey,omitempty"`
	BaiduAppID   string    `json:"baiduAppId,omitempty"`
}

// SpeechConfig 是发音设置，和翻译用哪个服务无关。
type SpeechConfig struct {
	Word     string    `json:"word"`     // 单个英文单词：youdao | google | sentence（和句子用同一个引擎）
	Sentence string    `json:"sentence"` // 句子和长文本：edge | system | openai | kokoro
	Accent   string    `json:"accent"`   // 英语口音：us | uk
	Rate     int       `json:"rate"`     // 语速增减的百分比，-50 到 100
	Edge     EdgeTTS   `json:"edge"`
	OpenAI   SpeechAPI `json:"openai"` // OpenAI 兼容的语音接口（/audio/speech）
	Kokoro   SpeechAPI `json:"kokoro"` // 本地部署的 Kokoro（Kokoro-FastAPI 也是 OpenAI 兼容接口）
}

// EdgeTTS 是微软 Edge 在线语音的设置。
type EdgeTTS struct {
	Voices map[string]string `json:"voices"` // 语言 → 音色，例如 zh → zh-CN-XiaoxiaoNeural
	// Mode 决定怎么连：auto 先用内置实现，失败了再试外部命令；builtin 只用内置；command 只用外部命令。
	Mode       string `json:"mode"`
	Command    string `json:"command"`    // 外部命令，默认 edge-tts（pip install edge-tts）
	ProfileURL string `json:"profileUrl"` // 连接参数的在线更新地址（JSON）
}

// SpeechAPI 是一个 OpenAI 兼容的语音合成接口。
type SpeechAPI struct {
	BaseURL string `json:"baseUrl"`
	Model   string `json:"model"`
	Voice   string `json:"voice"`
}

// DefaultEdgeVoices 是各语言默认的 Edge 音色。
func DefaultEdgeVoices() map[string]string {
	return map[string]string{
		"zh": "zh-CN-XiaoxiaoNeural", "en": "en-US-AvaMultilingualNeural", "ja": "ja-JP-NanamiNeural", "ko": "ko-KR-SunHiNeural",
		"fr": "fr-FR-DeniseNeural", "de": "de-DE-KatjaNeural", "es": "es-ES-ElviraNeural", "ru": "ru-RU-SvetlanaNeural",
	}
}

// OCRConfig 是截图识别设置。
type OCRConfig struct {
	Engine   string `json:"engine"`   // system | claude | openai（大模型接口复用翻译里的设置）
	Language string `json:"language"` // 系统识别的语言：zh（中文+英文）| en | ja | ko
}

// SelectionConfig 是「带入选中的文字」设置。
type SelectionConfig struct {
	// off：关闭；accessibility：只通过辅助功能读取，不动剪贴板（仅 macOS）；
	// auto：读取不到时模拟一次复制，读完恢复剪贴板。
	Mode string `json:"mode"`
}

// ReaderConfig 是摸鱼阅读设置。
type ReaderConfig struct {
	BossKey        string  `json:"bossKey"` // 一键隐藏/显示阅读窗口
	PrevKey        string  `json:"prevKey"` // 全局上一页
	NextKey        string  `json:"nextKey"` // 全局下一页
	FontSize       int     `json:"fontSize"`
	LineHeight     float64 `json:"lineHeight"`
	Theme          string  `json:"theme"`          // auto | paper | green | dark
	StealthOpacity int     `json:"stealthOpacity"` // 摸鱼窗口鼠标移开后的文字可见度 5-100
	StealthLines   int     `json:"stealthLines"`   // 摸鱼窗口显示的行数
	AutoPageSecs   int     `json:"autoPageSecs"`   // 自动翻页间隔，0 为关闭
}

// Config 是 config.json 的完整结构。
type Config struct {
	Hotkey          string            `json:"hotkey"`
	HideOnBlur      bool              `json:"hideOnBlur"`
	RememberSeconds int               `json:"rememberSeconds"` // 再次唤出时保留上次输入的秒数
	AutoFillSeconds int               `json:"autoFillSeconds"` // 唤出时自动填入 N 秒内复制的文本，0 为关闭
	MaxResults      int               `json:"maxResults"`
	HalfLifeDays    float64           `json:"halfLifeDays"` // 使用记录的半衰期
	Editor          string            `json:"editor"`       // 打开脚本用的编辑器命令，留空用系统默认
	Appearance      Appearance        `json:"appearance"`
	Modules         map[string]Module `json:"modules"`
	Web             []WebEntry        `json:"web"`
	Hotkeys         map[string]string `json:"hotkeys"`  // 命令 ID → 直达热键
	Disabled        []string          `json:"disabled"` // 隐藏的命令 ID
	Clipboard       ClipboardConfig   `json:"clipboard"`
	Files           FilesConfig       `json:"files"`
	Interpreters    map[string]string `json:"interpreters"` // 扩展名 → 解释器
	URIAllowlist    []string          `json:"uriAllowlist"` // 允许通过 URI 直接执行的命令 ID
	Keys            Keys              `json:"keys"`
	DisabledPlugins []string          `json:"disabledPlugins"` // 停用的扩展：不加载、不占快捷键、窗口和后端进程都关掉
	DetachOnHotkey  map[string]bool   `json:"detachOnHotkey"`  // 这些命令按直达热键时直接以独立窗口打开
	HotkeyInput     map[string]string `json:"hotkeyInput"`     // 这些命令按直达热键时带入的内容：selection（默认）| clipboard | both | none
	Translate       TranslateConfig   `json:"translate"`
	Speech          SpeechConfig      `json:"speech"`
	OCR             OCRConfig         `json:"ocr"`
	Reader          ReaderConfig      `json:"reader"`
	Selection       SelectionConfig   `json:"selection"`
	PanelPosition   string            `json:"panelPosition"` // remember：记住拖动后的位置；center：每次在鼠标所在屏幕居中
}

// DefaultClaudeModel 是翻译和识别默认使用的 Claude 模型。
const DefaultClaudeModel = "claude-opus-5-5"

// DefaultHotkey 是默认的唤出热键。
const DefaultHotkey = "Alt+Space"

// DefaultModules 是各模块的默认配置。
func DefaultModules() map[string]Module {
	return map[string]Module{
		"apps":      {Enabled: true, Global: true, Weight: 1},
		"scripts":   {Enabled: true, Global: true, Weight: 1},
		"plugins":   {Enabled: true, Global: true, Weight: 1},
		"system":    {Enabled: true, Global: true, Weight: 1},
		"self":      {Enabled: true, Global: true, Weight: 1, Prefix: "pocket"},
		"calc":      {Enabled: true, Global: true, Weight: 1, Prefix: "="},
		"tools":     {Enabled: true, Global: true, Weight: 0.95},
		"snippets":  {Enabled: true, Global: true, Weight: 0.9, Prefix: "sn"},
		"clipboard": {Enabled: true, Global: false, Weight: 1, Prefix: "cb"},
		"files":     {Enabled: true, Global: true, Weight: 0.7, Prefix: "f"},
		"paths":     {Enabled: true, Global: true, Weight: 1},
		"shell":     {Enabled: true, Global: false, Weight: 1, Prefix: ">"},
		"features":  {Enabled: true, Global: true, Weight: 1.05},
		"windows":   {Enabled: true, Global: true, Weight: 1.1},
		"web":       {Enabled: true, Global: true, Weight: 0.5, Prefix: "?"},
		"wintools":  {Enabled: true, Global: true, Weight: 1},
	}
}

// DefaultConfig 返回默认配置。
func DefaultConfig() *Config {
	ignore := []string{"1Password", "KeePassXC", "Bitwarden", "LastPass", "Keychain Access", "钥匙串访问"}
	if runtime.GOOS == "windows" {
		ignore = []string{"1Password.exe", "KeePassXC.exe", "Bitwarden.exe", "LastPass.exe"}
	}
	return &Config{
		Hotkey:          DefaultHotkey,
		HideOnBlur:      true,
		RememberSeconds: 3,
		AutoFillSeconds: 0,
		MaxResults:      50,
		HalfLifeDays:    14,
		Appearance: Appearance{
			Theme:       "system",
			Accent:      "#2f6bff",
			Material:    "glass",
			Tint:        55,
			Width:       760,
			Rows:        8,
			Density:     "normal",
			FontSize:    14,
			ShowSource:  true,
			ShowPreview: true,
			ShowMeta:    true,
		},
		Modules: DefaultModules(),
		Web: []WebEntry{
			{Key: "g", Title: "Google", URL: "https://www.google.com/search?q={q}", Icon: "svg:search", Fallback: true},
			{Key: "bd", Title: "百度", URL: "https://www.baidu.com/s?wd={q}", Icon: "svg:search", Fallback: true},
			{Key: "bing", Title: "必应", URL: "https://www.bing.com/search?q={q}", Icon: "svg:search"},
			{Key: "gh", Title: "GitHub", URL: "https://github.com/search?q={q}", Icon: "svg:code"},
			{Key: "zh", Title: "知乎", URL: "https://www.zhihu.com/search?q={q}", Icon: "svg:globe"},
			{Key: "bili", Title: "哔哩哔哩", URL: "https://search.bilibili.com/all?keyword={q}", Icon: "svg:globe"},
		},
		Hotkeys:         map[string]string{},
		Disabled:        []string{},
		Clipboard:       ClipboardConfig{MaxItems: 1000, MaxDays: 30, Images: true, IgnoreApps: ignore},
		Files:           FilesConfig{Roots: []string{"~/Desktop", "~/Documents", "~/Downloads"}, FindPreview: true, FindMeta: true, FindScope: "home"},
		Interpreters:    map[string]string{},
		URIAllowlist:    []string{},
		Keys:            Keys{Detach: "CmdOrCtrl+D"},
		DisabledPlugins: []string{},
		DetachOnHotkey:  map[string]bool{},
		HotkeyInput:     map[string]string{},
		Speech: SpeechConfig{
			Word: "youdao", Sentence: "edge", Accent: "us",
			Edge:   EdgeTTS{Mode: "auto", Command: "edge-tts", Voices: DefaultEdgeVoices()},
			OpenAI: SpeechAPI{BaseURL: "https://api.openai.com/v1", Model: "gpt-4o-mini-tts", Voice: "alloy"},
			Kokoro: SpeechAPI{BaseURL: "http://127.0.0.1:8880/v1", Model: "kokoro", Voice: "af_heart"},
		},
		Translate: TranslateConfig{
			Provider: "claude", From: "auto", To: "auto", Voice: "system",
			Claude: LLMConfig{Model: DefaultClaudeModel},
			OpenAI: LLMConfig{BaseURL: "https://api.openai.com/v1"},
		},
		OCR:           OCRConfig{Engine: "system", Language: "zh"},
		Selection:     SelectionConfig{Mode: "auto"},
		PanelPosition: "remember",
		Reader: ReaderConfig{
			BossKey: "Alt+Shift+M", FontSize: 17, LineHeight: 1.85, Theme: "auto",
			StealthOpacity: 18, StealthLines: 2,
		},
	}
}

// Normalize 把越界或缺失的字段拉回合理范围，避免手改配置把界面弄坏。
func (c *Config) Normalize() {
	d := DefaultConfig()
	if c.Hotkey == "" {
		c.Hotkey = d.Hotkey
	}
	if c.MaxResults <= 0 {
		c.MaxResults = d.MaxResults
	}
	if c.HalfLifeDays <= 0 {
		c.HalfLifeDays = d.HalfLifeDays
	}
	a := &c.Appearance
	if a.Theme != "light" && a.Theme != "dark" {
		a.Theme = "system"
	}
	if a.Accent == "" {
		a.Accent = d.Appearance.Accent
	}
	switch a.Material {
	case "glass", "clear", "hud", "none":
	default:
		a.Material = "glass"
	}
	a.Tint = clamp(a.Tint, 0, 100)
	if a.Width == 0 {
		a.Width = d.Appearance.Width
	}
	a.Width = clamp(a.Width, 520, 1200)
	if a.Rows == 0 {
		a.Rows = d.Appearance.Rows
	}
	a.Rows = clamp(a.Rows, 4, 14)
	switch a.Density {
	case "compact", "normal", "comfortable":
	default:
		a.Density = "normal"
	}
	if a.FontSize == 0 {
		a.FontSize = d.Appearance.FontSize
	}
	a.FontSize = clamp(a.FontSize, 12, 18)
	if c.Clipboard.MaxItems <= 0 {
		c.Clipboard.MaxItems = d.Clipboard.MaxItems
	}
	if c.Clipboard.MaxDays <= 0 {
		c.Clipboard.MaxDays = d.Clipboard.MaxDays
	}
	if c.Modules == nil {
		c.Modules = map[string]Module{}
	}
	for id, m := range DefaultModules() {
		if _, ok := c.Modules[id]; !ok {
			c.Modules[id] = m
		}
	}
	if c.Hotkeys == nil {
		c.Hotkeys = map[string]string{}
	}
	if c.Disabled == nil {
		c.Disabled = []string{}
	}
	if c.Web == nil {
		c.Web = []WebEntry{}
	}
	if c.Interpreters == nil {
		c.Interpreters = map[string]string{}
	}
	if c.URIAllowlist == nil {
		c.URIAllowlist = []string{}
	}
	if c.Clipboard.IgnoreApps == nil {
		c.Clipboard.IgnoreApps = []string{}
	}
	if c.Files.Roots == nil {
		c.Files.Roots = []string{}
	}
	if c.Keys.Detach == "" {
		c.Keys.Detach = d.Keys.Detach
	}
	if c.DisabledPlugins == nil {
		c.DisabledPlugins = []string{}
	}
	if c.DetachOnHotkey == nil {
		c.DetachOnHotkey = map[string]bool{}
	}
	if c.HotkeyInput == nil {
		c.HotkeyInput = map[string]string{}
	}
	for id, mode := range c.HotkeyInput {
		switch mode {
		case "clipboard", "both", "none":
		default:
			delete(c.HotkeyInput, id)
		}
	}
	t := &c.Translate
	switch t.Provider {
	case "claude", "openai", "youdao", "baidu":
	default:
		t.Provider = d.Translate.Provider
	}
	if t.From == "" {
		t.From = "auto"
	}
	if t.To == "" {
		t.To = "auto"
	}
	if t.Voice != "youdao" {
		t.Voice = "system"
	}
	if t.Claude.Model == "" {
		t.Claude.Model = DefaultClaudeModel
	}
	switch c.OCR.Engine {
	case "system", "claude", "openai":
	default:
		c.OCR.Engine = "system"
	}
	switch c.OCR.Language {
	case "zh", "en", "ja", "ko":
	default:
		c.OCR.Language = "zh"
	}
	switch c.Selection.Mode {
	case "off", "accessibility", "auto":
	default:
		c.Selection.Mode = "auto"
	}
	if c.PanelPosition != "center" {
		c.PanelPosition = "remember"
	}
	r := &c.Reader
	if r.FontSize == 0 {
		r.FontSize = d.Reader.FontSize
	}
	r.FontSize = clamp(r.FontSize, 12, 32)
	if r.LineHeight < 1.2 || r.LineHeight > 3 {
		r.LineHeight = d.Reader.LineHeight
	}
	switch r.Theme {
	case "auto", "paper", "green", "dark":
	default:
		r.Theme = "auto"
	}
	if r.StealthOpacity == 0 {
		r.StealthOpacity = d.Reader.StealthOpacity
	}
	r.StealthOpacity = clamp(r.StealthOpacity, 5, 100)
	if r.StealthLines == 0 {
		r.StealthLines = d.Reader.StealthLines
	}
	r.StealthLines = clamp(r.StealthLines, 1, 6)
	r.AutoPageSecs = clamp(r.AutoPageSecs, 0, 120)
}

func clamp(v, lo, hi int) int {
	return min(max(v, lo), hi)
}

// ParseConfig 解析配置：缺失的字段（包括模块里缺失的字段）都保持默认值。
func ParseConfig(data []byte) (*Config, error) {
	c := DefaultConfig()
	var raw struct {
		Modules map[string]json.RawMessage `json:"modules"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, describeJSONError(data, err)
	}
	modules := DefaultModules() // Unmarshal 会整项替换 map 的值，所以这里单独按字段合并
	if err := json.Unmarshal(data, c); err != nil {
		return nil, describeJSONError(data, err)
	}
	for id, msg := range raw.Modules {
		m := modules[id]
		if err := json.Unmarshal(msg, &m); err != nil {
			return nil, fmt.Errorf("modules.%s: %w", id, err)
		}
		modules[id] = m
	}
	c.Modules = modules
	c.Normalize()
	return c, nil
}

func describeJSONError(data []byte, err error) error {
	if se, ok := err.(*json.SyntaxError); ok {
		line := 1
		for _, b := range data[:min(int(se.Offset), len(data))] {
			if b == '\n' {
				line++
			}
		}
		return fmt.Errorf("第 %d 行：%s", line, se.Error())
	}
	return err
}

// ConfigStore 持有当前生效的配置。配置写错时保留上一份有效配置，并记录错误。
type ConfigStore struct {
	mu      sync.RWMutex
	path    string
	cfg     *Config
	loadErr string
	lastRaw []byte
}

// NewConfigStore 读取配置；文件不存在时写入默认配置。
func NewConfigStore(path string) *ConfigStore {
	s := &ConfigStore{path: path, cfg: DefaultConfig()}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		_ = s.Save(s.cfg)
		return s
	}
	s.Reload()
	return s
}

// Get 返回当前配置。返回值只读：要修改请用 Update 或 Save。
func (s *ConfigStore) Get() *Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

// LoadError 返回配置文件的错误（如有）。
func (s *ConfigStore) LoadError() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.loadErr
}

// Reload 重新读取文件。返回 true 表示内容有变化。
func (s *ConfigStore) Reload() bool {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if string(data) == string(s.lastRaw) {
		return false
	}
	s.lastRaw = data
	cfg, err := ParseConfig(data)
	if err != nil {
		s.loadErr = err.Error()
		return true
	}
	s.cfg, s.loadErr = cfg, ""
	return true
}

// Save 校验并写入配置。
func (s *ConfigStore) Save(c *Config) error {
	c.Normalize()
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := WriteFileAtomic(s.path, data); err != nil {
		return err
	}
	s.cfg, s.loadErr, s.lastRaw = c, "", data
	return nil
}

// Update 在当前配置的副本上修改并保存。
func (s *ConfigStore) Update(fn func(*Config)) error {
	data, err := json.Marshal(s.Get())
	if err != nil {
		return err
	}
	c, err := ParseConfig(data)
	if err != nil {
		return err
	}
	fn(c)
	return s.Save(c)
}
