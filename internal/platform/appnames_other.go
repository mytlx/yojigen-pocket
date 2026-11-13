//go:build !darwin

package platform

// AppNames 在其他系统上不需要：开始菜单里的名字已经是本地化的。
func AppNames(string) (zh, en string) { return "", "" }

// PrefersChinese 只在 macOS 上用来挑应用的显示名。
func PrefersChinese() bool { return false }
