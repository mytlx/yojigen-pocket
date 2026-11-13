//go:build windows

package ocr

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"yojigen-pocket/internal/platform"
	"yojigen-pocket/internal/scripts"
)

// 用 Windows PowerShell 5.1 调 Windows.Media.Ocr（WinRT），pwsh 7 不能直接用 WinRT 类型。
const winScript = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($args[0])) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($engine -eq $null) { throw 'NO_OCR_LANGUAGE' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Lines | ForEach-Object { $_.Text }
`

func recognizeSystem(ctx context.Context, path, _ string) ([]string, error) {
	script := filepath.Join(os.TempDir(), "yojigen-pocket-ocr.ps1")
	// 带 BOM 写入，Windows PowerShell 5.1 才会按 UTF-8 读脚本。
	if err := os.WriteFile(script, append([]byte{0xEF, 0xBB, 0xBF}, winScript...), 0o644); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ps := platform.LookFirst("powershell.exe")
	if ps == "" {
		return nil, ErrUnsupported
	}
	cmd := platform.Command(ctx, ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, path)
	out, err := cmd.CombinedOutput()
	text := scripts.Decode(out)
	if err != nil {
		if strings.Contains(text, "NO_OCR_LANGUAGE") {
			return nil, errors.New("系统里没有可用的 OCR 语言包：在「设置 → 时间和语言 → 语言」里为中文添加「光学字符识别」")
		}
		return nil, errors.New("系统文字识别失败：" + firstLine(text))
	}
	return strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n"), nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	line, _, _ := strings.Cut(s, "\n")
	return line
}

type cgRect struct{ X, Y, W, H float64 }

type observation struct {
	text string
	box  cgRect
}
