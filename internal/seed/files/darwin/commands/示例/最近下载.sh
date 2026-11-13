#!/bin/bash
# @pocket.title 最近下载
# @pocket.desc list 模式：回车打开，继续输入可过滤
# @pocket.keywords downloads
# @pocket.icon 📥
# @pocket.mode list

cd ~/Downloads || { echo "无法访问下载文件夹，请在系统设置里授权" >&2; exit 1; }
ls -t | head -30 | while IFS= read -r name; do
  printf '%s\t%s\topen:%s\n' "$name" "$PWD/$name" "$PWD/$name"
done
