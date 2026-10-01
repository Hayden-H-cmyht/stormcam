@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   StormCam 风暴相机   http://127.0.0.1:8787
echo.
set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if defined PY (
  start "StormCam Server" cmd /c "%PY% -m http.server 8787 --bind 127.0.0.1"
  timeout /t 1 /nobreak >nul
  start "" "http://127.0.0.1:8787/"
  echo 服务已在后台运行,浏览器将自动打开。关闭弹出的服务窗口即可停止。
) else (
  echo [!] 未找到 Python 3。请先安装 Python,或在项目目录执行:
  echo     python -m http.server 8787
)
echo.
pause
