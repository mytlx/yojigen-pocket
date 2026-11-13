//go:build !darwin && !windows

package providers

func systemCommands() []*sysCommand { return nil }
