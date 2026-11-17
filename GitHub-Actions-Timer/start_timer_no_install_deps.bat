@echo off
echo 正在启动计时器...
start /b pythonw timer.py
echo 计时器已在后台启动，可以关闭此窗口。
timeout /t 2 >nul
exit 