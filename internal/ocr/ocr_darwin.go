//go:build darwin

package ocr

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var (
	visionOnce sync.Once
	visionErr  error
)

func loadVision() error {
	visionOnce.Do(func() {
		for _, lib := range []string{
			"/System/Library/Frameworks/Foundation.framework/Foundation",
			"/System/Library/Frameworks/Vision.framework/Vision",
		} {
			if _, err := purego.Dlopen(lib, purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
				visionErr = err
				return
			}
		}
	})
	return visionErr
}

func sel(name string) objc.SEL { return objc.RegisterName(name) }

func nsString(s string) objc.ID {
	b := append([]byte(s), 0)
	return objc.ID(objc.GetClass("NSString")).Send(sel("stringWithUTF8String:"), unsafe.Pointer(&b[0]))
}

func goString(id objc.ID) string {
	if id == 0 {
		return ""
	}
	p := id.Send(sel("UTF8String"))
	if p == 0 {
		return ""
	}
	var b []byte
	for i := uintptr(0); ; i++ {
		c := *(*byte)(unsafe.Add(unsafe.Pointer(nil), uintptr(p)+i))
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

func nsArray(items ...objc.ID) objc.ID {
	if len(items) == 0 {
		return objc.ID(objc.GetClass("NSArray")).Send(sel("array"))
	}
	return objc.ID(objc.GetClass("NSArray")).Send(sel("arrayWithObjects:count:"), unsafe.Pointer(&items[0]), uint(len(items)))
}

type cgRect struct{ X, Y, W, H float64 }

// 一行识别结果和它在图片里的位置（Vision 的坐标原点在左下角，范围 0-1）。
type observation struct {
	text string
	box  cgRect
}

func visionLanguages(lang string) []string {
	switch lang {
	case "en":
		return []string{"en-US"}
	case "ja":
		return []string{"ja-JP", "en-US"}
	case "ko":
		return []string{"ko-KR", "en-US"}
	}
	// 中文模型同时认英文和数字；日文、韩文单独选，不混在一起。
	return []string{"zh-Hans", "zh-Hant", "en-US"}
}

// recognizeSystem 用 Vision 框架识别（macOS 13 起支持中文）。整个过程同步完成，不需要回调。
func recognizeSystem(ctx context.Context, path, lang string) ([]string, error) {
	if err := loadVision(); err != nil {
		return nil, fmt.Errorf("加载 Vision 失败：%w", err)
	}
	obs, err := vision(path, visionLanguages(lang))
	if err != nil {
		// 较早的系统不认识中文，退回只识别英文。
		obs, err = vision(path, []string{"en-US"})
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return mergeLines(obs), err
}

func vision(path string, languages []string) (out []observation, err error) {
	// 自动释放池必须在创建它的线程上释放，goroutine 中途换线程会直接崩溃。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool := objc.ID(objc.GetClass("NSAutoreleasePool")).Send(sel("new"))
	defer pool.Send(sel("drain"))

	reqClass := objc.GetClass("VNRecognizeTextRequest")
	handlerClass := objc.GetClass("VNImageRequestHandler")
	if reqClass == 0 || handlerClass == 0 {
		return nil, ErrUnsupported
	}
	url := objc.ID(objc.GetClass("NSURL")).Send(sel("fileURLWithPath:"), nsString(path))

	req := objc.ID(reqClass).Send(sel("alloc")).Send(sel("init"))
	defer req.Send(sel("release"))
	req.Send(sel("setRecognitionLevel:"), 0) // VNRequestTextRecognitionLevelAccurate
	req.Send(sel("setUsesLanguageCorrection:"), true)
	langs := make([]objc.ID, len(languages))
	for i, l := range languages {
		langs[i] = nsString(l)
	}
	req.Send(sel("setRecognitionLanguages:"), nsArray(langs...))

	options := objc.ID(objc.GetClass("NSDictionary")).Send(sel("dictionary"))
	handler := objc.ID(handlerClass).Send(sel("alloc")).Send(sel("initWithURL:options:"), url, options)
	defer handler.Send(sel("release"))

	var nsErr objc.ID
	ok := objc.Send[bool](handler, sel("performRequests:error:"), nsArray(req), unsafe.Pointer(&nsErr))
	if !ok {
		msg := "无法识别这张图片"
		if nsErr != 0 {
			msg = goString(nsErr.Send(sel("localizedDescription")))
		}
		return nil, errors.New(msg)
	}
	results := req.Send(sel("results"))
	if results == 0 {
		return nil, nil
	}
	n := int(objc.Send[uint](results, sel("count")))
	for i := range n {
		o := results.Send(sel("objectAtIndex:"), uint(i))
		cands := o.Send(sel("topCandidates:"), uint(1))
		if cands == 0 || objc.Send[uint](cands, sel("count")) == 0 {
			continue
		}
		out = append(out, observation{
			text: goString(cands.Send(sel("objectAtIndex:"), uint(0)).Send(sel("string"))),
			box:  objc.Send[cgRect](o, sel("boundingBox")),
		})
	}
	return out, nil
}
