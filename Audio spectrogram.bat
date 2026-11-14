@echo off
cd /d "%~dp0"
start "Spectrogram server" /min python server.py
timeout /t 1 /nobreak >nul
start "" http://localhost:8000/
