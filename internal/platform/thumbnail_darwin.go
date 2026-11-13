package platform

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// FileFlags 只在 Windows 上有内容。
func FileFlags(os.FileInfo) []string { return nil }

// ThumbnailSupported 报告系统能不能给任意文件出预览图。
func ThumbnailSupported() bool { return true }

// Thumbnail 用“快速查看”给文件生成一张预览图（Office 文档、Keynote、网页播放不了的视频等都能出），
// 返回图片路径。结果按路径和修改时间缓存在 dir 里。
func Thumbnail(ctx context.Context, path, dir string, size int) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	sum := sha1.Sum([]byte(fmt.Sprintf("%s|%d|%d|%d", path, info.ModTime().UnixNano(), info.Size(), size)))
	out := filepath.Join(dir, hex.EncodeToString(sum[:12])+".png")
	if _, err := os.Stat(out); err == nil {
		return out, nil
	}
	work, err := os.MkdirTemp(dir, "ql-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	if err := Command(ctx, "/usr/bin/qlmanage", "-t", "-s", fmt.Sprint(size), "-o", work, path).Run(); err != nil {
		return "", err
	}
	made, _ := filepath.Glob(filepath.Join(work, "*.png"))
	if len(made) == 0 {
		return "", errors.New("系统没有给出这种文件的预览图")
	}
	if !strings.HasSuffix(made[0], ".png") {
		return "", errors.New("预览图格式不对")
	}
	if err := os.Rename(made[0], out); err != nil {
		return "", err
	}
	return out, nil
}
