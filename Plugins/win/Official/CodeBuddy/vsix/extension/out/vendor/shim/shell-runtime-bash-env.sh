# CodeBuddy bash runtime environment — sourced via BASH_ENV for bash subprocesses.
# Keep feature-specific bootstrap scripts separate and compose them here.
__codebuddy_shell_runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ ! -f "${__codebuddy_shell_runtime_dir}/safe-bin/safe-delete-bash-env.sh" ] || . "${__codebuddy_shell_runtime_dir}/safe-bin/safe-delete-bash-env.sh"
[ ! -f "${__codebuddy_shell_runtime_dir}/brokered-sandbox-bash-env.sh" ] || . "${__codebuddy_shell_runtime_dir}/brokered-sandbox-bash-env.sh"

unset __codebuddy_shell_runtime_dir
