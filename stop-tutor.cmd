@echo off
rem Double-click this to stop the tutor and the Whisper server.
title Stop French Tutor
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-tutor.ps1" -Stop
timeout /t 2 >nul
