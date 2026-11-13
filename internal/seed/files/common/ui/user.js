// 界面钩子。保存后重新打开主窗口时生效。
//
// pocket.hooks.onQuery(text => text.replace(/^kk\b/, "kill"))   // 改写输入
// pocket.hooks.onResults(items => items)                        // 调整结果
// pocket.keymap.bind("mod+l", () => pocket.query.set("/"))      // 加快捷键
