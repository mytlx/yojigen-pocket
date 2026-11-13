//go:build !darwin && !windows

package ocr

import "context"

func recognizeSystem(context.Context, string, string) ([]string, error) {
	return nil, ErrUnsupported
}

type cgRect struct{ X, Y, W, H float64 }

type observation struct {
	text string
	box  cgRect
}
