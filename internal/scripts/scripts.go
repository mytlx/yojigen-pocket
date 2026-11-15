// Package scripts 实现「脚本即工具」：解析脚本头部的 @pocket. 元数据、执行脚本、解析输出。
package scripts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"

	"yojigen-pocket/internal/core"
)

// 输出模式。
const (
	ModeSilent = "silent"
	ModeToast  = "toast"
	ModeText   = "text"
	ModeDetail = "detail"
	ModeList   = "list"
	ModeFilter = "filter"
	ModePanel  = "panel"
)

// Arg 是脚本声明的一个参数。
type Arg struct {
	Name        string   `json:"name"`
	Placeholder string   `json:"placeholder,omitempty"`
	Type        string   `json:"type,omitempty"`
	Options     []string `json:"options,omitempty"`
	Optional    bool     `json:"optional,omitempty"`
	Default     string   `json:"default,omitempty"`
}

// Command 是一个脚本命令。
type Command struct {
	Path        string        `json:"path"`
	Name        string        `json:"name"`
	Title       string        `json:"title"`
	Desc        string        `json:"desc,omitempty"`
	Keywords    []string      `json:"keywords,omitempty"`
	Icon        string        `json:"icon,omitempty"`
	Mode        string        `json:"mode"`
	Args        []Arg         `json:"args,omitempty"`
	Hotkey      string        `json:"hotkey,omitempty"`
	When        []string      `json:"when,omitempty"`
	Fallback    bool          `json:"fallback,omitempty"`
	Timeout     time.Duration `json:"-"`
	Cwd         string        `json:"cwd,omitempty"`
	Confirm     string        `json:"confirm,omitempty"`
	Refresh     time.Duration `json:"-"`
	Interpreter string        `json:"interpreter,omitempty"`
	Problems    []string      `json:"problems,omitempty"`
}

var metaRe = regexp.MustCompile(`@pocket\.([a-zA-Z0-9_]+)(?:[ \t]+(.*?))?[ \t]*$`)

const metaLines = 40

var validModes = map[string]bool{
	ModeSilent: true, ModeToast: true, ModeText: true, ModeDetail: true,
	ModeList: true, ModeFilter: true, ModePanel: true,
}

// Parse 解析脚本文件的元数据。所有元数据都可选，不写就用文件名作标题。
func Parse(path string, content []byte) *Command {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	c := &Command{Path: path, Name: name, Title: name, Mode: ModeSilent, Timeout: 10 * time.Second}

	lines := bytes.SplitN(content, []byte("\n"), metaLines+1)
	if len(lines) > metaLines {
		lines = lines[:metaLines]
	}
	for i, raw := range lines {
		m := metaRe.FindSubmatch(bytes.TrimRight(raw, "\r"))
		if m == nil {
			continue
		}
		key, value := string(m[1]), string(m[2])
		problem := func(format string, a ...any) {
			c.Problems = append(c.Problems, fmt.Sprintf("第 %d 行：", i+1)+fmt.Sprintf(format, a...))
		}
		switch key {
		case "title":
			if value != "" {
				c.Title = value
			}
		case "desc":
			c.Desc = value
		case "keywords":
			for _, k := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == '，' }) {
				if k = strings.TrimSpace(k); k != "" {
					c.Keywords = append(c.Keywords, k)
				}
			}
		case "icon":
			c.Icon = value
		case "mode":
			if validModes[value] {
				c.Mode = value
			} else {
				problem("未知的 mode「%s」", value)
			}
		case "arg", "arg1", "arg2", "arg3":
			var a Arg
			if strings.HasPrefix(value, "{") {
				if err := json.Unmarshal([]byte(value), &a); err != nil {
					problem("参数不是合法的 JSON：%v", err)
					continue
				}
			} else {
				a.Name = value
			}
			if a.Name == "" {
				a.Name = "arg" + strconv.Itoa(len(c.Args)+1)
			}
			if a.Type == "" {
				a.Type = "text"
			}
			c.Args = append(c.Args, a)
		case "hotkey":
			c.Hotkey = value
		case "when":
			for _, k := range strings.Split(value, ",") {
				if k = strings.TrimSpace(k); k != "" {
					c.When = append(c.When, strings.ToLower(k))
				}
			}
		case "fallback":
			c.Fallback = value == "" || value == "true"
		case "timeout":
			if n, err := strconv.ParseFloat(value, 64); err == nil && n > 0 {
				c.Timeout = time.Duration(n * float64(time.Second))
			} else {
				problem("timeout 应为正数（秒）")
			}
		case "cwd":
			c.Cwd = value
		case "confirm":
			c.Confirm = value
		case "refresh":
			if n, err := strconv.ParseFloat(value, 64); err == nil && n >= 0 {
				c.Refresh = time.Duration(n * float64(time.Second))
			} else {
				problem("refresh 应为非负数（秒）")
			}
		case "interpreter":
			c.Interpreter = value
		default:
			problem("未知的元数据「%s」", key)
		}
	}
	return c
}

// Runnable 判断目录里的文件能否作为命令。
func Runnable(path string, info os.FileInfo) bool {
	base := filepath.Base(path)
	if strings.HasPrefix(base, ".") || strings.HasPrefix(base, "_") || info.IsDir() {
		return false
	}
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".sh", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".php", ".lua":
		return true
	case ".ps1", ".bat", ".cmd", ".exe", ".lnk", ".ahk":
		return runtime.GOOS == "windows" || ext == ".ps1"
	case ".applescript", ".scpt", ".command":
		return runtime.GOOS == "darwin"
	case "":
		return info.Mode()&0o111 != 0
	}
	return false
}

// Decode 把脚本输出转成 UTF-8：先按 UTF-8，失败再按 GBK（Windows 中文系统的默认代码页）。
func Decode(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	if out, err := simplifiedchinese.GB18030.NewDecoder().Bytes(b); err == nil {
		return string(out)
	}
	return strings.ToValidUTF8(string(b), "�")
}

// ansiSeq 匹配终端的转义序列：颜色（ESC[32;1m）、移动光标、清屏、设置标题等。
var ansiSeq = regexp.MustCompile("\x1b\\[[0-9;?<=>!]*[ -/]*[@-~]|\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78cDEHMNOZ]")

// StripANSI 去掉终端的转义序列。很多程序（PowerShell 7 的表头、各种编译器）不管输出的是不是终端
// 都带颜色码，原样显示出来是一堆 [32;1m。脚本命令和命令行的输出只当纯文本用，直接去掉。
func StripANSI(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	return ansiSeq.ReplaceAllString(s, "")
}

// DecodeText 是 Decode 加上 StripANSI：给只显示纯文本的地方用。
func DecodeText(b []byte) string { return StripANSI(Decode(b)) }

// ParseList 解析 list / filter 模式的输出：JSON（{"items":[...]} 或数组），或者每行一项的 Tab 分隔文本。
func ParseList(output string) []core.Item {
	s := strings.TrimSpace(output)
	if s == "" {
		return nil
	}
	if s[0] == '{' || s[0] == '[' {
		var obj struct {
			Items []core.Item `json:"items"`
		}
		if s[0] == '{' && json.Unmarshal([]byte(s), &obj) == nil {
			return normalizeItems(obj.Items)
		}
		var arr []core.Item
		if s[0] == '[' && json.Unmarshal([]byte(s), &arr) == nil {
			return normalizeItems(arr)
		}
	}
	var items []core.Item
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		it := core.Item{Title: parts[0]}
		action := ""
		if len(parts) > 1 {
			it.Subtitle = parts[1]
		}
		if len(parts) > 2 {
			action = parts[2]
		}
		if action == "" {
			action = parts[0]
		}
		it.Actions = []core.Action{ParseActionSpec(action)}
		items = append(items, it)
	}
	return items
}

func normalizeItems(items []core.Item) []core.Item {
	out := items[:0]
	for _, it := range items {
		if it.Title == "" {
			continue
		}
		if len(it.Actions) == 0 {
			it.Actions = []core.Action{ParseActionSpec(it.Title)}
		}
		for i := range it.Actions {
			if it.Actions[i].Title == "" {
				it.Actions[i].Title = defaultActionTitle(it.Actions[i].Type)
			}
		}
		out = append(out, it)
	}
	return out
}

func defaultActionTitle(t core.ActionType) string {
	switch t {
	case core.ActionOpen:
		return "打开"
	case core.ActionReveal:
		return "在文件夹中显示"
	case core.ActionCopy:
		return "复制"
	case core.ActionPaste:
		return "粘贴"
	case core.ActionTyping:
		return "键入"
	case core.ActionRun, core.ActionShell:
		return "执行"
	}
	return "执行"
}

// ParseActionSpec 解析纯文本里的动作：open:、copy:、paste:、shell:、run: 前缀；
// 不写前缀时，像路径或网址就打开，否则复制。
func ParseActionSpec(spec string) core.Action {
	if kind, rest, ok := strings.Cut(spec, ":"); ok {
		switch kind {
		case "open":
			return core.Action{Type: core.ActionOpen, Title: "打开", Target: rest}
		case "copy":
			return core.Action{Type: core.ActionCopy, Title: "复制", Text: rest}
		case "paste":
			return core.Action{Type: core.ActionPaste, Title: "粘贴", Text: rest}
		case "shell":
			return core.Action{Type: core.ActionShell, Title: "执行", Command: rest}
		case "run":
			return core.Action{Type: core.ActionRun, Title: "执行", Command: rest}
		}
	}
	if LooksOpenable(spec) {
		return core.Action{Type: core.ActionOpen, Title: "打开", Target: spec}
	}
	return core.Action{Type: core.ActionCopy, Title: "复制", Text: spec}
}

// LooksOpenable 判断文本是否像网址或路径。
func LooksOpenable(s string) bool {
	if strings.Contains(s, "://") {
		return true
	}
	if strings.HasPrefix(s, "/") || strings.HasPrefix(s, "~/") || strings.HasPrefix(s, `~\`) {
		return true
	}
	return len(s) > 2 && s[1] == ':' && (s[2] == '\\' || s[2] == '/')
}
