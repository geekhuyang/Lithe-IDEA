@echo off
setlocal enabledelayedexpansion

REM CodeBuddy Safe-Delete: del/erase wrapper for cmd.exe
REM Moves files to recycle bin instead of permanent delete.
REM Usage: cb-del.cmd [/f] [/q] [/s] [/a:attrs] [/p] file1 [file2 ...]
REM
REM Limitations:
REM - Wildcards (*.txt) are expanded by cmd before passing to this wrapper.
REM - /p (prompt) is not supported (fail-closed).
REM - /s (recursive subdir search) is not supported via recycle bin.
REM - Directory targets are rejected; use cb-rd.cmd for explicit directory deletion.

set "FORCE=0"
set "QUIET=0"
set "ATTRS="
set "FILE_COUNT=0"
set "EXIT_CODE=0"

:parse_args
if "%~1"=="" goto :do_delete
set "arg=%~1"
if /i "%arg%"=="/f" (set "FORCE=1" & shift & goto :parse_args)
if /i "%arg%"=="/q" (set "QUIET=1" & shift & goto :parse_args)
if /i "%arg%"=="/s" (set "RECURSIVE=1" & shift & goto :parse_args)
if /i "%arg:~0,3%"=="/a:" (set "ATTRS=%arg:~3%" & shift & goto :parse_args)
if /i "%arg%"=="/p" (
    echo [safe-delete][SAFE_DELETE_FAIL_CLOSED] {"reason":"interactive-prompt-not-supported"} 1>&2
    exit /b 1
)
if /i "%arg%"=="/?" goto :help
REM Treat as file path
set /a "FILE_COUNT+=1"
set "FILE_!FILE_COUNT!=%~f1"
shift
goto :parse_args

:do_delete
if %FILE_COUNT% equ 0 (
    if "%QUIET%"=="0" echo [safe-delete] No files specified. 1>&2
    exit /b 0
)

set "PS_SCRIPT="
for /l %%i in (1,1,%FILE_COUNT%) do (
    set "target=!FILE_%%i!"
    if not exist "!target!" (
        if "!FORCE!"=="0" (
            echo [safe-delete][SAFE_DELETE_FAIL_CLOSED] {"target":"!target!","reason":"path-not-found"} 1>&2
            set "EXIT_CODE=1"
        )
    ) else if exist "!target!\NUL" (
        REM `del` is file-only. Reject directories even if shell re-parsing injected one.
        echo [safe-delete][SAFE_DELETE_FAIL_CLOSED] {"target":"!target!","reason":"directory-not-supported"} 1>&2
        set "EXIT_CODE=1"
    ) else (
        REM Build PowerShell command to move the file to the recycle bin.
        set "PS_SCRIPT=!PS_SCRIPT!Add-Type -AssemblyName Microsoft.VisualBasic; $t='!target!'; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($t, 'OnlyErrorDialogs', 'SendToRecycleBin'); if (Test-Path -LiteralPath $t) { Write-Error 'still-exists' };"
    )
)

if defined PS_SCRIPT (
    powershell -NoProfile -NonInteractive -Command "!PS_SCRIPT!" 2>&1
    if errorlevel 1 (
        echo [safe-delete][SAFE_DELETE_FAIL_CLOSED] {"reason":"trash-failed"} 1>&2
        set "EXIT_CODE=1"
    )
)

endlocal & exit /b %EXIT_CODE%

:help
echo CodeBuddy Safe-Delete: del/erase wrapper
echo Moves files to Windows recycle bin instead of permanent delete.
echo.
echo Usage: cb-del.cmd [/f] [/q] [/a:attrs] file1 [file2 ...]
echo.
echo Options:
echo   /f         Force (ignore missing files)
echo   /q         Quiet mode
echo   /a:attrs   Filter by attributes (ignored, all files processed)
echo.
echo Limitations:
echo   /p (prompt) not supported
echo   /s (recursive subdir search) falls back to per-file recycle
exit /b 0
