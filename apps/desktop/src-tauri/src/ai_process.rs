use std::{
    collections::HashMap,
    io::{Read, Write},
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProcessResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
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
    let mut command = Command::new(&request.executable);
    command
        .args(&request.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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

    let output_request_id = request.request_id.clone();
    let output_app = app.clone();
    let stdout_thread =
        thread::spawn(move || read_stream(stdout, output_app, output_request_id, "stdout"));
    let error_request_id = request.request_id.clone();
    let error_app = app;
    let stderr_thread =
        thread::spawn(move || read_stream(stderr, error_app, error_request_id, "stderr"));
    if let Some(mut input) = stdin.take() {
        if let Err(error) = input.write_all(request.stdin.as_bytes()) {
            terminate_child(&mut child);
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err(format!("[ai_process] 写入 AI stdin 失败：{error}"));
        }
        let _ = input.flush();
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
        match child
            .try_wait()
            .map_err(|error| format!("[ai_process] 等待 AI 进程失败：{error}"))?
        {
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
        return Err("[ai_timeout] AI 请求超时".to_owned());
    }
    Ok(AiProcessResult {
        stdout,
        stderr,
        exit_code,
        cancelled,
        timed_out,
    })
}

fn read_stream<R: Read>(
    mut stream: R,
    app: Option<AppHandle>,
    request_id: String,
    stream_name: &str,
) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let length = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if length == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..length]);
        if let Some(app) = app.as_ref() {
            let _ = app.emit(
                "ai:output",
                AiProcessOutputEvent {
                    request_id: request_id.clone(),
                    stream: stream_name.to_owned(),
                    data: String::from_utf8_lossy(&chunk[..length]).into_owned(),
                },
            );
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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
}
