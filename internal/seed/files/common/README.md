# Yojigen Pocket 用户目录

这个文件夹就是 Yojigen Pocket 的全部配置，可以直接用 git 管理、复制到新电脑。

| 位置 | 内容 |
| --- | --- |
| `config.json` | 主配置。也可以在设置窗口里改，两边实时同步 |
| `commands/` | 脚本命令：放一个脚本进去，保存后马上能搜到 |
| `plugins/` | 网页插件：每个文件夹一个，含 `plugin.json` 和网页 |
| `snippets/` | 文本片段：`.md` / `.txt` 文件，文件名是标题 |
| `ui/theme.css` | 只放 CSS 变量，换配色和字体改这里就够 |
| `ui/user.css` | 覆盖任意样式 |
| `ui/user.js` | 界面钩子：改输入、改排序、加快捷键 |
| `data/` `cache/` `logs/` | 运行数据，不需要同步（已写入 .gitignore） |

## 写一个脚本命令

文件头部写几行注释就够了，全部可选：

```bash
#!/bin/bash
# @pocket.title 问候
# @pocket.keywords hi,hello
# @pocket.mode toast
echo "你好，$1"
```

输出模式 `mode`：`silent` 只干活；`toast` 把最后一行显示成通知；`text` 显示文本；
`detail` 显示 Markdown；`list` 显示可过滤的列表；`filter` 每次输入都重新运行；`panel` 显示网页。

`list` / `filter` 输出 JSON（`{"items":[{"title":"…","subtitle":"…","actions":[{"type":"open","target":"…"}]}]}`），
或每行一项的文本（`标题⇥副标题⇥动作`，动作写 `open:`、`copy:`、`shell:`、`run:` 前缀）。

脚本能拿到的环境变量：`POCKET_QUERY`、`POCKET_CLIPBOARD`、`POCKET_FG_PROCESS`、`POCKET_FG_TITLE`、
`POCKET_DATA_DIR`（这个命令专属的持久目录）、`POCKET_CACHE_DIR`。stdin 是完整的 JSON 上下文。

更多元数据（`arg1`、`hotkey`、`when`、`fallback`、`timeout`、`cwd`、`confirm`、`refresh`、`interpreter`）见项目 README。
