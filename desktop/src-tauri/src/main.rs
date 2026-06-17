#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, Window};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CliRequest {
    command: String,
    nats_url: String,
    node_id: Option<String>,
    device_id: Option<String>,
    text: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
    skills: Option<String>,
    source_path: Option<String>,
    source_text: Option<String>,
    remote_name: Option<String>,
    workspace: Option<String>,
    latex_mcp_dir: Option<String>,
    main_tex: Option<String>,
    engine: Option<String>,
    output_subdir: Option<String>,
    peer_command: Option<String>,
    payload: Option<Value>,
    timeout_ms: Option<u64>,
    wait_timeout_sec: Option<f64>,
    stream_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CliResponse {
    ok: bool,
    stdout: Value,
    stderr: String,
    exit_code: i32,
    argv: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentChatRequest {
    provider_url: String,
    api_key: Option<String>,
    model: String,
    messages: Vec<Value>,
    temperature: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrontendDebugLogRequest {
    label: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageChatAttachmentRequest {
    source_path: String,
    workspace_root: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveChatAttachmentRequest {
    name: String,
    workspace_root: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedChatAttachment {
    name: String,
    source_path: String,
    staged_path: String,
    relative_path: String,
    size_bytes: u64,
    copied: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPeerRequest {
    nats_url: String,
    node_id: String,
    device_label: Option<String>,
    device_tags: Option<String>,
    capabilities: Option<String>,
    enable_pi: Option<bool>,
    pi_cli: Option<String>,
    pi_model: Option<String>,
    pi_provider: Option<String>,
    pi_cwd: Option<String>,
    start_nats: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAgentToolRequest {
    tool: String,
    command: Option<String>,
    script: Option<String>,
    cwd: Option<String>,
    workspace_root: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopAgentToolResponse {
    ok: bool,
    tool: String,
    cwd: String,
    command: Option<String>,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    duration_ms: u128,
    timed_out: Option<bool>,
    truncated: Option<bool>,
    meta: Option<Value>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalPeerStatus {
    ok: bool,
    node_id: Option<String>,
    nats_url: Option<String>,
    node_running: bool,
    nats_running: bool,
    nats_managed: bool,
    message: String,
    node_exit_code: Option<i32>,
    nats_exit_code: Option<i32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PiWebStatus {
    ok: bool,
    running: bool,
    url: String,
    port: u16,
    message: String,
    server_exit_code: Option<i32>,
    sessiond_exit_code: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    node_id: Option<String>,
    device_label: Option<String>,
    nats_url: Option<String>,
    repo_root: Option<String>,
    default_workspace: Option<String>,
}

#[derive(Default)]
struct PeerManager {
    inner: Mutex<ManagedPeer>,
}

#[derive(Default)]
struct PiWebManager {
    inner: Mutex<ManagedPiWeb>,
}

#[derive(Default)]
struct ManagedPeer {
    node: Option<Child>,
    nats: Option<Child>,
    node_id: Option<String>,
    nats_url: Option<String>,
    last_message: String,
    last_node_exit_code: Option<i32>,
    last_nats_exit_code: Option<i32>,
}

#[derive(Default)]
struct ManagedPiWeb {
    server: Option<Child>,
    sessiond: Option<Child>,
    port: Option<u16>,
    sessiond_port: Option<u16>,
    data_dir: Option<PathBuf>,
    last_message: String,
    last_server_exit_code: Option<i32>,
    last_sessiond_exit_code: Option<i32>,
}

enum PiWebSessiondEndpoint {
    Http { host: &'static str, port: u16, url: String },
    Socket { path: PathBuf },
}

enum PiWebProcessRole {
    Sessiond,
    Web,
}

impl PiWebSessiondEndpoint {
    fn new(data_dir: &Path) -> Result<Self, String> {
        if cfg!(windows) {
            let port = reserve_loopback_port()
                .map_err(|err| format!("failed to reserve Ag runtime session port: {err}"))?;
            let host = "127.0.0.1";
            return Ok(Self::Http {
                host,
                port,
                url: format!("http://{host}:{port}"),
            });
        }
        Ok(Self::Socket {
            path: data_dir.join("sessiond.sock"),
        })
    }

    fn port(&self) -> Option<u16> {
        match self {
            Self::Http { port, .. } => Some(*port),
            Self::Socket { .. } => None,
        }
    }
}

fn reserve_loopback_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

trait PiWebSessiondEndpointCommandExt {
    fn with_pi_web_sessiond_endpoint(
        &mut self,
        endpoint: &PiWebSessiondEndpoint,
        role: PiWebProcessRole,
    ) -> &mut Self;
}

impl PiWebSessiondEndpointCommandExt for Command {
    fn with_pi_web_sessiond_endpoint(
        &mut self,
        endpoint: &PiWebSessiondEndpoint,
        role: PiWebProcessRole,
    ) -> &mut Self {
        match endpoint {
            PiWebSessiondEndpoint::Http { host, port, url } => {
                match role {
                    PiWebProcessRole::Sessiond => {
                        self.env("PI_WEB_SESSIOND_HOST", host)
                            .env("PI_WEB_SESSIOND_PORT", port.to_string());
                    }
                    PiWebProcessRole::Web => {
                        self.env("PI_WEB_SESSIOND_URL", url);
                    }
                }
            }
            PiWebSessiondEndpoint::Socket { path } => {
                self.env("PI_WEB_SESSIOND_SOCKET", path);
            }
        }
        self
    }
}

impl Drop for PeerManager {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.stop_node();
            inner.stop_nats();
        }
    }
}

impl Drop for PiWebManager {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.stop();
        }
    }
}

#[tauri::command]
fn frontend_debug_log(request: FrontendDebugLogRequest) -> Result<(), String> {
    append_frontend_debug_log(&request.label, request.payload)
}

fn append_frontend_debug_log(label: &str, payload: Value) -> Result<(), String> {
    let log_dir = frontend_debug_log_dir();
    fs::create_dir_all(&log_dir)
        .map_err(|err| format!("failed to create frontend debug log dir: {err}"))?;
    let log_path = log_dir.join("frontend-debug.log");
    let payload = truncate_debug_value(payload, 16_000);
    let line = serde_json::json!({
        "tsMs": now_millis(),
        "label": truncate_debug_string(label, 120),
        "payload": payload,
    });
    let serialized = serde_json::to_string(&line)
        .map_err(|err| format!("failed to serialize frontend debug log: {err}"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("failed to open frontend debug log: {err}"))?;
    writeln!(file, "{serialized}")
        .map_err(|err| format!("failed to write frontend debug log: {err}"))?;
    Ok(())
}

fn frontend_debug_log_dir() -> PathBuf {
    if let Some(value) = env_non_empty("AGSWARM_LOG_DIR") {
        return PathBuf::from(value);
    }
    if let Ok(value) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(value).join("AgSwarm Client").join("logs");
    }
    if let Ok(value) = std::env::var("APPDATA") {
        return PathBuf::from(value).join("AgSwarm Client").join("logs");
    }
    if let Ok(value) = std::env::var("HOME") {
        return PathBuf::from(value).join(".agswarm-client").join("logs");
    }
    std::env::temp_dir().join("agswarm-client").join("logs")
}

#[tauri::command]
fn stage_chat_attachment(request: StageChatAttachmentRequest) -> Result<StagedChatAttachment, String> {
    let workspace_root = normalize_path(Path::new(request.workspace_root.trim()));
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        return Err("Host Working Directory must be an existing absolute path before attaching files.".to_string());
    }
    let source_path = normalize_path(Path::new(request.source_path.trim()));
    if !source_path.is_file() {
        return Err("Only files can be attached to chat right now.".to_string());
    }
    let metadata = fs::metadata(&source_path)
        .map_err(|err| format!("failed to inspect attachment: {err}"))?;
    let name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(sanitize_attachment_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "attachment".to_string());
    if source_path.starts_with(&workspace_root) {
        let relative = source_path
            .strip_prefix(&workspace_root)
            .map_err(|err| format!("failed to resolve workspace attachment path: {err}"))?
            .to_string_lossy()
            .replace('\\', "/");
        return Ok(StagedChatAttachment {
            name,
            source_path: source_path.to_string_lossy().to_string(),
            staged_path: source_path.to_string_lossy().to_string(),
            relative_path: relative,
            size_bytes: metadata.len(),
            copied: false,
        });
    }

    let attachment_dir = workspace_root.join(".agswarm").join("attachments");
    fs::create_dir_all(&attachment_dir)
        .map_err(|err| format!("failed to create attachment directory: {err}"))?;
    let staged_name = unique_attachment_name(&attachment_dir, &name);
    let staged_path = attachment_dir.join(staged_name);
    fs::copy(&source_path, &staged_path)
        .map_err(|err| format!("failed to copy attachment into workspace: {err}"))?;
    let relative = staged_path
        .strip_prefix(&workspace_root)
        .map_err(|err| format!("failed to resolve staged attachment path: {err}"))?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(StagedChatAttachment {
        name,
        source_path: source_path.to_string_lossy().to_string(),
        staged_path: staged_path.to_string_lossy().to_string(),
        relative_path: relative,
        size_bytes: metadata.len(),
        copied: true,
    })
}

#[tauri::command]
fn save_chat_attachment(request: SaveChatAttachmentRequest) -> Result<StagedChatAttachment, String> {
    let workspace_root = normalize_path(Path::new(request.workspace_root.trim()));
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        return Err("Host Working Directory must be an existing absolute path before attaching files.".to_string());
    }
    let name = sanitize_attachment_name(&request.name)
        .trim()
        .to_string();
    let name = if name.is_empty() { "attachment".to_string() } else { name };
    let attachment_dir = workspace_root.join(".agswarm").join("attachments");
    fs::create_dir_all(&attachment_dir)
        .map_err(|err| format!("failed to create attachment directory: {err}"))?;
    let staged_name = unique_attachment_name(&attachment_dir, &name);
    let staged_path = attachment_dir.join(staged_name);
    fs::write(&staged_path, &request.bytes)
        .map_err(|err| format!("failed to save attachment into workspace: {err}"))?;
    let relative = staged_path
        .strip_prefix(&workspace_root)
        .map_err(|err| format!("failed to resolve saved attachment path: {err}"))?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(StagedChatAttachment {
        name,
        source_path: staged_path.to_string_lossy().to_string(),
        staged_path: staged_path.to_string_lossy().to_string(),
        relative_path: relative,
        size_bytes: request.bytes.len() as u64,
        copied: true,
    })
}

fn sanitize_attachment_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| if matches!(ch, '/' | '\\' | ':' | '\0') || ch.is_control() { '_' } else { ch })
        .collect::<String>()
        .trim_matches('_')
        .trim()
        .to_string();
    if sanitized == "." || sanitized == ".." {
        "attachment".to_string()
    } else {
        sanitized
    }
}

fn unique_attachment_name(dir: &Path, name: &str) -> String {
    let candidate = Path::new(name);
    let stem = candidate
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    for index in 0..1000 {
        let next = if index == 0 {
            format!("{stem}{extension}")
        } else {
            format!("{stem}-{index}{extension}")
        };
        if !dir.join(&next).exists() {
            return next;
        }
    }
    format!("{stem}-{}{}", now_millis(), extension)
}

fn truncate_debug_value(value: Value, max_chars: usize) -> Value {
    let text = serde_json::to_string(&value).unwrap_or_default();
    if text.len() <= max_chars {
        return value;
    }
    serde_json::json!({
        "truncated": true,
        "preview": truncate_debug_string(&text, max_chars),
    })
}

fn truncate_debug_string(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let preview: String = value.chars().take(max_chars).collect();
    format!("{preview}... truncated ...")
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[tauri::command]
async fn agswarm_cli(window: Window, request: CliRequest) -> Result<CliResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.command == "submit-pi" {
            run_agswarm_cli_streaming(window, request)
        } else if request.stream_token.is_some() {
            run_agswarm_cli_streaming(window, request)
        } else {
            run_agswarm_cli_blocking(window.app_handle().clone(), request)
        }
    })
        .await
        .map_err(|err| format!("failed to join AgSwarm CLI task: {err}"))?
}

fn run_agswarm_cli_blocking(app: tauri::AppHandle, request: CliRequest) -> Result<CliResponse, String> {
    let repo_root = repo_root()?;
    if request.command == "pi-commands" {
        return run_pi_agent_commands_bridge(&app, &repo_root, &request);
    }
    let command_cwd = default_workspace_dir(&app).unwrap_or_else(|_| repo_root.clone());
    let python = python_path(&repo_root);
    let argv = build_agswarm_cli_argv(&repo_root, request, false)?;

    let mut cmd = Command::new(&python);
    cmd.args(&argv)
        .current_dir(&command_cwd)
        .env("PYTHONPATH", repo_root.join("src"));
    configure_child_env(&mut cmd);
    let output = cmd
        .output()
        .map_err(|err| format!("failed to run {python}: {err}"))?;
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = serde_json::from_str(stdout_text.trim()).unwrap_or_else(|_| {
        serde_json::json!({
            "ok": output.status.success(),
            "raw": stdout_text.trim(),
        })
    });
    Ok(CliResponse {
        ok: output.status.success(),
        stdout,
        stderr,
        exit_code: output.status.code().unwrap_or(-1),
        argv,
    })
}

fn run_pi_agent_commands_bridge(app: &tauri::AppHandle, repo_root: &Path, request: &CliRequest) -> Result<CliResponse, String> {
    let bridge_command = resolve_pi_agent_session_bridge_without_window(repo_root)?;
    let workspace = request
        .workspace
        .clone()
        .or_else(|| env_non_empty("AGSWARM_PI_CWD"))
        .or_else(|| default_workspace_dir(app).ok().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|| repo_root.to_string_lossy().to_string());
    let mut argv = vec![
        "--list-commands".to_string(),
        "--cwd".to_string(),
        workspace.clone(),
    ];
    if let Some(skills) = request.skills.clone().filter(|value| !value.trim().is_empty()) {
        argv.push("--skills".to_string());
        argv.push(skills);
    }
    let mut cmd = Command::new(&bridge_command.executable);
    if let Some(package_dir) = &bridge_command.package_dir {
        cmd.env("PI_PACKAGE_DIR", package_dir);
    }
    cmd.args(&argv)
        .current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_child_env(&mut cmd);
    let output = cmd
        .output()
        .map_err(|err| format!("failed to list AgSwarm AI commands with {}: {err}", bridge_command.executable))?;
    let stdout_text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let stdout = parse_bridge_result_stdout(&stdout_text).unwrap_or_else(|| {
        serde_json::json!({
            "ok": output.status.success(),
            "raw": stdout_text,
        })
    });
    Ok(CliResponse {
        ok: output.status.success(),
        stdout,
        stderr,
        exit_code: output.status.code().unwrap_or(-1),
        argv,
    })
}

fn run_agswarm_cli_streaming(window: Window, request: CliRequest) -> Result<CliResponse, String> {
    let repo_root = repo_root()?;
    if request.command == "submit-pi" {
        return run_pi_agent_session_bridge(window, &repo_root, &request);
    }
    let command_cwd = default_workspace_dir(window.app_handle()).unwrap_or_else(|_| repo_root.clone());
    let python = python_path(&repo_root);
    let stream_token = request
        .stream_token
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "streamToken is required for streaming submit-pi".to_string())?;
    let argv = build_agswarm_cli_argv(&repo_root, request, true)?;
    let _ = append_frontend_debug_log(
        "tauri-cli-stream-start",
        serde_json::json!({
            "python": python,
            "argv": argv,
            "streamToken": stream_token,
        }),
    );

    let mut cmd = Command::new(&python);
    cmd.args(&argv)
        .current_dir(&command_cwd)
        .env("PYTHONPATH", repo_root.join("src"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_child_env(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("failed to run {python}: {err}"))?;
    let _ = append_frontend_debug_log(
        "tauri-cli-stream-spawned",
        serde_json::json!({
            "pid": child.id(),
            "streamToken": stream_token,
        }),
    );
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture AgSwarm CLI stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture AgSwarm CLI stderr".to_string())?;
    let stderr_handle = std::thread::spawn(move || {
        let mut output = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut output);
        output
    });

    let mut stdout_text = String::new();
    let mut final_stdout = Value::Null;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|err| format!("failed to read AgSwarm CLI stdout: {err}"))?;
        if line.trim().is_empty() {
            continue;
        }
        stdout_text.push_str(&line);
        stdout_text.push('\n');
        let _ = append_frontend_debug_log(
            "tauri-cli-stream-stdout-line",
            serde_json::json!({
                "streamToken": stream_token,
                "line": line,
            }),
        );
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("stream").and_then(Value::as_bool).unwrap_or(false) {
            let payload = serde_json::json!({
                "streamToken": stream_token,
                "kind": value.get("kind").cloned().unwrap_or(Value::Null),
                "payload": value.get("payload").cloned().unwrap_or(Value::Null),
            });
            let _ = window.emit("agswarm-pi-stream", payload);
            if value.get("kind").and_then(Value::as_str) == Some("result") {
                final_stdout = value.get("payload").cloned().unwrap_or(Value::Null);
            }
        } else {
            final_stdout = value;
        }
    }

    let status = child
        .wait()
        .map_err(|err| format!("failed to wait for AgSwarm CLI: {err}"))?;
    let stderr = stderr_handle.join().unwrap_or_default();
    let _ = append_frontend_debug_log(
        "tauri-cli-stream-finished",
        serde_json::json!({
            "streamToken": stream_token,
            "exitCode": status.code().unwrap_or(-1),
            "success": status.success(),
            "stderr": stderr,
        }),
    );
    let stdout = if final_stdout.is_null() {
        serde_json::from_str(stdout_text.trim()).unwrap_or_else(|_| {
            serde_json::json!({
                "ok": status.success(),
                "raw": stdout_text.trim(),
            })
        })
    } else {
        final_stdout
    };
    Ok(CliResponse {
        ok: status.success(),
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(-1),
        argv,
    })
}

fn run_pi_agent_session_bridge(
    window: Window,
    repo_root: &Path,
    request: &CliRequest,
) -> Result<CliResponse, String> {
    let stream_token = request
        .stream_token
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("pi-stream-{}", now_millis()));
    let bridge_command = resolve_pi_agent_session_bridge(&window, repo_root)?;
    let workspace = request
        .workspace
        .clone()
        .or_else(|| env_non_empty("AGSWARM_PI_CWD"))
        .or_else(|| default_workspace_dir(window.app_handle()).ok().map(|path| path.to_string_lossy().to_string()))
        .unwrap_or_else(|| repo_root.to_string_lossy().to_string());
    let prompt = agswarm_ai_prompt_context(repo_root, &workspace, request.prompt.clone().unwrap_or_default());
    let mut argv = vec![
        "--prompt".to_string(),
        prompt,
        "--cwd".to_string(),
        workspace.clone(),
        "--timeout-ms".to_string(),
        request.timeout_ms.unwrap_or(120_000).max(100).to_string(),
        "--task-id".to_string(),
        format!("pi-agent-session-{}", now_millis()),
    ];
    if let Some(model) = request.model.clone().filter(|value| !value.trim().is_empty()) {
        argv.push("--model".to_string());
        argv.push(model);
    }
    if let Some(skills) = request.skills.clone().filter(|value| !value.trim().is_empty()) {
        argv.push("--skills".to_string());
        argv.push(skills);
    }

    let _ = append_frontend_debug_log(
        "pi-agent-session-bridge-start",
        serde_json::json!({
            "executable": bridge_command.executable,
            "runtime": "pi-sdk-agent-session",
            "argv": argv,
            "streamToken": stream_token,
        }),
    );
    let mut cmd = Command::new(&bridge_command.executable);
    if let Some(package_dir) = &bridge_command.package_dir {
        cmd.env("PI_PACKAGE_DIR", package_dir);
    }
    cmd.args(&argv)
        .current_dir(&workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_child_env(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("failed to run pi AgentSession bridge with {}: {err}", bridge_command.executable))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture pi AgentSession bridge stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture pi AgentSession bridge stderr".to_string())?;
    let stderr_handle = std::thread::spawn(move || {
        let mut output = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut output);
        output
    });

    let mut stdout_text = String::new();
    let mut final_stdout = Value::Null;
    let mut events = Vec::new();
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|err| format!("failed to read pi AgentSession bridge stdout: {err}"))?;
        if line.trim().is_empty() {
            continue;
        }
        stdout_text.push_str(&line);
        stdout_text.push('\n');
        let _ = append_frontend_debug_log(
            "pi-agent-session-bridge-stdout-line",
            serde_json::json!({
                "streamToken": stream_token,
                "line": line,
            }),
        );
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("stream").and_then(Value::as_bool).unwrap_or(false) {
            let kind = value.get("kind").cloned().unwrap_or(Value::Null);
            let payload_value = value.get("payload").cloned().unwrap_or(Value::Null);
            if kind.as_str() == Some("event") {
                events.push(payload_value.clone());
            }
            let payload = serde_json::json!({
                "streamToken": stream_token,
                "kind": kind,
                "payload": payload_value,
            });
            let _ = window.emit("agswarm-pi-stream", payload);
            if value.get("kind").and_then(Value::as_str) == Some("result") {
                final_stdout = value.get("payload").cloned().unwrap_or(Value::Null);
            }
        } else {
            final_stdout = value;
        }
    }

    let status = child
        .wait()
        .map_err(|err| format!("failed to wait for pi AgentSession bridge: {err}"))?;
    let stderr = stderr_handle.join().unwrap_or_default();
    let _ = append_frontend_debug_log(
        "pi-agent-session-bridge-finished",
        serde_json::json!({
            "streamToken": stream_token,
            "exitCode": status.code().unwrap_or(-1),
            "success": status.success(),
            "stderr": stderr,
        }),
    );
    if final_stdout.is_null() {
        final_stdout = serde_json::json!({
            "ok": status.success(),
            "raw": stdout_text.trim(),
            "events": [],
        });
    } else if let Some(object) = final_stdout.as_object_mut() {
        object.insert("events".to_string(), Value::Array(Vec::<Value>::new()));
        object.insert("streamEventCount".to_string(), Value::Number(events.len().into()));
    }
    Ok(CliResponse {
        ok: status.success(),
        stdout: final_stdout,
        stderr,
        exit_code: status.code().unwrap_or(-1),
        argv,
    })
}

struct PiAgentSessionBridgeCommand {
    executable: String,
    package_dir: Option<String>,
}

fn resolve_pi_agent_session_bridge(
    window: &Window,
    repo_root: &Path,
) -> Result<PiAgentSessionBridgeCommand, String> {
    let binary_names = pi_agent_session_bridge_binary_names();
    let mut candidates = Vec::new();

    if let Some(path) = env_non_empty("AGSWARM_PI_AGENT_SESSION_BRIDGE_BIN") {
        candidates.push(PathBuf::from(path));
    }
    for binary_name in &binary_names {
        if let Ok(resource_dir) = window.app_handle().path().resource_dir() {
            candidates.push(resource_dir.join(binary_name));
            candidates.push(resource_dir.join("binaries").join(binary_name));
        }
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(exe_dir) = current_exe.parent() {
                candidates.push(exe_dir.join(binary_name));
                if let Some(contents_dir) = exe_dir.parent() {
                    candidates.push(contents_dir.join("Resources").join(binary_name));
                    candidates.push(contents_dir.join("Resources").join("binaries").join(binary_name));
                }
            }
        }
        candidates.push(
            repo_root
                .join("desktop")
                .join("src-tauri")
                .join("binaries")
                .join(binary_name),
        );
    }

    for candidate in candidates {
        if candidate.is_file() {
            let package_dir = pi_agent_session_bridge_package_dir(&candidate);
            return Ok(PiAgentSessionBridgeCommand {
                executable: candidate.to_string_lossy().to_string(),
                package_dir,
            });
        }
    }

    Err(format!(
        "pi SDK AgentSession sidecar not found; expected {}. Install/build the desktop pi SDK sidecar instead of falling back to Python or Node scripts.",
        binary_names.join(" / ")
    ))
}

fn resolve_pi_agent_session_bridge_without_window(
    repo_root: &Path,
) -> Result<PiAgentSessionBridgeCommand, String> {
    let binary_names = pi_agent_session_bridge_binary_names();
    let mut candidates = Vec::new();

    if let Some(path) = env_non_empty("AGSWARM_PI_AGENT_SESSION_BRIDGE_BIN") {
        candidates.push(PathBuf::from(path));
    }
    for binary_name in &binary_names {
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(exe_dir) = current_exe.parent() {
                candidates.push(exe_dir.join(binary_name));
                if let Some(contents_dir) = exe_dir.parent() {
                    candidates.push(contents_dir.join("Resources").join(binary_name));
                    candidates.push(contents_dir.join("Resources").join("binaries").join(binary_name));
                }
            }
        }
        candidates.push(
            repo_root
                .join("desktop")
                .join("src-tauri")
                .join("binaries")
                .join(binary_name),
        );
    }

    for candidate in candidates {
        if candidate.is_file() {
            let package_dir = pi_agent_session_bridge_package_dir(&candidate);
            return Ok(PiAgentSessionBridgeCommand {
                executable: candidate.to_string_lossy().to_string(),
                package_dir,
            });
        }
    }

    Err(format!(
        "pi SDK AgentSession sidecar not found; expected {}.",
        binary_names.join(" / ")
    ))
}

fn parse_bridge_result_stdout(stdout_text: &str) -> Option<Value> {
    for line in stdout_text.lines().rev() {
        let value = serde_json::from_str::<Value>(line.trim()).ok()?;
        if value.get("kind").and_then(Value::as_str) == Some("result") {
            return value.get("payload").cloned();
        }
    }
    None
}

fn agswarm_ai_prompt_context(repo_root: &Path, workspace: &str, user_prompt: String) -> String {
    format!(
        "{}\n\nUser request:\n{}",
        agswarm_project_context(repo_root, workspace),
        user_prompt
    )
}

fn agswarm_project_context(repo_root: &Path, workspace: &str) -> String {
    format!(
        r#"<agswarm_context>
You are the AI worker inside AgSwarm Client, a desktop app for multi-device agent collaboration.

Product summary:
- AgSwarm discovers trusted devices on the user's local network and represents each device's AI worker as a participant in shared conversations.
- The chat page is the user's command surface for asking the local device AI to reason, use tools, inspect the workspace, and coordinate tasks.
- Device and task pages track discovered peers, transfer/task state, and future multi-device handoffs.
- Prefer concise, helpful Chinese when the user writes Chinese. Keep a calm, collaborative tone.

Operating guidance:
- Treat this context as background. Do not mention implementation internals unless asked.
- When doing work, explain the next concrete action briefly, then use available tools.
- Keep file, shell, and network actions bounded to the user's request and current workspace.
- If a model/provider/runtime connection fails, report a short user-facing recovery hint instead of raw stack traces.

Current workspace: {workspace}
Repository root: {}
</agswarm_context>"#,
        repo_root.to_string_lossy()
    )
}

fn pi_agent_session_bridge_binary_names() -> Vec<String> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        std::env::consts::ARCH
    };
    vec![
        format!("pi-agent-session-bridge{suffix}"),
        format!("pi-agent-session-bridge-{triple}{suffix}"),
    ]
}

fn pi_agent_session_bridge_package_dir(executable: &Path) -> Option<String> {
    let executable_dir = executable.parent()?;
    if executable_dir.join("package.json").is_file() {
        return Some(executable_dir.to_string_lossy().to_string());
    }
    let resources_dir = executable_dir
        .parent()
        .map(|contents_dir| contents_dir.join("Resources").join("binaries"));
    if let Some(resources_dir) = resources_dir {
        if resources_dir.join("package.json").is_file() {
            return Some(resources_dir.to_string_lossy().to_string());
        }
    }
    Some(executable_dir.to_string_lossy().to_string())
}

fn build_agswarm_cli_argv(repo_root: &Path, request: CliRequest, stream_events: bool) -> Result<Vec<String>, String> {
    let mut argv = vec!["-m".to_string(), "workflow_cli".to_string()];

    match request.command.as_str() {
        "node-snapshot" => {
            argv.push("node-snapshot".to_string());
            push_common(&mut argv, &request);
            argv.push("--timeout-sec".to_string());
            argv.push(request.wait_timeout_sec.unwrap_or(3.0).max(0.1).to_string());
        }
        "discover-nodes" => {
            argv.push("discover-nodes".to_string());
            argv.push("--nats-url".to_string());
            argv.push(request.nats_url.clone());
            argv.push("--timeout-sec".to_string());
            argv.push(request.wait_timeout_sec.unwrap_or(1.5).max(0.1).to_string());
            if let Some(skills) = request.skills.filter(|value| !value.trim().is_empty()) {
                argv.push("--require-capabilities".to_string());
                argv.push(skills);
            }
        }
        "submit-echo" => {
            argv.push("submit-echo".to_string());
            push_common(&mut argv, &request);
            argv.push("--text".to_string());
            argv.push(request.text.unwrap_or_default());
            argv.push("--wait-timeout-sec".to_string());
            argv.push(
                request
                    .wait_timeout_sec
                    .unwrap_or(20.0)
                    .max(0.1)
                    .to_string(),
            );
            if let Some(skills) = request.skills.filter(|value| !value.trim().is_empty()) {
                argv.push("--skills".to_string());
                argv.push(skills);
            }
            if stream_events {
                argv.push("--stream-events".to_string());
            }
        }
        "submit-pi" => {
            argv.push("submit-pi".to_string());
            push_common(&mut argv, &request);
            argv.push("--prompt".to_string());
            argv.push(request.prompt.unwrap_or_default());
            if let Some(model) = request.model.filter(|value| !value.trim().is_empty()) {
                argv.push("--model".to_string());
                argv.push(model);
            }
            argv.push("--wait-timeout-sec".to_string());
            argv.push(
                request
                    .wait_timeout_sec
                    .unwrap_or(60.0)
                    .max(0.1)
                    .to_string(),
            );
            argv.push("--timeout-ms".to_string());
            argv.push(request.timeout_ms.unwrap_or(120_000).max(100).to_string());
            if let Some(device_id) = request.device_id.filter(|value| !value.trim().is_empty()) {
                argv.push("--device-id".to_string());
                argv.push(device_id);
            }
            if let Some(skills) = request.skills.filter(|value| !value.trim().is_empty()) {
                argv.push("--skills".to_string());
                argv.push(skills);
            }
            if stream_events {
                argv.push("--stream-events".to_string());
            }
        }
        "submit-latex" => {
            argv.push("submit-latex".to_string());
            push_common(&mut argv, &request);
            let latex_source = resolve_latex_source(&repo_root, &request)?;
            push_required(
                &mut argv,
                "--workspace",
                latex_source.workspace,
                "workspace",
            )?;
            push_required(
                &mut argv,
                "--latex-mcp-dir",
                request.latex_mcp_dir,
                "latexMcpDir",
            )?;
            push_required(&mut argv, "--main-tex", latex_source.main_tex, "mainTex")?;
            argv.push("--engine".to_string());
            argv.push(request.engine.unwrap_or_else(|| "pdflatex".to_string()));
            argv.push("--output-subdir".to_string());
            argv.push(
                request
                    .output_subdir
                    .unwrap_or_else(|| "build_case_tauri".to_string()),
            );
            argv.push("--wait-timeout-sec".to_string());
            argv.push(
                request
                    .wait_timeout_sec
                    .unwrap_or(900.0)
                    .max(0.1)
                    .to_string(),
            );
            argv.push("--timeout-ms".to_string());
            argv.push(request.timeout_ms.unwrap_or(600_000).max(100).to_string());
            if let Some(skills) = request.skills.filter(|value| !value.trim().is_empty()) {
                argv.push("--skills".to_string());
                argv.push(skills);
            }
        }
        "upload-file" => {
            argv.push("upload-file".to_string());
            push_common(&mut argv, &request);
            push_required(
                &mut argv,
                "--source-path",
                request.source_path,
                "sourcePath",
            )?;
            if let Some(remote_name) = request.remote_name.filter(|value| !value.trim().is_empty())
            {
                argv.push("--remote-name".to_string());
                argv.push(remote_name);
            }
        }
        "peer-ping" => {
            argv.push("peer-ping".to_string());
            push_common(&mut argv, &request);
            argv.push("--timeout-sec".to_string());
            argv.push(request.wait_timeout_sec.unwrap_or(3.0).max(0.1).to_string());
            if let Some(device_id) = request.device_id.filter(|value| !value.trim().is_empty()) {
                argv.push("--device-id".to_string());
                argv.push(device_id);
            }
        }
        "peer-command" => {
            argv.push("peer-command".to_string());
            push_common(&mut argv, &request);
            argv.push("--timeout-sec".to_string());
            argv.push(
                request
                    .wait_timeout_sec
                    .unwrap_or(30.0)
                    .max(0.1)
                    .to_string(),
            );
            if let Some(device_id) = request.device_id.filter(|value| !value.trim().is_empty()) {
                argv.push("--device-id".to_string());
                argv.push(device_id);
            }
            let command = request
                .peer_command
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "describe".to_string());
            argv.push(command);
            if let Some(payload) = request.payload {
                argv.push("--payload".to_string());
                argv.push(payload.to_string());
            }
        }
        other => return Err(format!("unsupported AgSwarm CLI command: {other}")),
    }
    Ok(argv)
}

#[tauri::command]
fn start_local_peer(
    app: tauri::AppHandle,
    request: LocalPeerRequest,
    manager: tauri::State<'_, PeerManager>,
) -> Result<LocalPeerStatus, String> {
    let repo_root = repo_root()?;
    let python = python_path(&repo_root);
    let mut inner = manager
        .inner
        .lock()
        .map_err(|_| "local peer manager lock is poisoned".to_string())?;

    inner.reap_finished();
    if request.start_nats.unwrap_or(true) && is_loopback_nats(&request.nats_url) {
        inner.ensure_nats(&app, &repo_root)?;
    }
    inner.ensure_node(&app, &repo_root, &python, request)?;
    Ok(inner.status())
}

#[tauri::command]
fn stop_local_peer(manager: tauri::State<'_, PeerManager>) -> Result<LocalPeerStatus, String> {
    let mut inner = manager
        .inner
        .lock()
        .map_err(|_| "local peer manager lock is poisoned".to_string())?;
    inner.stop_node();
    Ok(inner.status())
}

#[tauri::command]
fn local_peer_status(manager: tauri::State<'_, PeerManager>) -> Result<LocalPeerStatus, String> {
    let mut inner = manager
        .inner
        .lock()
        .map_err(|_| "local peer manager lock is poisoned".to_string())?;
    inner.reap_finished();
    Ok(inner.status())
}

#[tauri::command]
fn start_pi_web(
    app: tauri::AppHandle,
    manager: tauri::State<'_, PiWebManager>,
) -> Result<PiWebStatus, String> {
    let repo_root = repo_root()?;
    let mut inner = manager
        .inner
        .lock()
        .map_err(|_| "pi-web manager lock is poisoned".to_string())?;
    inner.reap_finished();
    inner.ensure_started(&app, &repo_root)?;
    Ok(inner.status())
}

#[tauri::command]
fn pi_web_status(manager: tauri::State<'_, PiWebManager>) -> Result<PiWebStatus, String> {
    let mut inner = manager
        .inner
        .lock()
        .map_err(|_| "pi-web manager lock is poisoned".to_string())?;
    inner.reap_finished();
    Ok(inner.status())
}

#[tauri::command]
fn runtime_config(app: tauri::AppHandle) -> RuntimeConfig {
    RuntimeConfig {
        node_id: env_non_empty("AGSWARM_NODE_ID"),
        device_label: env_non_empty("AGSWARM_DEVICE_LABEL"),
        nats_url: env_non_empty("AGSWARM_NATS_URL"),
        repo_root: repo_root().ok().map(|path| path.to_string_lossy().to_string()),
        default_workspace: default_workspace_dir(&app)
            .ok()
            .map(|path| path.to_string_lossy().to_string()),
    }
}

#[tauri::command]
fn system_device_name() -> String {
    env_non_empty("AGSWARM_DEVICE_LABEL")
        .or_else(|| command_output("scutil", &["--get", "ComputerName"]))
        .or_else(|| command_output("hostname", &["-s"]))
        .or_else(|| command_output("hostname", &[]))
        .or_else(|| env_non_empty("HOSTNAME"))
        .unwrap_or_else(|| "AgSwarm Client".to_string())
}

#[tauri::command]
async fn agent_provider_chat(request: AgentChatRequest) -> Result<Value, String> {
    let endpoint = format!(
        "{}/v1/chat/completions",
        request.provider_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "model": request.model,
        "messages": request.messages,
        "temperature": request.temperature.unwrap_or(0.2),
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|err| format!("failed to build provider client: {err}"))?;
    let mut builder = client.post(endpoint).json(&body);
    if let Some(api_key) = request.api_key.filter(|value| !value.trim().is_empty()) {
        builder = builder.bearer_auth(api_key);
    }
    let response = builder
        .send()
        .await
        .map_err(|err| format!("provider request failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("failed to read provider response: {err}"))?;
    if !status.is_success() {
        return Err(format!("provider returned {status}: {text}"));
    }
    serde_json::from_str(&text)
        .map_err(|err| format!("provider returned invalid JSON: {err}: {text}"))
}

#[tauri::command]
fn desktop_agent_tool(
    request: DesktopAgentToolRequest,
) -> Result<DesktopAgentToolResponse, String> {
    let started = Instant::now();
    let tool = normalize_desktop_tool(&request.tool)?;
    let repo_root = repo_root()?;
    let workspace_root = resolve_workspace_root(&repo_root, request.workspace_root.as_deref())?;
    let cwd = resolve_tool_cwd(&workspace_root, request.cwd.as_deref())?;
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(30_000).clamp(500, 120_000));

    if tool == "workspace_info" {
        let files = fs::read_dir(&cwd)
            .map_err(|err| format!("failed to list workspace: {err}"))?
            .filter_map(|entry| entry.ok())
            .take(80)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        return Ok(DesktopAgentToolResponse {
            ok: true,
            tool: tool.to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            command: None,
            stdout: serde_json::to_string_pretty(&serde_json::json!({
                "cwd": cwd,
                "workspaceRoot": workspace_root,
                "repoRoot": repo_root,
                "platform": std::env::consts::OS,
                "files": files,
            }))
            .unwrap_or_else(|_| "{}".to_string()),
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: started.elapsed().as_millis(),
            timed_out: Some(false),
            truncated: Some(false),
            meta: Some(serde_json::json!({ "readOnly": true })),
        });
    }

    let (program, args, display_command) = if tool == "python" {
        let script = request
            .script
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "python script is required".to_string())?;
        let script_path = write_temp_python_script(&repo_root, script)?;
        (
            "python3".to_string(),
            vec![script_path.to_string_lossy().to_string()],
            "python3 <generated script>".to_string(),
        )
    } else {
        let command = request
            .command
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "shell command is required".to_string())?;
        assert_allowed_shell_command(command)?;
        (
            "/bin/zsh".to_string(),
            vec!["-lc".to_string(), command.to_string()],
            command.to_string(),
        )
    };

    let output = run_command_with_timeout(program, args, cwd.clone(), timeout)?;
    Ok(DesktopAgentToolResponse {
        ok: output.exit_code == Some(0) && !output.timed_out,
        tool: tool.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        command: Some(display_command),
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
        duration_ms: started.elapsed().as_millis(),
        timed_out: Some(output.timed_out),
        truncated: Some(output.truncated),
        meta: None,
    })
}

impl ManagedPeer {
    fn ensure_nats(&mut self, app: &tauri::AppHandle, repo_root: &Path) -> Result<(), String> {
        if tcp_port_open("127.0.0.1:4222") {
            self.last_message = "Using existing local NATS server.".to_string();
            return Ok(());
        }
        if self
            .nats
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none())
        {
            return Ok(());
        }
        let Some(nats_server) = find_nats_server() else {
            self.last_message =
                "nats-server was not found; start NATS manually or install nats-server."
                    .to_string();
            return Ok(());
        };
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("failed to resolve AgSwarm app data dir: {err}"))?;
        let log_dir = app_data_dir.join("logs").join("tauri-peer");
        std::fs::create_dir_all(&log_dir)
            .map_err(|err| format!("failed to create local peer log dir: {err}"))?;
        let stdout = std::fs::File::create(log_dir.join("nats.out.log"))
            .map_err(|err| format!("failed to create NATS stdout log: {err}"))?;
        let stderr = std::fs::File::create(log_dir.join("nats.err.log"))
            .map_err(|err| format!("failed to create NATS stderr log: {err}"))?;
        let mut command = Command::new(&nats_server);
        command
            .arg("-c")
            .arg(repo_root.join("configs").join("nats-dev.conf"))
            .current_dir(&app_data_dir)
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        let child = command
            .spawn_with_path()
            .map_err(|err| format!("failed to start {nats_server}: {err}"))?;
        self.nats = Some(child);
        self.last_nats_exit_code = None;
        self.last_message = "Started managed local NATS server.".to_string();
        Ok(())
    }

    fn ensure_node(
        &mut self,
        app: &tauri::AppHandle,
        repo_root: &Path,
        python: &str,
        request: LocalPeerRequest,
    ) -> Result<(), String> {
        let requested_node_id = request.node_id.trim();
        if requested_node_id.is_empty() {
            return Err("nodeId is required for the local peer".to_string());
        }
        let same_identity = self.node_id.as_deref() == Some(requested_node_id)
            && self.nats_url.as_deref() == Some(request.nats_url.as_str());
        if same_identity
            && self
                .node
                .as_mut()
                .is_some_and(|child| child.try_wait().ok().flatten().is_none())
        {
            self.last_message = "Local peer node is already running.".to_string();
            return Ok(());
        }
        self.stop_node();
        stop_stale_node_processes(repo_root, requested_node_id);

        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("failed to resolve AgSwarm app data dir: {err}"))?;
        let workspace_dir = default_workspace_dir(app).unwrap_or_else(|_| app_data_dir.clone());
        let log_dir = app_data_dir.join("logs").join("tauri-peer");
        std::fs::create_dir_all(&log_dir)
            .map_err(|err| format!("failed to create local peer log dir: {err}"))?;
        let stdout = std::fs::File::create(log_dir.join(format!("{requested_node_id}.out.log")))
            .map_err(|err| format!("failed to create node stdout log: {err}"))?;
        let stderr = std::fs::File::create(log_dir.join(format!("{requested_node_id}.err.log")))
            .map_err(|err| format!("failed to create node stderr log: {err}"))?;

        let mut argv = vec![
            "-m".to_string(),
            "workflow_cli".to_string(),
            "node".to_string(),
            "--node-id".to_string(),
            requested_node_id.to_string(),
            "--nats-url".to_string(),
            request.nats_url.clone(),
            "--peer-device-label".to_string(),
            request
                .device_label
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| requested_node_id.to_string()),
            "--peer-device-tags".to_string(),
            request
                .device_tags
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "desktop,tauri,local".to_string()),
            "--peer-capabilities".to_string(),
            request
                .capabilities
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "echo-client,interactive-file-stream".to_string()),
        ];
        if request.enable_pi.unwrap_or(false) {
            argv.push("--enable-pi".to_string());
        }
        push_optional(&mut argv, "--pi-cli", request.pi_cli);
        push_optional(&mut argv, "--pi-model", request.pi_model);
        push_optional(&mut argv, "--pi-provider", request.pi_provider);
        push_optional(&mut argv, "--pi-cwd", request.pi_cwd);

        let child = Command::new(python)
            .args(&argv)
            .current_dir(&workspace_dir)
            .env("PYTHONPATH", repo_root.join("src"))
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn_with_path()
            .map_err(|err| format!("failed to start local peer node with {python}: {err}"))?;
        self.node = Some(child);
        self.node_id = Some(requested_node_id.to_string());
        self.nats_url = Some(request.nats_url);
        self.last_node_exit_code = None;
        self.last_message = "Started local AgSwarm peer node.".to_string();
        Ok(())
    }

    fn status(&self) -> LocalPeerStatus {
        LocalPeerStatus {
            ok: self.node.is_some() && self.last_node_exit_code.is_none(),
            node_id: self.node_id.clone(),
            nats_url: self.nats_url.clone(),
            node_running: self.node.is_some() && self.last_node_exit_code.is_none(),
            nats_running: self.nats.is_some() && self.last_nats_exit_code.is_none(),
            nats_managed: self.nats.is_some(),
            message: self.last_message.clone(),
            node_exit_code: self.last_node_exit_code,
            nats_exit_code: self.last_nats_exit_code,
        }
    }

    fn reap_finished(&mut self) {
        if let Some(child) = self.node.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                self.last_node_exit_code = Some(status.code().unwrap_or(-1));
                self.node = None;
                self.last_message = format!(
                    "Local peer node exited with code {}.",
                    self.last_node_exit_code.unwrap_or(-1)
                );
            }
        }
        if let Some(child) = self.nats.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                self.last_nats_exit_code = Some(status.code().unwrap_or(-1));
                self.nats = None;
            }
        }
    }

    fn stop_node(&mut self) {
        if let Some(mut child) = self.node.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.last_message = "Stopped local AgSwarm peer node.".to_string();
    }

    fn stop_nats(&mut self) {
        if let Some(mut child) = self.nats.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl ManagedPiWeb {
    fn ensure_started(&mut self, app: &tauri::AppHandle, repo_root: &Path) -> Result<(), String> {
        if tcp_port_open("127.0.0.1:8504") {
            if pi_web_runtime_healthy("127.0.0.1:8504") {
                self.port = Some(8504);
                self.last_message = "Using healthy pi-web server on 127.0.0.1:8504.".to_string();
                return Ok(());
            }
            stop_stale_pi_web_processes(repo_root);
            wait_for_tcp_port_closed("127.0.0.1:8504", Duration::from_secs(2))?;
        }
        if self.server_running() && self.sessiond_running() {
            wait_for_pi_web_runtime("127.0.0.1:8504", Duration::from_secs(30))?;
            self.last_message = "Ag runtime is ready on 127.0.0.1:8504.".to_string();
            return Ok(());
        }

        self.stop();
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("failed to resolve AgSwarm app data dir: {err}"))?;
        let workspace_dir = default_workspace_dir(app)?;
        let node = find_node_runtime(app, repo_root)
            .ok_or_else(|| "node runtime was not found; install Node.js >=22 or bundle a Node sidecar before starting pi-web.".to_string())?;
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|err| format!("failed to resolve app resource dir: {err}"))?;
        let packaged_runtime_dir = ensure_packaged_pi_web_runtime(app, repo_root, &resource_dir)?;
        let package_dir = resolve_pi_web_package_dir(app, repo_root, packaged_runtime_dir.as_deref())?;
        let server_entry = resolve_pi_web_server_entry(app, repo_root, &resource_dir)?;
        let sessiond_entry = package_dir.join("dist").join("server").join("sessiond.js");
        if !sessiond_entry.is_file() || !server_entry.is_file() {
            return Err(format!(
                "pi-web package is incomplete at {}; expected sessiond and AgSwarm pi-web server entry.",
                package_dir.to_string_lossy()
            ));
        }

        let log_dir = app_data_dir.join("logs").join("tauri-peer");
        fs::create_dir_all(&log_dir)
            .map_err(|err| format!("failed to create pi-web log dir: {err}"))?;
        let data_dir = app_data_dir.join("pi-web");
        fs::create_dir_all(&data_dir)
            .map_err(|err| format!("failed to create pi-web data dir: {err}"))?;
        let sessiond_endpoint = PiWebSessiondEndpoint::new(&data_dir)?;

        let sessiond_stdout = fs::File::create(log_dir.join("pi-web-sessiond.out.log"))
            .map_err(|err| format!("failed to create pi-web sessiond stdout log: {err}"))?;
        let sessiond_stderr = fs::File::create(log_dir.join("pi-web-sessiond.err.log"))
            .map_err(|err| format!("failed to create pi-web sessiond stderr log: {err}"))?;
        let sessiond = Command::new(&node)
            .arg(&sessiond_entry)
            .current_dir(&workspace_dir)
            .env("PI_WEB_PACKAGE_DIR", &package_dir)
            .envs(pi_web_runtime_env(packaged_runtime_dir.as_deref()))
            .env("PI_WEB_DATA_DIR", &data_dir)
            .env("PI_CODING_AGENT_DIR", pi_coding_agent_dir())
            .env("PI_CODING_AGENT_SESSION_DIR", data_dir.join("sessions"))
            .stdout(Stdio::from(sessiond_stdout))
            .stderr(Stdio::from(sessiond_stderr))
            .with_pi_web_sessiond_endpoint(&sessiond_endpoint, PiWebProcessRole::Sessiond)
            .spawn_with_path()
            .map_err(|err| format!("failed to start pi-web session daemon with {node}: {err}"))?;
        self.sessiond = Some(sessiond);
        self.sessiond_port = sessiond_endpoint.port();
        self.last_sessiond_exit_code = None;

        let server_stdout = fs::File::create(log_dir.join("pi-web-server.out.log"))
            .map_err(|err| format!("failed to create pi-web server stdout log: {err}"))?;
        let server_stderr = fs::File::create(log_dir.join("pi-web-server.err.log"))
            .map_err(|err| format!("failed to create pi-web server stderr log: {err}"))?;
        let server = Command::new(&node)
            .arg(&server_entry)
            .current_dir(&workspace_dir)
            .env("PI_WEB_PACKAGE_DIR", &package_dir)
            .envs(pi_web_runtime_env(packaged_runtime_dir.as_deref()))
            .env("PI_WEB_HOST", "127.0.0.1")
            .env("PI_WEB_PORT", "8504")
            .env("PI_WEB_DATA_DIR", &data_dir)
            .env("PI_CODING_AGENT_DIR", pi_coding_agent_dir())
            .env("PI_CODING_AGENT_SESSION_DIR", data_dir.join("sessions"))
            .stdout(Stdio::from(server_stdout))
            .stderr(Stdio::from(server_stderr))
            .with_pi_web_sessiond_endpoint(&sessiond_endpoint, PiWebProcessRole::Web)
            .spawn_with_path()
            .map_err(|err| format!("failed to start pi-web server with {node}: {err}"))?;
        self.server = Some(server);
        self.port = Some(8504);
        self.data_dir = Some(data_dir);
        self.last_server_exit_code = None;

        wait_for_pi_web_runtime("127.0.0.1:8504", Duration::from_secs(30))?;
        self.last_message = format!(
            "Started Ag runtime on 127.0.0.1:8504 with workspace {}.",
            workspace_dir.to_string_lossy()
        );
        Ok(())
    }

    fn status(&self) -> PiWebStatus {
        let running = self.server.is_some() && self.last_server_exit_code.is_none();
        PiWebStatus {
            ok: running && self.last_sessiond_exit_code.is_none(),
            running,
            url: "http://127.0.0.1:8504".to_string(),
            port: 8504,
            message: self.last_message.clone(),
            server_exit_code: self.last_server_exit_code,
            sessiond_exit_code: self.last_sessiond_exit_code,
        }
    }

    fn reap_finished(&mut self) {
        if let Some(child) = self.server.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                self.last_server_exit_code = Some(status.code().unwrap_or(-1));
                self.server = None;
                self.last_message = format!(
                    "pi-web server exited with code {}. Check tmp/tauri-peer/pi-web-server.err.log.",
                    self.last_server_exit_code.unwrap_or(-1)
                );
            }
        }
        if let Some(child) = self.sessiond.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                self.last_sessiond_exit_code = Some(status.code().unwrap_or(-1));
                self.sessiond = None;
                if self.server.is_none() {
                    self.last_message = format!(
                        "pi-web session daemon exited with code {}. Check tmp/tauri-peer/pi-web-sessiond.err.log.",
                        self.last_sessiond_exit_code.unwrap_or(-1)
                    );
                }
            }
        }
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.server.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(mut child) = self.sessiond.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn server_running(&mut self) -> bool {
        self.server
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none())
    }

    fn sessiond_running(&mut self) -> bool {
        self.sessiond
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none())
    }
}

fn push_common(argv: &mut Vec<String>, request: &CliRequest) {
    argv.push("--nats-url".to_string());
    argv.push(request.nats_url.clone());
    argv.push("--node-id".to_string());
    argv.push(
        request
            .node_id
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "node-a".to_string()),
    );
}

fn push_optional(argv: &mut Vec<String>, flag: &str, value: Option<String>) {
    if let Some(value) = value.filter(|item| !item.trim().is_empty()) {
        argv.push(flag.to_string());
        argv.push(value);
    }
}

fn push_required(
    argv: &mut Vec<String>,
    flag: &str,
    value: Option<String>,
    field_name: &str,
) -> Result<(), String> {
    let value = value
        .filter(|item| !item.trim().is_empty())
        .ok_or_else(|| format!("{field_name} is required for this command"))?;
    argv.push(flag.to_string());
    argv.push(value);
    Ok(())
}

struct LatexSource {
    workspace: Option<String>,
    main_tex: Option<String>,
}

fn resolve_latex_source(_repo_root: &Path, request: &CliRequest) -> Result<LatexSource, String> {
    if request
        .source_text
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        let dir = std::env::temp_dir().join("agswarm-client").join("tauri-latex");
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("failed to create temporary LaTeX workspace: {err}"))?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| format!("failed to build timestamp: {err}"))?
            .as_millis();
        let main_tex = format!("agswarm-{stamp}.tex");
        std::fs::write(
            dir.join(&main_tex),
            request.source_text.clone().unwrap_or_default(),
        )
        .map_err(|err| format!("failed to write temporary LaTeX source: {err}"))?;
        return Ok(LatexSource {
            workspace: Some(dir.to_string_lossy().to_string()),
            main_tex: Some(main_tex),
        });
    }
    Ok(LatexSource {
        workspace: request.workspace.clone(),
        main_tex: request.main_tex.clone(),
    })
}

fn repo_root() -> Result<PathBuf, String> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "failed to resolve repository root".to_string())
}

fn default_workspace_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .home_dir()
        .map_err(|err| format!("failed to resolve home directory for AgSwarm workspace: {err}"))?;
    let dir = base.join("AgSwarm");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create default AgSwarm workspace: {err}"))?;
    Ok(dir)
}

fn python_path(repo_root: &Path) -> String {
    if let Ok(value) = std::env::var("AGSWARM_PYTHON") {
        if !value.trim().is_empty() {
            return value;
        }
    }
    let venv_python = repo_root.join(".venv").join("bin").join("python");
    if venv_python.is_file() {
        return venv_python.to_string_lossy().to_string();
    }
    "python3".to_string()
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    configure_child_env(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn is_loopback_nats(nats_url: &str) -> bool {
    nats_url.contains("127.0.0.1:4222") || nats_url.contains("localhost:4222")
}

fn tcp_port_open(addr: &str) -> bool {
    std::net::TcpStream::connect_timeout(
        &addr
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:4222".parse().unwrap()),
        std::time::Duration::from_millis(150),
    )
    .is_ok()
}

fn pi_web_runtime_healthy(addr: &str) -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    else {
        return false;
    };
    let Ok(response) = client
        .get(format!("http://{addr}/api/machines/local/runtime"))
        .send()
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(payload) = response.json::<Value>() else {
        return false;
    };
    let sessiond_available = payload
        .pointer("/components/sessiond/available")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    payload.get("ok").and_then(Value::as_bool).unwrap_or(false) && sessiond_available
}

fn find_nats_server() -> Option<String> {
    if let Ok(value) = std::env::var("NATS_SERVER") {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }
    for candidate in [
        "/opt/homebrew/bin/nats-server",
        "/opt/homebrew/opt/nats-server/bin/nats-server",
        "/usr/local/bin/nats-server",
        "/usr/local/opt/nats-server/bin/nats-server",
    ] {
        if Path::new(candidate).is_file() {
            return Some(candidate.to_string());
        }
    }
    Some("nats-server".to_string()).filter(|command| {
        let mut cmd = Command::new(command);
        cmd.arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_child_env(&mut cmd);
        cmd.status().is_ok()
    })
}

fn find_node_runtime(app: &tauri::AppHandle, repo_root: &Path) -> Option<String> {
    if let Some(value) = env_non_empty("AGSWARM_NODE") {
        return Some(value);
    }
    for binary_name in node_binary_names() {
        #[cfg(debug_assertions)]
        {
            let candidate = repo_root
                .join("desktop")
                .join("src-tauri")
                .join("binaries")
                .join(&binary_name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            for candidate in [
                resource_dir.join(&binary_name),
                resource_dir.join("binaries").join(&binary_name),
            ] {
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(exe_dir) = current_exe.parent() {
                for candidate in [
                    exe_dir.join(&binary_name),
                    exe_dir.join("binaries").join(&binary_name),
                ] {
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
                if let Some(contents_dir) = exe_dir.parent() {
                    for candidate in [
                        contents_dir.join("Resources").join(&binary_name),
                        contents_dir.join("Resources").join("binaries").join(&binary_name),
                    ] {
                        if candidate.is_file() {
                            return Some(candidate.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
        let candidate = repo_root
            .join("desktop")
            .join("src-tauri")
            .join("binaries")
            .join(&binary_name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    for candidate in [
        "/opt/homebrew/bin/node",
        "/opt/homebrew/opt/node/bin/node",
        "/usr/local/bin/node",
        "/usr/local/opt/node/bin/node",
        "/usr/bin/node",
    ] {
        if Path::new(candidate).is_file() {
            return Some(candidate.to_string());
        }
    }
    Some("node".to_string()).filter(|command| {
        let mut cmd = Command::new(command);
        cmd.arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_child_env(&mut cmd);
        cmd.status().is_ok()
    })
}

fn node_binary_names() -> Vec<String> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        std::env::consts::ARCH
    };
    vec![format!("node{suffix}"), format!("node-{triple}{suffix}")]
}

fn resolve_pi_web_package_dir(
    app: &tauri::AppHandle,
    repo_root: &Path,
    packaged_runtime_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = env_non_empty("PI_WEB_PACKAGE_DIR") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(runtime_dir) = packaged_runtime_dir {
        candidates.push(runtime_dir.join("node_modules").join("@jmfederico").join("pi-web"));
    }
    #[cfg(debug_assertions)]
    {
        candidates.push(
            repo_root
                .join("desktop")
                .join("src-tauri")
                .join("binaries")
                .join("runtime-node")
                .join("node_modules")
                .join("@jmfederico")
                .join("pi-web"),
        );
        candidates.push(
            repo_root
                .join("desktop")
                .join("src-tauri")
                .join("binaries")
                .join("pi-web-package"),
        );
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("pi-web-package"));
        candidates.push(resource_dir.join("binaries").join("pi-web-package"));
        candidates.push(resource_dir.join("binaries").join("runtime-node").join("node_modules").join("@jmfederico").join("pi-web"));
        candidates.push(resource_dir.join("binaries").join("node_modules").join("@jmfederico").join("pi-web"));
        candidates.push(resource_dir.join("_up_").join("node_modules").join("@jmfederico").join("pi-web"));
        candidates.push(resource_dir.join("node_modules").join("@jmfederico").join("pi-web"));
        candidates.push(resource_dir.join("pi-web"));
        candidates.push(resource_dir.join("binaries").join("pi-web"));
    }
    if let Some(runtime_dir) = packaged_pi_web_runtime_dir(app) {
        candidates.push(runtime_dir.join("node_modules").join("@jmfederico").join("pi-web"));
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("pi-web-package"));
            candidates.push(exe_dir.join("binaries").join("pi-web-package"));
            if let Some(contents_dir) = exe_dir.parent() {
                candidates.push(contents_dir.join("Resources").join("pi-web-package"));
                candidates.push(contents_dir.join("Resources").join("binaries").join("pi-web-package"));
                candidates.push(
                    contents_dir
                        .join("Resources")
                        .join("binaries")
                        .join("runtime-node")
                        .join("node_modules")
                        .join("@jmfederico")
                        .join("pi-web"),
                );
            }
        }
    }
    candidates.push(
        repo_root
            .join("desktop")
            .join("src-tauri")
            .join("binaries")
            .join("pi-web-package"),
    );
    candidates.push(
        repo_root
            .join("desktop")
            .join("src-tauri")
            .join("binaries")
            .join("runtime-node")
            .join("node_modules")
            .join("@jmfederico")
            .join("pi-web"),
    );
    candidates.push(
        repo_root
            .join("desktop")
            .join("src-tauri")
            .join("binaries")
            .join("node_modules")
            .join("@jmfederico")
            .join("pi-web"),
    );
    candidates.push(
        repo_root
            .join("desktop")
            .join("node_modules")
            .join("@jmfederico")
            .join("pi-web"),
    );
    candidates.push(
        repo_root
            .join("node_modules")
            .join("@jmfederico")
            .join("pi-web"),
    );

    for candidate in candidates {
        if candidate.join("dist").join("server").join("index.js").is_file()
            && candidate
                .join("dist")
                .join("server")
                .join("sessiond.js")
                .is_file()
        {
            return Ok(candidate);
        }
    }
    Err("Ag runtime package was not found. Restart the app or reinstall AgSwarm Client.".to_string())
}

fn resolve_pi_web_server_entry(
    app: &tauri::AppHandle,
    repo_root: &Path,
    resource_dir: &Path,
) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = env_non_empty("AGSWARM_PI_WEB_SERVER") {
        candidates.push(PathBuf::from(path));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        repo_root
            .join("desktop")
            .join("src-tauri")
            .join("binaries")
            .join("pi-web-agswarm-server.mjs"),
    );
    candidates.push(resource_dir.join("binaries").join("pi-web-agswarm-server.mjs"));
    candidates.push(resource_dir.join("pi-web-agswarm-server.mjs"));
    if let Ok(app_resource_dir) = app.path().resource_dir() {
        candidates.push(app_resource_dir.join("binaries").join("pi-web-agswarm-server.mjs"));
    }
    candidates.push(
        repo_root
            .join("desktop")
            .join("src-tauri")
            .join("binaries")
            .join("pi-web-agswarm-server.mjs"),
    );
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Ok(resolve_pi_web_package_dir(app, repo_root, None)?
        .join("dist")
        .join("server")
        .join("index.js"))
}

fn pi_web_runtime_env(runtime_dir: Option<&Path>) -> Vec<(&'static str, String)> {
    runtime_dir
        .map(|path| vec![("PI_WEB_RUNTIME_DIR", path.to_string_lossy().to_string())])
        .unwrap_or_default()
}

fn packaged_pi_web_runtime_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("runtime").join("runtime-node"))
}

fn ensure_packaged_pi_web_runtime(
    app: &tauri::AppHandle,
    repo_root: &Path,
    resource_dir: &Path,
) -> Result<Option<PathBuf>, String> {
    let archive = packaged_pi_web_runtime_archive(app, repo_root, resource_dir);
    let Some(archive) = archive else {
        return Ok(None);
    };
    let Some(runtime_dir) = packaged_pi_web_runtime_dir(app) else {
        return Ok(None);
    };
    let package_dir = runtime_dir
        .join("node_modules")
        .join("@jmfederico")
        .join("pi-web");
    let expected_stamp = runtime_archive_stamp(&archive)?;
    let stamp_path = runtime_dir.join(".agswarm-runtime-archive-stamp");
    if package_dir.join("dist").join("server").join("sessiond.js").is_file()
        && package_dir.join("dist").join("server").join("app.js").is_file()
        && fs::read_to_string(&stamp_path)
            .map(|value| value == expected_stamp)
            .unwrap_or(false)
    {
        return Ok(Some(runtime_dir));
    }

    let runtime_root = runtime_dir
        .parent()
        .ok_or_else(|| "failed to resolve Ag runtime extraction root".to_string())?
        .to_path_buf();
    if runtime_root.exists() {
        fs::remove_dir_all(&runtime_root)
            .map_err(|err| format!("failed to reset bundled Ag runtime: {err}"))?;
    }
    fs::create_dir_all(&runtime_root)
        .map_err(|err| format!("failed to create bundled Ag runtime dir: {err}"))?;
    unzip_archive(&archive, &runtime_root)?;

    if !package_dir.join("dist").join("server").join("sessiond.js").is_file() {
        return Err("bundled Ag runtime archive did not contain a usable runtime.".to_string());
    }
    fs::write(&stamp_path, expected_stamp)
        .map_err(|err| format!("failed to write bundled Ag runtime stamp: {err}"))?;
    Ok(Some(runtime_dir))
}

fn runtime_archive_stamp(archive: &Path) -> Result<String, String> {
    let metadata = fs::metadata(archive)
        .map_err(|err| format!("failed to read bundled Ag runtime archive metadata: {err}"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    Ok(format!("{}:{modified}", metadata.len()))
}

fn packaged_pi_web_runtime_archive(
    app: &tauri::AppHandle,
    repo_root: &Path,
    resource_dir: &Path,
) -> Option<PathBuf> {
    let mut candidates = vec![
        resource_dir.join("binaries").join("runtime-node.zip"),
        resource_dir.join("runtime-node.zip"),
        repo_root
            .join("desktop")
            .join("src-tauri")
            .join("binaries")
            .join("runtime-node.zip"),
    ];
    if let Ok(app_resource_dir) = app.path().resource_dir() {
        candidates.push(app_resource_dir.join("binaries").join("runtime-node.zip"));
        candidates.push(app_resource_dir.join("runtime-node.zip"));
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("binaries").join("runtime-node.zip"));
            if let Some(contents_dir) = exe_dir.parent() {
                candidates.push(contents_dir.join("Resources").join("binaries").join("runtime-node.zip"));
            }
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn unzip_archive(archive: &Path, destination: &Path) -> Result<(), String> {
    validate_zip_archive(archive)?;
    let file = fs::File::open(archive)
        .map_err(|err| format!("failed to open bundled Ag runtime archive: {err}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| format!("failed to read bundled Ag runtime archive: {err}"))?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("failed to read bundled Ag runtime entry: {err}"))?;
        let Some(enclosed_name) = file.enclosed_name() else {
            continue;
        };
        let outpath = destination.join(enclosed_name);
        if file.is_dir() {
            fs::create_dir_all(&outpath)
                .map_err(|err| format!("failed to create bundled Ag runtime dir: {err}"))?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("failed to create bundled Ag runtime parent: {err}"))?;
        }
        let mut outfile = fs::File::create(&outpath)
            .map_err(|err| format!("failed to write bundled Ag runtime file: {err}"))?;
        std::io::copy(&mut file, &mut outfile)
            .map_err(|err| format!("failed to extract bundled Ag runtime file: {err}"))?;
    }
    Ok(())
}

fn validate_zip_archive(archive: &Path) -> Result<(), String> {
    let bytes = fs::read(archive)
        .map_err(|err| format!("failed to read bundled Ag runtime archive: {err}"))?;
    if bytes.len() < 22
        || !bytes.starts_with(b"PK")
        || !bytes
            .windows(4)
            .rev()
            .any(|window| window == [0x50, 0x4b, 0x05, 0x06])
    {
        return Err(format!(
            "bundled Ag runtime archive is invalid at {}; reinstall AgSwarm Client with a fresh installer.",
            archive.to_string_lossy()
        ));
    }
    Ok(())
}

fn pi_coding_agent_dir() -> String {
    if let Some(value) = env_non_empty("PI_CODING_AGENT_DIR") {
        return value;
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".pi")
            .join("agent")
            .to_string_lossy()
            .to_string();
    }
    ".pi/agent".to_string()
}

fn wait_for_tcp_port_closed(addr: &str, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if !tcp_port_open(addr) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    Err(format!(
        "stale pi-web is still listening at {addr}; quit the old AgSwarm Client or stop the old pi-web process."
    ))
}

fn wait_for_pi_web_runtime(addr: &str, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if pi_web_runtime_healthy(addr) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(160));
    }
    Err(format!(
        "Ag runtime did not become healthy at {addr}; check the app data logs for pi-web-server.err.log and pi-web-sessiond.err.log."
    ))
}

struct TimedCommandOutput {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    truncated: bool,
}

fn normalize_desktop_tool(value: &str) -> Result<&'static str, String> {
    match value {
        "workspace_info" | "shell" | "python" => Ok(match value {
            "workspace_info" => "workspace_info",
            "shell" => "shell",
            _ => "python",
        }),
        _ => Err("unsupported desktop agent tool".to_string()),
    }
}

fn stop_stale_node_processes(repo_root: &Path, node_id: &str) {
    let repo = repo_root.to_string_lossy().to_string();
    let Ok(output) = Command::new("pgrep")
        .args(["-fl", "workflow_cli node"])
        .output()
    else {
        return;
    };
    let Ok(text) = String::from_utf8(output.stdout) else {
        return;
    };
    for line in text.lines() {
        let mut parts = line.splitn(2, ' ');
        let Some(pid_text) = parts.next() else {
            continue;
        };
        let Some(command_text) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_text.parse::<i32>() else {
            continue;
        };
        if command_text.contains(&repo)
            && command_text.contains("-m workflow_cli node")
            && command_text.contains("--node-id")
            && command_text.contains(node_id)
        {
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .output();
        }
    }
}

fn stop_stale_pi_web_processes(repo_root: &Path) {
    let repo = repo_root.to_string_lossy().to_string();
    let Ok(output) = Command::new("pgrep")
        .args(["-fl", "pi-web"])
        .output()
    else {
        return;
    };
    let Ok(text) = String::from_utf8(output.stdout) else {
        return;
    };
    for line in text.lines() {
        let mut parts = line.splitn(2, ' ');
        let Some(pid_text) = parts.next() else {
            continue;
        };
        let Some(command_text) = parts.next() else {
            continue;
        };
        let Ok(pid) = pid_text.parse::<i32>() else {
            continue;
        };
        if command_text.contains(&repo)
            && (command_text.contains("pi-web-agswarm-server.mjs")
                || command_text.contains("server/sessiond.js"))
        {
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .output();
        }
    }
}

fn resolve_workspace_root(repo_root: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    let Some(value) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(repo_root.to_path_buf());
    };
    let candidate = PathBuf::from(value);
    let path = if candidate.is_absolute() {
        candidate
    } else {
        repo_root.join(candidate)
    };
    let normalized = normalize_path(&path);
    if !normalized.is_dir() {
        return Err(format!(
            "configured host working directory does not exist: {}",
            normalized.to_string_lossy()
        ));
    }
    Ok(normalized)
}

fn resolve_tool_cwd(workspace_root: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    let cwd = match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => workspace_root.join(value),
        None => workspace_root.to_path_buf(),
    };
    let normalized = normalize_path(&cwd);
    let root = normalize_path(workspace_root);
    if normalized != root && !normalized.starts_with(&root) {
        return Err("cwd must stay inside the configured host working directory".to_string());
    }
    Ok(normalized)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn write_temp_python_script(_repo_root: &Path, script: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("agswarm-client").join("desktop-agent");
    fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create desktop agent temp dir: {err}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("failed to build timestamp: {err}"))?
        .as_millis();
    let path = dir.join(format!("tool-{stamp}.py"));
    let mut file = fs::File::create(&path)
        .map_err(|err| format!("failed to create temporary python script: {err}"))?;
    writeln!(file, "{}", script.trim())
        .map_err(|err| format!("failed to write temporary python script: {err}"))?;
    Ok(path)
}

fn assert_allowed_shell_command(command: &str) -> Result<(), String> {
    let lower = command.to_lowercase();
    for pattern in [
        "rm -rf /",
        "sudo ",
        "mkfs",
        "diskutil erase",
        "dd if=",
        ":(){",
        "chmod -r 777 /",
    ] {
        if lower.contains(pattern) {
            return Err("command blocked by desktop agent safety policy".to_string());
        }
    }
    Ok(())
}

fn run_command_with_timeout(
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    timeout: Duration,
) -> Result<TimedCommandOutput, String> {
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_child_env(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to start desktop tool {program}: {err}"))?;
    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|err| format!("failed to poll desktop tool: {err}"))?
            .is_some()
        {
            let output = child
                .wait_with_output()
                .map_err(|err| format!("failed to read desktop tool output: {err}"))?;
            return Ok(build_timed_output(output, false));
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|err| format!("failed to read timed-out desktop tool output: {err}"))?;
            return Ok(build_timed_output(output, true));
        }
        std::thread::sleep(Duration::from_millis(35));
    }
}

fn build_timed_output(output: std::process::Output, timed_out: bool) -> TimedCommandOutput {
    let stdout_raw = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_raw = String::from_utf8_lossy(&output.stderr).to_string();
    let (stdout, stdout_truncated) = limit_tool_output(stdout_raw);
    let (stderr, stderr_truncated) = limit_tool_output(stderr_raw);
    TimedCommandOutput {
        stdout,
        stderr,
        exit_code: output.status.code(),
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    }
}

fn limit_tool_output(text: String) -> (String, bool) {
    const LIMIT: usize = 24_000;
    if text.len() <= LIMIT {
        return (text, false);
    }
    let mut truncated = text.chars().take(LIMIT).collect::<String>();
    truncated.push_str("\n...[truncated]");
    (truncated, true)
}

trait CommandPathExt {
    fn spawn_with_path(&mut self) -> std::io::Result<Child>;
}

impl CommandPathExt for Command {
    fn spawn_with_path(&mut self) -> std::io::Result<Child> {
        configure_child_env(self);
        self.spawn()
    }
}

fn configure_child_env(command: &mut Command) {
    command.env("PATH", child_path_env());
    if let Some(shell) = child_shell_env() {
        command.env("SHELL", shell);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
}

fn child_shell_env() -> Option<String> {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.trim().is_empty() && Path::new(&shell).is_file() {
            return Some(shell);
        }
    }
    #[cfg(windows)]
    {
        return std::env::var("ComSpec")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| Some("C:\\Windows\\System32\\cmd.exe".to_string()));
    }
    #[cfg(not(windows))]
    {
        for shell in ["/bin/bash", "/bin/zsh", "/bin/sh"] {
            if Path::new(shell).is_file() {
                return Some(shell.to_string());
            }
        }
        None
    }
}

fn child_path_env() -> String {
    let mut paths = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for path in [
            home.join(".nvm").join("current").join("bin"),
            home.join(".fnm")
                .join("aliases")
                .join("default")
                .join("bin"),
            home.join(".asdf").join("shims"),
            home.join(".volta").join("bin"),
        ] {
            if path.is_dir() {
                push_unique_path(&mut paths, &path.to_string_lossy());
            }
        }
    }
    for path in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/opt/homebrew/opt/node/bin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/local/opt/node/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push_unique_path(&mut paths, path);
    }
    if let Ok(existing) = std::env::var("PATH") {
        for path in existing.split(':').filter(|value| !value.trim().is_empty()) {
            push_unique_path(&mut paths, path);
        }
    }
    paths.join(":")
}

fn push_unique_path(paths: &mut Vec<String>, path: &str) {
    if !paths.iter().any(|item| item == path) {
        paths.push(path.to_string());
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PeerManager::default())
        .manage(PiWebManager::default())
        .invoke_handler(tauri::generate_handler![
            agswarm_cli,
            agent_provider_chat,
            desktop_agent_tool,
            start_local_peer,
            stop_local_peer,
            local_peer_status,
            start_pi_web,
            pi_web_status,
            runtime_config,
            system_device_name,
            stage_chat_attachment,
            save_chat_attachment,
            frontend_debug_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running AgSwarm Client");
}
