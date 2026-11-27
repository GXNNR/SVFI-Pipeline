@echo off
chcp 65001 >nul
setlocal
if /I "%~1"=="/scripts" goto :scripts

set "DEST=%APPDATA%\Adobe\CEP\extensions\com.gxnnr.svfipipeline"
if exist "%DEST%" rmdir /S /Q "%DEST%"
echo [OK] Extension removed.
echo Removing SVFI_Pipeline.jsx from the After Effects Scripts folder (administrator permission)...
powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '/scripts' -Verb RunAs -Wait -ErrorAction Stop } catch { exit 1 }"
echo.
echo SVFI Pipeline uninstalled. Restart After Effects.
echo Your settings stay in Documents\SVFIPipeline (delete that folder to remove them).
pause
exit /b 0

:scripts
for /d %%D in ("%ProgramFiles%\Adobe\Adobe After Effects *") do (
    if exist "%%D\Support Files\Scripts\SVFI_Pipeline.jsx" del /F /Q "%%D\Support Files\Scripts\SVFI_Pipeline.jsx" && echo [OK] %%D
)
timeout /t 3 >nul
exit /b 0
