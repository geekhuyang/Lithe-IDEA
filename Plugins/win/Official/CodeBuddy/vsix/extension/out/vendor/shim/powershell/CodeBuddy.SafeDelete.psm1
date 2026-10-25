# CodeBuddy.SafeDelete PowerShell Module (Phase 2)
# Extracted from inline POWERSHELL_SAFE_DELETE_PRELUDE for VSCode Terminal bootstrap.
# Overrides Remove-Item and aliases to route deletions through system recycle bin.

if (-not (Get-Variable -Name CODEBUDDY_SAFE_DELETE_PS_READY -Scope Global -ErrorAction SilentlyContinue)) {
    Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null

    function New-SafeDeleteFailClosedMessage {
        param([AllowEmptyString()] [string]$Target, [string]$Reason, [AllowEmptyString()] [string]$Detail = '')
        $payload = [ordered]@{ target = $Target; reason = $Reason }
        if ($Detail) { $payload['detail'] = $Detail }
        return '[safe-delete][SAFE_DELETE_FAIL_CLOSED] ' + ($payload | ConvertTo-Json -Compress)
    }

    # Human readable counterpart of the machine marker (issue #87864).
    #
    # ASCII only on purpose: the VS Code terminal may still run under a legacy OEM code
    # page, where non-ASCII text would be painted as mojibake.
    function Get-SafeDeleteFailClosedText {
        param([AllowEmptyString()] [string]$Target, [string]$Reason, [AllowEmptyString()] [string]$Detail = '')
        $quoted = if ($Target) { "'" + $Target + "'" } else { 'the requested path' }
        switch ($Reason) {
            'path-not-found' { return 'Cannot find ' + $quoted + ' because it does not exist.' }
            'non-empty-directory' { return $quoted + ' is not empty. Re-run with -Recurse to delete it and everything it contains.' }
            'interactive-not-supported' { return 'Interactive deletion (-i) is not supported while safe delete is enabled.' }
            'confirm-not-supported' { return '-Confirm is not supported while safe delete is enabled.' }
            'trash-failed' {
                $trashText = 'Cannot move ' + $quoted + ' to the recycle bin.'
                if ($Detail) { $trashText = $trashText + ' ' + $Detail }
                return $trashText
            }
        }
        $text = 'Safe delete refused to delete ' + $quoted + ' (' + $Reason + ').'
        if ($Detail) { $text = $text + ' ' + $Detail }
        return $text
    }

    # Build the terminating error for a fail-closed deletion *and* publish the machine
    # marker the host escalates on (issue #87864).
    #
    # Two separate channels on purpose:
    #   - The ErrorRecord carries only the human sentence. `throw '<marker> {json}'` made
    #     PowerShell render the payload twice (once as the message, once as the
    #     FullyQualifiedErrorId, since a thrown string doubles as the error id) and print
    #     this file's own source line plus a squiggle underneath, so a mistyped path
    #     produced a wall of red shim internals.
    #   - The marker goes to stderr concealed (SGR 8), exactly like the readiness marker:
    #     it stays in the terminal buffer for hosts that can only scrape the visible
    #     screen, yet it is not readable as text. The host strips it before the output
    #     reaches the model.
    #
    # Emitting the marker here instead of at every call site keeps the two from drifting:
    # an ErrorRecord without its marker would silently disable the host's escalation.
    function New-SafeDeleteFailClosedError {
        param([AllowEmptyString()] [string]$Target, [string]$Reason, [AllowEmptyString()] [string]$Detail = '')
        $sdEsc = [char]27
        [Console]::Error.WriteLine($sdEsc + '[8m' + (New-SafeDeleteFailClosedMessage $Target $Reason $Detail) + $sdEsc + '[0m')
        $category = switch ($Reason) {
            'path-not-found' { [System.Management.Automation.ErrorCategory]::ObjectNotFound }
            'non-empty-directory' { [System.Management.Automation.ErrorCategory]::InvalidOperation }
            'interactive-not-supported' { [System.Management.Automation.ErrorCategory]::InvalidArgument }
            'confirm-not-supported' { [System.Management.Automation.ErrorCategory]::InvalidArgument }
            default { [System.Management.Automation.ErrorCategory]::WriteError }
        }
        $text = Get-SafeDeleteFailClosedText $Target $Reason $Detail
        $exception = if ($Reason -eq 'path-not-found') {
            New-Object System.Management.Automation.ItemNotFoundException -ArgumentList $text
        } else {
            New-Object System.InvalidOperationException -ArgumentList $text
        }
        return New-Object System.Management.Automation.ErrorRecord -ArgumentList $exception, ('SafeDelete.' + $Reason), $category, $Target
    }

    # Terminating error for a bulk guard verdict.
    #
    # Carries only the human readable sentence. The machine marker is published on the
    # concealed stderr channel by Invoke-SafeDeleteBulkGuard, exactly like the fail-closed
    # marker above. Passing the guard's own output through as the message made PowerShell
    # render the whole marker payload a second time under `Remove-Item : ...`, and the
    # payload arrived pre-wrapped at CRLF because it had been formatted for a console
    # (issue #88164).
    function New-SafeDeleteBulkGuardError {
        param([string]$Message)
        $exception = New-Object System.InvalidOperationException -ArgumentList $Message
        return New-Object System.Management.Automation.ErrorRecord -ArgumentList $exception, 'SafeDelete.bulk-guard', ([System.Management.Automation.ErrorCategory]::OperationStopped), $null
    }

    function Write-SafeDeleteReport {
        param([string]$Target)
        $reportPath = $env:CODEBUDDY_SAFE_DELETE_REPORT_PATH
        if (-not $reportPath) { return }
        try {
            $payload = [ordered]@{ operation = 'trash'; runtime = 'powershell'; path = $Target; timestamp = [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds) }
            $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
            [System.IO.File]::AppendAllText($reportPath, ($payload | ConvertTo-Json -Compress) + [Environment]::NewLine, $utf8)
        } catch { }
    }

    # Resolve the bundled genie-trash native binary path.
    #
    # Mirrors the Node/bash/Python shims' resolveTrashBin(): the binary is named
    # platform-arch plus '.exe' on Windows; GENIE_TRASH_DIR (injected by
    # buildSafeDeleteEnv) wins, then <shimDir>/../genie-trash as a dev-environment
    # fallback. Returns candidate paths (possibly none): an unrecognized
    # platform/architecture must fail open to the VB.FileIO recycle-bin path
    # instead of throwing. A bare ToLower() on the raw PROCESSOR_ARCHITECTURE
    # env var crashed the wrapper outside every fail-open catch (issue #95509
    # review).
    $Global:CODEBUDDY_SAFE_DELETE_TRASH_BIN_AVAILABLE = $null # $null=unprobed, $true/$false=known
    function Resolve-SafeDeleteTrashBin {
        $platform = $null
        if ($env:OS -eq 'Windows_NT' -or [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) { $platform = 'win32' }
        elseif ($IsMacOS) { $platform = 'darwin' }
        elseif ($IsLinux) { $platform = 'linux' }
        $arch = $null
        if ($platform -eq 'win32') {
            # PROCESSOR_ARCHITECTURE is empty/absent on non-Windows pwsh hosts and
            # under constrained sessions; a 32-bit process on 64-bit Windows reports
            # the real architecture via PROCESSOR_ARCHITEW6432.
            $pa = [string]$env:PROCESSOR_ARCHITECTURE
            if (-not $pa) { $pa = [string]$env:PROCESSOR_ARCHITEW6432 }
            if ($pa -match '(?i)^amd64$') { $arch = 'x64' }
            elseif ($pa -match '(?i)^arm64$') { $arch = 'arm64' }
        } elseif ($platform) {
            # Windows PowerShell 5.1 is Windows-only and never reaches here; pwsh
            # 7+ always exposes RuntimeInformation.ProcessArchitecture.
            $pa = [string][System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture
            if ($pa -match '(?i)^x64$') { $arch = 'x64' }
            elseif ($pa -match '(?i)^arm64$') { $arch = 'arm64' }
        }
        $names = New-Object System.Collections.Generic.List[string]
        if ($platform -and $arch) {
            $ext = ''
            if ($platform -eq 'win32') { $ext = '.exe' }
            [void]$names.Add($platform + '-' + $arch + $ext)
            if ($platform -eq 'win32' -and $arch -eq 'arm64') {
                # The vendored set ships win32-x64.exe only; Windows on ARM runs
                # it through x64 emulation.
                [void]$names.Add('win32-x64.exe')
            }
        }
        $candidates = New-Object System.Collections.Generic.List[string]
        foreach ($name in $names) {
            if ($env:GENIE_TRASH_DIR) { [void]$candidates.Add((Join-Path $env:GENIE_TRASH_DIR $name)) }
            if ($env:CODEBUDDY_SAFE_DELETE_SHIM_DIR) {
                [void]$candidates.Add((Join-Path (Split-Path -Parent $env:CODEBUDDY_SAFE_DELETE_SHIM_DIR) (Join-Path 'genie-trash' $name)))
            }
        }
        return $candidates.ToArray()
    }

    # Run genie-trash with a hard timeout. This used to be the only unbounded
    # native call in the shim family (Node/bash/Python use 5-10s); a hung helper
    # (UNC path, antivirus, an IFileOperation dialog) would hang the whole Agent
    # terminal forever — the exact symptom the native path exists to remove.
    # Returns $null when the helper could not start or timed out (both are
    # transient: the caller fails open WITHOUT caching the binary as
    # unavailable), otherwise a pscustomobject with ExitCode and Output.
    function Invoke-SafeDeleteTrashBinProcess {
        param([string]$BinPath, [string]$TargetPath, [int]$TimeoutMs)
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $BinPath
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
            # Windows PowerShell 5.1 has no ProcessStartInfo.ArgumentList, so the
            # command line is built by hand. A trailing backslash would escape the
            # closing quote under the Windows argument-parsing rules; recycle-bin
            # targets are never drive roots, so it is safe to strip.
            $arg = $TargetPath
            if ($arg.Length -gt 3 -and $arg.EndsWith('\')) { $arg = $arg.TrimEnd('\') }
            $psi.Arguments = '-q "' + $arg + '"'
        } else {
            # Unix .NET splits Arguments on whitespace with no shell involved, so
            # the per-argument list (pwsh 7+/.NET Core only) is the only safe way
            # to pass paths containing spaces.
            [void]$psi.ArgumentList.Add('-q')
            [void]$psi.ArgumentList.Add($TargetPath)
        }
        $proc = $null
        try {
            $proc = New-Object System.Diagnostics.Process
            $proc.StartInfo = $psi
            if (-not $proc.Start()) { return $null }
            # Async reads keep a full pipe buffer from deadlocking WaitForExit.
            $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
            $stderrTask = $proc.StandardError.ReadToEndAsync()
            if (-not $proc.WaitForExit($TimeoutMs)) {
                try { [void]$proc.Kill() } catch { }
                return $null
            }
            return [pscustomobject]@{ ExitCode = $proc.ExitCode; Output = ([string]$stdoutTask.Result + [string]$stderrTask.Result) }
        } catch {
            return $null
        } finally {
            if ($null -ne $proc) { $proc.Dispose() }
        }
    }

    # Move a single path to the recycle bin via the bundled genie-trash native
    # helper (Rust, IFileOperation on Windows — batches metadata registration
    # instead of the per-file overhead of Microsoft.VisualBasic.FileIO; a
    # 1000+-file directory took 1-2 minutes through VB.FileIO).
    #
    # Returns $true on success, $false when the helper is unavailable, refused
    # this request (exit 2: over --limit, bad arguments) or timed out — the
    # caller falls back to VB.FileIO in all those cases, exactly the pre-native
    # behavior. Throws when the helper ran and failed the recycle operation
    # itself (caller must NOT silently permanent-delete).
    function Invoke-SafeDeleteNativeTrash {
        param([string]$TargetPath)
        if ($Global:CODEBUDDY_SAFE_DELETE_TRASH_BIN_AVAILABLE -eq $false) { return $false }
        # Resolution and startup stay inside try: a throw before it (the
        # unguarded ToLower() of the first iteration) escaped every
        # fail-open catch, was relabelled trash-failed and made the host offer a
        # permanent delete for a path the recycle bin could have taken
        # (issue #95509 review).
        $result = $null
        try {
            $binPath = $null
            foreach ($candidate in @(Resolve-SafeDeleteTrashBin)) {
                if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $candidate -PathType Leaf) { $binPath = $candidate; break }
            }
            if (-not $binPath) {
                # No binary for this platform/architecture: cache like the Node
                # shim caches ENOENT — the vendored set will not appear mid-session.
                $Global:CODEBUDDY_SAFE_DELETE_TRASH_BIN_AVAILABLE = $false
                return $false
            }
            $result = Invoke-SafeDeleteTrashBinProcess -BinPath $binPath -TargetPath $TargetPath -TimeoutMs 10000
        } catch {
            # Transient startup failure (permissions etc.): fail open WITHOUT
            # caching, mirroring the EACCES branch of the Node shim — one flaky
            # moment must not spend the whole session on the slow path.
            return $false
        }
        if ($null -eq $result) { return $false }
        if ($result.ExitCode -eq 0) { $Global:CODEBUDDY_SAFE_DELETE_TRASH_BIN_AVAILABLE = $true; return $true }
        # exit 2 means the helper declined the request itself, not that the
        # recycle failed: over --limit (a large directory then only needs the
        # slower VB.FileIO path, same as before this prelude existed) or a
        # command-line problem. Fail open instead of blocking the deletion.
        if ($result.ExitCode -eq 2) { return $false }
        # Helper ran but failed the recycle operation itself: surface the
        # reason, do NOT fall through to a silent permanent delete of a path the
        # helper refused. Reuses Get-SafeDeleteGuardOutputText for the same
        # reason as the bulk guard output (issue #88164): rendering stderr
        # ErrorRecords with the console string formatter produces PowerShell's
        # full native-command error report instead of the helper's own
        # plain-text line.
        throw ('genie-trash rejected the path: ' + (Get-SafeDeleteGuardOutputText $result.Output))
    }

    function Get-SafeDeleteComparablePath {
        param([string]$Path)
        $fullPath = [System.IO.Path]::GetFullPath($Path)
        try {
            $info = $null
            if ([System.IO.Directory]::Exists($fullPath)) { $info = [System.IO.DirectoryInfo]::new($fullPath) }
            elseif ([System.IO.File]::Exists($fullPath)) { $info = [System.IO.FileInfo]::new($fullPath) }
            if ($null -ne $info) {
                $linkTarget = $null
                try { $linkTarget = $info.ResolveLinkTarget($true) } catch { $linkTarget = $null }
                if ($null -ne $linkTarget) { $fullPath = [string]$linkTarget.FullName } else { $fullPath = [string]$info.FullName }
            }
        } catch { }
        return $fullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    }

    function Test-SafeDeleteUnderOsTemp {
        param([string]$Target)
        try {
            $tmpPath = Get-SafeDeleteComparablePath ([System.IO.Path]::GetTempPath())
            $targetPath = Get-SafeDeleteComparablePath $Target
            return $targetPath.Length -gt $tmpPath.Length -and $targetPath.StartsWith($tmpPath, [System.StringComparison]::OrdinalIgnoreCase) -and ($targetPath.Substring($tmpPath.Length, 1) -in @([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
        } catch { return $false }
    }

    function Get-SafeDeleteEpochMs {
        return [double][int64](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds)
    }

    # Read a small JSON state file together with its mtime. Returns $null when the file
    # cannot be read; `Parsed` is $null when the content is not valid JSON (which happens
    # when an atomic rename is caught mid-flight).
    function Get-SafeDeleteJsonState {
        param([string]$Path)
        try {
            if (-not [System.IO.File]::Exists($Path)) { return $null }
            $raw = [System.IO.File]::ReadAllText($Path)
            $mtimeMs = [double][int64](([System.IO.File]::GetLastWriteTimeUtc($Path) - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds)
        } catch { return $null }
        $parsed = $null
        try { $parsed = $raw | Microsoft.PowerShell.Utility\ConvertFrom-Json } catch { $parsed = $null }
        return [pscustomobject]@{ Parsed = $parsed; MtimeMs = $mtimeMs }
    }

    # Host liveness: 'live' | 'dead' | 'unknown'. Semantics live in
    # packages/safe-delete/src/context-liveness.ts (single source of truth) and are pinned
    # across runtimes by SAFE_DELETE_LIVENESS_VECTORS.
    function Get-SafeDeleteHostLiveness {
        param([double]$NowMs)
        $heartbeatPath = $env:CODEBUDDY_SAFE_DELETE_HOST_HEARTBEAT
        if (-not $heartbeatPath) { return 'unknown' }
        $file = Get-SafeDeleteJsonState $heartbeatPath
        # The heartbeat lives in the host's own state dir; its absence means the host that
        # injected this env is gone.
        if ($null -eq $file) { return 'dead' }
        $defaultInterval = 30000
        if ($null -eq $file.Parsed -or $file.Parsed.version -ne 1) {
            # Corrupt / mid-write snapshot: fall back to mtime instead of declaring the host
            # dead, which would silently disable protection.
            $mtimeAge = $NowMs - $file.MtimeMs
            if ($mtimeAge -le 0 -or $mtimeAge -le ($defaultInterval * 3)) { return 'live' }
            return 'dead'
        }
        $refreshedAt = $file.MtimeMs
        if ($null -ne $file.Parsed.refreshedAt) { try { $refreshedAt = [double]$file.Parsed.refreshedAt } catch { $refreshedAt = $file.MtimeMs } }
        $age = $NowMs - $refreshedAt
        # Clock skew / NTP correction — keep protection on.
        if ($age -le 0) { return 'live' }
        $interval = $defaultInterval
        if ($null -ne $file.Parsed.intervalMs) { try { $interval = [double]$file.Parsed.intervalMs } catch { $interval = $defaultInterval } }
        if ($interval -lt 1000) { $interval = 1000 }
        if ($interval -gt 300000) { $interval = 300000 }
        if ($age -le ($interval * 3)) { return 'live' }
        return 'dead'
    }

    # Per-terminal execution context state. Returns `Liveness` ('live' | 'dead' |
    # 'unknown') plus the parsed context when live.
    #
    # The VS Code Terminal API has no per-command env, so the host writes the dynamic
    # toolCallId into a per-terminal state file before every command
    # (terminal-state-writer.ts). Without reading it, `CODEBUDDY_TOOL_CALL_ID` is empty
    # in a reusable terminal and the bulk threshold guard below skipped silently — a
    # single-file `Remove-Item` deleted without confirmation even at threshold 1.
    #
    # Validation mirrors node-safe-delete-shim.cjs / safe-delete-common.sh: the state
    # file must stay inside the state root (no symlink/`..` escape), be version 1,
    # active and unexpired.
    function Get-SafeDeleteTerminalState {
        param([double]$NowMs)
        $stateDir = $env:CODEBUDDY_SAFE_DELETE_STATE_DIR
        $terminalKey = $env:CODEBUDDY_SAFE_DELETE_TERMINAL_KEY
        if (-not $stateDir -or -not $terminalKey) { return [pscustomobject]@{ Liveness = 'unknown'; Context = $null } }
        try {
            $sep = [System.IO.Path]::DirectorySeparatorChar
            $root = [System.IO.Path]::GetFullPath($stateDir).TrimEnd($sep, [System.IO.Path]::AltDirectorySeparatorChar)
            $stateFile = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $terminalKey + '.json'))
            if (-not $stateFile.StartsWith($root + $sep, [System.StringComparison]::OrdinalIgnoreCase)) {
                return [pscustomobject]@{ Liveness = 'unknown'; Context = $null }
            }
            $file = Get-SafeDeleteJsonState $stateFile
            if ($null -eq $file) { return [pscustomobject]@{ Liveness = 'dead'; Context = $null } }
            $ctx = $file.Parsed
            if ($null -eq $ctx -or $ctx.version -ne 1 -or $ctx.active -ne $true) {
                return [pscustomobject]@{ Liveness = 'dead'; Context = $null }
            }
            $expiresAt = 0
            if ($null -ne $ctx.expiresAt) { $expiresAt = [double]$ctx.expiresAt }
            if ($NowMs -gt $expiresAt) { return [pscustomobject]@{ Liveness = 'dead'; Context = $null } }
            return [pscustomobject]@{ Liveness = 'live'; Context = $ctx }
        } catch { return [pscustomobject]@{ Liveness = 'unknown'; Context = $null } }
    }

    # True while this session's safe-delete env is still owned by a live tool call.
    #
    # The terminal env is inherited by every child of an Agent terminal, including the
    # long-lived daemons build tools fork themselves. Those daemons outlive the tool call
    # — and CodeBuddy itself — and get reused by other IDEs, so once the owning context is
    # gone every deletion must fall through to the native cmdlet: no trash, no bulk guard,
    # no blocking. Both gates are 'unknown -> treat as live', so a host that injects
    # neither keeps the pre-fix behaviour.
    function Test-SafeDeleteContextLive {
        $nowMs = Get-SafeDeleteEpochMs
        if ((Get-SafeDeleteHostLiveness $nowMs) -eq 'dead') { return $false }
        if ((Get-SafeDeleteTerminalState $nowMs).Liveness -eq 'dead') { return $false }
        return $true
    }

    # Resolve the bulk guard identity for the current command. Identity is scoped to the
    # guard invocation only (see Invoke-SafeDeleteBulkGuard) and never left in the session
    # env.
    function Resolve-SafeDeleteTerminalIdentity {
        if ($env:CODEBUDDY_TOOL_CALL_ID) {
            return [pscustomobject]@{ ToolCallId = [string]$env:CODEBUDDY_TOOL_CALL_ID; ConversationRequestId = [string]$env:CODEBUDDY_CONVERSATION_REQUEST_ID }
        }
        $state = Get-SafeDeleteTerminalState (Get-SafeDeleteEpochMs)
        if ($state.Liveness -ne 'live' -or $null -eq $state.Context -or -not $state.Context.toolCallId) { return $null }
        return [pscustomobject]@{ ToolCallId = [string]$state.Context.toolCallId; ConversationRequestId = [string]$state.Context.conversationRequestId }
    }

    # Plain text of the output captured from the bulk guard process.
    #
    # `& node ... 2>&1` turns the child's stderr into *ErrorRecord* objects, and rendering
    # those with `Out-String` produces PowerShell's full native-command error report:
    # `node.exe : <marker>` followed by `At line:N char:M`, a squiggle, `CategoryInfo` and
    # `FullyQualifiedErrorId` - a wall of shim internals printed for every blocked
    # deletion, with the marker's JSON payload hard-wrapped at the console width
    # (issue #88164). Each record's own payload is the raw stderr line, so reading it keeps
    # the guard's single marker line intact.
    function Get-SafeDeleteGuardOutputText {
        param([object]$Output)
        $lines = New-Object System.Collections.Generic.List[string]
        foreach ($item in @($Output)) {
            if ($null -eq $item) { continue }
            $text = if ($item -is [System.Management.Automation.ErrorRecord]) {
                if ($item.TargetObject -is [string]) { [string]$item.TargetObject } else { [string]$item.Exception.Message }
            } else { [string]$item }
            foreach ($line in ($text -split '\r?\n')) { if ($line.Trim()) { $lines.Add($line.TrimEnd()) } }
        }
        return ($lines.ToArray() -join ([string][char]10))
    }

    # Human readable counterpart of a bulk guard marker (issue #88164).
    #
    # ASCII only on purpose, same reason as Get-SafeDeleteFailClosedText. The count and
    # threshold are read from the marker payload when present; a malformed payload only
    # costs the numbers, never the sentence.
    function Get-SafeDeleteBulkGuardText {
        param([AllowEmptyString()] [string]$Marker)
        $count = 0; $threshold = 0
        try {
            $jsonStart = $Marker.IndexOf('{'); $jsonEnd = $Marker.LastIndexOf('}')
            if ($jsonStart -ge 0 -and $jsonEnd -gt $jsonStart) {
                $payload = $Marker.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | Microsoft.PowerShell.Utility\ConvertFrom-Json
                if ($null -ne $payload.count) { $count = [int]$payload.count }
                if ($null -ne $payload.threshold) { $threshold = [int]$payload.threshold }
            }
        } catch { }
        $scale = if ($count -gt 0 -and $threshold -gt 0) { ' (' + $count + ' item(s), threshold ' + $threshold + ')' } else { '' }
        if ($Marker -match 'SAFE_DELETE_BULK_CONFIRM_REQUIRED') { return 'Safe delete needs confirmation for this bulk deletion' + $scale + '. Nothing was deleted.' }
        if ($Marker -match 'SAFE_DELETE_BULK_REJECTED') { return 'Safe delete rejected this bulk deletion' + $scale + '. Nothing was deleted.' }
        return 'Safe delete could not verify this bulk deletion. Nothing was deleted.'
    }

    # Bulk guard batching (issue #95509 follow-up).
    #
    # Every `Remove-Item` used to spawn one node.exe to run the guard. A script that
    # removes a tree file by file — `lct-ai-update-kit` deletes ~1000 files with one
    # `Remove-Item` each — therefore paid a full Node startup per deletion: ~450 ms per
    # file, minutes per run, even after the recycle-bin call itself went native.
    #
    # Deletions whose item count can be counted here are counted in this session and
    # submitted to the guard together. The guard still decides, because the batch is
    # flushed (and the deletion blocked by its verdict) whenever
    #   - a target is a real directory: only the guard can count its contents,
    #   - the accumulated count can reach the threshold,
    #   - this request was already rejected,
    #   - the count cannot be established locally, or
    #   - the batch reaches the limit below.
    # The threshold test adds the deferred count to the guard's own total, so a run can
    # never cross the threshold without the guard seeing it. The only thing lost is at
    # most (limit - 1) deletions that never got submitted, and only when the session ends
    # in the middle of a batch.
    $Global:CODEBUDDY_SAFE_DELETE_BULK_DEFER_LIMIT = 32
    $Global:CODEBUDDY_SAFE_DELETE_BULK_PENDING = $null

    # Items the guard counts for this path: 0 when it does not exist, 1 for a file or a
    # link, -1 for a real directory (only the guard can count its contents).
    function Get-SafeDeleteBulkTargetCount {
        param([string]$Target)
        try {
            if (-not [System.IO.File]::Exists($Target) -and -not [System.IO.Directory]::Exists($Target)) { return 0 }
            $attributes = [System.IO.File]::GetAttributes($Target)
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return 1 }
            if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { return -1 }
            return 1
        } catch { return -1 }
    }

    # <state root>/<sha256(sessionId)>/state.json: where safe-delete-bulk-guard.cjs keeps
    # the per-request delete counter and the approval / rejection verdicts.
    function Get-SafeDeleteBulkStatePath {
        $stateRoot = $env:CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR
        $sessionId = $env:CODEBUDDY_SESSION_ID
        if (-not $stateRoot -or -not $sessionId) { return $null }
        try {
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$sessionId)) }
            finally { $sha.Dispose() }
            $hex = New-Object System.Text.StringBuilder
            foreach ($byte in $bytes) { [void]$hex.Append($byte.ToString('x2')) }
            return [System.IO.Path]::Combine([string]$stateRoot, $hex.ToString(), 'state.json')
        } catch { return $null }
    }

    function Get-SafeDeleteBulkStateEntry {
        param([object]$Container, [string]$Key)
        if ($null -eq $Container) { return $null }
        $property = $Container.PSObject.Properties[$Key]
        if ($null -eq $property) { return $null }
        return $property.Value
    }

    # The guard's counters, read in-process. `Known` is $false when the state file or the
    # env needed to address it is unavailable: an unknown count has to go to the guard.
    function Get-SafeDeleteBulkStateSummary {
        param([string]$RequestId, [string]$ToolCallId)
        $unknown = [pscustomobject]@{ Known = $false; Count = 0; Approved = $false; Rejected = $false; Threshold = 0 }
        $statePath = Get-SafeDeleteBulkStatePath
        if (-not $statePath) { return $unknown }
        $rawThreshold = [string]$env:CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD
        if (-not $rawThreshold) { $rawThreshold = '500' }
        $threshold = 0
        if (-not [int]::TryParse($rawThreshold, [ref]$threshold) -or $threshold -le 0) { return $unknown }
        $known = [pscustomobject]@{ Known = $true; Count = 0; Approved = $false; Rejected = $false; Threshold = $threshold }
        $file = Get-SafeDeleteJsonState $statePath
        if ($null -eq $file -or $null -eq $file.Parsed) { return $known }
        $state = $file.Parsed
        $count = 0
        $request = Get-SafeDeleteBulkStateEntry $state.requests $RequestId
        if ($null -ne $request -and $null -ne $request.count) { $count = [int][double]$request.count }
        $approval = Get-SafeDeleteBulkStateEntry $state.toolApprovals $ToolCallId
        $rejection = Get-SafeDeleteBulkStateEntry $state.requestRejections $RequestId
        return [pscustomobject]@{
            Known = $true
            Count = $count
            Approved = ($null -ne $approval -and $approval.approved -eq $true)
            Rejected = ($null -ne $rejection -and $rejection.rejected -eq $true)
            Threshold = $threshold
        }
    }

    # Submit every deferred target to the guard in one process and reset the batch.
    function Invoke-SafeDeleteBulkGuardBatch {
        param([object]$Pending)
        $Global:CODEBUDDY_SAFE_DELETE_BULK_PENDING = $null
        if ($null -eq $Pending -or $null -eq $Pending.Targets -or $Pending.Targets.Count -eq 0) { return $null }
        return Invoke-SafeDeleteBulkGuardProcess -Targets $Pending.Targets.ToArray() -Identity $Pending.Identity
    }

    # Runs the guard once for a whole batch. The identity is injected for the duration of
    # the call only: leaving it in the session env would make the *next* command check
    # against the previous toolCallId, which no longer matches the key the host approves
    # under — the "approval had no effect" failure of issue #86273.
    function Invoke-SafeDeleteBulkGuardProcess {
        param([string[]]$Targets, [object]$identity)
        # --deleted: the targets of a deferred batch were already recycled, so the guard
        # has to count them even though they no longer exist — otherwise the batch would
        # add 1 (the still existing target of the current call) instead of one per file.
        $guardArgs = @('check', '--deleted'); foreach ($t in $Targets) { $guardArgs += @('--target', $t) }
        $prev = $env:NODE_OPTIONS; $prevToolCallId = $env:CODEBUDDY_TOOL_CALL_ID; $prevRequestId = $env:CODEBUDDY_CONVERSATION_REQUEST_ID
        try {
            $env:NODE_OPTIONS = ''
            $env:CODEBUDDY_TOOL_CALL_ID = $identity.ToolCallId
            if ($identity.ConversationRequestId) { $env:CODEBUDDY_CONVERSATION_REQUEST_ID = $identity.ConversationRequestId }
            $output = & $env:CODEBUDDY_NODE_BIN $env:CODEBUDDY_SAFE_DELETE_BULK_GUARD $guardArgs 2>&1; $rc = $LASTEXITCODE
        }
        finally { $env:NODE_OPTIONS = $prev; $env:CODEBUDDY_TOOL_CALL_ID = $prevToolCallId; $env:CODEBUDDY_CONVERSATION_REQUEST_ID = $prevRequestId }
        if ($rc -eq 0) { return $null }
        $marker = Get-SafeDeleteGuardOutputText $output
        if (-not $marker) { $marker = '[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR] guard exited with ' + $rc }
        # Concealed (SGR 8) on stderr, like the fail-closed and readiness markers: it stays
        # in the terminal buffer for hosts that can only scrape the visible screen, is not
        # readable as text, and the host strips it before the output reaches the model.
        $sdEsc = [char]27
        [Console]::Error.WriteLine($sdEsc + '[8m' + $marker + $sdEsc + '[0m')
        return [pscustomobject]@{ Marker = $marker; Message = (Get-SafeDeleteBulkGuardText $marker) }
    }

    # Returns $null when the deletion may proceed, or the guard's verdict when it must be
    # blocked. Returning instead of throwing lets `Remove-Item` raise the verdict as a
    # proper terminating error attributed to itself (issue #87864). The verdict carries
    # `Marker` (machine payload, already published) and `Message` (human sentence).
    function Invoke-SafeDeleteBulkGuard {
        param([string[]]$Targets)
        if (-not $env:CODEBUDDY_SAFE_DELETE_BULK_GUARD -or -not $env:CODEBUDDY_NODE_BIN -or -not $env:CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR -or -not $Targets -or $Targets.Count -eq 0) { return $null }
        # Defense in depth: Remove-Item already delegates to the native cmdlet when the
        # context is dead, but a dead context must never accumulate bulk counts.
        if (-not (Test-SafeDeleteContextLive)) { return $null }
        $identity = Resolve-SafeDeleteTerminalIdentity
        if ($null -eq $identity -or -not $identity.ToolCallId) {
            # Infrastructure env is complete but no execution context is active: skip, as
            # the POSIX shim does. A user typing a delete command directly into the Agent
            # terminal legitimately has no active context, and failing closed there would
            # break their command. The diagnostic keeps the downgrade visible, so a host
            # regression (state file no longer written) cannot silently disable the guard.
            [Console]::Error.WriteLine('[safe-delete][diag] bulk guard skipped: tool-call-id-unresolved')
            return $null
        }
        $toolCallId = [string]$identity.ToolCallId
        # The key the guard counts under: the request scopes the accumulation, the tool
        # call the approval.
        $requestId = if ($identity.ConversationRequestId) { [string]$identity.ConversationRequestId } else { $toolCallId }
        $pending = $Global:CODEBUDDY_SAFE_DELETE_BULK_PENDING
        if ($null -ne $pending -and ($pending.RequestId -ne $requestId -or $pending.ToolCallId -ne $toolCallId)) {
            # Another tool call owns the session now: the deferred targets belong to the
            # previous one and have to be counted under that identity.
            $previousVerdict = Invoke-SafeDeleteBulkGuardBatch $pending
            if ($null -ne $previousVerdict) { return $previousVerdict }
            $pending = $null
        }
        if ($null -eq $pending) {
            $pending = [pscustomobject]@{
                RequestId = $requestId
                ToolCallId = $toolCallId
                Identity = $identity
                Targets = (New-Object System.Collections.Generic.List[string])
                Count = 0
            }
            $Global:CODEBUDDY_SAFE_DELETE_BULK_PENDING = $pending
        }
        $countable = $true
        foreach ($target in $Targets) {
            $count = Get-SafeDeleteBulkTargetCount ([string]$target)
            if ($count -lt 0) { $countable = $false } else { $pending.Count += $count }
            $pending.Targets.Add([string]$target)
        }
        if ($countable) {
            $summary = Get-SafeDeleteBulkStateSummary -RequestId $requestId -ToolCallId $toolCallId
            $underThreshold = $summary.Approved -or ($summary.Count + $pending.Count) -lt $summary.Threshold
            if ($summary.Known -and -not $summary.Rejected -and $underThreshold -and $pending.Count -lt $Global:CODEBUDDY_SAFE_DELETE_BULK_DEFER_LIMIT) {
                return $null
            }
        }
        return Invoke-SafeDeleteBulkGuardBatch $pending
    }

    # Flatten one bound argument into its individual string tokens.
    #
    # PowerShell binds a comma separated value list to a `ValueFromRemainingArguments`
    # parameter as a *nested array element* rather than as separate tokens: `Remove-Item
    # a, b` arrives as one `Object[]` on Windows PowerShell 5.1, and `Remove-Item a,b` /
    # `-Path a,b` do so on 5.1 and 7 alike. `[string]$raw` then joins the elements with
    # $OFS, producing the single bogus path "a b", which resolves to nothing — the
    # `path-not-found` fail-closed of issue #87864 that also let each retried single-file
    # delete slip under the bulk threshold. Recursive so `a,(b,c)` cannot smuggle a target
    # past the guard either.
    #
    # `-is [string]` is tested first because a string is itself an IEnumerable of chars.
    function Expand-SafeDeleteArgumentList {
        param([object]$Value)
        if ($null -eq $Value) { return @() }
        if ($Value -is [string]) { return @([string]$Value) }
        if ($Value -is [System.Collections.IEnumerable]) {
            $acc = New-Object System.Collections.Generic.List[string]
            foreach ($item in $Value) { foreach ($token in @(Expand-SafeDeleteArgumentList $item)) { $acc.Add($token) } }
            return $acc.ToArray()
        }
        return @([string]$Value)
    }

    # True when the bound argument is a value list rather than a single token. Such a list
    # only ever holds path operands, never switches, so it is never parsed for flags.
    function Test-SafeDeleteArgumentList {
        param([object]$Value)
        return ($null -ne $Value) -and ($Value -isnot [string]) -and ($Value -is [System.Collections.IEnumerable])
    }

    function global:Remove-Item {
        [CmdletBinding()] param([Parameter(ValueFromRemainingArguments = $true)] [object[]]$RawArgs)
        # Dead execution context → full native passthrough, before any argument parsing, so
        # even the forms this wrapper refuses to emulate (-Confirm, -Interactive, provider
        # specific switches) behave exactly like an unhooked session.
        if (-not (Test-SafeDeleteContextLive)) {
            $sdPassthroughArgs = @()
            if ($null -ne $RawArgs) { $sdPassthroughArgs = $RawArgs }
            if ($MyInvocation.ExpectingInput) { $input | Microsoft.PowerShell.Management\Remove-Item @sdPassthroughArgs }
            else { Microsoft.PowerShell.Management\Remove-Item @sdPassthroughArgs }
            return
        }
        $force = $false; $recursive = $false; $allowDir = $false; $interactive = $false; $whatIf = $false; $confirm = $false; $afterDD = $false; $ppm = $null; $psm = $null
        $specs = New-Object System.Collections.Generic.List[object]
        foreach ($raw in $RawArgs) {
            if (Test-SafeDeleteArgumentList $raw) {
                # A value list closes any pending -Path/-LiteralPath and inherits its mode
                # for *every* element: `-LiteralPath a,b` has to treat b as literal too.
                if ($null -ne $psm) { throw 'invalid bool for -' + $psm }
                $listLiteral = ($ppm -eq 'literal'); $ppm = $null
                foreach ($token in @(Expand-SafeDeleteArgumentList $raw)) { $specs.Add([pscustomobject]@{ Value = $token; IsLiteral = $listLiteral }) }
                continue
            }
            $arg = [string]$raw
            if ($null -ne $psm) { $val = $arg -match '^(?i)(\$?true|1)$'; $nval = $arg -match '^(?i)(\$?false|0)$'; if ($val) { if ($psm -eq 'force') { $force = $true } elseif ($psm -eq 'recurse') { $recursive = $true } }; if ($val -or $nval) { $psm = $null; continue } throw 'invalid bool for -' + $psm }
            if ($null -ne $ppm) { $specs.Add([pscustomobject]@{ Value = $arg; IsLiteral = ($ppm -eq 'literal') }); $ppm = $null; continue }
            if (-not $afterDD) {
                if ($arg -eq '--') { $afterDD = $true; continue }
                if ($arg -match '^(?i)-Path:(.+)$') { $specs.Add([pscustomobject]@{ Value = $Matches[1]; IsLiteral = $false }); continue }
                if ($arg -match '^(?i)-LiteralPath:(.+)$') { $specs.Add([pscustomobject]@{ Value = $Matches[1]; IsLiteral = $true }); continue }
                # `-Path:a,b` binds as the bare token `-Path:` plus the value list, so the
                # colon form must be able to await its value the way `-Path` does.
                if ($arg -match '^(?i)-Path:?$') { $ppm = 'path'; continue }
                if ($arg -match '^(?i)-LiteralPath:?$') { $ppm = 'literal'; continue }
                if ($arg -match '^(?i)-f$|^(?i)-Force$') { $force = $true; continue }
                if ($arg -match '^(?i)-r$|^(?i)-R$|^(?i)-Recurse$') { $recursive = $true; continue }
                if ($arg -match '^(?i)-d$') { $allowDir = $true; continue }
                if ($arg -match '^(?i)-i$|^(?i)-I$') { $interactive = $true; continue }
                if ($arg -match '^(?i)-WhatIf$') { $whatIf = $true; continue }
                if ($arg -match '^(?i)-Confirm$') { $confirm = $true; continue }
                if ($arg -match '^-[fFrRdDiI]{2,}$') { if ($arg -match '[fF]') { $force = $true }; if ($arg -match '[rR]') { $recursive = $true }; if ($arg -match '[dD]') { $allowDir = $true }; if ($arg -match '[iI]') { $interactive = $true }; continue }
                if ($arg.StartsWith('-')) { throw 'unsupported option: ' + $arg }
            }
            $specs.Add([pscustomobject]@{ Value = $arg; IsLiteral = $false })
        }
        if ($null -ne $ppm) { throw 'missing value for -Path/-LiteralPath' }
        if ($null -ne $psm) { throw 'missing bool for -' + $psm }
        if ($interactive) { $PSCmdlet.ThrowTerminatingError((New-SafeDeleteFailClosedError '' 'interactive-not-supported')) }
        if ($specs.Count -eq 0) { throw 'Remove-Item: missing path operand' }

        $sdTargets = New-Object System.Collections.Generic.List[string]
        $sdItems = New-Object System.Collections.Generic.List[object]
        foreach ($spec in $specs) {
            $resolved = if ($spec.IsLiteral) { @(Microsoft.PowerShell.Management\Resolve-Path -LiteralPath $spec.Value -ErrorAction SilentlyContinue) } else { @(Microsoft.PowerShell.Management\Resolve-Path -Path $spec.Value -ErrorAction SilentlyContinue) }
            if ($resolved.Count -eq 0) { if ($force) { continue }; $PSCmdlet.ThrowTerminatingError((New-SafeDeleteFailClosedError $spec.Value 'path-not-found')) }
            foreach ($r in $resolved) {
                $rp = [string]$r.Path; $pn = [string]$r.Provider.Name
                if ($pn -ne 'FileSystem' -or $whatIf) { $da = @{ LiteralPath = $rp; ErrorAction = 'Stop' }; if ($force) { $da['Force'] = $true }; if ($recursive) { $da['Recurse'] = $true }; if ($whatIf) { $da['WhatIf'] = $true }; if ($confirm) { $da['Confirm'] = $true }; Microsoft.PowerShell.Management\Remove-Item @da; continue }
                $isDir = Microsoft.PowerShell.Management\Test-Path -LiteralPath $rp -PathType Container
                $sdTargets.Add($rp); $sdItems.Add([pscustomobject]@{ TargetSpec = $spec.Value; ResolvedPath = $rp; IsDir = $isDir })
            }
        }

        $gTargets = New-Object System.Collections.Generic.List[string]
        $gItems = New-Object System.Collections.Generic.List[object]
        foreach ($item in $sdItems) {
            $rp = [string]$item.ResolvedPath
            if (Test-SafeDeleteUnderOsTemp $rp) { $ta = @{ LiteralPath = $rp; ErrorAction = 'Stop' }; if ($force) { $ta['Force'] = $true }; if ($recursive) { $ta['Recurse'] = $true }; Microsoft.PowerShell.Management\Remove-Item @ta; continue }
            $gTargets.Add($rp); $gItems.Add($item)
        }

        $sdBulkVerdict = Invoke-SafeDeleteBulkGuard -Targets $gTargets.ToArray()
        if ($null -ne $sdBulkVerdict) { $PSCmdlet.ThrowTerminatingError((New-SafeDeleteBulkGuardError $sdBulkVerdict.Message)) }

        foreach ($item in $gItems) {
            $tv = [string]$item.TargetSpec; $rp = [string]$item.ResolvedPath; $isDir = [bool]$item.IsDir
            # The pre-checks sit outside the try on purpose: a `throw` inside it was caught
            # by the trash-failed handler below, which relabelled `confirm-not-supported`
            # and `non-empty-directory` as `trash-failed` and made the host offer a
            # permanent delete for a directory that merely needed -Recurse.
            if ($confirm) { $PSCmdlet.ThrowTerminatingError((New-SafeDeleteFailClosedError $tv 'confirm-not-supported')) }
            if ($isDir -and -not $recursive -and -not $allowDir) {
                $children = $null
                try { $children = @(Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $rp -Force -ErrorAction Stop) }
                catch { $PSCmdlet.ThrowTerminatingError((New-SafeDeleteFailClosedError $tv 'trash-failed' $_.Exception.Message)) }
                if ($children.Count -gt 0) { $PSCmdlet.ThrowTerminatingError((New-SafeDeleteFailClosedError $tv 'non-empty-directory')) }
            }
            try {
                $nativeTrashed = $false
                if ($isDir) { $nativeTrashed = Invoke-SafeDeleteNativeTrash $rp }
                if (-not $nativeTrashed) {
                    if ($isDir) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($rp, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) }
                    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($rp, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin) }
                }
                if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $rp) { throw 'target still exists: ' + $rp }
                Write-SafeDeleteReport $rp
            } catch { $PSCmdlet.ThrowTerminatingError((New-SafeDeleteFailClosedError $tv 'trash-failed' $_.Exception.Message)) }
        }
    }

    foreach ($aliasName in @('ri', 'rm', 'del', 'erase', 'rmdir', 'unlink')) {
        try { Set-Alias -Name $aliasName -Value Remove-Item -Scope Global -Force -ErrorAction Stop } catch { }
    }

    $Global:CODEBUDDY_SAFE_DELETE_PS_READY = $true
}

# Per-command readiness assertion for the VS Code Terminal path.
#
# The host must prove, inside the *same* command line and *before* the deletion runs,
# that Remove-Item is still our recycle-bin wrapper (issue #81619). Keeping that
# assertion in a session-scoped function shrinks the injected prefix to
# `& { __cbsd; <user command> }`, so the terminal panel no longer shows hundreds of
# bytes of bootstrap code in front of every delete command.
#
# The readiness marker must stay in the shell-integration output stream (the host
# fails closed without it) but must not be readable as normal text on screen, so it
# is written with the "conceal" attribute (SGR 8).
#
# It must NOT be followed by a line erase: when shell integration is unavailable the
# host can only scrape the *visible terminal buffer*, and erasing the line removes the
# marker from that buffer too. The delete then ran under a proven wrapper but was
# reported as "readiness marker missing (no shell integration)" — a correct deletion
# surfaced as a failure. Concealing keeps the marker in the buffer while hiding it.
#
# Defined outside the readiness guard on purpose: a session that already loaded an
# older module keeps its (working) wrapper and READY flag, so the guarded block above
# is skipped. Re-importing must still be able to add the helper, otherwise the host
# would stay on the noisy per-command bootstrap forever.
function global:Assert-CodeBuddySafeDelete {
    $sdCmd = Get-Command Remove-Item -ErrorAction SilentlyContinue
    if ($null -eq $sdCmd -or $sdCmd.CommandType -ne 'Function' -or
        -not (Get-Variable -Name CODEBUDDY_SAFE_DELETE_PS_READY -Scope Global -ErrorAction SilentlyContinue)) {
        throw '[safe-delete][INIT_ERROR] safe-delete wrapper is not active'
    }
    $sdEsc = [char]27
    [Console]::Out.WriteLine($sdEsc + '[8m' + '[safe-delete][READY]' + $sdEsc + '[0m')
}
try { Set-Alias -Name __cbsd -Value Assert-CodeBuddySafeDelete -Scope Global -Force -ErrorAction Stop } catch { }

# Self-healing prompt hook — the PowerShell counterpart of the POSIX precmd hook.
#
# Once the host has verified this session it stops injecting anything in front of a
# delete command, so the terminal panel shows only what the user asked for. Nothing
# would then restore interception if a later command dropped our wrapper (an explicit
# `Remove-Item Function:\Remove-Item`, `Remove-Module CodeBuddy.SafeDelete`, or a
# re-sourced profile that redefines it). This hook re-installs it before the next
# prompt is drawn, without touching the command line.
#
# Defined outside the readiness guard so re-importing an already initialized session
# can still add it.
if (-not (Get-Variable -Name CODEBUDDY_SAFE_DELETE_PROMPT_HOOK -Scope Global -ErrorAction SilentlyContinue)) {
    # Captured before we override it: VS Code's shell integration installs its own
    # prompt (emitting the OSC 633 sequences the host relies on), so it has to keep
    # running. `$function:prompt` is $null when no prompt is defined at all.
    $Global:CODEBUDDY_SAFE_DELETE_ORIGINAL_PROMPT = $function:prompt

    function global:prompt {
        # A broken prompt is far worse than a missing wrapper, and the host still
        # fails closed through its own per-command assertion, so healing never throws.
        try {
            $sdCmd = Get-Command Remove-Item -ErrorAction SilentlyContinue
            if ($null -eq $sdCmd -or $sdCmd.CommandType -ne 'Function') {
                if ($env:CODEBUDDY_SAFE_DELETE_SHIM_DIR) {
                    $sdB = Join-Path $env:CODEBUDDY_SAFE_DELETE_SHIM_DIR 'powershell\Initialize-CodeBuddySafeDelete.ps1'
                    if (Test-Path -LiteralPath $sdB) {
                        # Re-entry is not possible: this block only runs while the
                        # hook variable is unset, and re-importing leaves it set.
                        #
                        # -Encoding UTF8 is required: the shim source is UTF-8 and PS 5.1
                        # would otherwise decode it with the ANSI code page (issue #88107).
                        $CODEBUDDY_SAFE_DELETE_BOOTSTRAP_ROOT = Split-Path -Parent $sdB
                        Invoke-Expression (Get-Content -Raw -Encoding UTF8 -LiteralPath $sdB)
                    }
                }
            }
        } catch { }

        if ($Global:CODEBUDDY_SAFE_DELETE_ORIGINAL_PROMPT) {
            & $Global:CODEBUDDY_SAFE_DELETE_ORIGINAL_PROMPT
        } else {
            "PS $($ExecutionContext.SessionState.Path.CurrentLocation)$('>' * ($NestedPromptLevel + 1)) "
        }
    }

    $Global:CODEBUDDY_SAFE_DELETE_PROMPT_HOOK = $true
}
