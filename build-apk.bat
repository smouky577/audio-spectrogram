@echo off
cd /d "%~dp0"
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"

call npx cap sync android || goto :error
pushd android
call gradlew.bat assembleDebug || (popd & goto :error)
popd
copy /y android\app\build\outputs\apk\debug\app-debug.apk Spectrogram.apk >nul

echo.
echo Gotovo: %~dp0Spectrogram.apk
pause
exit /b 0

:error
echo.
echo Greshka pri kompiliraneto.
pause
exit /b 1
