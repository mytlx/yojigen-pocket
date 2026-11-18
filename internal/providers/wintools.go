package providers

import (
	"context"
	"errors"
	"runtime"
	"strings"

	"yojigen-pocket/internal/core"
	"yojigen-pocket/internal/match"
	"yojigen-pocket/internal/platform"
)

// WinTool 是一个 Windows 自带的工具：控制面板项（.cpl）、管理单元（.msc）或系统程序。
type WinTool struct {
	Name     string  `json:"name"`     // 原名，例如 services.msc
	Title    string  `json:"title"`    // 中文名
	Desc     string  `json:"desc"`     // 说明
	Category string  `json:"category"` // 控制面板 | 管理工具 | 系统程序
	Run      string  `json:"-"`        // 实际执行的命令；空表示就是 Name
	Admin    bool    `json:"admin,omitempty"`
	Score    float64 `json:"-"`

	name, title, desc *match.Target
}

func winTools() []*WinTool {
	cpl, msc, exe := "控制面板", "管理工具", "系统程序"
	return []*WinTool{
		{Name: "control", Title: "控制面板", Desc: "经典控制面板主页", Category: cpl, Run: "control.exe"},
		{Name: "appwiz.cpl", Title: "程序和功能", Desc: "卸载或更改程序", Category: cpl},
		{Name: "sysdm.cpl", Title: "系统属性", Desc: "计算机名、硬件、高级、系统保护、远程", Category: cpl},
		{Name: "main.cpl", Title: "鼠标属性", Desc: "鼠标按键、指针、滚轮", Category: cpl},
		{Name: "ncpa.cpl", Title: "网络连接", Desc: "网卡、适配器、IP 设置", Category: cpl},
		{Name: "mmsys.cpl", Title: "声音", Desc: "播放和录制设备、系统声音", Category: cpl},
		{Name: "desk.cpl", Title: "显示设置", Desc: "分辨率、缩放、多显示器", Category: cpl},
		{Name: "powercfg.cpl", Title: "电源选项", Desc: "电源计划、睡眠、合盖动作", Category: cpl},
		{Name: "firewall.cpl", Title: "Windows 防火墙", Desc: "防火墙开关和允许的应用", Category: cpl},
		{Name: "inetcpl.cpl", Title: "Internet 选项", Desc: "代理、安全、证书、连接", Category: cpl},
		{Name: "intl.cpl", Title: "区域", Desc: "日期、时间、数字格式，系统区域设置", Category: cpl},
		{Name: "timedate.cpl", Title: "日期和时间", Desc: "系统时间、时区、时间同步", Category: cpl},
		{Name: "hdwwiz.cpl", Title: "设备管理器", Desc: "硬件和驱动程序", Category: cpl},
		{Name: "joy.cpl", Title: "游戏控制器", Desc: "手柄、摇杆校准", Category: cpl},
		{Name: "bthprops.cpl", Title: "蓝牙设备", Desc: "蓝牙设置", Category: cpl},
		{Name: "wscui.cpl", Title: "安全和维护", Desc: "安全状态、UAC、维护", Category: cpl},
		{Name: "netplwiz", Title: "用户账户", Desc: "管理本机用户、自动登录", Category: cpl, Run: "netplwiz.exe"},
		{Name: "control printers", Title: "设备和打印机", Desc: "打印机、扫描仪和其他设备", Category: cpl, Run: "control.exe printers"},
		{Name: "control fonts", Title: "字体", Desc: "已安装的字体", Category: cpl, Run: "control.exe fonts"},
		{Name: "control folders", Title: "文件夹选项", Desc: "显示隐藏文件、扩展名", Category: cpl, Run: "control.exe folders"},
		{Name: "control keyboard", Title: "键盘属性", Desc: "重复延迟、光标闪烁", Category: cpl, Run: "control.exe keyboard"},
		{Name: "control userpasswords2", Title: "高级用户账户", Desc: "用户、密码、凭据", Category: cpl, Run: "control.exe userpasswords2"},
		{Name: "环境变量", Title: "环境变量", Desc: "PATH 等用户和系统环境变量（sysdm.cpl,EditEnvironmentVariables）", Category: cpl, Run: "rundll32.exe sysdm.cpl,EditEnvironmentVariables"},
		{Name: "SystemPropertiesAdvanced", Title: "高级系统设置", Desc: "性能、用户配置文件、启动和故障恢复", Category: cpl, Run: "SystemPropertiesAdvanced.exe"},
		{Name: "SystemPropertiesPerformance", Title: "性能选项", Desc: "视觉效果、虚拟内存", Category: cpl, Run: "SystemPropertiesPerformance.exe"},
		{Name: "optionalfeatures", Title: "Windows 功能", Desc: "启用或关闭 Windows 功能（Hyper-V、WSL 等）", Category: cpl, Run: "optionalfeatures.exe"},
		{Name: "UserAccountControlSettings", Title: "用户账户控制设置", Desc: "UAC 通知级别", Category: cpl, Run: "UserAccountControlSettings.exe"},

		{Name: "compmgmt.msc", Title: "计算机管理", Desc: "任务计划、事件、共享、磁盘、服务的集合", Category: msc},
		{Name: "services.msc", Title: "服务", Desc: "启动、停止和配置系统服务", Category: msc},
		{Name: "devmgmt.msc", Title: "设备管理器", Desc: "硬件设备和驱动程序", Category: msc},
		{Name: "diskmgmt.msc", Title: "磁盘管理", Desc: "分区、格式化、盘符", Category: msc},
		{Name: "taskschd.msc", Title: "任务计划程序", Desc: "定时任务、开机任务", Category: msc},
		{Name: "eventvwr.msc", Title: "事件查看器", Desc: "系统、应用程序和安全日志", Category: msc},
		{Name: "gpedit.msc", Title: "本地组策略编辑器", Desc: "组策略（家庭版没有）", Category: msc},
		{Name: "secpol.msc", Title: "本地安全策略", Desc: "账户、审核、安全选项", Category: msc},
		{Name: "lusrmgr.msc", Title: "本地用户和组", Desc: "用户、组（家庭版没有）", Category: msc},
		{Name: "perfmon.msc", Title: "性能监视器", Desc: "性能计数器、数据收集器", Category: msc},
		{Name: "wf.msc", Title: "高级安全防火墙", Desc: "入站、出站规则", Category: msc},
		{Name: "certmgr.msc", Title: "证书（当前用户）", Desc: "个人和受信任的证书", Category: msc},
		{Name: "certlm.msc", Title: "证书（本地计算机）", Desc: "计算机证书存储", Category: msc},
		{Name: "fsmgmt.msc", Title: "共享文件夹", Desc: "共享、会话、打开的文件", Category: msc},
		{Name: "printmanagement.msc", Title: "打印管理", Desc: "打印机、驱动、端口", Category: msc},
		{Name: "comexp.msc", Title: "组件服务", Desc: "COM+、DCOM 配置", Category: msc},
		{Name: "wmimgmt.msc", Title: "WMI 控件", Desc: "WMI 管理", Category: msc},
		{Name: "rsop.msc", Title: "策略的结果集", Desc: "查看已生效的组策略", Category: msc},
		{Name: "tpm.msc", Title: "TPM 管理", Desc: "受信任的平台模块", Category: msc},
		{Name: "virtmgmt.msc", Title: "Hyper-V 管理器", Desc: "虚拟机（需要启用 Hyper-V）", Category: msc},

		{Name: "regedit", Title: "注册表编辑器", Desc: "查看和修改注册表", Category: exe, Run: "regedit.exe"},
		{Name: "msconfig", Title: "系统配置", Desc: "启动项、引导、服务", Category: exe, Run: "msconfig.exe"},
		{Name: "taskmgr", Title: "任务管理器", Desc: "进程、性能、启动应用", Category: exe, Run: "taskmgr.exe"},
		{Name: "resmon", Title: "资源监视器", Desc: "CPU、内存、磁盘、网络占用明细", Category: exe, Run: "resmon.exe"},
		{Name: "msinfo32", Title: "系统信息", Desc: "硬件、组件、软件环境", Category: exe, Run: "msinfo32.exe"},
		{Name: "dxdiag", Title: "DirectX 诊断工具", Desc: "显卡、声卡信息", Category: exe, Run: "dxdiag.exe"},
		{Name: "cmd", Title: "命令提示符", Desc: "命令行", Category: exe, Run: "cmd.exe"},
		{Name: "powershell", Title: "Windows PowerShell", Desc: "PowerShell 命令行", Category: exe, Run: "powershell.exe"},
		{Name: "wt", Title: "Windows 终端", Desc: "终端（需要已安装）", Category: exe, Run: "wt.exe"},
		{Name: "cleanmgr", Title: "磁盘清理", Desc: "清理临时文件、更新缓存", Category: exe, Run: "cleanmgr.exe"},
		{Name: "dfrgui", Title: "优化驱动器", Desc: "碎片整理、TRIM", Category: exe, Run: "dfrgui.exe"},
		{Name: "mstsc", Title: "远程桌面连接", Desc: "连接到远程电脑", Category: exe, Run: "mstsc.exe"},
		{Name: "winver", Title: "关于 Windows", Desc: "系统版本号", Category: exe, Run: "winver.exe"},
		{Name: "rstrui", Title: "系统还原", Desc: "还原到还原点", Category: exe, Run: "rstrui.exe"},
		{Name: "mrt", Title: "恶意软件删除工具", Desc: "微软的扫描工具", Category: exe, Run: "mrt.exe"},
		{Name: "charmap", Title: "字符映射表", Desc: "查找和复制特殊字符", Category: exe, Run: "charmap.exe"},
		{Name: "osk", Title: "屏幕键盘", Desc: "虚拟键盘", Category: exe, Run: "osk.exe"},
		{Name: "magnify", Title: "放大镜", Desc: "放大屏幕内容", Category: exe, Run: "magnify.exe"},
		{Name: "snippingtool", Title: "截图工具", Desc: "系统截图", Category: exe, Run: "snippingtool.exe"},
		{Name: "mspaint", Title: "画图", Desc: "简单的图片编辑", Category: exe, Run: "mspaint.exe"},
		{Name: "notepad", Title: "记事本", Desc: "纯文本编辑", Category: exe, Run: "notepad.exe"},
		{Name: "calc", Title: "计算器", Desc: "系统计算器", Category: exe, Run: "calc.exe"},
		{Name: "sndvol", Title: "音量合成器", Desc: "按应用调音量", Category: exe, Run: "sndvol.exe"},
		{Name: "mblctr", Title: "Windows 移动中心", Desc: "亮度、音量、电池（笔记本）", Category: exe, Run: "mblctr.exe"},
		{Name: "credwiz", Title: "凭据备份和还原", Desc: "存储的用户名和密码", Category: exe, Run: "credwiz.exe"},
		{Name: "verifier", Title: "驱动程序验证器", Desc: "排查驱动问题", Category: exe, Run: "verifier.exe"},
		{Name: "perfmon /rel", Title: "可靠性监视器", Desc: "系统稳定性历史", Category: exe, Run: "perfmon.exe /rel"},
		{Name: "shell:startup", Title: "启动文件夹", Desc: "开机自动运行的快捷方式", Category: exe, Run: "explorer.exe shell:startup"},
		{Name: "shell:sendto", Title: "发送到文件夹", Desc: "右键“发送到”菜单里的项目", Category: exe, Run: "explorer.exe shell:sendto"},
		{Name: "hosts", Title: "hosts 文件", Desc: "用记事本打开 hosts（保存需要管理员权限）", Category: exe, Run: `notepad.exe %SystemRoot%\System32\drivers\etc\hosts`},
	}
}

// WinTools 是 Windows 工具页的数据，也让这些工具能在搜索框里直接搜到。
type WinTools struct {
	list []*WinTool
}

// NewWinTools 创建 Windows 工具数据源。
func NewWinTools() *WinTools {
	w := &WinTools{list: winTools()}
	for _, t := range w.list {
		t.name, t.title, t.desc = match.Prepare(t.Name), match.Prepare(t.Title), match.Prepare(t.Desc)
	}
	return w
}

// Available 报告当前系统能不能运行这些工具。
func (w *WinTools) Available() bool { return runtime.GOOS == "windows" }

// Info 实现 core.Provider。
func (w *WinTools) Info() core.Info {
	return core.Info{ID: "wintools", Title: "Windows 工具", Icon: "svg:wrench"}
}

// Find 按原名、中文名或说明模糊搜索（支持拼音）；query 为空时返回全部。
func (w *WinTools) Find(query string) []WinTool {
	query = strings.TrimSpace(query)
	q := match.NewQuery(query)
	var out []WinTool
	for _, t := range w.list {
		if query == "" {
			out = append(out, *t)
			continue
		}
		best := 0.0
		if r := t.name.Match(q); r.OK && r.Score > best {
			best = r.Score
		}
		if r := t.title.Match(q); r.OK && r.Score > best {
			best = r.Score
		}
		// 说明只是补充：命中说明的排在命中名字的后面。
		if r := t.desc.Match(q); r.OK && r.Score*0.8 > best {
			best = r.Score * 0.8
		}
		if best > 0 {
			hit := *t
			hit.Score = best
			out = append(out, hit)
		}
	}
	if query != "" {
		sortByScore(out)
	}
	return out
}

func sortByScore(list []WinTool) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].Score > list[j-1].Score; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

// Launch 运行一个工具。
func (w *WinTools) Launch(name string) error {
	for _, t := range w.list {
		if t.Name != name {
			continue
		}
		if !w.Available() {
			return errors.New("这些工具只在 Windows 上可用")
		}
		line := t.Run
		if line == "" {
			line = t.Name
		}
		// start 会按文件关联打开 .cpl 和 .msc，也认 PATH 里的程序。
		args := append([]string{"/c", "start", ""}, strings.Fields(line)...)
		return platform.DetachedCommand("cmd", args...).Start()
	}
	return errors.New("没有这个工具：" + name)
}

// Search 实现 core.Provider：在搜索框里也能直接搜到（只在 Windows 上）。
func (w *WinTools) Search(_ context.Context, req *core.Request) []core.Item {
	if !w.Available() && !ForceFeatures["wintools"] {
		return nil
	}
	if strings.TrimSpace(req.Text) == "" {
		return nil
	}
	var out []core.Item
	for _, t := range w.Find(req.Text) {
		out = append(out, w.item(t))
	}
	return out
}

func (w *WinTools) item(t WinTool) core.Item {
	name := t.Name
	return core.Item{
		ID: "wintools:" + t.Name, Title: t.Title, Subtitle: t.Name + " · " + t.Desc, Icon: "svg:wrench",
		Source: "wintools", SourceLabel: t.Category, Score: t.Score * 0.96,
		Actions: []core.Action{
			{Type: core.ActionFunc, Title: "打开", Fn: func(_ context.Context, r *core.Run) error {
				r.Hide()
				return w.Launch(name)
			}},
			{Type: core.ActionCopy, Title: "复制名称", Text: t.Name, KeepOpen: true},
		},
	}
}

// Resolve 实现 core.Resolver。
func (w *WinTools) Resolve(id string) (core.Item, bool) {
	name, ok := strings.CutPrefix(id, "wintools:")
	if !ok {
		return core.Item{}, false
	}
	for _, t := range w.list {
		if t.Name == name {
			return w.item(*t), true
		}
	}
	return core.Item{}, false
}
