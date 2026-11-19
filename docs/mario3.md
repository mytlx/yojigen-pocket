# 超级马力欧兄弟 3

独立扩展，主程序无需改动。游戏逻辑来自 [Southbird 的 SMB3 反汇编](https://github.com/captainsouthbird/smb3)，并非任天堂发布的原始开发源码。用 NESASM 汇编得到美版 PRG1，再由扩展内的 JSNES 离线运行。

两种包均可在「道具库 → 扩展管理」安装。标准商店构建不带游戏数据，需要手动打开自己的 .nes。若从源代码生成本地游戏包，安装后直接点「开始游戏」即可。两种包 ID 相同，会互相替换。

从项目根目录构建本地版（需要 Bun、Go、Git、make 和 C 编译器；以下为 macOS 示例）：

```sh
work=$(mktemp -d)
git clone https://github.com/captainsouthbird/smb3 "$work/smb3"
git -C "$work/smb3" checkout 09b1bd81a788de8ceec664a34094e84ddb463117
git clone https://github.com/camsaul/nesasm "$work/nesasm"
git -C "$work/nesasm" checkout 229033a4b76466b447ad47704808a4d03c493cee
make -C "$work/nesasm/source" CFLAGS="-O2 -std=gnu89 -Wno-implicit-int -Wno-int-conversion"
bun tools/build-mario3-local.ts "$work/smb3" "$work/nesasm/nesasm"
```

输出 `build/local/mario3-1.1.3.zip`。构建会核对汇编产物的 SHA-256；本地包不进入商店发布目录。公开反汇编不等于游戏资产获得再分发许可。

操作：方向键移动，X 为 A，Z 为 B，Enter 为 Start，左 Shift 为 Select，P 暂停。窗口失焦会暂停。在「控制设置」中点击动作即可更改键位。标准手柄支持方向键或左摇杆；如果系统 WebView 未识别手柄，可使用手柄的键盘映射模式。点「大画面」可扩展游戏区域，Esc 退出。游戏暂停、失焦及收到窗口关闭事件时自动保存，也可点「保存进度」查看写入结果。「保存并退出」会等待进度写入后关闭窗口。宿主直接销毁窗口时可能来不及通知插件，需要确保保留最后一帧时请使用这个按钮。控制设置中点「完成」会继续游戏。再次启动同一卡带会自动恢复。存档按卡带内容区分，位于扩展私有数据目录；覆盖更新不删除，卸载时选择清除数据才会删除。

「重新开始」会先暂停游戏。取消可返回当前进度，确认会用新游戏替换当前卡带的存档，其他卡带和自定义键位会保留。
