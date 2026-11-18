#!/bin/bash
# @pocket.title 复制当前时间戳
# @pocket.desc toast 模式：把最后一行显示成通知
# @pocket.keywords now,unixtime
# @pocket.icon ⏱
# @pocket.mode toast

ts=$(date +%s)
printf '%s' "$ts" | pbcopy
echo "已复制 $ts"
