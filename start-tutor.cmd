@echo off
rem Double-click this to start the French tutor.
title French Tutor
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-tutor.ps1" %*
