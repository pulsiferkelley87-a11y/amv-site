@echo off
chcp 65001 >nul
title 部署 0AMV 云端网站
echo 正在部署到 GitHub（约 1-2 分钟），窗口会自动关闭...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
echo.
echo 部署完成，结果已写入 deploy_log.txt
timeout /t 5 >nul
