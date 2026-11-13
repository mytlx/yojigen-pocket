# @pocket.title 进程查询
# @pocket.desc filter 模式：每次输入都重新运行，旧进程会被结束
# @pocket.keywords ps,process
# @pocket.icon 🔍
# @pocket.mode filter

$q = $args[0]
Get-Process | Where-Object { -not $q -or $_.ProcessName -like "*$q*" } | Select-Object -First 30 | ForEach-Object {
  "$($_.ProcessName)`tPID $($_.Id)`tcopy:$($_.Id)"
}
