# @pocket.title 最近下载
# @pocket.desc list 模式：回车打开，继续输入可过滤
# @pocket.keywords downloads
# @pocket.icon 📥
# @pocket.mode list

Get-ChildItem "$HOME\Downloads" | Sort-Object LastWriteTime -Descending | Select-Object -First 30 | ForEach-Object {
  "$($_.Name)`t$($_.FullName)`topen:$($_.FullName)"
}
