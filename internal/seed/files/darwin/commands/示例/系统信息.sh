#!/bin/bash
# @pocket.title 系统信息
# @pocket.desc text 模式：把输出显示在文本视图里
# @pocket.keywords sysinfo,about
# @pocket.icon 💻
# @pocket.mode text

sw_vers
echo
echo "CPU：$(sysctl -n machdep.cpu.brand_string)"
echo "内存：$(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
echo
df -h / | tail -1 | awk '{print "磁盘：已用 " $3 " / 共 " $2}'
