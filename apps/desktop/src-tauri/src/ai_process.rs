use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Owns cancellation flags for the short-lived AI helper processes.  AI
/// processes intentionally live outside the terminal/session managers.
#[derive(Clone, Default)]
pub(crate) struct AiProcessManager {
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProcessRequest {
    pub request_id: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub stdin: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub run_as_administrator: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
    pub timeout_phase: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProcessOutputEvent {
    pub request_id: String,
    pub stream: String,
    pub data: String,
}

impl AiProcessManager {
    pub(crate) fn register(&self, request_id: &str) -> Result<Arc<AtomicBool>, String> {
        if request_id.trim().is_empty() {
            return Err("AI 请求 ID 不能为空".to_owned());
        }
        let token = Arc::new(AtomicBool::new(false));
        let mut active = lock_unpoisoned(&self.cancellations);
        if active.contains_key(request_id) {
            return Err("AI 请求已在运行".to_owned());
        }
        active.insert(request_id.to_owned(), Arc::clone(&token));
        Ok(token)
    }

    pub(crate) fn cancel(&self, request_id: &str) -> bool {
        lock_unpoisoned(&self.cancellations)
            .get(request_id)
            .map(|token| token.store(true, Ordering::Release))
            .is_some()
    }

    pub(crate) fn remove(&self, request_id: &str) {
        lock_unpoisoned(&self.cancellations).remove(request_id);
    }

    pub(crate) fn cancel_all(&self) {
        for token in lock_unpoisoned(&self.cancellations).values() {
            token.store(true, Ordering::Release);
        }
    }

    pub(crate) fn active_count(&self) -> usize {
        lock_unpoisoned(&self.cancellations).len()
    }
}

pub(crate) fn run(
    request: AiProcessRequest,
    cancellation: Arc<AtomicBool>,
    app: Option<AppHandle>,
) -> Result<AiProcessResult, String> {
    if request.executable.trim().is_empty() {
        return Err("[ai_invalid_argument] AI 可执行文件不能为空".to_owned());
    }
    let timeout = Duration::from_millis(request.timeout_ms.clamp(1_000, 600_000));
    if request.run_as_administrator {
        #[cfg(windows)]
        {
            return run_as_administrator(request, cancellation, app, timeout);
        }
        #[cfg(not(windows))]
        {
            return Err("[ai_process] 管理员模式仅支持 Windows".to_owned());
        }
    }
    let mut command = Command::new(&request.executable);
    command
        .args(&request.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    if let Some(cwd) = request
        .cwd
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("[ai_process] 无法启动 AI 进程：{error}"))?;
    process_stage(
        &request.request_id,
        "process_started",
        child.id(),
        request.stdin.len(),
    );
    let mut stdin = child.stdin.take();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err("[ai_process] AI stdout 不可用".to_owned());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_child(&mut child);
            return Err("[ai_process] AI stderr 不可用".to_owned());
        }
    };

    let output_seen = Arc::new(AtomicBool::new(false));
    let output_request_id = request.request_id.clone();
    let output_app = app.clone();
    let output_seen_stdout = Arc::clone(&output_seen);
    let stdout_thread = thread::spawn(move || {
        read_stream(
            stdout,
            output_app,
            output_request_id,
            "stdout",
            output_seen_stdout,
        )
    });
    let error_request_id = request.request_id.clone();
    let error_app = app;
    let output_seen_stderr = Arc::clone(&output_seen);
    let stderr_thread = thread::spawn(move || {
        read_stream(
            stderr,
            error_app,
            error_request_id,
            "stderr",
            output_seen_stderr,
        )
    });
    if let Some(mut input) = stdin.take() {
        process_stage(
            &request.request_id,
            "request_delivery",
            child.id(),
            request.stdin.len(),
        );
        if let Err(error) = input.write_all(request.stdin.as_bytes()) {
            terminate_child(&mut child);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(format!("[ai_process] 写入 AI stdin 失败：{error}"));
        }
        // Drop closes the one-shot request pipe and delivers EOF. There is no
        // interactive READY handshake in this runner.
        drop(input);
        process_stage(
            &request.request_id,
            "stdin_closed_waiting_output",
            child.id(),
            request.stdin.len(),
        );
    }

    let started = Instant::now();
    let mut cancelled = false;
    let mut timed_out = false;
    let exit_code = loop {
        if cancellation.load(Ordering::Acquire) {
            cancelled = true;
            terminate_child(&mut child);
        } else if started.elapsed() >= timeout {
            timed_out = true;
            terminate_child(&mut child);
        }
        let status = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                terminate_child(&mut child);
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return Err(format!("[ai_process] 等待 AI 进程失败：{error}"));
            }
        };
        match status {
            Some(status) => break status.code(),
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    let stdout = stdout_thread
        .join()
        .map_err(|_| "[ai_process] AI stdout worker 异常退出".to_owned())??;
    let stderr = stderr_thread
        .join()
        .map_err(|_| "[ai_process] AI stderr worker 异常退出".to_owned())??;
    if cancelled {
        return Err("[ai_cancelled] AI 请求已停止".to_owned());
    }
    if timed_out {
        process_stage(
            &request.request_id,
            "provider_timeout",
            child.id(),
            request.stdin.len(),
        );
        return Err(timeout_error(output_seen.load(Ordering::Acquire)));
    }
    Ok(AiProcessResult {
        stdout,
        stderr,
        exit_code,
        cancelled,
        timed_out,
        timeout_phase: None,
    })
}

fn read_stream<R: Read>(
    mut stream: R,
    app: Option<AppHandle>,
    request_id: String,
    stream_name: &str,
    output_seen: Arc<AtomicBool>,
) -> Result<String, String> {
    let mut text = String::new();
    let mut decoder = Utf8StreamDecoder::default();
    let mut chunk = [0_u8; 8192];
    loop {
        let length = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if length == 0 {
            break;
        }
        output_seen.store(true, Ordering::Release);
        let decoded = decoder.push(&chunk[..length], false);
        text.push_str(&decoded);
        if let Some(app) = app.as_ref()
            && !decoded.is_empty()
        {
            let _ = app.emit(
                "ai:output",
                AiProcessOutputEvent {
                    request_id: request_id.clone(),
                    stream: stream_name.to_owned(),
                    data: decoded,
                },
            );
        }
    }
    let trailing = decoder.push(&[], true);
    text.push_str(&trailing);
    if let Some(app) = app.as_ref()
        && !trailing.is_empty()
    {
        let _ = app.emit(
            "ai:output",
            AiProcessOutputEvent {
                request_id,
                stream: stream_name.to_owned(),
                data: trailing,
            },
        );
    }
    Ok(text)
}

#[derive(Default)]
struct Utf8StreamDecoder {
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    fn push(&mut self, bytes: &[u8], final_chunk: bool) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(value) => {
                let decoded = value.to_owned();
                self.pending.clear();
                decoded
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                let mut decoded =
                    String::from_utf8_lossy(&self.pending[..valid_up_to]).into_owned();
                if error.error_len().is_none() && !final_chunk {
                    self.pending.drain(..valid_up_to);
                } else {
                    decoded.push_str(&String::from_utf8_lossy(&self.pending[valid_up_to..]));
                    self.pending.clear();
                }
                decoded
            }
        }
    }
}

#[cfg(windows)]
fn run_as_administrator(
    request: AiProcessRequest,
    cancellation: Arc<AtomicBool>,
    app: Option<AppHandle>,
    timeout: Duration,
) -> Result<AiProcessResult, String> {
    let request_suffix = request
        .request_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(48)
        .collect::<String>();
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let directory =
        std::env::temp_dir().join(format!("neterminai-ai-admin-{request_suffix}-{nonce}"));
    fs::create_dir_all(&directory)
        .map_err(|error| format!("[ai_process] 无法创建管理员进程临时目录：{error}"))?;

    let result = run_elevated_process_in_directory(&directory, request, cancellation, app, timeout);
    let _ = fs::remove_dir_all(&directory);
    result
}

#[cfg(windows)]
fn run_elevated_process_in_directory(
    directory: &Path,
    request: AiProcessRequest,
    cancellation: Arc<AtomicBool>,
    app: Option<AppHandle>,
    timeout: Duration,
) -> Result<AiProcessResult, String> {
    let input_path = directory.join("input.json");
    let payload_path = directory.join("payload.json");
    let runner_path = directory.join("runner.ps1");
    let launcher_path = directory.join("launcher.ps1");
    let stdout_path = directory.join("stdout.txt");
    let stderr_path = directory.join("stderr.txt");
    let cancel_path = directory.join("cancel");

    fs::write(&input_path, request.stdin.as_bytes())
        .map_err(|error| format!("[ai_process] 无法写入管理员进程输入：{error}"))?;
    let payload = ElevatedProcessPayload {
        executable: request.executable.clone(),
        arguments: request.args.clone(),
        cwd: request.cwd.clone().unwrap_or_default(),
        input_path: input_path.to_string_lossy().into_owned(),
        stdout_path: stdout_path.to_string_lossy().into_owned(),
        stderr_path: stderr_path.to_string_lossy().into_owned(),
        cancel_path: cancel_path.to_string_lossy().into_owned(),
    };
    let payload_json = serde_json::to_vec(&payload)
        .map_err(|error| format!("[ai_process] 管理员进程参数编码失败：{error}"))?;
    fs::write(&payload_path, payload_json)
        .map_err(|error| format!("[ai_process] 无法写入管理员进程参数：{error}"))?;
    let runner_script = elevated_runner_script(&payload_path);
    fs::write(&runner_path, powershell_script_bytes(&runner_script))
        .map_err(|error| format!("[ai_process] 无法写入管理员进程桥接脚本：{error}"))?;
    let launcher_script = elevated_launcher_script(&runner_path, &request.executable);
    fs::write(&launcher_path, powershell_script_bytes(&launcher_script))
        .map_err(|error| format!("[ai_process] 无法写入管理员启动脚本：{error}"))?;

    let launcher_path = launcher_path
        .to_str()
        .ok_or_else(|| "[ai_process] 管理员启动脚本路径无效".to_owned())?;
    let mut launcher = Command::new("powershell.exe");
    launcher
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            launcher_path,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        launcher.creation_flags(0x0800_0000);
    }
    let mut child = launcher
        .spawn()
        .map_err(|error| format!("[ai_process] 无法启动管理员请求：{error}"))?;
    let mut launcher_stderr = child.stderr.take();
    let started = Instant::now();
    let mut launcher_status = None;
    let mut cancelled = false;
    let mut timed_out = false;

    while launcher_status.is_none() {
        if cancellation.load(Ordering::Acquire) {
            cancelled = true;
            let _ = fs::write(&cancel_path, b"cancelled");
            terminate_child(&mut child);
            break;
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = fs::write(&cancel_path, b"timed out");
            terminate_child(&mut child);
            break;
        }
        match child.try_wait() {
            Ok(status) => launcher_status = status,
            Err(error) => {
                terminate_child(&mut child);
                return Err(format!("[ai_process] 等待管理员进程失败：{error}"));
            }
        }
        if launcher_status.is_none() {
            thread::sleep(Duration::from_millis(20));
        }
    }

    if cancelled {
        return Err("[ai_cancelled] AI 请求已停止".to_owned());
    }
    if timed_out {
        let output_seen = stdout_path
            .metadata()
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
            || stderr_path
                .metadata()
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false);
        return Err(timeout_error(output_seen));
    }

    let launcher_diagnostics = launcher_stderr
        .as_mut()
        .map(|stream| {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).trim().to_owned()
        })
        .unwrap_or_default();
    let status = launcher_status
        .or_else(|| child.wait().ok())
        .ok_or_else(|| "[ai_process] 管理员进程没有返回退出状态".to_owned())?;
    if !stdout_path.exists() || !stderr_path.exists() {
        let detail = if launcher_diagnostics.is_empty() {
            "可能取消了 UAC 授权".to_owned()
        } else {
            launcher_diagnostics
        };
        return Err(format!(
            "[ai_process] 无法以管理员身份启动 PowerShell 脚本：{detail}"
        ));
    }

    let stdout = read_utf8_file(&stdout_path)?;
    let stderr = read_utf8_file(&stderr_path)?;
    if let Some(app) = app.as_ref() {
        emit_process_output(app, &request.request_id, "stdout", &stdout);
        emit_process_output(app, &request.request_id, "stderr", &stderr);
    }
    Ok(AiProcessResult {
        stdout,
        stderr,
        exit_code: status.code(),
        cancelled: false,
        timed_out: false,
        timeout_phase: None,
    })
}

fn timeout_error(output_seen: bool) -> String {
    if output_seen {
        "[ai_timeout] AI 进程等待完成超时（已收到输出，无法仅据此判断启动或推理阶段）".to_owned()
    } else {
        "[ai_timeout] AI 进程等待完成超时（未收到输出；不代表进程尚未启动）".to_owned()
    }
}

fn process_stage(request_id: &str, stage: &str, pid: u32, request_bytes: usize) {
    #[cfg(debug_assertions)]
    eprintln!(
        "[neterminai][ai] request={request_id} stage={stage} pid={pid} request_bytes={request_bytes}"
    );
    #[cfg(not(debug_assertions))]
    let _ = (request_id, stage, pid, request_bytes);
}

#[cfg(windows)]
#[derive(Serialize)]
struct ElevatedProcessPayload {
    executable: String,
    arguments: Vec<String>,
    cwd: String,
    input_path: String,
    stdout_path: String,
    stderr_path: String,
    cancel_path: String,
}

#[cfg(windows)]
fn elevated_launcher_script(runner_path: &Path, executable: &str) -> String {
    let mut script = r#"$ErrorActionPreference = 'Stop'
$runnerPath = '__RUNNER_PATH__'
$executable = '__EXECUTABLE__'
$argumentList = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $runnerPath))
try {
    $started = Start-Process -FilePath $executable -Verb RunAs -WindowStyle Hidden -ArgumentList $argumentList -Wait -PassThru
    exit $started.ExitCode
} catch {
    Write-Error ($_ | Out-String)
    exit 1
}
"#
    .to_owned();
    script = script.replace(
        "__RUNNER_PATH__",
        &powershell_literal(&runner_path.to_string_lossy()),
    );
    script.replace("__EXECUTABLE__", &powershell_literal(executable))
}

#[cfg(windows)]
fn elevated_runner_script(payload_path: &Path) -> String {
    let script = r#"$ErrorActionPreference = 'Stop'
$payloadPath = '__PAYLOAD_PATH__'
$utf8 = [System.Text.UTF8Encoding]::new($false)
try {
    $payload = [System.IO.File]::ReadAllText($payloadPath, $utf8) | ConvertFrom-Json
    if (Test-Path -LiteralPath ([string]$payload.cancelPath)) { exit 1223 }
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = [string]$payload.executable
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardInputEncoding = $utf8
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8
    if (-not [string]::IsNullOrWhiteSpace([string]$payload.cwd)) {
        $psi.WorkingDirectory = [string]$payload.cwd
    }
    foreach ($argument in @($payload.arguments)) {
        [void]$psi.ArgumentList.Add([string]$argument)
    }
    $process = [System.Diagnostics.Process]::Start($psi)
    $input = [System.IO.File]::ReadAllText([string]$payload.inputPath, $utf8)
    $process.StandardInput.Write($input)
    $process.StandardInput.Close()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $cancelled = $false
    while (-not $process.HasExited) {
        if (Test-Path -LiteralPath ([string]$payload.cancelPath)) {
            $cancelled = $true
            try { $process.Kill($true) } catch {}
            break
        }
        Start-Sleep -Milliseconds 40
    }
    $process.WaitForExit()
    [System.IO.File]::WriteAllText([string]$payload.stdoutPath, $stdoutTask.GetAwaiter().GetResult(), $utf8)
    [System.IO.File]::WriteAllText([string]$payload.stderrPath, $stderrTask.GetAwaiter().GetResult(), $utf8)
    if ($cancelled) { exit 1223 }
    exit $process.ExitCode
} catch {
    try { [System.IO.File]::WriteAllText([string]$payload.stderrPath, ($_ | Out-String), $utf8) } catch {}
    exit 1
}
"#;
    script.replace(
        "__PAYLOAD_PATH__",
        &powershell_literal(&payload_path.to_string_lossy()),
    )
}

#[cfg(windows)]
fn powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(windows)]
fn powershell_script_bytes(script: &str) -> Vec<u8> {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(script.as_bytes());
    bytes
}

#[cfg(windows)]
fn read_utf8_file(path: &PathBuf) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|error| format!("[ai_process] 无法读取 AI 输出：{error}"))
}

#[cfg(windows)]
fn emit_process_output(app: &AppHandle, request_id: &str, stream: &str, data: &str) {
    if data.is_empty() {
        return;
    }
    let _ = app.emit(
        "ai:output",
        AiProcessOutputEvent {
            request_id: request_id.to_owned(),
            stream: stream.to_owned(),
            data: data.to_owned(),
        },
    );
}

fn terminate_child(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_are_unique_while_running_and_cancel_all_is_bounded() {
        let manager = AiProcessManager::default();
        let first = manager.register("r1").expect("first request");
        assert!(manager.register("r1").is_err());
        assert_eq!(manager.active_count(), 1);
        manager.cancel_all();
        assert!(first.load(Ordering::Acquire));
        manager.remove("r1");
        assert_eq!(manager.active_count(), 0);
    }

    #[test]
    fn utf8_decoder_keeps_multibyte_characters_together_across_reads() {
        let mut decoder = Utf8StreamDecoder::default();
        assert_eq!(decoder.push("中".as_bytes().get(..1).unwrap(), false), "");
        assert_eq!(decoder.push("中".as_bytes().get(1..).unwrap(), false), "中");
        assert_eq!(decoder.push("文".as_bytes(), true), "文");
    }
}
