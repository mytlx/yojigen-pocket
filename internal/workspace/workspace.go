// Package workspace 是一个限定在某个目录里的小文件库：笔记和代码草稿都存在这样的目录里。
//
// 所有路径都是相对这个目录的，用 os.Root 打开，页面传来的路径写成什么样都出不了这个目录。
package workspace

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Store 是一个目录里的文件库。
type Store struct {
	Dir string
	// Exts 限定能看到和创建的文件类型（带点、小写）；为空表示不限。
	Exts []string
}

// Node 是文件树里的一项。
type Node struct {
	Path     string `json:"path"` // 相对路径，用 / 分隔
	Name     string `json:"name"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
	Children []Node `json:"children,omitempty"`
}

const maxFileSize = 8 << 20

func (s *Store) root() (*os.Root, error) {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return nil, err
	}
	return os.OpenRoot(s.Dir)
}

// clean 把页面传来的路径整理成库里的相对路径；空串是根目录。
func clean(p string) (string, error) {
	p = strings.ReplaceAll(strings.TrimSpace(p), `\`, "/")
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return "", errors.New("路径不能跳出这个目录")
		}
	}
	return strings.Trim(path.Clean("/"+p), "/"), nil
}

func local(p string) string {
	if p == "" {
		return "."
	}
	return filepath.FromSlash(p)
}

// validName 检查文件名：不能为空、不能带路径分隔符，也不用系统保留的字符。
func validName(name string) error {
	name = strings.TrimSpace(name)
	switch {
	case name == "" || name == "." || name == "..":
		return errors.New("名字不能为空")
	case strings.ContainsAny(name, `/\:*?"<>|`) || strings.ContainsRune(name, 0):
		return errors.New(`名字里不能有 / \ : * ? " < > |`)
	case len(name) > 200:
		return errors.New("名字太长了")
	case strings.HasPrefix(name, "."):
		return errors.New("名字不能以点开头")
	}
	return nil
}

func (s *Store) allowed(name string) bool {
	if len(s.Exts) == 0 {
		return true
	}
	ext := strings.ToLower(filepath.Ext(name))
	for _, e := range s.Exts {
		if e == ext {
			return true
		}
	}
	return false
}

// Tree 返回整个目录树：文件夹在前，其余按名字排。
func (s *Store) Tree() ([]Node, error) {
	r, err := s.root()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return s.list(r, "", 0)
}

func (s *Store) list(r *os.Root, dir string, depth int) ([]Node, error) {
	if depth > 12 {
		return nil, nil
	}
	f, err := r.Open(local(dir))
	if err != nil {
		return nil, err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return nil, err
	}
	out := []Node{}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		n := Node{Path: path.Join(dir, name), Name: name, IsDir: e.IsDir(), Modified: info.ModTime().UnixMilli()}
		if e.IsDir() {
			n.Children, _ = s.list(r, n.Path, depth+1)
		} else {
			if !s.allowed(name) {
				continue
			}
			n.Size = info.Size()
		}
		out = append(out, n)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return naturalLess(out[i].Name, out[j].Name)
	})
	return out, nil
}

// naturalLess 按自然序比较文件名：连续 ASCII 数字按数值大小比较，其余字符按小写进行比较。
func naturalLess(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	ia, ib := 0, 0
	var zeroTie, caseTie int
	isAsciiDigit := func(r rune) bool { return r >= '0' && r <= '9' }

	for ia < len(ra) && ib < len(rb) {
		if isAsciiDigit(ra[ia]) && isAsciiDigit(rb[ib]) {
			ja, jb := ia, ib
			for ja < len(ra) && isAsciiDigit(ra[ja]) {
				ja++
			}
			for jb < len(rb) && isAsciiDigit(rb[jb]) {
				jb++
			}
			za, zb := ia, ib
			for za < ja && ra[za] == '0' {
				za++
			}
			for zb < jb && rb[zb] == '0' {
				zb++
			}
			if la, lb := ja-za, jb-zb; la != lb {
				return la < lb
			}
			for k := 0; k < ja-za; k++ {
				if ra[za+k] != rb[zb+k] {
					return ra[za+k] < rb[zb+k]
				}
			}
			if zeroTie == 0 && (ja-ia) != (jb-ib) {
				if (ja - ia) < (jb - ib) {
					zeroTie = -1
				} else {
					zeroTie = 1
				}
			}
			ia, ib = ja, jb
			continue
		}
		la, lb := unicode.ToLower(ra[ia]), unicode.ToLower(rb[ib])
		if la != lb {
			return la < lb
		}
		if caseTie == 0 && ra[ia] != rb[ib] {
			if ra[ia] < rb[ib] {
				caseTie = -1
			} else {
				caseTie = 1
			}
		}
		ia++
		ib++
	}
	if ia != len(ra) || ib != len(rb) {
		return ia == len(ra)
	}
	if zeroTie != 0 {
		return zeroTie < 0
	}
	return caseTie < 0
}

// Read 读一个文件。
func (s *Store) Read(p string) (string, error) {
	p, err := clean(p)
	if err != nil {
		return "", err
	}
	r, err := s.root()
	if err != nil {
		return "", err
	}
	defer r.Close()
	info, err := r.Stat(local(p))
	if err != nil {
		return "", errors.New("这个文件已经不在了")
	}
	if info.IsDir() {
		return "", errors.New("这是一个文件夹")
	}
	if info.Size() > maxFileSize {
		return "", errors.New("文件太大，打不开")
	}
	data, err := r.ReadFile(local(p))
	return string(data), err
}

// Write 保存一个文件（先写临时文件再改名，写到一半断电也不会丢原来的内容）。
func (s *Store) Write(p, content string) error {
	p, err := clean(p)
	if err != nil {
		return err
	}
	if p == "" {
		return errors.New("没有指定文件")
	}
	if len(content) > maxFileSize {
		return errors.New("内容太大了")
	}
	r, err := s.root()
	if err != nil {
		return err
	}
	defer r.Close()
	tmp := local(p) + ".tmp~"
	if err := r.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	if err := r.Rename(tmp, local(p)); err != nil {
		_ = r.Remove(tmp)
		return err
	}
	return nil
}

// unique 在目录里找一个没被占用的名字：笔记.md、笔记 2.md、笔记 3.md……
func unique(r *os.Root, dir, name string) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	candidate := name
	for i := 2; i < 1000; i++ {
		if _, err := r.Stat(local(path.Join(dir, candidate))); err != nil {
			return candidate
		}
		candidate = fmt.Sprintf("%s %d%s", stem, i, ext)
	}
	return fmt.Sprintf("%s %d%s", stem, time.Now().UnixNano(), ext)
}

// CreateFile 在 dir 里新建文件，重名时自动加序号；返回新文件的路径。
func (s *Store) CreateFile(dir, name, content string) (string, error) {
	dir, err := clean(dir)
	if err != nil {
		return "", err
	}
	if err := validName(name); err != nil {
		return "", err
	}
	if !s.allowed(name) {
		return "", errors.New("不支持这种文件类型")
	}
	r, err := s.root()
	if err != nil {
		return "", err
	}
	defer r.Close()
	if dir != "" {
		if err := r.MkdirAll(local(dir), 0o755); err != nil {
			return "", err
		}
	}
	name = unique(r, dir, strings.TrimSpace(name))
	p := path.Join(dir, name)
	return p, r.WriteFile(local(p), []byte(content), 0o644)
}

// CreateFolder 在 dir 里新建文件夹。
func (s *Store) CreateFolder(dir, name string) (string, error) {
	dir, err := clean(dir)
	if err != nil {
		return "", err
	}
	if err := validName(name); err != nil {
		return "", err
	}
	r, err := s.root()
	if err != nil {
		return "", err
	}
	defer r.Close()
	name = unique(r, dir, strings.TrimSpace(name))
	p := path.Join(dir, name)
	return p, r.MkdirAll(local(p), 0o755)
}

// Rename 改名（留在原来的文件夹里）。目标已经存在时报错，不覆盖。
func (s *Store) Rename(p, name string) (string, error) {
	p, err := clean(p)
	if err != nil {
		return "", err
	}
	if p == "" {
		return "", errors.New("没有指定文件")
	}
	if err := validName(name); err != nil {
		return "", err
	}
	return s.move(p, path.Join(path.Dir(p), strings.TrimSpace(name)))
}

// Move 把文件或文件夹移到另一个文件夹里（dir 为空是根目录）。
func (s *Store) Move(p, dir string) (string, error) {
	p, err := clean(p)
	if err != nil {
		return "", err
	}
	dir, err = clean(dir)
	if err != nil {
		return "", err
	}
	if p == "" {
		return "", errors.New("没有指定文件")
	}
	if dir == p || strings.HasPrefix(dir+"/", p+"/") {
		return "", errors.New("不能把文件夹移到它自己里面")
	}
	return s.move(p, path.Join(dir, path.Base(p)))
}

func (s *Store) move(from, to string) (string, error) {
	to = strings.TrimPrefix(to, "./")
	if from == to {
		return to, nil
	}
	r, err := s.root()
	if err != nil {
		return "", err
	}
	defer r.Close()
	info, err := r.Stat(local(from))
	if err != nil {
		return "", errors.New("这个文件已经不在了")
	}
	if !info.IsDir() && !s.allowed(path.Base(to)) {
		return "", errors.New("不支持这种文件类型")
	}
	// 只差大小写时（不区分大小写的文件系统上是同一个文件）允许直接改。
	if _, err := r.Stat(local(to)); err == nil && !strings.EqualFold(from, to) {
		return "", errors.New("已经有同名的了")
	}
	return to, r.Rename(local(from), local(to))
}

// Abs 返回库里一个路径在磁盘上的绝对路径（交给系统的“移到废纸篓”“在文件夹中显示”用）。
func (s *Store) Abs(p string) (string, error) {
	p, err := clean(p)
	if err != nil {
		return "", err
	}
	r, err := s.root()
	if err != nil {
		return "", err
	}
	defer r.Close()
	if _, err := r.Lstat(local(p)); err != nil {
		return "", errors.New("这个文件已经不在了")
	}
	return filepath.Join(s.Dir, filepath.FromSlash(p)), nil
}

// Remove 直接删除（没有废纸篓可用时的后备）。
func (s *Store) Remove(p string) error {
	p, err := clean(p)
	if err != nil {
		return err
	}
	if p == "" {
		return errors.New("没有指定文件")
	}
	r, err := s.root()
	if err != nil {
		return err
	}
	defer r.Close()
	return r.RemoveAll(local(p))
}
