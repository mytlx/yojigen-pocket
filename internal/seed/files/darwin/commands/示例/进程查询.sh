#!/bin/bash
# @pocket.title 进程查询
# @pocket.desc filter 模式：每次输入都重新运行，旧进程会被结束
# @pocket.keywords ps,process
# @pocket.icon 🔍
# @pocket.mode filter

ps -axo pid=,comm= | grep -i -- "${1:-.}" | head -30 | while read -r pid comm; do
  printf '%s\tPID %s\tcopy:%s\n' "$(basename "$comm")" "$pid" "$pid"
done
