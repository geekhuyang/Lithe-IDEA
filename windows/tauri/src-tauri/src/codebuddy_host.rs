//! CodeBuddy official plugin host: runs the vendored VS Code extension in a
//! Node sidecar and bridges it to the frontend over newline-delimited JSON on
//! stdio.
//!
//! The vendored extension (`Plugins/win/Official/CodeBuddy/vsix/extension`) is
//! the reference VS Code implementation of CodeBuddy. Lithe does not reimplement
//! its chat or commit logic; it supplies a `vscode` API shim (under the plugin's
//! `host/` directory) and this process/bridge layer. The sidecar owns the
//! extension lifecycle; the frontend owns presentation.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const HOST_EVENT: &str = "codebuddy-host-event";
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStartRequest {
    /// Directory containing the vendored `vsix/extension` package.
    pub extension_root: String,
    /// Directory containing the compiled `host/main.js` bridge entry.
    pub host_root: String,
    /// Explicit Node executable path; when empty the host probes `PATH`.
    #[serde(default)]
    pub node_path: String,
}

struct PendingRequest {
    reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
}

struct HostProcess {
    child: Child,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
}

impl HostProcess {
    fn stop(&mut self) {
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n");
            let _ = stdin.flush();
        }
        let deadline = std::time::Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return;
                }
            }
        }
    }
}

pub struct CodeBuddyHostState {
    process: Mutex<Option<HostProcess>>,
    node_path: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
}

impl Default for CodeBuddyHostState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            node_path: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }
}

fn set_last_error(state: &CodeBuddyHostState, error: Option<String>) {
    if let Ok(mut slot) = state.last_error.lock() {
        *slot = error;
    }
}

fn executable_candidates_in(directory: &std::path::Path, name: &str) -> Vec<std::path::PathBuf> {
    [format!("{name}.exe"), name.to_string()]
        .into_iter()
        .map(|file_name| directory.join(file_name))
        .collect()
}

fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    std::env::split_paths(&path_env).find_map(|directory| {
        executable_candidates_in(&directory, name)
            .into_iter()
            .find(|candidate| candidate.is_file())
    })
}

fn resolve_node(node_path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = node_path.trim();
    if !trimmed.is_empty() {
        let explicit = std::path::Path::new(trimmed);
        if explicit.is_file() {
            return Ok(explicit.to_path_buf());
        }
        return Err("CODEBUDDY_NODE_NOT_FOUND".into());
    }
    find_on_path("node").ok_or_else(|| "CODEBUDDY_NODE_NOT_FOUND".to_string())
}

fn send_line(child: &mut Child, line: &str) -> Result<(), String> {
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "CODEBUDDY_HOST_STDIN_CLOSED".to_string())?;
    stdin
        .write_all(line.as_bytes())
        .map_err(|error| format!("CODEBUDDY_HOST_WRITE_FAILED: {error}"))?;
    stdin
        .write_all(b"\n")
        .map_err(|error| format!("CODEBUDDY_HOST_WRITE_FAILED: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("CODEBUDDY_HOST_WRITE_FAILED: {error}"))?;
    Ok(())
}

/// Starts the CodeBuddy Node sidecar.
///
/// This command waits for the extension host to report readiness, which takes
/// seconds. It is therefore `async`: a synchronous Tauri command runs on the
/// main thread and would freeze the whole application while the sidecar boots.
#[tauri::command]
pub async fn codebuddy_host_start(
    app: AppHandle,
    state: tauri::State<'_, Arc<CodeBuddyHostState>>,
    request: HostStartRequest,
) -> Result<Value, String> {
    let node = resolve_node(&request.node_path)?;
    let extension_entry = std::path::Path::new(&request.extension_root)
        .join("out")
        .join("extension")
        .join("index.js");
    if !extension_entry.is_file() {
        return Err("CODEBUDDY_EXTENSION_MISSING".into());
    }
    let host_entry = std::path::Path::new(&request.host_root).join("main.js");
    if !host_entry.is_file() {
        return Err("CODEBUDDY_HOST_ENTRY_MISSING".into());
    }

    {
        let mut slot = state
            .process
            .lock()
            .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?;
        if let Some(mut existing) = slot.take() {
            existing.stop();
        }
    }
    set_last_error(&state, None);

    let mut command = Command::new(&node);
    command
        .arg(&host_entry)
        .arg("--extension-root")
        .arg(&request.extension_root)
        .arg("--extension-entry")
        .arg(&extension_entry)
        .env("CODEBUDDY_EXTENSION_ROOT", &request.extension_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("CODEBUDDY_HOST_SPAWN_FAILED: {error}"))?;

    let pending: Arc<Mutex<HashMap<u64, PendingRequest>>> = Arc::new(Mutex::new(HashMap::new()));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    // Reader: correlates replies and forwards extension events to the frontend.
    {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "CODEBUDDY_HOST_STDOUT_CLOSED".to_string())?;
        let pending = Arc::clone(&pending);
        let app_handle = app.clone();
        // The oneshot sender is consumed by `send`, so it is held in an `Option`
        // and taken on the first readiness signal.
        let mut ready_tx = Some(ready_tx);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(_) => break,
                };
                if line.trim().is_empty() {
                    continue;
                }
                let message: Value = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(_) => continue,
                };
                match message.get("type").and_then(Value::as_str) {
                    Some("ready") => {
                        if let Some(sender) = ready_tx.take() {
                            let _ = sender.send(Ok(()));
                        }
                    }
                    Some("reply") => {
                        if let Some(id) = message.get("id").and_then(Value::as_u64) {
                            let sender = pending.lock().ok().and_then(|mut map| map.remove(&id));
                            if let Some(request) = sender {
                                let result = match message.get("error") {
                                    Some(error) => Err(error.as_str().unwrap_or("CODEBUDDY_HOST_CALL_FAILED").to_string()),
                                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                                };
                                let _ = request.reply.send(result);
                            }
                        }
                    }
                    Some("event") => {
                        // The frontend addresses notifications by `method`, so the
                        // method has to travel with the params. Dropping it here
                        // silently swallows every sidecar event (`host.activated`,
                        // `webview.html`, `commands.registered`, ...).
                        let _ = app_handle.emit(
                            HOST_EVENT,
                            json!({
                                "method": message.get("method").cloned().unwrap_or(Value::Null),
                                "params": message.get("params").cloned().unwrap_or(Value::Null),
                            }),
                        );
                    }
                    Some("request") => {
                        // The shim asks the frontend for IDE data; the frontend
                        // answers through `codebuddy_host_reply`.
                        if let Some(id) = message.get("id").and_then(Value::as_u64) {
                            let _ = app_handle.emit(
                                HOST_EVENT,
                                json!({
                                    "method": "host.request",
                                    "params": {
                                        "requestId": id,
                                        "method": message.get("method").cloned().unwrap_or(Value::Null),
                                        "params": message.get("params").cloned().unwrap_or(Value::Null),
                                    }
                                }),
                            );
                        }
                    }
                    _ => {}
                }
            }
            // The sidecar exited; fail every in-flight call.
            if let Ok(mut map) = pending.lock() {
                for (_, request) in map.drain() {
                    let _ = request.reply.send(Err("CODEBUDDY_HOST_EXITED".into()));
                }
            }
            let _ = app_handle.emit(
                HOST_EVENT,
                json!({ "method": "host.exited", "params": {} }),
            );
        });
    }

    // stderr is surfaced as a host event for diagnostics.
    {
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "CODEBUDDY_HOST_STDERR_CLOSED".to_string())?;
        let app_handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let _ = app_handle.emit(
                    HOST_EVENT,
                    json!({ "method": "host.stderr", "params": { "line": line } }),
                );
            }
        });
    }

    let host_process = HostProcess {
        child,
        pending: Arc::clone(&pending),
    };

    match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => {
            let mut process = host_process;
            process.stop();
            set_last_error(&state, Some(error.clone()));
            return Err(error);
        }
        // The sidecar dropped the ready signal without reporting readiness.
        Ok(Err(_)) => {
            let mut process = host_process;
            process.stop();
            set_last_error(&state, Some("CODEBUDDY_HOST_EXITED".into()));
            return Err("CODEBUDDY_HOST_EXITED".into());
        }
        Err(_) => {
            let mut process = host_process;
            process.stop();
            set_last_error(&state, Some("CODEBUDDY_HOST_START_TIMEOUT".into()));
            return Err("CODEBUDDY_HOST_START_TIMEOUT".into());
        }
    }

    {
        let mut slot = state
            .process
            .lock()
            .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?;
        *slot = Some(host_process);
    }
    if let Ok(mut slot) = state.node_path.lock() {
        *slot = Some(node.to_string_lossy().into_owned());
    }
    Ok(json!({ "nodePath": node.to_string_lossy() }))
}

#[tauri::command]
pub async fn codebuddy_host_stop(
    state: tauri::State<'_, Arc<CodeBuddyHostState>>,
) -> Result<(), String> {
    let mut slot = state
        .process
        .lock()
        .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?;
    if let Some(mut process) = slot.take() {
        process.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn codebuddy_host_status(
    state: tauri::State<'_, Arc<CodeBuddyHostState>>,
) -> Result<Value, String> {
    let running = state
        .process
        .lock()
        .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?
        .is_some();
    let node_path = state
        .node_path
        .lock()
        .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?
        .clone();
    let last_error = state
        .last_error
        .lock()
        .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?
        .clone();
    Ok(json!({ "running": running, "nodePath": node_path, "lastError": last_error }))
}

/// Resolves the vendored extension and compiled bridge entry on disk.
///
/// Packaged builds map both into the bundle resources under `codebuddy/`;
/// development builds resolve the repository paths through `LITHE_REPO_ROOT`
/// or the executable's location.
/// Locates the repository root that holds the vendored CodeBuddy extension.
///
/// Developers run the app through `tauri dev`, where the bundled resource copy
/// under the dev target can be incomplete. The authoritative source lives in the
/// repository at `Plugins/win/Official/CodeBuddy/...`, so we prefer an explicit
/// `LITHE_REPO_ROOT` override and otherwise walk up from the executable until we
/// find it. This keeps CodeBuddy working in dev without manual env setup.
fn discover_repo_root() -> Option<std::path::PathBuf> {
    let extension_entry = |root: &std::path::Path| -> bool {
        root.join("Plugins/win/Official/CodeBuddy/vsix/extension/out/extension/index.js")
            .is_file()
    };
    if let Some(root) = std::env::var_os("LITHE_REPO_ROOT") {
        let root = std::path::PathBuf::from(root);
        if extension_entry(&root) {
            return Some(root);
        }
    }
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    loop {
        if extension_entry(&dir) {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

#[tauri::command]
pub async fn codebuddy_host_paths(app: AppHandle) -> Result<Value, String> {
    let resolve = |relative: &str| -> Option<std::path::PathBuf> {
        app.path()
            .resolve(relative, tauri::path::BaseDirectory::Resource)
            .ok()
            .filter(|path| path.exists())
    };
    // `codebuddy_host_start` launches `out/extension/index.js` and `host/main.js`.
    // A directory may exist while its compiled entry is missing (for example an
    // incomplete resource copy in a dev build), so validate the real files.
    let extension_entry_ok = |root: &std::path::Path| -> bool {
        root.join("out").join("extension").join("index.js").is_file()
    };
    let host_entry_ok = |entry: &std::path::Path| -> bool { entry.is_file() };

    let repo_root = discover_repo_root();

    // In development the repository source (`LITHE_REPO_ROOT`) is authoritative:
    // the bundled resource copy under the dev target can be incomplete. Packaged
    // builds have no `LITHE_REPO_ROOT`, so they fall back to the resource dir.
    let extension_root = repo_root
        .as_ref()
        .map(|root| root.join("Plugins/win/Official/CodeBuddy/vsix/extension"))
        .filter(|root| extension_entry_ok(root))
        .or_else(|| {
            resolve("codebuddy/vsix/extension").filter(|root| extension_entry_ok(root))
        });

    let host_entry = repo_root
        .as_ref()
        .map(|root| root.join("Plugins/win/Official/CodeBuddy/host/main.js"))
        .filter(|entry| host_entry_ok(entry))
        .or_else(|| resolve("codebuddy/host/main.js").filter(|entry| host_entry_ok(entry)));

    match (extension_root, host_entry) {
        (Some(extension_root), Some(host_entry)) => Ok(json!({
            "extensionRoot": extension_root.to_string_lossy(),
            "hostRoot": host_entry.parent().map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default(),
            "hostEntry": host_entry.to_string_lossy(),
        })),
        _ => Err("CODEBUDDY_RESOURCES_MISSING".into()),
    }
}

/// Answers a shim-initiated request forwarded to the frontend as an event.
#[tauri::command]
pub async fn codebuddy_host_reply(
    state: tauri::State<'_, Arc<CodeBuddyHostState>>,
    request_id: u64,
    result: Value,
    error: Option<String>,
) -> Result<(), String> {
    let line = match error {
        Some(error) => json!({ "type": "reply", "id": request_id, "error": error }).to_string(),
        None => json!({ "type": "reply", "id": request_id, "result": result }).to_string(),
    };
    let mut slot = state
        .process
        .lock()
        .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?;
    let process = slot
        .as_mut()
        .ok_or_else(|| "CODEBUDDY_HOST_NOT_RUNNING".to_string())?;
    send_line(&mut process.child, &line)
}

/// Frontend-to-shim call: one request over stdio, one correlated reply.
///
/// The reply can take seconds, so the command is `async`: a synchronous Tauri
/// command would occupy the main thread for the whole round trip.
#[tauri::command]
pub async fn codebuddy_host_call(
    state: tauri::State<'_, Arc<CodeBuddyHostState>>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    let line = json!({ "type": "call", "id": id, "method": method, "params": params }).to_string();

    // The process lock is scoped so the guard is released before the await
    // below: a `MutexGuard` held across an await would make the future
    // non-`Send`, and Tauri requires command futures to be `Send`.
    {
        let mut slot = state
            .process
            .lock()
            .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?;
        let process = slot
            .as_mut()
            .ok_or_else(|| "CODEBUDDY_HOST_NOT_RUNNING".to_string())?;
        {
            let mut pending = process
                .pending
                .lock()
                .map_err(|_| "CODEBUDDY_HOST_STATE_UNAVAILABLE".to_string())?;
            pending.insert(id, PendingRequest { reply: reply_tx });
        }
        if let Err(error) = send_line(&mut process.child, &line) {
            if let Ok(mut pending) = process.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
    }

    match tokio::time::timeout(Duration::from_secs(120), reply_rx).await {
        Ok(Ok(result)) => result,
        // The sidecar exited before answering.
        Ok(Err(_)) => Err("CODEBUDDY_HOST_EXITED".to_string()),
        Err(_) => Err("CODEBUDDY_HOST_CALL_TIMEOUT".to_string()),
    }
}
