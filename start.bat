@echo off
cd /d "%~dp0www"
start "Spectrogram server" /min python -m http.server 8000 --bind 127.0.0.1
timeout /t 1 /nobreak >nul
start "" http://localhost:8000/
