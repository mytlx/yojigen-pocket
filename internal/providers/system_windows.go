//go:build windows

package providers

func start(uri string) []string { return []string{"cmd", "/c", "start", "", uri} }

func systemCommands() []*sysCommand {
	return []*sysCommand{
		{id: "lock", title: "锁屏", icon: "svg:lock", keywords: []string{"lock", "suoping"}, argv: []string{"rundll32.exe", "user32.dll,LockWorkStation"}},
		{id: "sleep", title: "睡眠", icon: "svg:moon", keywords: []string{"sleep", "shuimian"}, argv: []string{"rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"}},
		{id: "restart", title: "重新启动", icon: "svg:rotate", keywords: []string{"restart", "reboot"}, confirm: "确定要重新启动电脑吗？", argv: []string{"shutdown", "/r", "/t", "0"}},
		{id: "shutdown", title: "关机", icon: "svg:power", keywords: []string{"shutdown", "guanji"}, confirm: "确定要关机吗？", argv: []string{"shutdown", "/s", "/t", "0"}},
		{id: "logout", title: "注销", icon: "svg:logout", keywords: []string{"logout", "signout", "退出登录"}, confirm: "确定要注销吗？", argv: []string{"shutdown", "/l"}},
		{id: "empty-trash", title: "清空回收站", icon: "svg:trash", keywords: []string{"empty recycle bin", "qingkong", "废纸篓"}, confirm: "确定清空回收站？此操作不可恢复。", line: "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"},
		{id: "toggle-dark", title: "切换深色模式", icon: "svg:moon", keywords: []string{"dark mode", "theme"}, line: `$p='HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize';$v=(Get-ItemProperty $p).AppsUseLightTheme;$n=1-$v;Set-ItemProperty $p AppsUseLightTheme $n;Set-ItemProperty $p SystemUsesLightTheme $n`},
		{id: "settings", title: "打开系统设置", icon: "svg:settings", keywords: []string{"settings", "windows settings"}, argv: start("ms-settings:")},
		{id: "settings-wifi", title: "Wi-Fi 设置", icon: "svg:wifi", keywords: []string{"wifi", "wlan", "network", "网络"}, argv: start("ms-settings:network-wifi")},
		{id: "settings-bluetooth", title: "蓝牙设置", icon: "svg:bluetooth", keywords: []string{"bluetooth"}, argv: start("ms-settings:bluetooth")},
		{id: "settings-display", title: "显示器设置", icon: "svg:monitor", keywords: []string{"display", "screen", "分辨率"}, argv: start("ms-settings:display")},
		{id: "settings-sound", title: "声音设置", icon: "svg:volume", keywords: []string{"sound", "volume", "音量"}, argv: start("ms-settings:sound")},
		{id: "activity", title: "任务管理器", icon: "svg:activity", keywords: []string{"task manager", "taskmgr", "活动监视器"}, argv: []string{"taskmgr.exe"}},
		{id: "control", title: "控制面板", icon: "svg:settings", keywords: []string{"control panel"}, argv: []string{"control.exe"}},
		{id: "explorer", title: "文件资源管理器", icon: "svg:folder", keywords: []string{"explorer", "files"}, argv: []string{"explorer.exe"}},
	}
}
