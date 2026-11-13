//go:build darwin

package providers

func osa(script string) []string { return []string{"osascript", "-e", script} }

func systemCommands() []*sysCommand {
	return []*sysCommand{
		{id: "lock", title: "锁屏", icon: "svg:lock", keywords: []string{"lock", "suoping"}, argv: osa(`tell application "System Events" to keystroke "q" using {control down, command down}`)},
		{id: "sleep", title: "睡眠", icon: "svg:moon", keywords: []string{"sleep", "shuimian"}, argv: []string{"pmset", "sleepnow"}},
		{id: "display-sleep", title: "关闭显示器", icon: "svg:monitor-off", keywords: []string{"display", "screen off"}, argv: []string{"pmset", "displaysleepnow"}},
		{id: "restart", title: "重新启动", icon: "svg:rotate", keywords: []string{"restart", "reboot"}, confirm: "确定要重新启动电脑吗？", argv: osa(`tell application "System Events" to restart`)},
		{id: "shutdown", title: "关机", icon: "svg:power", keywords: []string{"shutdown", "guanji"}, confirm: "确定要关机吗？", argv: osa(`tell application "System Events" to shut down`)},
		{id: "logout", title: "退出登录", icon: "svg:logout", keywords: []string{"logout"}, confirm: "确定要退出登录吗？", argv: osa(`tell application "System Events" to log out`)},
		{id: "empty-trash", title: "清空废纸篓", icon: "svg:trash", keywords: []string{"empty trash", "qingkong", "回收站"}, confirm: "确定清空废纸篓？此操作不可恢复。", argv: osa(`tell application "Finder" to empty trash`)},
		{id: "toggle-dark", title: "切换深色模式", icon: "svg:moon", keywords: []string{"dark mode", "theme"}, argv: osa(`tell application "System Events" to tell appearance preferences to set dark mode to not dark mode`)},
		{id: "settings", title: "打开系统设置", icon: "svg:settings", keywords: []string{"system settings", "preferences", "偏好设置"}, argv: []string{"open", "-b", "com.apple.systempreferences"}},
		{id: "settings-wifi", title: "Wi-Fi 设置", icon: "svg:wifi", keywords: []string{"wifi", "wlan", "network", "网络"}, argv: []string{"open", "x-apple.systempreferences:com.apple.wifi-settings-extension"}},
		{id: "settings-bluetooth", title: "蓝牙设置", icon: "svg:bluetooth", keywords: []string{"bluetooth"}, argv: []string{"open", "x-apple.systempreferences:com.apple.BluetoothSettings"}},
		{id: "settings-display", title: "显示器设置", icon: "svg:monitor", keywords: []string{"display", "screen", "分辨率"}, argv: []string{"open", "x-apple.systempreferences:com.apple.Displays-Settings.extension"}},
		{id: "settings-sound", title: "声音设置", icon: "svg:volume", keywords: []string{"sound", "volume", "音量"}, argv: []string{"open", "x-apple.systempreferences:com.apple.Sound-Settings.extension"}},
		{id: "activity", title: "活动监视器", icon: "svg:activity", keywords: []string{"activity monitor", "任务管理器", "task manager"}, argv: []string{"open", "-b", "com.apple.ActivityMonitor"}},
	}
}
