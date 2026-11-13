package providers

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"yojigen-pocket/internal/store"
)

// FindRequest 是一次高级搜索。
type FindRequest struct {
	Query string `json:"query"`
	Kind  string `json:"kind"`  // FileKinds 里的 ID
	Scope string `json:"scope"` // home | all（Everything 总是搜全盘）
	Limit int    `json:"limit"`
}

// FileHit 是一条搜索结果。
type FileHit struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Dir      string `json:"dir"`
	Ext      string `json:"ext"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	SizeText string `json:"sizeText"`
	Modified int64  `json:"modified"`
	ModText  string `json:"modText"`
	TypeName string `json:"typeName"`
	Icon     string `json:"icon"`
}

// FindResult 是搜索结果和这次用的是哪个引擎。
type FindResult struct {
	Items     []FileHit `json:"items"`
	Engine    string    `json:"engine"` // everything | spotlight | index
	Truncated bool      `json:"truncated"`
	Note      string    `json:"note,omitempty"`
}

// FindEngine 报告当前会用哪个引擎搜索，以及给用户看的说明。
func (f *Files) FindEngine() (engine, note string) {
	return findEngine(f.Config())
}

// Find 执行高级搜索：能用系统的索引（Everything / Spotlight）就用，否则查内置索引。
func (f *Files) Find(ctx context.Context, req FindRequest) FindResult {
	if req.Limit <= 0 || req.Limit > 1000 {
		req.Limit = 300
	}
	req.Query = strings.TrimSpace(req.Query)
	cfg := f.Config()
	res := FindResult{}
	if req.Query == "" && (req.Kind == "" || req.Kind == "all") {
		res.Engine, res.Note = findEngine(cfg)
		return res
	}
	paths, engine, note, ok := nativeFind(ctx, req, cfg)
	if !ok {
		engine = "index"
		paths = f.findIndex(req, cfg)
		if note == "" {
			_, note = findEngine(cfg)
		}
		if f.Indexing() {
			note = "正在建立文件索引，结果可能不全，稍等再搜一次。" + note
		}
	}
	res.Engine, res.Note = engine, note
	res.Truncated = len(paths) >= req.Limit
	seen := map[string]bool{}
	for _, p := range paths {
		if ctx.Err() != nil {
			break
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		info, err := os.Stat(p)
		if err != nil {
			continue
		}
		res.Items = append(res.Items, hitOf(p, info))
	}
	return res
}

func hitOf(p string, info os.FileInfo) FileHit {
	ext := strings.ToLower(filepath.Ext(p))
	h := FileHit{
		Path: p, Name: filepath.Base(p), Dir: filepath.Dir(p), Ext: ext, IsDir: info.IsDir(),
		Modified: info.ModTime().UnixMilli(), ModText: info.ModTime().Format("2006-01-02 15:04"),
		TypeName: typeName(ext, info.IsDir()), Icon: "file:" + p,
	}
	if !info.IsDir() {
		h.Size, h.SizeText = info.Size(), HumanSize(info.Size())
	}
	return h
}

// queryTokens 按空格拆开输入，双引号里的算一个整体。
func queryTokens(q string) []string {
	var out []string
	var cur strings.Builder
	quoted := false
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for _, r := range q {
		switch {
		case r == '"':
			quoted = !quoted
		case unicode.IsSpace(r) && !quoted:
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}

// globMatch 是不区分大小写的通配符匹配；没有通配符时是“包含”。
func globMatch(pattern, name string) bool {
	pattern, name = strings.ToLower(pattern), strings.ToLower(name)
	if !strings.ContainsAny(pattern, "*?") {
		return strings.Contains(name, pattern)
	}
	ok, err := filepath.Match(pattern, name)
	return err == nil && ok
}

// findIndex 在内置索引里查：每个词都要命中文件名，支持 * 和 ? 通配符。
func (f *Files) findIndex(req FindRequest, cfg *store.Config) []string {
	f.ensureIndex(cfg)
	f.mu.Lock()
	index := f.index
	f.mu.Unlock()
	tokens := queryTokens(req.Query)
	var kindExts map[string]bool
	for _, k := range FileKinds {
		if k.ID == req.Kind {
			kindExts = k.Exts
		}
	}
	var out []string
	for _, p := range index {
		base := filepath.Base(p)
		if kindExts != nil && !kindExts[strings.ToLower(filepath.Ext(base))] {
			continue
		}
		hit := true
		for _, t := range tokens {
			if !globMatch(t, base) {
				hit = false
				break
			}
		}
		if !hit {
			continue
		}
		if req.Kind == "folder" {
			if info, err := os.Stat(p); err != nil || !info.IsDir() {
				continue
			}
		}
		out = append(out, p)
		if len(out) >= req.Limit {
			break
		}
	}
	return out
}
