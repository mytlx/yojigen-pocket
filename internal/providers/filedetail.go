package providers

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/xml"
	"fmt"
	"image"
	_ "image/gif" // 读图片尺寸
	_ "image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	"golang.org/x/text/encoding/simplifiedchinese"

	"yojigen-pocket/internal/platform"
)

// FileAttr 是属性区里的一行。
type FileAttr struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// FileDetail 是一个文件的预览内容和属性。预览方式由 Kind 决定：
//
//	image / video / audio / pdf   界面直接加载 URL
//	text / code / markdown        Text
//	archive / folder              Entries
//	none                          没法直接预览；CanThumb 为真时可以再向系统要一张预览图
type FileDetail struct {
	Path      string     `json:"path"`
	Name      string     `json:"name"`
	Dir       string     `json:"dir"`
	Ext       string     `json:"ext"`
	IsDir     bool       `json:"isDir"`
	Kind      string     `json:"kind"`
	TypeName  string     `json:"typeName"`
	URL       string     `json:"url,omitempty"`
	Icon      string     `json:"icon,omitempty"`
	Text      string     `json:"text,omitempty"`
	Lang      string     `json:"lang,omitempty"`
	Truncated bool       `json:"truncated,omitempty"`
	Entries   []string   `json:"entries,omitempty"`
	Total     int        `json:"total,omitempty"`
	CanThumb  bool       `json:"canThumb,omitempty"`
	Size      int64      `json:"size"`
	Modified  int64      `json:"modified"`
	Attrs     []FileAttr `json:"attrs"`
	Error     string     `json:"error,omitempty"`
}

// 各类文件的扩展名。预览、类型筛选和类型名都用这一份。
var (
	imageExts   = exts("png jpg jpeg gif webp bmp svg ico avif heic heif tif tiff jfif")
	videoExts   = exts("mp4 m4v mov webm mkv avi wmv flv mpg mpeg 3gp ts rmvb rm")
	audioExts   = exts("mp3 m4a wav flac ogg oga aac opus wma aiff aif mid midi ape")
	archiveExts = exts("zip rar 7z tar gz tgz bz2 xz zst jar war apk ipa iso dmg pkg cab")
	docExts     = exts("pdf doc docx xls xlsx ppt pptx txt md rtf odt ods odp pages numbers key csv epub mobi wps et dps xmind")
	codeExts    = exts("go js jsx ts tsx py java c h cpp hpp cc cs rs rb php swift kt kts m mm sh bash zsh ps1 bat cmd sql html htm css scss less vue svelte json yaml yml toml xml ini conf lua pl r dart scala gradle proto tf")
	appExts     = exts("app exe msi lnk appx dmg pkg bat cmd com")
	// 网页内核大多能直接播放的格式；其他视频只能给一张预览图。
	playableVideo = exts("mp4 m4v mov webm")
	playableAudio = exts("mp3 m4a wav flac ogg oga aac opus")
	markdownExts  = exts("md markdown mdx")
)

func exts(list string) map[string]bool {
	out := map[string]bool{}
	for _, e := range strings.Fields(list) {
		out["."+e] = true
	}
	return out
}

// FileKinds 是高级搜索左侧的类型筛选。
var FileKinds = []struct {
	ID, Title, Icon string
	Exts            map[string]bool
}{
	{"all", "全部", "svg:search", nil},
	{"folder", "文件夹", "svg:folder", nil},
	{"doc", "文档", "svg:snippet", docExts},
	{"image", "图片", "svg:image", imageExts},
	{"video", "视频", "svg:play", videoExts},
	{"audio", "音频", "svg:volume", audioExts},
	{"code", "代码", "svg:code", codeExts},
	{"archive", "压缩包", "svg:download", archiveExts},
	{"app", "程序", "svg:app", appExts},
}

// KindExts 返回一个类型的扩展名（不带点、排好序）；all 和 folder 没有。
func KindExts(kind string) []string {
	for _, k := range FileKinds {
		if k.ID == kind && k.Exts != nil {
			out := make([]string, 0, len(k.Exts))
			for e := range k.Exts {
				out = append(out, strings.TrimPrefix(e, "."))
			}
			sort.Strings(out)
			return out
		}
	}
	return nil
}

var typeNames = map[string]string{
	".pdf": "PDF 文档", ".doc": "Word 文档", ".docx": "Word 文档", ".xls": "Excel 表格", ".xlsx": "Excel 表格", ".ppt": "PowerPoint 演示", ".pptx": "PowerPoint 演示",
	".txt": "纯文本", ".md": "Markdown 文档", ".rtf": "富文本", ".csv": "CSV 表格", ".json": "JSON", ".xml": "XML", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
	".html": "网页", ".htm": "网页", ".css": "样式表", ".js": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript", ".jsx": "JavaScript", ".go": "Go 源码", ".py": "Python 脚本",
	".java": "Java 源码", ".c": "C 源码", ".h": "C 头文件", ".cpp": "C++ 源码", ".rs": "Rust 源码", ".sh": "Shell 脚本", ".ps1": "PowerShell 脚本", ".bat": "批处理", ".sql": "SQL",
	".png": "PNG 图片", ".jpg": "JPEG 图片", ".jpeg": "JPEG 图片", ".gif": "GIF 图片", ".webp": "WebP 图片", ".bmp": "BMP 图片", ".svg": "SVG 矢量图", ".ico": "图标", ".heic": "HEIC 图片", ".tiff": "TIFF 图片", ".tif": "TIFF 图片", ".psd": "Photoshop 文件",
	".mp4": "MP4 视频", ".mov": "QuickTime 视频", ".mkv": "MKV 视频", ".avi": "AVI 视频", ".webm": "WebM 视频", ".wmv": "WMV 视频", ".flv": "FLV 视频", ".m4v": "MP4 视频",
	".mp3": "MP3 音频", ".m4a": "AAC 音频", ".wav": "WAV 音频", ".flac": "FLAC 音频", ".ogg": "Ogg 音频", ".aac": "AAC 音频", ".wma": "WMA 音频",
	".zip": "ZIP 压缩包", ".rar": "RAR 压缩包", ".7z": "7z 压缩包", ".tar": "TAR 归档", ".gz": "Gzip 压缩包", ".tgz": "Gzip 压缩包", ".jar": "Java 归档", ".apk": "安卓安装包", ".iso": "光盘映像", ".dmg": "磁盘映像", ".pkg": "安装包",
	".exe": "应用程序", ".msi": "安装程序", ".lnk": "快捷方式", ".app": "应用程序", ".dll": "动态链接库", ".ttf": "字体", ".otf": "字体", ".woff": "网页字体", ".woff2": "网页字体",
	".epub": "电子书", ".mobi": "电子书", ".pages": "Pages 文稿", ".numbers": "Numbers 表格", ".key": "Keynote 讲演", ".log": "日志",
}

func typeName(ext string, isDir bool) string {
	if isDir && ext != ".app" {
		return "文件夹"
	}
	if n, ok := typeNames[ext]; ok {
		return n
	}
	if ext == "" {
		return "文件"
	}
	return strings.ToUpper(strings.TrimPrefix(ext, ".")) + " 文件"
}

const (
	previewBytes   = 96 << 10
	previewLines   = 400
	previewEntries = 200
)

func timeText(t time.Time) string {
	if t.IsZero() || t.Unix() <= 0 {
		return ""
	}
	return t.Format("2006-01-02 15:04:05")
}

// Detail 读出文件的预览内容和属性。URL 由调用方按 Kind 填。
func Detail(path string) *FileDetail {
	d := &FileDetail{Path: path, Name: filepath.Base(path), Dir: filepath.Dir(path), Kind: "none", Icon: "file:" + path}
	info, err := os.Stat(path)
	if err != nil {
		d.Error = "读不到这个文件：" + err.Error()
		d.Attrs = []FileAttr{{"位置", d.Dir}}
		return d
	}
	d.Ext = strings.ToLower(filepath.Ext(path))
	d.IsDir = info.IsDir()
	d.Size, d.Modified = info.Size(), info.ModTime().UnixMilli()
	d.TypeName = typeName(d.Ext, d.IsDir)
	bundle := d.IsDir && d.Ext == ".app"

	attr := func(label, value string) {
		if value != "" {
			d.Attrs = append(d.Attrs, FileAttr{label, value})
		}
	}
	attr("名称", d.Name)
	attr("类型", d.TypeName)
	if !d.IsDir {
		attr("大小", fmt.Sprintf("%s（%s 字节）", HumanSize(info.Size()), groupDigits(info.Size())))
	}
	attr("位置", d.Dir)

	var extra []FileAttr // 跟内容有关的属性，排在时间前面
	switch {
	case d.IsDir && !bundle:
		d.Kind = "folder"
		entries, _ := os.ReadDir(path)
		dirs := 0
		for _, e := range entries {
			if e.IsDir() {
				dirs++
			}
			if len(d.Entries) < previewEntries {
				name := e.Name()
				if e.IsDir() {
					name += "/"
				}
				d.Entries = append(d.Entries, name)
			}
		}
		d.Total = len(entries)
		extra = append(extra, FileAttr{"包含", fmt.Sprintf("%d 项（%d 个文件夹，%d 个文件）", len(entries), dirs, len(entries)-dirs)})
	case bundle:
		d.CanThumb = false
	case imageExts[d.Ext]:
		d.Kind = "image"
		if f, err := os.Open(path); err == nil {
			if cfg, format, err := image.DecodeConfig(f); err == nil {
				extra = append(extra, FileAttr{"尺寸", fmt.Sprintf("%d × %d 像素", cfg.Width, cfg.Height)}, FileAttr{"格式", strings.ToUpper(format)})
			}
			f.Close()
		}
	case d.Ext == ".pdf":
		d.Kind = "pdf"
	case playableVideo[d.Ext]:
		d.Kind = "video"
		d.CanThumb = platform.ThumbnailSupported()
	case playableAudio[d.Ext]:
		d.Kind = "audio"
	case d.Ext == ".zip" || d.Ext == ".jar" || d.Ext == ".war" || d.Ext == ".apk" || d.Ext == ".ipa" || d.Ext == ".epub":
		if entries, total, err := zipEntries(path); err == nil {
			d.Kind, d.Entries, d.Total = "archive", entries, total
			extra = append(extra, FileAttr{"包含", fmt.Sprintf("%d 项", total)})
		}
	case d.Ext == ".tar" || d.Ext == ".tgz" || strings.HasSuffix(strings.ToLower(d.Name), ".tar.gz"):
		if entries, total, err := tarEntries(path, d.Ext != ".tar"); err == nil {
			d.Kind, d.Entries, d.Total = "archive", entries, total
			more := ""
			if total >= maxTarScan {
				more = " 以上"
			}
			extra = append(extra, FileAttr{"包含", fmt.Sprintf("%d 项%s", total, more)})
		}
	case d.Ext == ".docx":
		if text, err := docxText(path); err == nil && strings.TrimSpace(text) != "" {
			d.Kind, d.Text = "text", text
			d.Truncated = utf8.RuneCountInString(text) >= previewBytes/3
		}
	}
	if d.Kind == "none" && !d.IsDir && info.Size() > 0 {
		if text, enc, truncated, ok := readText(path); ok {
			d.Text, d.Truncated = text, truncated
			switch {
			case markdownExts[d.Ext]:
				d.Kind = "markdown"
			case codeExts[d.Ext]:
				d.Kind, d.Lang = "code", strings.TrimPrefix(d.Ext, ".")
			default:
				d.Kind = "text"
			}
			extra = append(extra, FileAttr{"编码", enc})
			if !truncated {
				extra = append(extra, FileAttr{"行数", fmt.Sprint(strings.Count(text, "\n") + 1)})
			}
		}
	}
	if d.Kind == "none" && !bundle {
		// 办公文档、设计稿、播放不了的音视频：看系统能不能给一张预览图。
		d.CanThumb = platform.ThumbnailSupported()
	}
	d.Attrs = append(d.Attrs, extra...)

	created, accessed := platform.FileTimes(info)
	attr("创建时间", timeText(created))
	attr("修改时间", timeText(info.ModTime()))
	attr("访问时间", timeText(accessed))
	if flags := platform.FileFlags(info); len(flags) > 0 {
		attr("属性", strings.Join(flags, "、"))
	} else if info.Mode().Perm() != 0 {
		attr("权限", info.Mode().String())
	}
	if link, err := os.Readlink(path); err == nil {
		attr("指向", link)
	}
	return d
}

func groupDigits(n int64) string {
	s := fmt.Sprint(n)
	var out []byte
	for i := range len(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, s[i])
	}
	return string(out)
}

// readText 读文件开头并判断是不是文本；认 UTF-8、UTF-16 和 GB18030。
func readText(path string) (text, encoding string, truncated, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", false, false
	}
	defer f.Close()
	buf := make([]byte, previewBytes+1)
	n, _ := io.ReadFull(f, buf)
	truncated = n > previewBytes
	if truncated {
		n = previewBytes
	}
	buf = buf[:n]
	switch {
	case bytes.HasPrefix(buf, []byte{0xEF, 0xBB, 0xBF}):
		text, encoding = string(buf[3:]), "UTF-8（带 BOM）"
	case bytes.HasPrefix(buf, []byte{0xFF, 0xFE}), bytes.HasPrefix(buf, []byte{0xFE, 0xFF}):
		big := buf[0] == 0xFE
		body := buf[2:]
		units := make([]uint16, 0, len(body)/2)
		for i := 0; i+1 < len(body); i += 2 {
			if big {
				units = append(units, uint16(body[i])<<8|uint16(body[i+1]))
			} else {
				units = append(units, uint16(body[i+1])<<8|uint16(body[i]))
			}
		}
		text, encoding = string(utf16.Decode(units)), "UTF-16"
	default:
		if bytes.IndexByte(buf, 0) >= 0 {
			return "", "", false, false
		}
		// 可能从多字节字符中间截断，判断时去掉结尾几个字节。
		probe := buf
		if truncated && len(probe) > 8 {
			probe = probe[:len(probe)-8]
		}
		if utf8.Valid(probe) {
			text, encoding = strings.ToValidUTF8(string(buf), ""), "UTF-8"
		} else if out, err := simplifiedchinese.GB18030.NewDecoder().Bytes(buf); err == nil && strings.Count(string(out), "�") <= len(out)/200 {
			text, encoding = string(out), "GB18030"
		} else {
			return "", "", false, false
		}
	}
	// 控制字符太多的不是文本。
	ctrl := 0
	for _, r := range text {
		if r < 0x20 && r != '\n' && r != '\r' && r != '\t' && r != 0x1b && r != '\f' {
			ctrl++
		}
	}
	if ctrl > len(text)/100+2 {
		return "", "", false, false
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if lines := strings.SplitN(text, "\n", previewLines+1); len(lines) > previewLines {
		text, truncated = strings.Join(lines[:previewLines], "\n"), true
	}
	return text, encoding, truncated, true
}

func zipEntries(path string) ([]string, int, error) {
	r, err := zip.OpenReader(path)
	if err != nil {
		return nil, 0, err
	}
	defer r.Close()
	var out []string
	for _, f := range r.File {
		if len(out) >= previewEntries {
			break
		}
		name := f.Name
		if f.NonUTF8 {
			// Windows 上打的包常是 GBK 文件名。
			if s, err := simplifiedchinese.GB18030.NewDecoder().String(name); err == nil {
				name = s
			}
		}
		if !f.FileInfo().IsDir() {
			name += "　" + HumanSize(int64(f.UncompressedSize64))
		}
		out = append(out, name)
	}
	return out, len(r.File), nil
}

const maxTarScan = 5000

func tarEntries(path string, gz bool) ([]string, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	var src io.Reader = f
	if gz {
		zr, err := gzip.NewReader(f)
		if err != nil {
			return nil, 0, err
		}
		defer zr.Close()
		src = zr
	}
	tr := tar.NewReader(src)
	var out []string
	total := 0
	for total < maxTarScan {
		h, err := tr.Next()
		if err != nil {
			break
		}
		total++
		if len(out) < previewEntries {
			name := h.Name
			if h.Typeflag == tar.TypeReg {
				name += "　" + HumanSize(h.Size)
			}
			out = append(out, name)
		}
	}
	if total == 0 {
		return nil, 0, fmt.Errorf("空的归档")
	}
	return out, total, nil
}

// docxText 抽出 Word 文档的正文（不含格式）。
func docxText(path string) (string, error) {
	r, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer r.Close()
	for _, f := range r.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		defer rc.Close()
		dec := xml.NewDecoder(io.LimitReader(rc, 8<<20))
		var b strings.Builder
		inText := false
		for b.Len() < previewBytes {
			tok, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tok.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "t":
					inText = true
				case "tab":
					b.WriteByte('\t')
				case "br":
					b.WriteByte('\n')
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "t":
					inText = false
				case "p":
					b.WriteByte('\n')
				}
			case xml.CharData:
				if inText {
					b.Write(t)
				}
			}
		}
		return b.String(), nil
	}
	return "", fmt.Errorf("不是 Word 文档")
}

// MediaAllowed 报告本地媒体服务能不能把这个文件交给界面（只放行能预览的类型）。
func MediaAllowed(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return imageExts[ext] || playableVideo[ext] || playableAudio[ext] || ext == ".pdf"
}
