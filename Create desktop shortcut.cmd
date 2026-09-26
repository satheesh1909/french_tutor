@echo off
rem Run once: puts a "French Tutor" icon on your desktop and in the Start menu.
title French Tutor setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shortcut.ps1"
pause
