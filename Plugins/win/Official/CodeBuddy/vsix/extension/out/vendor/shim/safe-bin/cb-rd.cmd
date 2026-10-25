@echo off
setlocal enabledelayedexpansion

REM CodeBuddy Safe-Delete: rd/rmdir wrapper for cmd.exe
REM Moves directories to recycle bin instead of permanent delete.
REM Usage: cb-rd.cmd [/s] [/q] dir1 [dir2 ...]

set "RECURSIVE=0"
set "QUIET=0"
set "DIR_COUNT=0"
set "EXIT_CODE=0"

:parse_args
if "%~1"=="" goto :do_delete
set "arg=%~1"
if /i "%arg%"=="/s" (set "RECURSIVE=1" & shift & goto :parse_args)
if /i "%arg%"=="/q" (set "QUIET=1" & shift & goto :parse_args)
if /i "%arg%"=="/?" goto :help
REM Treat as directory path
set /a "DIR_COUNT+=1"
set "DIR_!DIR_COUNT!=%~f1"
shift
goto :parse_args

:do_delete
if %DIR_COUNT% equ 0 (
    if "%QUIET%"=="0" echo [safe-delete] No directories specified. 1>&2
    exit /b 0
)

for /l %%i in (1,1,%DIR_COUNT%) do (
    set "target=!DIR_%%i!"
    if not exist "!target!" (
        if "%QUIET%"=="0" echo [safe-delete] Directory not found: "!target!" 1>&2
    ) else (
        REM Check if directory is empty (when /s not specified)
        if "!RECURSIVE!"=="0" (
            dir /b "!target!" 2>nul | findstr /r ".*" >nul 2>&1
            if not errorlevel 1 (
                echo [safe-delete][SAFE_DELETE_FAIL_CLOSED] {"target":"!target!","reason":"non-empty-directory"} 1>&2
                set "EXIT_CODE=1"
            ) else (
                call :trash_dir "!target!"
                if errorlevel 1 set "EXIT_CODE=1"
            )
        ) else (
            call :trash_dir "!target!"
            if errorlevel 1 set "EXIT_CODE=1"
        )
    )
)

endlocal & exit /b %EXIT_CODE%

:trash_dir
set "dir_path=%~1"
powershell -NoProfile -NonInteractive -Command ^
    "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('%dir_path%', 'OnlyErrorDialogs', 'SendToRecycleBin')" 2>&1
if errorlevel 1 (
    echo [safe-delete][SAFE_DELETE_FAIL_CLOSED] {"target":"%dir_path%","reason":"trash-failed"} 1>&2
    exit /b 1
)
REM Verify directory was moved
if exist "%dir_path%" (
    echo [safe-delete][SAFE_DELETE_FAIL_CLOSED] {"target":"%dir_path%","reason":"still-exists-after-trash"} 1>&2
    exit /b 1
)
exit /b 0

:help
echo CodeBuddy Safe-Delete: rd/rmdir wrapper
echo Moves directories to Windows recycle bin instead of permanent delete.
echo.
echo Usage: cb-rd.cmd [/s] [/q] dir1 [dir2 ...]
echo.
echo Options:
echo   /s   Remove directory with all subdirectories and files
echo   /q   Quiet mode
exit /b 0
