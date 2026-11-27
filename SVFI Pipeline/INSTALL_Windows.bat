@echo off
chcp 65001 >nul
setlocal
if /I "%~1"=="/scripts" goto :scripts

echo === SVFI Pipeline 2.0.0 - install ===
echo.
REM 1) Extension (current user, no admin needed)
REM Allows unsigned extensions (required for custom CEP extensions)
for %%v in (9 10 11 12 13 14) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.gxnnr.svfipipeline"
if exist "%DEST%" rmdir /S /Q "%DEST%"
xcopy /E /I /Y /H "%~dp0com.gxnnr.svfipipeline" "%DEST%" >nul
echo [OK] Extension installed to:
echo      %DEST%
echo.

REM 2) Launcher script in File ^> Scripts (Program Files: needs administrator permission)
echo Installing SVFI_Pipeline.jsx in the After Effects Scripts folder...
echo Windows will ask for administrator permission for this step only.
powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '/scripts' -Verb RunAs -Wait -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 (
    echo [!] Permission denied: the launcher script was not installed.
    echo     The panel still works from Window ^> Extensions ^> SVFI Pipeline.
)
echo.
echo Close After Effects completely and open it again.
echo Open the panel from Window ^> Extensions ^> SVFI Pipeline
echo or from File ^> Scripts ^> SVFI_Pipeline.jsx
pause
exit /b 0

:scripts
set "FOUND=0"
for /d %%D in ("%ProgramFiles%\Adobe\Adobe After Effects *") do (
    if exist "%%D\Support Files\Scripts\" (
        copy /Y "%~dp0SVFI_Pipeline.jsx" "%%D\Support Files\Scripts\" >nul && echo [OK] %%D\Support Files\Scripts
        set "FOUND=1"
    )
)
if "%FOUND%"=="0" echo [!] No After Effects installation found in %ProgramFiles%\Adobe
timeout /t 3 >nul
exit /b 0
