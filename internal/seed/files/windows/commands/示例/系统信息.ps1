# @pocket.title 系统信息
# @pocket.desc text 模式：把输出显示在文本视图里
# @pocket.keywords sysinfo,about
# @pocket.icon 💻
# @pocket.mode text

$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Write-Output "系统：$($os.Caption) $($os.Version)"
Write-Output "CPU：$($cpu.Name)"
Write-Output ("内存：{0:N1} GB" -f ($os.TotalVisibleMemorySize / 1MB))
