use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::{serial::SerialManager, telnet::TelnetManager, terminal::TerminalManager};

const STATUS_EVENT: &str = "automation:status";
const SEND_PREFIX: &str = "__NETERMINAI_AUTOMATION_SEND__";
const ACK_PREFIX: &str = "__NETERMINAI_AUTOMATION_ACK__";
const MAX_SCRIPT_BYTES: usize = 512 * 1024;
const MAX_TARGETS: usize = 64;
const MAX_COMMAND_BYTES: usize = 64 * 1024;
const SHUTDOWN_POLL: Duration = Duration::from_millis(20);

const PYTHON_BOOTSTRAP: &str = r#"
import json
import pathlib
import sys
import time
import traceback

SEND_PREFIX = "__NETERMINAI_AUTOMATION_SEND__"
ACK_PREFIX = "__NETERMINAI_AUTOMATION_ACK__"

def send(command):
    if not isinstance(command, str):
        command = str(command)
    sys.stdout.write(SEND_PREFIX + json.dumps({"command": command}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("终端自动化已停止")
        if line.startswith(ACK_PREFIX):
            try:
                response = json.loads(line[len(ACK_PREFIX):])
            except json.JSONDecodeError as error:
                raise RuntimeError("终端自动化主机响应无效") from error
            if not response.get("ok"):
                raise RuntimeError(response.get("error") or "终端输入失败")
            return None

source_path = pathlib.Path(sys.argv[1])
source = source_path.read_text(encoding="utf-8")
scope = {"__name__": "__main__", "send": send, "time": time}
try:
    exec(compile(source, str(source_path), "exec"), scope, scope)
except BaseException:
    traceback.print_exc(file=sys.stderr)
    raise
"#;

#[derive(Clone, Default)]
pub(crate) struct AutomationManager {
    inner: Arc<AutomationManagerInner>,
}

struct AutomationManagerInner {
    runs: Mutex<HashMap<String, Arc<AutomationRunRecord>>>,
}

struct AutomationRunRecord {
    control: Arc<AutomationRunControl>,
    done: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
}

struct AutomationRunControl {
    cancelled: AtomicBool,
    child_pids: Mutex<HashSet<u32>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRunRequest {
    pub run_id: String,
    pub script_id: String,
    pub code: String,
    pub targets: Vec<AutomationTargetRequest>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationTargetRequest {
    pub tab_id: String,
    pub session_id: Option<String>,
    pub connection_type: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationStatusEvent {
    run_id: String,
    script_id: String,
    tab_id: String,
    session_id: Option<String>,
    status: &'static str,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SendMessage {
    command: String,
}

impl Default for AutomationManagerInner {
    fn default() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
        }
    }
}

impl AutomationManager {
    pub(crate) fn start(
        &self,
        app: AppHandle,
        request: AutomationRunRequest,
    ) -> Result<(), String> {
        validate_request(&request)?;
        self.reap_finished();

        let control = Arc::new(AutomationRunControl {
            cancelled: AtomicBool::new(false),
            child_pids: Mutex::new(HashSet::new()),
        });
        let record = Arc::new(AutomationRunRecord {
            control: Arc::clone(&control),
            done: AtomicBool::new(false),
            worker: Mutex::new(None),
        });
        {
            let mut runs = lock_unpoisoned(&self.inner.runs);
            if runs.contains_key(&request.run_id) {
                return Err("[automation_invalid_argument] 自动化运行 ID 已存在".to_owned());
            }
            runs.insert(request.run_id.clone(), Arc::clone(&record));
        }

        let run_id = request.run_id.clone();
        let worker_control = Arc::clone(&control);
        let worker_record = Arc::clone(&record);
        let status_app = app.clone();
        let status_request = request.clone();
        let worker = match thread::Builder::new()
            .name(format!("neterminai-automation-{}", short_id(&run_id)))
            .spawn(move || {
                if catch_unwind(AssertUnwindSafe(|| {
                    run_automation(app, request, worker_control);
                }))
                .is_err()
                {
                    let message = Some("自动化运行进程异常退出".to_owned());
                    eprintln!(
                        "[neterminai][automation] supervisor panicked run={}",
                        status_request.run_id
                    );
                    for target in &status_request.targets {
                        emit_status(
                            &status_app,
                            &status_request,
                            target,
                            "error",
                            message.clone(),
                        );
                    }
                }
                worker_record.done.store(true, Ordering::Release);
            }) {
            Ok(worker) => worker,
            Err(error) => {
                lock_unpoisoned(&self.inner.runs).remove(&run_id);
                return Err(format!("[automation_process] 无法启动终端自动化：{error}"));
            }
        };
        *lock_unpoisoned(&record.worker) = Some(worker);
        // A very short script can finish before the handle is stored. Reap
        // once more after publication so the completed JoinHandle is always
        // reclaimed by the manager rather than dropped by a transient owner.
        self.reap_finished();
        Ok(())
    }

    pub(crate) fn stop(&self, run_id: &str) -> Result<(), String> {
        let record = lock_unpoisoned(&self.inner.runs)
            .get(run_id)
            .cloned()
            .ok_or_else(|| "[automation_not_found] 自动化运行不存在".to_owned())?;
        record.control.cancelled.store(true, Ordering::Release);
        record.control.kill_children();
        self.reap_finished();
        Ok(())
    }

    pub(crate) fn shutdown(&self, deadline: Instant) {
        let records = lock_unpoisoned(&self.inner.runs)
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for record in &records {
            record.control.cancelled.store(true, Ordering::Release);
            record.control.kill_children();
        }
        while Instant::now() < deadline {
            self.reap_finished();
            if self.active_count() == 0 {
                return;
            }
            thread::sleep(SHUTDOWN_POLL);
            for record in &records {
                record.control.kill_children();
            }
        }
        self.reap_finished();
        for (run_id, record) in lock_unpoisoned(&self.inner.runs).iter() {
            if !record.done.load(Ordering::Acquire) {
                eprintln!("[neterminai][automation] shutdown deadline reached run={run_id}");
                record.control.kill_children();
            }
        }
    }

    pub(crate) fn active_count(&self) -> usize {
        lock_unpoisoned(&self.inner.runs)
            .values()
            .filter(|record| {
                !record.done.load(Ordering::Acquire) || lock_unpoisoned(&record.worker).is_none()
            })
            .count()
    }

    fn reap_finished(&self) {
        let finished = {
            let runs = lock_unpoisoned(&self.inner.runs);
            runs.iter()
                .filter(|(_, record)| {
                    record.done.load(Ordering::Acquire) && lock_unpoisoned(&record.worker).is_some()
                })
                .map(|(run_id, _)| run_id.clone())
                .collect::<Vec<_>>()
        };
        for run_id in finished {
            let record = lock_unpoisoned(&self.inner.runs).remove(&run_id);
            if let Some(record) = record
                && let Some(worker) = lock_unpoisoned(&record.worker).take()
            {
                let _ = worker.join();
            }
        }
    }
}

impl AutomationRunControl {
    fn register_child(&self, pid: u32) {
        lock_unpoisoned(&self.child_pids).insert(pid);
    }

    fn unregister_child(&self, pid: u32) {
        lock_unpoisoned(&self.child_pids).remove(&pid);
    }

    fn kill_children(&self) {
        let pids = lock_unpoisoned(&self.child_pids)
            .iter()
            .copied()
            .collect::<Vec<_>>();
        for pid in pids {
            terminate_pid(pid);
        }
    }
}

fn validate_request(request: &AutomationRunRequest) -> Result<(), String> {
    if request.run_id.trim().is_empty() || request.script_id.trim().is_empty() {
        return Err("[automation_invalid_argument] 自动化运行标识不能为空".to_owned());
    }
    if request.code.len() > MAX_SCRIPT_BYTES {
        return Err("[automation_invalid_argument] Python 脚本不能超过 512 KB".to_owned());
    }
    if request.targets.is_empty() || request.targets.len() > MAX_TARGETS {
        return Err("[automation_invalid_argument] 请选择 1 到 64 个目标终端".to_owned());
    }
    if request
        .targets
        .iter()
        .any(|target| target.tab_id.trim().is_empty())
    {
        return Err("[automation_invalid_argument] 目标终端标识不能为空".to_owned());
    }
    Ok(())
}

fn run_automation(
    app: AppHandle,
    request: AutomationRunRequest,
    control: Arc<AutomationRunControl>,
) {
    let script_path = match write_script_file(&request.run_id, &request.code) {
        Ok(path) => path,
        Err(error) => {
            for target in &request.targets {
                emit_status(&app, &request, target, "error", Some(error.clone()));
            }
            return;
        }
    };

    let mut workers = Vec::with_capacity(request.targets.len());
    for target in request.targets.iter().cloned() {
        emit_status(&app, &request, &target, "pending", None);
        if control.cancelled.load(Ordering::Acquire) {
            emit_status(
                &app,
                &request,
                &target,
                "cancelled",
                Some("运行已停止".to_owned()),
            );
            continue;
        }
        if target.session_id.as_deref().is_none_or(str::is_empty) {
            emit_status(
                &app,
                &request,
                &target,
                "error",
                Some("目标终端已关闭或尚未建立连接".to_owned()),
            );
            continue;
        }
        let target_app = app.clone();
        let target_request = request.clone_for_worker();
        let target_control = Arc::clone(&control);
        let target_path = script_path.clone();
        let target_for_worker = target.clone();
        match thread::Builder::new()
            .name(format!(
                "neterminai-automation-target-{}",
                short_id(&target.tab_id)
            ))
            .spawn(move || {
                run_target(
                    target_app,
                    target_request,
                    target_for_worker,
                    target_control,
                    target_path,
                );
            }) {
            Ok(worker) => workers.push(worker),
            Err(error) => emit_status(
                &app,
                &request,
                &target,
                "error",
                Some(format!("无法启动自动化目标：{error}")),
            ),
        }
    }

    for worker in workers {
        let _ = worker.join();
    }
    let _ = fs::remove_file(script_path);
}

fn run_target(
    app: AppHandle,
    request: AutomationRunRequestWorker,
    target: AutomationTargetRequest,
    control: Arc<AutomationRunControl>,
    script_path: String,
) {
    if control.cancelled.load(Ordering::Acquire) {
        emit_status_worker(
            &app,
            &request,
            &target,
            "cancelled",
            Some("运行已停止".to_owned()),
        );
        return;
    }

    let mut child = match spawn_python(&script_path) {
        Ok(child) => child,
        Err(error) => {
            emit_status_worker(&app, &request, &target, "error", Some(error));
            return;
        }
    };
    let pid = child.id();
    control.register_child(pid);
    if control.cancelled.load(Ordering::Acquire) {
        terminate_child(&mut child);
        control.unregister_child(pid);
        emit_status_worker(
            &app,
            &request,
            &target,
            "cancelled",
            Some("运行已停止".to_owned()),
        );
        return;
    }
    emit_status_worker(&app, &request, &target, "running", None);

    let mut child_stdin = child.stdin.take();
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            control.unregister_child(pid);
            terminate_child(&mut child);
            emit_status_worker(
                &app,
                &request,
                &target,
                "error",
                Some("Python 输出通道不可用".to_owned()),
            );
            return;
        }
    };
    let stderr = child.stderr.take();
    let stderr_worker = stderr.map(|mut stream| {
        thread::spawn(move || {
            let mut output = Vec::new();
            let _ = stream.read_to_end(&mut output);
            output
        })
    });

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut read_error = None;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if let Some(payload) = line
                    .trim_end_matches(['\r', '\n'])
                    .strip_prefix(SEND_PREFIX)
                {
                    let response = match serde_json::from_str::<SendMessage>(payload) {
                        Ok(message) => send_to_terminal(&app, &target, &message.command),
                        Err(_) => Err("Python send() 请求格式无效".to_owned()),
                    };
                    if let Some(stdin) = child_stdin.as_mut() {
                        let response_json = match response {
                            Ok(()) => r#"{"ok":true}"#.to_owned(),
                            Err(error) => {
                                serde_json::json!({ "ok": false, "error": error }).to_string()
                            }
                        };
                        if stdin
                            .write_all(format!("{ACK_PREFIX}{response_json}\n").as_bytes())
                            .and_then(|_| stdin.flush())
                            .is_err()
                        {
                            break;
                        }
                    } else {
                        read_error = Some("Python 输入通道不可用".to_owned());
                        break;
                    }
                }
            }
            Err(error) => {
                read_error = Some(format!("读取 Python 输出失败：{error}"));
                break;
            }
        }
    }

    if control.cancelled.load(Ordering::Acquire) {
        terminate_child(&mut child);
    }
    let exit_status = child.wait();
    control.unregister_child(pid);
    if let Some(worker) = stderr_worker {
        let _ = worker.join();
    }

    let status = if control.cancelled.load(Ordering::Acquire) {
        ("cancelled", Some("运行已停止".to_owned()))
    } else if let Some(error) = read_error {
        ("error", Some(error))
    } else {
        match exit_status {
            Ok(status) if status.success() => ("success", None),
            Ok(status) => (
                "error",
                Some(format!("Python 脚本退出码 {}", status.code().unwrap_or(-1))),
            ),
            Err(error) => ("error", Some(format!("等待 Python 进程失败：{error}"))),
        }
    };
    emit_status_worker(&app, &request, &target, status.0, status.1);
}

fn spawn_python(script_path: &str) -> Result<Child, String> {
    let mut command = Command::new("python");
    configure_python_command(&mut command, script_path);
    match command.spawn() {
        Ok(child) => Ok(child),
        Err(first_error) => {
            let mut launcher = Command::new("py");
            configure_python_launcher(&mut launcher, script_path);
            launcher.spawn().map_err(|second_error| {
                format!(
                    "未找到可用的 Python 运行时，请安装 Python 3 并确保 python 可执行文件可用（{first_error}; {second_error}）"
                )
            })
        }
    }
}

fn configure_python_command(command: &mut Command, script_path: &str) {
    command
        .args(["-u", "-c", PYTHON_BOOTSTRAP, script_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

fn configure_python_launcher(command: &mut Command, script_path: &str) {
    command
        .args(["-3", "-u", "-c", PYTHON_BOOTSTRAP, script_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

fn send_to_terminal(
    app: &AppHandle,
    target: &AutomationTargetRequest,
    command: &str,
) -> Result<(), String> {
    if command.len() > MAX_COMMAND_BYTES {
        return Err("send() 单次命令不能超过 64 KB".to_owned());
    }
    if command.contains(['\r', '\n']) {
        return Err("send() 命令不能包含换行符".to_owned());
    }
    let session_id = target
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "目标终端已关闭或尚未建立连接".to_owned())?;
    let mut data = command.as_bytes().to_vec();
    data.push(b'\r');
    match target.connection_type.as_str() {
        "local" | "ssh" => app.state::<TerminalManager>().write(session_id, &data),
        "telnet" => app.state::<TelnetManager>().write(session_id, &data),
        "serial" => app.state::<SerialManager>().write(session_id, &data),
        _ => Err("该终端类型暂不支持自动化输入".to_owned()),
    }
}

fn write_script_file(run_id: &str, code: &str) -> Result<String, String> {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "neterminai-automation-{}.py",
        safe_component(run_id)
    ));
    fs::write(&path, code.as_bytes()).map_err(|error| format!("无法准备 Python 脚本：{error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn emit_status(
    app: &AppHandle,
    request: &AutomationRunRequest,
    target: &AutomationTargetRequest,
    status: &'static str,
    message: Option<String>,
) {
    let _ = app.emit(
        STATUS_EVENT,
        AutomationStatusEvent {
            run_id: request.run_id.clone(),
            script_id: request.script_id.clone(),
            tab_id: target.tab_id.clone(),
            session_id: target.session_id.clone(),
            status,
            message,
        },
    );
}

fn emit_status_worker(
    app: &AppHandle,
    request: &AutomationRunRequestWorker,
    target: &AutomationTargetRequest,
    status: &'static str,
    message: Option<String>,
) {
    let _ = app.emit(
        STATUS_EVENT,
        AutomationStatusEvent {
            run_id: request.run_id.clone(),
            script_id: request.script_id.clone(),
            tab_id: target.tab_id.clone(),
            session_id: target.session_id.clone(),
            status,
            message,
        },
    );
}

#[derive(Clone)]
struct AutomationRunRequestWorker {
    run_id: String,
    script_id: String,
}

impl AutomationRunRequest {
    fn clone_for_worker(&self) -> AutomationRunRequestWorker {
        AutomationRunRequestWorker {
            run_id: self.run_id.clone(),
            script_id: self.script_id.clone(),
        }
    }
}

fn terminate_child(child: &mut Child) {
    terminate_pid(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

fn safe_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "run".to_owned()
    } else {
        sanitized
    }
}

fn short_id(value: &str) -> String {
    safe_component(&value.chars().take(12).collect::<String>())
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Drop for AutomationManager {
    fn drop(&mut self) {
        self.shutdown(Instant::now() + Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(code: &str, targets: Vec<AutomationTargetRequest>) -> AutomationRunRequest {
        AutomationRunRequest {
            run_id: "run-1".to_owned(),
            script_id: "script-1".to_owned(),
            code: code.to_owned(),
            targets,
        }
    }

    fn target() -> AutomationTargetRequest {
        AutomationTargetRequest {
            tab_id: "tab-1".to_owned(),
            session_id: Some("session-1".to_owned()),
            connection_type: "local".to_owned(),
        }
    }

    #[test]
    fn validation_requires_a_script_and_target() {
        assert!(validate_request(&request("", vec![])).is_err());
        assert!(validate_request(&request("print('ok')", vec![target()])).is_ok());
    }

    #[test]
    fn run_ids_are_safe_for_temporary_script_paths() {
        assert_eq!(safe_component("run/with spaces"), "run-with-spaces");
        assert_eq!(safe_component(""), "run");
    }
}
