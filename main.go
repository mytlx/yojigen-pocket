// Yojigen Pocket：一个类似 uTools 的桌面启动器。Go 后端 + mygo 的网页前端。
package main

import (
	"log"
	"runtime"

	"github.com/egoist/mygo"
)

// bindExtra 由带构建标签的文件设置（端到端测试的钩子）。
var bindExtra func(a *App)

// allowSecondInstance 只在测试构建里为真：测试用自己的临时目录，可以和正在用的正式版同时运行。
var allowSecondInstance bool

func main() {
	if !allowSecondInstance && !mygo.App.RequestSingleInstanceLock() {
		return // 已经在运行的实例会显示自己
	}
	a := &App{}
	mygo.Bind(&Launcher{a: a})
	mygo.Bind(&Settings{a: a})
	mygo.Bind(&Windows{a: a})
	mygo.Bind(&Translator{a: a})
	mygo.Bind(&OCR{a: a})
	mygo.Bind(&Library{a: a})
	mygo.Bind(&DevTools{a: a})
	mygo.Bind(&Catalog{a: a})
	mygo.Bind(&Finder{a: a})
	mygo.Bind(&Calc{a: a})
	mygo.Bind(&Clips{a: a})
	mygo.Bind(&WinTools{a: a})
	mygo.Bind(&Speech{a: a})
	mygo.Bind(&Auto{a: a})
	mygo.Bind(&Extensions{a: a})
	if bindExtra != nil {
		bindExtra(a)
	}

	// Windows 上不要默认的应用菜单：窗口没有标题栏，按 Alt 时它会作为弹出菜单冒出来，
	// 抢走键盘（设置里录快捷键时一按 Alt 就被打断）。macOS 上菜单在屏幕顶部，复制粘贴也靠它，保留。
	if runtime.GOOS != "darwin" {
		mygo.App.SetMenu(nil)
	}
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.OnWindowAllClosed(func() {}) // 没有窗口也继续运行
	mygo.App.OnSecondInstance(func([]string, string) { a.showPanel("") })
	mygo.App.OnOpenURL(a.handleURL)
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { a.quitting.Store(true) })
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		a.flush()
		if a.pluginHost != nil {
			a.pluginHost.stopAll() // 扩展的后端进程不能留在后台
		}
	})
	mygo.App.WhenReady(a.ready)
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
