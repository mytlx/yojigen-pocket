# @pocket.title 复制当前时间戳
# @pocket.desc toast 模式：把最后一行显示成通知
# @pocket.keywords timestamp,now
# @pocket.icon ⏱
# @pocket.mode toast

$ts = [DateTimeOffset]::Now.ToUnixTimeSeconds()
Set-Clipboard -Value $ts
Write-Output "已复制 $ts"
