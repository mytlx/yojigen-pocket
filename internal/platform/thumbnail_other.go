//go:build !darwin

package platform

import "context"

// ThumbnailSupported 报告系统能不能给任意文件出预览图。
func ThumbnailSupported() bool { return false }

// Thumbnail 在这个系统上没有实现。
func Thumbnail(context.Context, string, string, int) (string, error) { return "", ErrUnsupported }
