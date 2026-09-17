@echo off
setlocal

set "CARPETA=%~dp0"
set "CARPETA=%CARPETA:~0,-1%"

for %%F in ("%CARPETA%\*") do (
    set "NOMBRE=%%~nxF"
    setlocal enabledelayedexpansion
    if /I "!NOMBRE!"=="SVFI_Panel.jsx" (
        rem saltar
    ) else if /I "!NOMBRE!"=="svfi_orquestador.py" (
        rem saltar
    ) else if /I "!NOMBRE!"=="mi_preset_svfi.ini" (
        rem saltar
    ) else if /I "!NOMBRE!"=="lanzar_svfi.vbs" (
        rem saltar
    ) else if /I "!NOMBRE!"=="Clean.bat" (
        rem saltar
    ) else if /I "!NOMBRE!"=="Config.bat" (
        rem saltar
    ) else if /I "!NOMBRE!"=="config.txt" (
        rem saltar
    ) else (
        if exist "%%F\" (
            rmdir /S /Q "%%F"
        ) else (
            del /F /Q "%%F"
        )
    )
    endlocal
)

exit /B 0