# 扩展

核心只保留启动器本身和一批小工具。体积大的、不是人人都要的功能做成**扩展包**：
一个 zip，装上才有，停用或卸载之后不占任何资源。官方扩展包也是这么来的：

| 扩展包 | 里面的工具 | 关键词 |
| --- | --- | --- |
| 写作与代码（`editors`） | Markdown 笔记、代码草稿、文本对比 | `md` `note` `笔记`、`scratch` `code` `草稿`、`diff` `对比` |
| 桌面宠物（`pet`） | 一只可以养的 3D 小狸猫 | `pet` `宠物` |
| 口袋直传（`peer`，API 2） | IPv6 点对点文件传输 | `peer` `直传` `传输` |

## 安装、停用、卸载

1. 从 [Releases](https://github.com/mytlx/yojigen-pocket/releases) 下载需要的 `<id>-<版本>.zip`。
2. 打开**道具库 → 扩展管理**，点“安装扩展…”选这个 zip，或者直接把 zip 拖进窗口。装同一个扩展的新版本就是升级，数据不动。
3. 在同一页可以停用（保留文件和数据，但不参与搜索、不启动任何东西）和卸载（可选是否一并删除数据）。

也可以直接把解压后的文件夹放进用户目录的 `plugins/` 里，效果一样。

扩展的数据都在用户目录下：

| 位置 | 内容 |
| --- | --- |
| `plugins/<id>/` | 扩展本身 |
| `data/plugins/<id>.json` | `storage` 存的键值 |
| `data/plugins/<id>-files/` | 扩展的私有文件目录 |
| `notes/`、`scratches/` 等 | 扩展在清单里声明的用户目录（卸载时不会删） |

## 写一个扩展

最小的扩展是一个文件夹加两个文件：

```
plugins/hello/
  plugin.json
  index.html
```

```json
{ "name": "打个招呼", "icon": "👋", "keywords": ["hello"], "main": "index.html", "height": 200 }
```

```html
<script src="/__pocket.js"></script>
<button onclick="pocket.ui.copy('你好')">复制一句你好</button>
```

文件夹名就是扩展的 id，只能用小写字母、数字和连字符。改完文件不用重启，重新打开工具即可。
`plugins/color-tool` 是随应用附带的一个完整例子。

要用构建工具（TypeScript、Preact、打包依赖），参考仓库里的 `extensions/`：每个子目录是一个扩展，
`bun run build:ext` 会逐个构建并打成 `build/extensions/<id>-<版本>.zip`。
`extensions/sdk/pocket.ts` 是宿主接口的类型定义。

### 清单 plugin.json

```jsonc
{
  "id": "editors",            // 可省略，默认是文件夹名
  "name": "写作与代码",
  "version": "1.0.0",
  "author": "…",
  "api": 1,                   // 需要的宿主接口版本；比应用支持的新时不加载，并提示升级应用
  "description": "…",
  "icon": "📝",               // emoji、svg:<内置图标名>，或扩展目录里的图片路径

  // 一个扩展可以带多个工具，它们共用同一份代码和依赖。
  // 只有一个工具时可以不写 tools，把下面这些字段直接写在最外层。
  "tools": [
    {
      "id": "notes",
      "title": "Markdown 笔记",
      "description": "…",
      "icon": "svg:notebook",
      "category": "效率工具",          // 道具库里的分类，默认“扩展”
      "keywords": ["md", "note", "笔记"],
      "entry": "index.html",           // 默认取最外层的 main
      "window": "panel",               // panel 主窗口里的页面（可分离）| window 直接开独立窗口 | float 无边框悬浮窗
      "width": 1040, "height": 580,
      // 带入内容时的匹配规则：选中文字、复制了图片或文件后唤出，符合规则的工具会出现在结果里
      "matches": [
        { "type": "text", "label": "存成笔记", "min": 1, "max": 200000, "regex": "" },
        { "type": "files", "exts": ["md", "txt"] },
        { "type": "image" }
      ]
    }
  ],

  "permissions": {
    "dirs": ["notes"],                 // 用户目录下可以读写的文件夹（不能是 commands、plugins、data 等保留名）
    "fetch": ["api.example.com"],      // 可以代为请求的主机；"*" 表示任意公网主机（内网地址始终拒绝）
    "runner": true,                    // 运行和格式化代码
    "files": true                      // 弹出系统对话框让用户选文件、另存为
  },

  // 可选：带一个外部进程，见“外部进程”一节
  "backend": { "command": "bin/helper", "mode": "on-demand", "idle": 300 }
}
```

没声明的权限一律拒绝，错误信息会说明缺哪一项。

### 宿主接口 window.pocket

页面运行在隔离的 iframe 里，引入 `<script src="/__pocket.js"></script>` 之后有 `window.pocket`。
所有接口都是异步的。主题（深浅色、强调色、字号）会自动同步到页面的 CSS 变量上。

| 接口 | 作用 |
| --- | --- |
| `pocket.ready` | Promise，拿到上下文：`{ plugin, tool, input, args, detached, float, platform, version }` |
| `pocket.onEnter(fn)` | 每次带着内容进来时调用（第一次打开、窗口开着时再次被叫到） |
| `pocket.ui.toast / copy / close / detach / remember` | 提示、复制、关闭、分离成独立窗口、记下要带到独立窗口的内容 |
| `pocket.storage.get / set` | 按扩展隔离的键值存储 |
| `pocket.fs.*` | `tree read write createFile createFolder rename move delete reveal open openWith pick saveAs`。第一个参数是根目录：空字符串是扩展的私有目录，其余必须在 `permissions.dirs` 里。`delete` 是移到废纸篓 |
| `pocket.on("fs", fn)` | 这个扩展的任何一个页面改了文件时收到 `{ root, op, path, to }`（`op` 是 `write` `create` `rename` `delete`）。同一个工具同时开在主窗口和独立窗口里时，靠它保持两边一致 |
| `pocket.fetch(url, options)` | 由宿主代发请求，不受跨域限制，只能访问 `permissions.fetch` 里的主机 |
| `pocket.runner.languages / format / run / stop` | 代码草稿用的那一套运行环境 |
| `pocket.window.*` | 悬浮窗专用：`info move ground resize dragStart dragMove setAlwaysOnTop close` |
| `pocket.backend.call(method, ...params)`、`pocket.backend.on(fn)` | 调用扩展自带的外部进程、接收它推过来的事件 |
| `copyText readClipboard pasteText openExternal notify hide getStorage setStorage` | 第一版的扁平接口，仍然可用 |

`Esc` 和分离快捷键会转给宿主；页面自己处理了（调用过 `preventDefault`）就不会转。

### 外部进程

有些事网页做不了：调用本机的命令行工具、跑一个 Python 脚本、常驻一个本地模型。
扩展可以带一个可执行文件或脚本，宿主负责启动、通信和回收。

```jsonc
"backend": {
  "command": "bin/helper",                         // 相对扩展目录；也可以是 PATH 里的命令
  "commands": { "windows": "bin/helper.exe", "darwin": "bin/helper" },   // 按平台覆盖
  "mode": "on-demand",                             // oneshot：每次调用起一个进程，返回后退出
                                                   // on-demand：第一次调用时启动，空闲一段时间后关掉
  "idle": 300                                      // on-demand 的空闲秒数，默认 300
}
```

协议是标准输入输出上的 JSON，一行一条：

```
→ {"id":1,"method":"sum","params":[1,2]}
← {"id":1,"result":3}
← {"id":2,"error":"出错的原因"}
← {"event":"progress","data":{"done":40}}          随时可以推事件，页面用 pocket.backend.on 接收
```

进程能拿到环境变量 `POCKET_PLUGIN_ID`、`POCKET_PLUGIN_DIR`、`POCKET_DATA_DIR`（私有数据目录）。
扩展被停用、卸载，或者应用退出时，进程会被结束。没有工具打开、也没人调用时，它根本不会启动。

## 安全边界

- 页面在独立的源里运行，拿不到应用的后端接口，只能通过 `window.pocket` 调用清单里声明过的能力。
- 文件接口限制在声明的目录里，路径里出现 `..` 或符号链接逃逸会被拒绝。
- zip 安装时会检查每个条目的路径，拒绝符号链接，并限制解压后的大小。
- 外部进程是以当前用户的权限运行的普通程序，**宿主不沙箱它**。只安装信得过的扩展。

### 点对点传输能力（API 2）

清单声明 `"api": 2` 和 `"permissions": { "peer": true, "files": true }`，并使用独立窗口。
`peer` 权限允许启动 IPv6 监听、建立直连和接收文件；`files` 允许通过原生文件选择框或拖拽发送本机文件、选择接收目录。
仅在调用 `peer.start` 后监听，关闭扩展窗口、停用或卸载时释放资源；正在传输时这些操作会被拦截。
旧 API 1 扩展仍兼容；旧宿主会提示新扩展需要升级。

通过 `pocket.call("peer.<方法>", ...参数)` 调用：

| 方法 | 用途 |
| --- | --- |
| `start` / `state` | 初始化或重新检测 IPv6 / 获取身份、连接状态、传输快照 |
| `connect(address)` | 输入对方公网 IPv6 发起直连 |
| `punchPrepare(pin, stunServer, refresh)` | 准备或刷新 UDP 打洞口令与 STUN 探测 |
| `punchInspect(token)` | 检查对方打洞口令是否需要提取码解密 |
| `punchConnect(token, pin)` | 使用对方口令发起并发 UDP/QUIC 打洞连接 |
| `accept` / `reject` / `confirm(number)` | 同意请求、拒绝请求、确认三选一数字 |
| `pick` / `folder` | 原生文件选择器 / 接收文件夹选择器 |
| `disconnect` / `cancel` | 空闲时断开 / 取消任务并断开 |
| `reveal(recordID)` | 在文件管理器中显示已完成的文件 |

不存在由扩展传入任意本地路径发送的接口。原生拖拽由宿主处理，页面不能 `preventDefault()` 截断拖拽。
主程序持有连接和文件任务，WebView 销毁不能绕过退出保护。详细操作见[口袋直传](peer.md)。
