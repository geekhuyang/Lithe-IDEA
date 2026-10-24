//! Bounded external-process execution for bundled official extensions.
//!
//! Official bundled extensions (for example the CodeBuddy plugin) drive a
//! user-installed CLI the same way the language-server catalog does: the
//! executable is discovered on `PATH` or supplied explicitly, then run without
//! a shell with captured output, a hard deadline and byte caps. Only Lithe's
//! own frontend can reach these commands; the webview never loads remote
//! content, so this surface does not widen the application's trust boundary.

use serde::Deserialize;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 16 * 1024;
const MAX_STDIN_BYTES: usize = 1024 * 1024;
const MAX_CANDIDATES: usize = 16;
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedProcessRequest {
    /// Absolute executable path or a bare name resolved on `PATH`.
    pub executable: String,
    pub arguments: Vec<String>,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedProcessResult {
    pub stdout: String,
    pub stderr: String,
    /// `None` when the process was killed at the deadline.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Set when either stream hit the byte cap before the process finished.
    pub truncated: bool,
}

/// Rejects a request before any process work starts. Kept pure so the boundary
/// rules are unit-testable without spawning anything.
fn validate_request(request: &BoundedProcessRequest) -> Result<(), &'static str> {
    if request.executable.trim().is_empty() || request.executable.contains('\0') {
        return Err("PROCESS_INVALID_EXECUTABLE");
    }
    if request.arguments.len() > MAX_ARGUMENTS {
        return Err("PROCESS_TOO_MANY_ARGUMENTS");
    }
    if request
        .arguments
        .iter()
        .any(|argument| argument.contains('\0') || argument.len() > MAX_ARGUMENT_BYTES)
    {
        return Err("PROCESS_INVALID_ARGUMENT");
    }
    if request
        .stdin
        .as_deref()
        .is_some_and(|text| text.len() > MAX_STDIN_BYTES)
    {
        return Err("PROCESS_STDIN_TOO_LARGE");
    }
    if let Some(timeout) = request.timeout_ms {
        if timeout == 0 || timeout > MAX_TIMEOUT_MS {
            return Err("PROCESS_INVALID_TIMEOUT");
        }
    }
    Ok(())
}

fn executable_candidates_in(directory: &Path, name: &str) -> Vec<PathBuf> {
    [
        format!("{name}.exe"),
        format!("{name}.cmd"),
        format!("{name}.bat"),
        name.to_string(),
    ]
    .into_iter()
    .map(|file_name| directory.join(file_name))
    .collect()
}

fn first_existing(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

fn find_system_tool(path_env: Option<&std::ffi::OsStr>, name: &str) -> Option<PathBuf> {
    let path_env = path_env?;
    for directory in std::env::split_paths(path_env) {
        if let Some(tool) = first_existing(executable_candidates_in(&directory, name)) {
            return Some(tool);
        }
    }
    None
}

/// Resolves a bare name on `PATH`, or accepts an explicit path that exists.
fn resolve_executable_path(executable: &str) -> Result<PathBuf, &'static str> {
    let candidate = Path::new(executable);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        if candidate.is_file() {
            return Ok(candidate.to_path_buf());
        }
        return Err("PROCESS_EXECUTABLE_NOT_FOUND");
    }
    find_system_tool(std::env::var_os("PATH").as_deref(), executable)
        .ok_or("PROCESS_EXECUTABLE_NOT_FOUND")
}

/// Returns the first candidate that resolves, for availability probes.
#[tauri::command]
pub fn resolve_executable(candidates: Vec<String>) -> Option<String> {
    if candidates.len() > MAX_CANDIDATES {
        return None;
    }
    let path_env = std::env::var_os("PATH");
    for candidate in candidates {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(found) = resolve_executable_path(trimmed).ok() {
            return Some(found.to_string_lossy().into_owned());
        }
        // A bare name may also exist on PATH when the explicit candidate was a
        // path; keep probing the remaining candidates either way.
        if let Some(found) = find_system_tool(path_env.as_deref(), trimmed) {
            return Some(found.to_string_lossy().into_owned());
        }
    }
    None
}

fn read_capped<R: Read>(reader: &mut R, cap: usize) -> std::io::Result<(String, bool)> {
    let mut limited = reader.take(cap as u64 + 1);
    let mut text = String::new();
    limited.read_to_string(&mut text)?;
    let truncated = text.len() > cap;
    if truncated {
        text.truncate(cap);
    }
    Ok((text, truncated))
}

/// Runs one command with captured output, a hard deadline and byte caps.
#[tauri::command]
pub fn run_bounded_process(request: BoundedProcessRequest) -> Result<BoundedProcessResult, String> {
    validate_request(&request).map_err(str::to_owned)?;
    let executable = resolve_executable_path(request.executable.trim()).map_err(str::to_owned)?;
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(MAX_TIMEOUT_MS));
    let mut command = Command::new(&executable);
    command.args(&request.arguments);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    if let Some(cwd) = request.cwd.as_deref() {
        let directory = Path::new(cwd);
        if !directory.is_dir() {
            return Err("PROCESS_INVALID_WORKING_DIRECTORY".into());
        }
        command.current_dir(directory);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("PROCESS_SPAWN_FAILED: {error}"))?;
    if let Some(stdin) = request.stdin.as_deref() {
        if let Some(mut pipe) = child.stdin.take() {
            // A CLI that exits before reading stdin must not fail the run.
            let _ = pipe.write_all(stdin.as_bytes());
        }
    }
    drop(child.stdin.take());

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(BoundedProcessResult {
                        stdout: String::new(),
                        stderr: String::new(),
                        exit_code: None,
                        timed_out: true,
                        truncated: false,
                    });
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(error) => return Err(format!("PROCESS_WAIT_FAILED: {error}")),
        }
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut truncated = false;
    if let Some(pipe) = child.stdout.as_mut() {
        let (text, hit_cap) = read_capped(pipe, MAX_OUTPUT_BYTES)
            .map_err(|error| format!("PROCESS_OUTPUT_READ_FAILED: {error}"))?;
        stdout = text;
        truncated |= hit_cap;
    }
    if let Some(pipe) = child.stderr.as_mut() {
        let (text, hit_cap) = read_capped(pipe, MAX_OUTPUT_BYTES)
            .map_err(|error| format!("PROCESS_OUTPUT_READ_FAILED: {error}"))?;
        stderr = text;
        truncated |= hit_cap;
    }
    let status = child
        .wait()
        .map_err(|error| format!("PROCESS_WAIT_FAILED: {error}"))?;
    Ok(BoundedProcessResult {
        stdout,
        stderr,
        exit_code: status.code(),
        timed_out: false,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(executable: &str) -> BoundedProcessRequest {
        BoundedProcessRequest {
            executable: executable.to_string(),
            arguments: Vec::new(),
            stdin: None,
            cwd: None,
            timeout_ms: None,
        }
    }

    #[test]
    fn validation_rejects_empty_executables_and_oversized_requests() {
        assert!(validate_request(&request("   ")).is_err());
        assert!(validate_request(&request("codebuddy\0")).is_err());
        let mut many = request("codebuddy");
        many.arguments = vec!["a".to_string(); MAX_ARGUMENTS + 1];
        assert!(validate_request(&many).is_err());
        let mut oversized = request("codebuddy");
        oversized.arguments = vec!["a".repeat(MAX_ARGUMENT_BYTES + 1)];
        assert!(validate_request(&oversized).is_err());
        let mut invalid_timeout = request("codebuddy");
        invalid_timeout.timeout_ms = Some(MAX_TIMEOUT_MS + 1);
        assert!(validate_request(&invalid_timeout).is_err());
        assert!(validate_request(&request("codebuddy")).is_ok());
    }

    #[test]
    fn bare_names_resolve_on_path_and_explicit_paths_must_exist() {
        let directory = temp_dir("process-runner-path");
        std::fs::create_dir_all(directory.join("bin")).expect("bin");
        std::fs::write(directory.join("bin").join("codebuddy.exe"), []).expect("tool");
        let path_env = std::env::join_paths([directory.join("bin")]).expect("join paths");
        let found = find_system_tool(Some(path_env.as_os_str()), "codebuddy");
        assert_eq!(found, Some(directory.join("bin").join("codebuddy.exe")));
        assert!(find_system_tool(Some(path_env.as_os_str()), "missing-tool").is_none());

        let resolved = resolve_executable_path(
            directory
                .join("bin")
                .join("codebuddy.exe")
                .to_string_lossy()
                .as_ref(),
        );
        assert!(resolved.is_ok());
        assert!(resolve_executable_path("definitely-not-a-real-tool-xyz").is_err());
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn resolve_executable_command_returns_the_first_available_candidate() {
        let directory = temp_dir("process-runner-candidates");
        std::fs::create_dir_all(&directory).expect("dir");
        std::fs::write(directory.join("cbc.exe"), []).expect("tool");
        let resolved = resolve_executable(vec![
            "definitely-not-a-real-tool-xyz".to_string(),
            directory.join("cbc.exe").to_string_lossy().into_owned(),
        ]);
        assert_eq!(
            resolved,
            Some(directory.join("cbc.exe").to_string_lossy().into_owned())
        );
        assert_eq!(resolve_executable(Vec::new()), None);
        std::fs::remove_dir_all(directory).ok();
    }

    fn temp_dir(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "lithe-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        directory
    }
}
