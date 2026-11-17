@echo off
setlocal enabledelayedexpansion

echo Checking Python installation...
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Python not found. Please install Python before running this script.
    pause
    exit /b 1
)

echo Checking and installing dependencies...
python -m pip --version >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing pip...
    python -m ensurepip --upgrade
)

echo Installing requests library...
python -m pip install requests

echo Checking tkinter...
python -c "import tkinter" >nul 2>nul
if %errorlevel% neq 0 (
    echo Warning: tkinter may not be installed. The timer program may not run properly.
    echo Please consider reinstalling Python with the tkinter option selected.
    pause
)

echo All dependencies are ready. Starting timer program...
start /b python timer.py

echo Program started! You can close this window.
timeout /t 3 >nul
exit