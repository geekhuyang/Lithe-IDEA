# Initialize-CodeBuddySafeDelete.ps1
# Bootstrap script for VSCode Terminal PowerShell initialization.
#
# This script loads the CodeBuddy.SafeDelete module and verifies that Remove-Item
# has been successfully overridden.
#
# It is evaluated as an *expression* by the host, not executed as a script file:
#
#   $CODEBUDDY_SAFE_DELETE_BOOTSTRAP_ROOT = Split-Path -Parent <path>
#   Invoke-Expression (Get-Content -Raw -Encoding UTF8 -LiteralPath <path>)
#
# `-Encoding UTF8` is part of the contract, not an optional extra: this file is
# UTF-8 and PowerShell 5.1 reads with the ANSI code page by default (issue #88107).
#
# Rationale (issue #81619): PowerShell's ExecutionPolicy only governs script
# *files* (.ps1 / .psm1). On machines with `Restricted` / `AllSigned` — very
# common with domain GPOs — dot-sourcing this file and `Import-Module` on the
# .psm1 both fail with PSSecurityException / UnauthorizedAccess, which used to
# leave the built-in `Remove-Item` in place and permanently delete user files.
# Loading the sources as expressions keeps safe-delete working under any policy.
#
# Because `$PSScriptRoot` is empty when a script is evaluated as an expression,
# the host passes the directory in $CODEBUDDY_SAFE_DELETE_BOOTSTRAP_ROOT. Legacy
# dot-source callers still work via the $PSScriptRoot fallback below.

$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Stop'

    $scriptRoot = $CODEBUDDY_SAFE_DELETE_BOOTSTRAP_ROOT
    if (-not $scriptRoot) { $scriptRoot = $PSScriptRoot }
    if (-not $scriptRoot -and $env:CODEBUDDY_SAFE_DELETE_SHIM_DIR) {
        $scriptRoot = Join-Path $env:CODEBUDDY_SAFE_DELETE_SHIM_DIR 'powershell'
    }
    if (-not $scriptRoot) {
        throw 'unable to resolve safe-delete shim directory'
    }

    $modulePath = Join-Path $scriptRoot 'CodeBuddy.SafeDelete.psm1'
    if (-not (Test-Path -LiteralPath $modulePath)) {
        throw ('module not found: ' + $modulePath)
    }

    $existingRemoveItem = Get-Command Remove-Item -ErrorAction SilentlyContinue
    if ((Get-Variable -Name CODEBUDDY_SAFE_DELETE_PS_READY -Scope Global -ErrorAction SilentlyContinue) -and
        ($null -eq $existingRemoveItem -or $existingRemoveItem.CommandType -ne 'Function')) {
        Remove-Variable -Name CODEBUDDY_SAFE_DELETE_PS_READY -Scope Global -Force -ErrorAction SilentlyContinue
    }

    # Load the module as an in-memory script block instead of `Import-Module <file>`:
    # the latter is also subject to ExecutionPolicy. `New-Module` keeps the module
    # semantics (its `global:` definitions land in the global scope on import).
    $moduleSource = Get-Content -Raw -Encoding UTF8 -LiteralPath $modulePath
    $moduleBlock = [ScriptBlock]::Create($moduleSource)
    New-Module -Name 'CodeBuddy.SafeDelete' -ScriptBlock $moduleBlock | Import-Module -Force -ErrorAction Stop

    # Verify Remove-Item has been overridden by checking for our readiness marker.
    if (-not (Get-Variable -Name CODEBUDDY_SAFE_DELETE_PS_READY -Scope Global -ErrorAction SilentlyContinue)) {
        throw 'module loaded but readiness marker not set'
    }

    # Verify Remove-Item is actually our wrapper (not the built-in).
    $removeItemDef = Get-Command Remove-Item -ErrorAction SilentlyContinue
    if ($null -eq $removeItemDef -or $removeItemDef.CommandType -ne 'Function') {
        throw 'Remove-Item not overridden by safe-delete wrapper'
    }

    # Once this session is verified the host stops injecting anything in front of a
    # plain delete command, so both session-scoped helpers have to exist. An older shim
    # bundle without them must fail initialization here, which keeps the host on its
    # self-contained per-command bootstrap.
    if ($null -eq (Get-Command Assert-CodeBuddySafeDelete -ErrorAction SilentlyContinue) -or
        $null -eq (Get-Command __cbsd -ErrorAction SilentlyContinue)) {
        throw 'safe-delete readiness assertion helper not available'
    }

    # Without the self-healing prompt hook nothing would restore interception after a
    # later command dropped our wrapper, yet the host would still be told the session
    # is ready and would stop injecting its own assertion. Asserting it here makes that
    # case fail closed instead (same reasoning as the POSIX hook assertion).
    if (-not (Get-Variable -Name CODEBUDDY_SAFE_DELETE_PROMPT_HOOK -Scope Global -ErrorAction SilentlyContinue)) {
        throw 'safe-delete self-healing prompt hook not installed'
    }

} catch {
    Remove-Variable -Name CODEBUDDY_SAFE_DELETE_PS_READY -Scope Global -Force -ErrorAction SilentlyContinue
    $message = '[safe-delete][INIT_ERROR] ' + $_.Exception.Message
    [Console]::Error.WriteLine($message)
    throw $message
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
