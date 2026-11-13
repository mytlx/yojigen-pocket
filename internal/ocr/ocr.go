// Package ocr 识别图片里的文字：系统自带的离线识别（macOS Vision、Windows.Media.Ocr），或大模型。
package ocr

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"

	"yojigen-pocket/internal/llm"
)

// Result 是识别结果。
type Result struct {
	Text   string   `json:"text"`
	Lines  []string `json:"lines"`
	Engine string   `json:"engine"`
}

// ErrUnsupported 表示当前系统没有离线识别能力。
var ErrUnsupported = errors.New("这个系统不支持离线文字识别，请在设置里改用大模型识别")

const llmPrompt = `识别图片中的全部文字，按原有的阅读顺序和换行输出。只输出识别到的文字，不要描述图片，不要解释。如果没有文字，输出空内容。`

// Options 是识别选项。
type Options struct {
	Engine   string     // system | claude | openai
	Language string     // 系统识别的语言：zh | en | ja | ko
	Model    llm.Config // 大模型识别用的接口
	TempDir  string     // 放预处理图片的目录
}

// Recognize 识别图片。Engine 为 system 时用系统自带的识别，否则用大模型。
func Recognize(ctx context.Context, path string, opts Options) (Result, error) {
	if opts.Engine == "" || opts.Engine == "system" {
		prepared, cleanup := Prepare(path, opts.TempDir)
		defer cleanup()
		lines, err := recognizeSystem(ctx, prepared, opts.Language)
		if err != nil {
			return Result{}, err
		}
		lines = CleanLines(lines)
		return Result{Text: strings.Join(lines, "\n"), Lines: lines, Engine: "system"}, nil
	}
	img, err := os.ReadFile(path)
	if err != nil {
		return Result{}, err
	}
	text, err := llm.Stream(ctx, opts.Model, llm.Request{Text: llmPrompt, ImagePNG: img}, nil)
	if err != nil {
		return Result{}, err
	}
	text = strings.TrimSpace(text)
	return Result{Text: text, Lines: strings.Split(text, "\n"), Engine: opts.Engine}, nil
}

var hanSpace = regexp.MustCompile(`(\p{Han}|[，。！？；：、“”‘’（）《》])\s+(\p{Han}|[，。！？；：、“”‘’（）《》])`)

// CleanLines 去掉空行，并去掉汉字之间多余的空格（Windows 的识别结果会在每个汉字之间加空格）。
func CleanLines(lines []string) []string {
	out := lines[:0:0]
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		for {
			next := hanSpace.ReplaceAllString(l, "$1$2")
			if next == l {
				break
			}
			l = next
		}
		out = append(out, l)
	}
	return out
}
