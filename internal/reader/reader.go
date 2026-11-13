// Package reader 是摸鱼阅读的书库：导入 txt / epub，切分章节，记录阅读进度。
// 导入时统一转成 UTF-8 文本存一份，之后读取不再需要原文件。
package reader

import (
	"archive/zip"
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/text/encoding/simplifiedchinese"

	"yojigen-pocket/internal/store"
)

// Book 是书库里的一本书。
type Book struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Format   string    `json:"format"`
	Chars    int       `json:"chars"`
	Chapters int       `json:"chapters"`
	Added    time.Time `json:"added"`
	LastRead time.Time `json:"lastRead,omitzero"`
	Chapter  int       `json:"chapter"`  // 读到第几章
	Position float64   `json:"position"` // 章内位置 0-1
	Percent  float64   `json:"percent"`  // 全书进度 0-100
}

// Chapter 是一章的位置（按字节，指向 UTF-8 文本）。
type Chapter struct {
	Title string `json:"title"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

// ChapterText 是一章的内容。
type ChapterText struct {
	Index int    `json:"index"`
	Total int    `json:"total"`
	Title string `json:"title"`
	Text  string `json:"text"`
}

// Library 是书库。
type Library struct {
	dir   string
	mu    sync.Mutex
	books []*Book
}

// Open 打开书库目录。
func Open(dir string) *Library {
	l := &Library{dir: dir}
	_ = os.MkdirAll(filepath.Join(dir, "books"), 0o755)
	if raw, err := os.ReadFile(l.indexPath()); err == nil {
		_ = json.Unmarshal(raw, &l.books)
	}
	return l
}

func (l *Library) indexPath() string         { return filepath.Join(l.dir, "library.json") }
func (l *Library) textPath(id string) string { return filepath.Join(l.dir, "books", id+".txt") }
func (l *Library) tocPath(id string) string  { return filepath.Join(l.dir, "books", id+".json") }

func (l *Library) save() error {
	raw, err := json.MarshalIndent(l.books, "", " ")
	if err != nil {
		return err
	}
	return store.WriteFileAtomic(l.indexPath(), raw)
}

// Books 返回全部书，最近读过的在前。
func (l *Library) Books() []Book {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Book, len(l.books))
	for i, b := range l.books {
		out[i] = *b
	}
	slices.SortStableFunc(out, func(a, b Book) int {
		ta, tb := a.LastRead, b.LastRead
		if ta.IsZero() {
			ta = a.Added
		}
		if tb.IsZero() {
			tb = b.Added
		}
		return tb.Compare(ta)
	})
	return out
}

func (l *Library) find(id string) *Book {
	for _, b := range l.books {
		if b.ID == id {
			return b
		}
	}
	return nil
}

// Import 导入一本书。同一个文件重复导入时返回已有的那本。
func (l *Library) Import(file string) (Book, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return Book{}, err
	}
	if len(raw) > 200<<20 {
		return Book{}, errors.New("文件太大（超过 200 MB）")
	}
	sum := sha1.Sum(raw)
	id := hex.EncodeToString(sum[:8])
	l.mu.Lock()
	if b := l.find(id); b != nil {
		l.mu.Unlock()
		return *b, nil
	}
	l.mu.Unlock()

	title := strings.TrimSuffix(filepath.Base(file), filepath.Ext(file))
	var text string
	var chapters []Chapter
	format := strings.TrimPrefix(strings.ToLower(filepath.Ext(file)), ".")
	switch format {
	case "epub":
		var epubTitle string
		text, chapters, epubTitle, err = parseEPUB(raw)
		if err != nil {
			return Book{}, err
		}
		if epubTitle != "" {
			title = epubTitle
		}
	default:
		format = "txt"
		text = NormalizeText(DecodeText(raw))
		chapters = SplitChapters(text)
	}
	if strings.TrimSpace(text) == "" {
		return Book{}, errors.New("没有读到文字内容")
	}
	if err := os.WriteFile(l.textPath(id), []byte(text), 0o644); err != nil {
		return Book{}, err
	}
	toc, _ := json.Marshal(chapters)
	if err := os.WriteFile(l.tocPath(id), toc, 0o644); err != nil {
		return Book{}, err
	}
	b := &Book{ID: id, Title: title, Format: format, Chars: utf8.RuneCountInString(text), Chapters: len(chapters), Added: time.Now()}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.books = append(l.books, b)
	return *b, l.save()
}

// Remove 从书库删除一本书。
func (l *Library) Remove(id string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	i := slices.IndexFunc(l.books, func(b *Book) bool { return b.ID == id })
	if i < 0 {
		return errors.New("找不到这本书")
	}
	l.books = slices.Delete(l.books, i, i+1)
	_ = os.Remove(l.textPath(id))
	_ = os.Remove(l.tocPath(id))
	return l.save()
}

func (l *Library) toc(id string) ([]Chapter, error) {
	raw, err := os.ReadFile(l.tocPath(id))
	if err != nil {
		return nil, errors.New("找不到这本书")
	}
	var out []Chapter
	return out, json.Unmarshal(raw, &out)
}

// Chapters 返回目录。
func (l *Library) Chapters(id string) ([]string, error) {
	toc, err := l.toc(id)
	if err != nil {
		return nil, err
	}
	titles := make([]string, len(toc))
	for i, c := range toc {
		titles[i] = c.Title
	}
	return titles, nil
}

// Chapter 读取一章。
func (l *Library) Chapter(id string, index int) (ChapterText, error) {
	toc, err := l.toc(id)
	if err != nil {
		return ChapterText{}, err
	}
	if len(toc) == 0 {
		return ChapterText{}, errors.New("这本书没有内容")
	}
	index = min(max(index, 0), len(toc)-1)
	f, err := os.Open(l.textPath(id))
	if err != nil {
		return ChapterText{}, err
	}
	defer f.Close()
	c := toc[index]
	buf := make([]byte, c.End-c.Start)
	if _, err := f.ReadAt(buf, int64(c.Start)); err != nil && !errors.Is(err, io.EOF) {
		return ChapterText{}, err
	}
	text := strings.TrimSpace(string(buf))
	// 正文第一行就是章节标题时去掉，页面上已经单独显示了标题。
	if first, rest, ok := strings.Cut(text, "\n"); ok && strings.TrimSpace(first) == c.Title {
		text = strings.TrimSpace(rest)
	}
	return ChapterText{Index: index, Total: len(toc), Title: c.Title, Text: text}, nil
}

// SaveProgress 记录阅读进度。
func (l *Library) SaveProgress(id string, chapter int, position float64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.find(id)
	if b == nil {
		return errors.New("找不到这本书")
	}
	b.Chapter, b.Position, b.LastRead = chapter, min(max(position, 0), 1), time.Now()
	if b.Chapters > 0 {
		b.Percent = (float64(chapter) + b.Position) / float64(b.Chapters) * 100
	}
	return l.save()
}

// DecodeText 把文件内容转成 UTF-8：识别 BOM（UTF-8、UTF-16），否则按 UTF-8，不合法再按 GB18030。
func DecodeText(raw []byte) string {
	switch {
	case bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF}):
		return string(raw[3:])
	case bytes.HasPrefix(raw, []byte{0xFF, 0xFE}):
		return decodeUTF16(raw[2:], false)
	case bytes.HasPrefix(raw, []byte{0xFE, 0xFF}):
		return decodeUTF16(raw[2:], true)
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	if out, err := simplifiedchinese.GB18030.NewDecoder().Bytes(raw); err == nil {
		return string(out)
	}
	return strings.ToValidUTF8(string(raw), "")
}

func decodeUTF16(b []byte, bigEndian bool) string {
	u := make([]uint16, len(b)/2)
	for i := range u {
		if bigEndian {
			u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
		} else {
			u[i] = uint16(b[2*i+1])<<8 | uint16(b[2*i])
		}
	}
	return string(utf16.Decode(u))
}

// NormalizeText 统一换行，去掉行尾空白和过多的空行。
func NormalizeText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	blank := 0
	for _, line := range lines {
		line = strings.TrimRight(line, " \t　")
		if strings.TrimSpace(line) == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, line)
	}
	return strings.TrimSpace(strings.Join(out, "\n")) + "\n"
}

var chapterRe = regexp.MustCompile(`(?m)^[ \t\x{3000}]*((第[0-9０-９零〇一二两三四五六七八九十百千万]+[章节回卷集部篇])|([Cc]hapter\s*[0-9IVXLC]+)|序章|序言|楔子|引子|尾声|后记|番外[^\n]{0,20})[^\n]{0,40}$`)

const (
	maxChapterBytes = 120 << 10 // 一章太长时再切开，翻页和加载都更顺
	chunkBytes      = 30 << 10
)

// SplitChapters 按章节标题切分；没有章节标题的文本按段落切成若干部分。
func SplitChapters(text string) []Chapter {
	var chapters []Chapter
	matches := chapterRe.FindAllStringIndex(text, -1)
	if len(matches) >= 2 {
		if first := matches[0][0]; strings.TrimSpace(text[:first]) != "" {
			chapters = append(chapters, Chapter{Title: "开始", Start: 0, End: first})
		}
		for i, m := range matches {
			end := len(text)
			if i+1 < len(matches) {
				end = matches[i+1][0]
			}
			chapters = append(chapters, Chapter{Title: strings.TrimSpace(text[m[0]:m[1]]), Start: m[0], End: end})
		}
	} else {
		chapters = []Chapter{{Title: "正文", Start: 0, End: len(text)}}
	}
	// 太长的章节按段落再切。
	var out []Chapter
	for _, c := range chapters {
		if c.End-c.Start <= maxChapterBytes {
			out = append(out, c)
			continue
		}
		part, start := 1, c.Start
		for start < c.End {
			end := min(start+chunkBytes, c.End)
			if end < c.End {
				if nl := strings.IndexByte(text[end:c.End], '\n'); nl >= 0 {
					end += nl + 1
				} else {
					end = c.End
				}
			}
			out = append(out, Chapter{Title: fmt.Sprintf("%s（%d）", c.Title, part), Start: start, End: end})
			part++
			start = end
		}
	}
	return out
}

// parseEPUB 读取 epub：按书脊顺序取出每个章节的文字。
func parseEPUB(raw []byte) (string, []Chapter, string, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return "", nil, "", errors.New("不是有效的 epub 文件")
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}
	read := func(name string) ([]byte, error) {
		f := files[name]
		if f == nil {
			return nil, fmt.Errorf("epub 里缺少 %s", name)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		return io.ReadAll(io.LimitReader(rc, 50<<20))
	}
	container, err := read("META-INF/container.xml")
	if err != nil {
		return "", nil, "", err
	}
	opfPath := attr(container, "full-path")
	opf, err := read(opfPath)
	if err != nil {
		return "", nil, "", err
	}
	base := path.Dir(opfPath)
	manifest := map[string]string{}
	for _, item := range tags(opf, "item") {
		manifest[item["id"]] = item["href"]
	}
	title := strings.TrimSpace(html.UnescapeString(innerText(opf, "dc:title")))

	var b strings.Builder
	var chapters []Chapter
	for i, ref := range tags(opf, "itemref") {
		href, ok := manifest[ref["idref"]]
		if !ok {
			continue
		}
		name := path.Clean(path.Join(base, href))
		doc, err := read(name)
		if err != nil {
			continue
		}
		chTitle, body := htmlText(doc)
		body = NormalizeText(body)
		if strings.TrimSpace(body) == "" {
			continue
		}
		if chTitle == "" {
			chTitle = fmt.Sprintf("第 %d 部分", i+1)
		}
		start := b.Len()
		b.WriteString(body)
		b.WriteString("\n")
		chapters = append(chapters, Chapter{Title: chTitle, Start: start, End: b.Len()})
	}
	if len(chapters) == 0 {
		return "", nil, "", errors.New("epub 里没有读到正文")
	}
	return b.String(), chapters, title, nil
}

var attrRe = regexp.MustCompile(`([\w:-]+)\s*=\s*"([^"]*)"`)

func attr(doc []byte, name string) string {
	for _, m := range attrRe.FindAllSubmatch(doc, -1) {
		if string(m[1]) == name {
			return string(m[2])
		}
	}
	return ""
}

func tags(doc []byte, name string) []map[string]string {
	re := regexp.MustCompile(`<` + regexp.QuoteMeta(name) + `\b([^>]*)>`)
	var out []map[string]string
	for _, m := range re.FindAllSubmatch(doc, -1) {
		attrs := map[string]string{}
		for _, a := range attrRe.FindAllSubmatch(m[1], -1) {
			attrs[string(a[1])] = string(a[2])
		}
		out = append(out, attrs)
	}
	return out
}

func innerText(doc []byte, name string) string {
	re := regexp.MustCompile(`(?s)<` + regexp.QuoteMeta(name) + `[^>]*>(.*?)</` + regexp.QuoteMeta(name) + `>`)
	if m := re.FindSubmatch(doc); m != nil {
		return string(m[1])
	}
	return ""
}

// htmlText 把 xhtml 转成纯文本，块级元素换行；同时取出第一个标题作为章节名。
func htmlText(doc []byte) (title, text string) {
	z := html.NewTokenizer(bytes.NewReader(doc))
	var b strings.Builder
	var heading strings.Builder
	inHeading, skip := false, 0
	for {
		switch z.Next() {
		case html.ErrorToken:
			return strings.TrimSpace(title), b.String()
		case html.StartTagToken, html.SelfClosingTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "script", "style", "head":
				skip++
			case "h1", "h2", "h3":
				if title == "" {
					inHeading = true
				}
				b.WriteString("\n")
			case "p", "div", "br", "li", "tr", "section", "blockquote", "h4", "h5", "h6":
				b.WriteString("\n")
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			switch string(name) {
			case "script", "style", "head":
				skip = max(skip-1, 0)
			case "h1", "h2", "h3":
				if inHeading {
					title = strings.TrimSpace(heading.String())
					inHeading = false
				}
				b.WriteString("\n")
			case "p", "div", "li", "section", "blockquote":
				b.WriteString("\n")
			}
		case html.TextToken:
			if skip > 0 {
				continue
			}
			t := string(z.Text())
			if inHeading {
				heading.WriteString(t)
			}
			b.WriteString(t)
		}
	}
}
