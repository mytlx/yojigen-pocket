// pack-ext 把一个构建好的扩展目录打成 zip：go run ./tools/pack-ext <目录> <输出.zip>
// 文件按名字排序、时间戳固定，同样的内容打出来的包一模一样。
package main

import (
	"archive/zip"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func main() {
	if len(os.Args) != 3 {
		log.Fatal("用法：pack-ext <目录> <输出.zip>")
	}
	dir, out := os.Args[1], os.Args[2]
	var files []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && !strings.HasPrefix(d.Name(), ".") {
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
	sort.Strings(files)
	f, err := os.Create(out)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, p := range files {
		rel, _ := filepath.Rel(dir, p)
		info, err := os.Stat(p)
		if err != nil {
			log.Fatal(err)
		}
		h := &zip.FileHeader{Name: filepath.ToSlash(rel), Method: zip.Deflate, Modified: stamp}
		h.SetMode(info.Mode().Perm())
		w, err := zw.CreateHeader(h)
		if err != nil {
			log.Fatal(err)
		}
		src, err := os.Open(p)
		if err != nil {
			log.Fatal(err)
		}
		if _, err := io.Copy(w, src); err != nil {
			log.Fatal(err)
		}
		src.Close()
	}
	if err := zw.Close(); err != nil {
		log.Fatal(err)
	}
}
