//go:build windows

package providers

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/scripts"
	"yojigen-pocket/internal/store"
)

func findEverything(cfg *store.Config) string {
	if p := cfg.Files.EverythingPath; p != "" {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if p := platform.LookFirst("es.exe"); p != "" {
		return p
	}
	for _, dir := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")} {
		p := filepath.Join(dir, "Everything", "es.exe")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// nativeSearch 用 Everything 的命令行工具 es.exe 搜索。输入原样透传，Everything 语法都能用。
func nativeSearch(ctx context.Context, text string, cfg *store.Config, limit int) ([]string, bool) {
	es := findEverything(cfg)
	if es == "" {
		return nil, false
	}
	lines, err := readLines(ctx, limit, es, "-n", "50", text)
	if err != nil {
		return nil, false
	}
	return lines, true
}

// EverythingStatus 返回 es.exe 的路径和是否可用。
func EverythingStatus(cfg *store.Config) (string, bool) {
	p := findEverything(cfg)
	return p, p != ""
}

func findEngine(cfg *store.Config) (string, string) {
	if findEverything(cfg) != "" {
		return "everything", "用 Everything 搜全盘，它的语法都能用：通配符 * ?、ext:pdf、size:>10mb、dm:today、路径里带 \\ 等。"
	}
	return "index", "没有找到 Everything 的命令行工具 es.exe，现在只搜设置里指定的目录。装上 Everything 和 es.exe 后可以搜全盘。"
}

// nativeFind 用 Everything 搜索。输入按词原样交给 es.exe，Everything 的语法都能用；类型筛选也翻译成它的语法。
func nativeFind(ctx context.Context, req FindRequest, cfg *store.Config) ([]string, string, string, bool) {
	es := findEverything(cfg)
	if es == "" {
		return nil, "", "", false
	}
	var filter []string
	switch req.Kind {
	case "", "all":
	case "folder":
		filter = append(filter, "folder:")
	default:
		if list := KindExts(req.Kind); len(list) > 0 {
			filter = append(filter, "ext:"+strings.Join(list, ";"))
		}
	}
	run := func(extra ...string) ([]string, string, error) {
		args := append([]string{"-n", strconv.Itoa(req.Limit)}, extra...)
		args = append(args, filter...)
		args = append(args, queryTokens(req.Query)...)
		cmd := platform.Command(ctx, es, args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		var lines []string
		for _, l := range strings.Split(scripts.Decode(out), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				lines = append(lines, l)
			}
		}
		return lines, strings.TrimSpace(scripts.Decode(stderr.Bytes())), err
	}
	lines, msg, err := run()
	if err != nil && len(lines) == 0 {
		// Everything 1.5 测试版的实例名不一样，再试一次。
		if l2, _, err2 := run("-instance", "1.5a"); err2 == nil {
			lines, err = l2, nil
		}
	}
	if err != nil && len(lines) == 0 {
		if ctx.Err() != nil {
			return nil, "everything", "", true
		}
		if msg == "" {
			msg = err.Error()
		}
		// 多半是 Everything 没在运行，或者语法有误：说明原因，退回内置索引。
		return nil, "", "Everything 没有给出结果（" + msg + "），这次只搜了设置里指定的目录。请确认 Everything 正在运行、搜索语法没有写错。", false
	}
	_, note := findEngine(cfg)
	return lines, "everything", note, true
}
