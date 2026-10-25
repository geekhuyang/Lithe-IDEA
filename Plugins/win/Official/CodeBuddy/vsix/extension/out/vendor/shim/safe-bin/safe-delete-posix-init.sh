# genie-safe-delete POSIX session initializer.
#
# Sourced ONCE per Agent terminal session (see TerminalManagerImpl's
# ensurePosixSafeDeleteSession) instead of being prepended to every command.
#
# Why a session script instead of a per-command prelude:
#   Issue #77906 was originally fixed by prepending a ~500 byte bootstrap to
#   every command (buildSafeDeletePosixBootstrap). Because VS Code shell
#   integration echoes the whole command line, that prelude was visible in the
#   terminal for every single command, and it also consumed part of the 1024
#   byte Terminal API command budget (microsoft/vscode#246204), silently
#   truncating longer commands. This script keeps the exact same protection
#   semantics but pays the cost once per session, mirroring how PowerShell
#   already loads its bootstrap through shellArgs at terminal startup.
#
# Every step is guarded on CODEBUDDY_SAFE_DELETE_BIN_DIR, so the script changes
# nothing when the safe-delete runtime is not configured. Sourcing it twice is
# harmless (PATH is de-duplicated, function redefinition is idempotent, and the
# prompt hooks are registered at most once).
#
# The script exits non-zero whenever interception cannot be proven active — which
# includes the case where the runtime is not configured at all — so the host never
# mistakes "nothing to do" for "protection verified" and keeps using the
# per-command prelude instead.

# Re-apply the safe-delete interception in the current shell.
#
# Two independent layers are installed so that neither alone is a single point
# of failure:
#   1. PATH prefix  — intercepts `rm` resolved through PATH lookup.
#   2. Shell functions — intercept `rm` even when PATH was reordered, and take
#      precedence over external commands during command resolution.
_codebuddy_safe_delete_apply() {
    [ -n "${CODEBUDDY_SAFE_DELETE_BIN_DIR:-}" ] || return 1

    # Drop any user alias / previously defined function first, otherwise the
    # alias would win over our function during command resolution.
    #
    # Every builtin this script relies on is backslash-escaped, here and below:
    # quoting suppresses alias expansion, so a user alias for `unalias`, `unset`,
    # `export`, `eval`, `alias`, `declare`, `local`, `printf` or `autoload`
    # cannot hijack the setup or the readiness probes.
    \unalias rm unlink rmdir 2>/dev/null || true
    \unset -f rm unlink rmdir 2>/dev/null || true

    # PATH de-duplication: an interactive shell may have already inherited the
    # prefix from the terminal env, and a session may be re-initialized. Without
    # this guard PATH would grow on every re-apply.
    case ":${PATH}:" in
        *":${CODEBUDDY_SAFE_DELETE_BIN_DIR}:"*) ;;
        *) PATH="${CODEBUDDY_SAFE_DELETE_BIN_DIR}:${PATH}"; \export PATH ;;
    esac

    # The wrappers are installed through `eval` on purpose.
    #
    # Both bash and zsh expand aliases while *parsing*, i.e. before any command
    # of the surrounding parse unit runs — and a function body is parsed as a
    # whole when the enclosing function is defined. So with a user
    # `alias rm='rm -i'` (common in hardened container images) a literal
    # `rm() { ...; }` here was read as `rm -i() { ...; }`, which aborted the
    # entire script at source time with
    #   bash: syntax error near unexpected token `('
    #   zsh: defining function based on alias `rm' / parse error near `()'
    # The `\unalias` above cannot prevent that: it only runs after this body was
    # already parsed. `eval` defers parsing to run time, when the alias is gone.
    \eval '
rm() { "${CODEBUDDY_SAFE_DELETE_BIN_DIR}/rm" "$@"; }
unlink() { "${CODEBUDDY_SAFE_DELETE_BIN_DIR}/unlink" "$@"; }
rmdir() { "${CODEBUDDY_SAFE_DELETE_BIN_DIR}/rmdir" "$@"; }
' || return 1

    # bash only: make the wrappers survive non-interactive subshells, which is
    # what the removed per-command prelude used to do via `export -f`.
    if [ -n "${BASH_VERSION:-}" ]; then
        \export -f rm unlink rmdir >/dev/null 2>&1 || true
    fi

    return 0
}

# Whether a shell function with the given name is currently defined.
#
# Implemented with shell builtins only (zsh `functions` associative array,
# bash `declare -F`) because this runs from a prompt hook on every prompt;
# `type -t` / `command -v` inside a command substitution would fork a
# subshell per prompt.
_codebuddy_safe_delete_has_fn() {
    if [ -n "${ZSH_VERSION:-}" ]; then
        [ -n "${functions[$1]-}" ]
        return $?
    fi
    if [ -n "${BASH_VERSION:-}" ]; then
        \declare -F "$1" >/dev/null 2>&1
        return $?
    fi
    # Unknown shell: no cheap builtin probe available, assume still installed
    # rather than re-applying (and paying `unalias`/`unset`) on every prompt.
    return 0
}

# Whether an alias shadows the given name.
#
# An alias must be treated as "interception broken" even though the wrapper
# function is still defined: aliases are expanded while the command line is
# *parsed*, so `alias rm='rm -i'` turns a later `rm -rf dir` into
# `rm -i -rf dir`. The wrapper still routes to safe-bin, but safe-bin rejects
# `-i` (its prompt semantics cannot be honoured, so it fails closed), and the
# user's delete simply errors out. Detecting the alias here lets the prompt hook
# call `_codebuddy_safe_delete_apply`, which unaliases it before the next
# command is parsed.
#
# `alias NAME` is a builtin in both shells, so this costs no fork per prompt. It
# is preferred over bash's `BASH_ALIASES` associative array because that
# requires bash >= 4.0, and over zsh's `$aliases` because plain `alias` also
# reports zsh global aliases (`alias -g`), which expand in any word position.
_codebuddy_safe_delete_has_alias() {
    \alias "$1" >/dev/null 2>&1
}

# True when the interception is fully in place in the current shell.
_codebuddy_safe_delete_installed() {
    [ -n "${CODEBUDDY_SAFE_DELETE_BIN_DIR:-}" ] || return 1
    case ":${PATH}:" in
        *":${CODEBUDDY_SAFE_DELETE_BIN_DIR}:"*) ;;
        *) return 1 ;;
    esac
    _codebuddy_safe_delete_has_fn rm || return 1
    _codebuddy_safe_delete_has_fn unlink || return 1
    _codebuddy_safe_delete_has_fn rmdir || return 1
    # A user alias added *after* initialization (interactively, by a tool, or by
    # re-sourcing an rc file that left PATH untouched) is not covered by the
    # checks above, because both the PATH prefix and the wrapper functions are
    # still in place.
    ! _codebuddy_safe_delete_has_alias rm || return 1
    ! _codebuddy_safe_delete_has_alias unlink || return 1
    ! _codebuddy_safe_delete_has_alias rmdir || return 1
    return 0
}

# Prompt hook: silently restore the interception if a command changed PATH or
# re-sourced the user's rc file (which resets PATH and drops our prefix).
#
# The original per-command prelude covered this by running before every
# command; the hook covers it without touching the command line. It performs
# only builtin string tests in the common case, so the added latency per prompt
# is negligible. `$?` is saved and restored so a user prompt that renders the
# previous exit status is unaffected.
_codebuddy_safe_delete_heal() {
    \local __codebuddy_safe_delete_status=$?
    if ! _codebuddy_safe_delete_installed; then
        _codebuddy_safe_delete_apply >/dev/null 2>&1 || true
    fi
    return $__codebuddy_safe_delete_status
}

_codebuddy_safe_delete_install_hook() {
    if [ -n "${ZSH_VERSION:-}" ]; then
        # add-zsh-hook de-duplicates by function name, so re-sourcing is safe.
        \autoload -Uz add-zsh-hook 2>/dev/null || true
        \add-zsh-hook precmd _codebuddy_safe_delete_heal 2>/dev/null || true
        return 0
    fi
    if [ -n "${BASH_VERSION:-}" ]; then
        \local __codebuddy_prompt_decl
        __codebuddy_prompt_decl="$(\declare -p PROMPT_COMMAND 2>/dev/null || \printf '')"
        case "${__codebuddy_prompt_decl}" in
            *_codebuddy_safe_delete_heal*) return 0 ;;
        esac
        case "${__codebuddy_prompt_decl}" in
            # bash >= 5.1 allows PROMPT_COMMAND to be an array; appending a
            # string to it would clobber the user's existing entries.
            'declare -a'*|'declare -ax'*)
                PROMPT_COMMAND+=('_codebuddy_safe_delete_heal')
                ;;
            *)
                PROMPT_COMMAND="_codebuddy_safe_delete_heal${PROMPT_COMMAND:+;${PROMPT_COMMAND}}"
                ;;
        esac
        return 0
    fi
    return 0
}

# Whether the self-healing prompt hook is actually registered.
#
# `_codebuddy_safe_delete_install_hook` deliberately swallows failures so it can
# never break the user's shell, so its effect must be verified separately: without
# the hook nothing restores the PATH prefix after a later command resets it, yet the
# host would still be told the session is ready. Including this in the final
# assertion makes that case fail closed, so the host keeps using the per-command
# prelude instead. Runs once at init, so the command substitution here is fine.
_codebuddy_safe_delete_hook_installed() {
    if [ -n "${ZSH_VERSION:-}" ]; then
        # `(r)` looks up an array element by value; empty means not registered.
        [ -n "${precmd_functions[(r)_codebuddy_safe_delete_heal]-}" ]
        return $?
    fi
    if [ -n "${BASH_VERSION:-}" ]; then
        # Covers both the string and the bash >= 5.1 array form of PROMPT_COMMAND.
        case "$(\declare -p PROMPT_COMMAND 2>/dev/null)" in
            *_codebuddy_safe_delete_heal*) return 0 ;;
            *) return 1 ;;
        esac
    fi
    return 0
}

_codebuddy_safe_delete_apply >/dev/null 2>&1 || true
_codebuddy_safe_delete_install_hook >/dev/null 2>&1 || true

# Final status doubles as the readiness assertion for the host: a non-zero exit
# means interception could not be proven active end to end (wrappers installed,
# PATH prefixed, trash helper executable AND the self-healing hook registered), and
# the caller must fall back to the per-command prelude rather than assume protection.
_codebuddy_safe_delete_installed \
    && _codebuddy_safe_delete_hook_installed \
    && [ -x "${CODEBUDDY_SAFE_DELETE_BIN_DIR}/rm" ]
