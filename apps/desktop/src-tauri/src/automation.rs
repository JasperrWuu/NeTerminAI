use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, PoisonError, TryLockError,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
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
const OUTPUT_EVENT: &str = "automation:output";
const SEND_PREFIX: &str = "__NETERMINAI_AUTOMATION_SEND__";
const ACK_PREFIX: &str = "__NETERMINAI_AUTOMATION_ACK__";
const MAX_SCRIPT_BYTES: usize = 512 * 1024;
const MAX_TARGETS: usize = 64;
const MAX_COMMAND_BYTES: usize = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MAX_COLLECTED_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const COMMAND_POLL: Duration = Duration::from_millis(25);
const SHUTDOWN_POLL: Duration = Duration::from_millis(20);

const PYTHON_BOOTSTRAP: &str = r#"
import json
import pathlib
import sys
import time
import traceback

SEND_PREFIX = "__NETERMINAI_AUTOMATION_SEND__"
ACK_PREFIX = "__NETERMINAI_AUTOMATION_ACK__"

def send(command, timeout=None):
    if not isinstance(command, str):
        command = str(command)
    sys.stdout.write(SEND_PREFIX + json.dumps({"command": command, "timeout": timeout}, ensure_ascii=False) + "\n")
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
                message = response.get("error") or "终端命令执行失败"
                if response.get("code") == "timeout":
                    raise TimeoutError(message)
                raise RuntimeError(message)
            output = response.get("output", "")
            if not isinstance(output, str):
                raise RuntimeError("终端自动化主机返回格式无效")
            return output

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

/// Raw terminal output fan-out for automation collectors. The renderer keeps
/// its existing Tauri event stream; this hub is an additional backend
/// consumer keyed by the concrete session identity.
#[derive(Clone, Default)]
pub(crate) struct AutomationOutputHub {
    inner: Arc<AutomationOutputHubInner>,
}

#[derive(Default)]
struct AutomationOutputHubInner {
    sessions: Mutex<HashMap<String, AutomationOutputSession>>,
    next_subscriber: std::sync::atomic::AtomicU64,
}

struct AutomationOutputSession {
    subscribers: HashMap<u64, Sender<(u64, Vec<u8>)>>,
    command_lock: Arc<Mutex<()>>,
    prompt: Option<String>,
    cursor: u64,
}

pub(crate) struct AutomationOutputSubscription {
    receiver: Receiver<(u64, Vec<u8>)>,
    hub: AutomationOutputHub,
    session_id: String,
    subscriber_id: u64,
    start_cursor: u64,
}

impl AutomationOutputHub {
    pub(crate) fn subscribe(&self, session_id: &str) -> AutomationOutputSubscription {
        let (sender, receiver) = mpsc::channel();
        let subscriber_id = self.inner.next_subscriber.fetch_add(1, Ordering::Relaxed);
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        let session =
            sessions
                .entry(session_id.to_owned())
                .or_insert_with(|| AutomationOutputSession {
                    subscribers: HashMap::new(),
                    command_lock: Arc::new(Mutex::new(())),
                    prompt: None,
                    cursor: 0,
                });
        session.subscribers.insert(subscriber_id, sender);
        AutomationOutputSubscription {
            receiver,
            hub: self.clone(),
            session_id: session_id.to_owned(),
            subscriber_id,
            start_cursor: session.cursor,
        }
    }

    pub(crate) fn publish(&self, session_id: &str, data: &[u8]) {
        let (subscribers, cursor) = {
            let mut sessions = lock_unpoisoned(&self.inner.sessions);
            let session =
                sessions
                    .entry(session_id.to_owned())
                    .or_insert_with(|| AutomationOutputSession {
                        subscribers: HashMap::new(),
                        command_lock: Arc::new(Mutex::new(())),
                        prompt: None,
                        cursor: 0,
                    });
            session.cursor = session.cursor.saturating_add(1);
            (
                session
                    .subscribers
                    .iter()
                    .map(|(id, sender)| (*id, sender.clone()))
                    .collect::<Vec<_>>(),
                session.cursor,
            )
        };
        if subscribers.is_empty() {
            return;
        }
        let mut disconnected = Vec::new();
        for (subscriber_id, sender) in subscribers {
            if sender.send((cursor, data.to_vec())).is_err() {
                disconnected.push(subscriber_id);
            }
        }
        if !disconnected.is_empty() {
            let mut sessions = lock_unpoisoned(&self.inner.sessions);
            if let Some(session) = sessions.get_mut(session_id) {
                for subscriber_id in disconnected {
                    session.subscribers.remove(&subscriber_id);
                }
            }
        }
    }

    fn command_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| AutomationOutputSession {
                subscribers: HashMap::new(),
                command_lock: Arc::new(Mutex::new(())),
                prompt: None,
                cursor: 0,
            })
            .command_lock
            .clone()
    }

    fn current_prompt(&self, session_id: &str) -> Option<String> {
        lock_unpoisoned(&self.inner.sessions)
            .get(session_id)
            .and_then(|session| session.prompt.clone())
    }

    fn set_prompt(&self, session_id: &str, prompt: String) {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        let session =
            sessions
                .entry(session_id.to_owned())
                .or_insert_with(|| AutomationOutputSession {
                    subscribers: HashMap::new(),
                    command_lock: Arc::new(Mutex::new(())),
                    prompt: None,
                    cursor: 0,
                });
        session.prompt = Some(prompt);
    }

    fn remove_subscriber(&self, session_id: &str, subscriber_id: u64) {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        if let Some(session) = sessions.get_mut(session_id) {
            session.subscribers.remove(&subscriber_id);
        }
    }
}

impl AutomationOutputSubscription {
    fn recv_timeout(&self, timeout: Duration) -> Result<Vec<u8>, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout).map(|(cursor, data)| {
            debug_assert!(cursor > self.start_cursor);
            data
        })
    }
}

impl Drop for AutomationOutputSubscription {
    fn drop(&mut self) {
        self.hub
            .remove_subscriber(&self.session_id, self.subscriber_id);
    }
}

pub(crate) fn publish_output(app: &AppHandle, session_id: &str, data: &[u8]) {
    app.state::<AutomationOutputHub>().publish(session_id, data);
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationOutputEvent {
    run_id: String,
    script_id: String,
    tab_id: String,
    session_id: Option<String>,
    stream: &'static str,
    data: String,
}

#[derive(Debug, Deserialize)]
struct SendMessage {
    command: String,
    #[serde(default)]
    timeout: Option<f64>,
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
                        Ok(message) => execute_command(&app, &target, &message, &control),
                        Err(_) => Err(CommandFailure::invalid_argument(
                            "Python send() 请求格式无效",
                        )),
                    };
                    if let Some(stdin) = child_stdin.as_mut() {
                        let response_json = match response {
                            Ok(output) => serde_json::json!({
                                "ok": true,
                                "output": output,
                            })
                            .to_string(),
                            Err(error) => serde_json::json!({
                                "ok": false,
                                "code": error.code,
                                "error": error.message,
                            })
                            .to_string(),
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
                } else {
                    emit_output_worker(&app, &request, &target, "stdout", line.as_bytes());
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
    if let Some(worker) = stderr_worker
        && let Ok(stderr) = worker.join()
        && !stderr.is_empty()
    {
        emit_output_worker(&app, &request, &target, "stderr", &stderr);
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

#[derive(Debug)]
struct CommandFailure {
    code: &'static str,
    message: String,
}

impl CommandFailure {
    fn invalid_argument(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_argument",
            message: message.into(),
        }
    }

    fn session_not_found(message: impl Into<String>) -> Self {
        Self {
            code: "session_not_found",
            message: message.into(),
        }
    }

    fn cancelled(message: impl Into<String>) -> Self {
        Self {
            code: "cancelled",
            message: message.into(),
        }
    }

    fn timeout(message: impl Into<String>) -> Self {
        Self {
            code: "timeout",
            message: message.into(),
        }
    }

    fn io(message: impl Into<String>) -> Self {
        Self {
            code: "io_error",
            message: message.into(),
        }
    }
}

fn execute_command(
    app: &AppHandle,
    target: &AutomationTargetRequest,
    message: &SendMessage,
    control: &AutomationRunControl,
) -> Result<String, CommandFailure> {
    validate_command(&message.command)?;
    let session_id = target
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CommandFailure::session_not_found("目标终端已关闭或尚未建立连接"))?;
    let timeout = parse_command_timeout(message.timeout)?;
    let deadline = Instant::now() + timeout;
    if control.cancelled.load(Ordering::Acquire) {
        return Err(CommandFailure::cancelled("自动化运行已停止"));
    }

    let output_hub = app.state::<AutomationOutputHub>().clone();
    let command_lock = output_hub.command_lock(session_id);
    let _lock = acquire_command_lock(
        &command_lock,
        control,
        deadline,
        session_id,
        &message.command,
    )?;
    if control.cancelled.load(Ordering::Acquire) {
        return Err(CommandFailure::cancelled("自动化运行已停止"));
    }

    let initial_prompt = output_hub.current_prompt(session_id);
    let subscription = output_hub.subscribe(session_id);
    let mut collector = CommandCollector::new(&message.command, initial_prompt);
    let mut command_bytes = message.command.as_bytes().to_vec();
    command_bytes.push(b'\r');
    write_terminal_bytes(app, target, &command_bytes).map_err(|error| {
        CommandFailure::io(format!("发送命令到终端失败（{session_id}）：{error}"))
    })?;

    loop {
        if control.cancelled.load(Ordering::Acquire) {
            return Err(CommandFailure::cancelled("自动化运行已停止"));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(CommandFailure::timeout(format!(
                "命令 `{}` 在终端 {session_id} 上等待超过 {} 秒",
                message.command,
                timeout.as_secs_f64(),
            )));
        }
        match subscription.recv_timeout(remaining.min(COMMAND_POLL)) {
            Ok(chunk) => {
                let signal = collector.push(&chunk)?;
                if signal.more_markers > collector.pages_requested {
                    let pages = signal.more_markers - collector.pages_requested;
                    for _ in 0..pages {
                        if control.cancelled.load(Ordering::Acquire) {
                            return Err(CommandFailure::cancelled("自动化运行已停止"));
                        }
                        write_terminal_bytes(app, target, b" ").map_err(|error| {
                            CommandFailure::io(format!("发送分页确认到终端失败：{error}"))
                        })?;
                        collector.pages_requested += 1;
                    }
                }
                if let Some(prompt) = signal.prompt {
                    output_hub.set_prompt(session_id, prompt.clone());
                    return Ok(collector.normalized_output(Some(&prompt)));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(CommandFailure::io("终端输出通道已关闭"));
            }
        }
    }
}

fn validate_command(command: &str) -> Result<(), CommandFailure> {
    if command.trim().is_empty() {
        return Err(CommandFailure::invalid_argument("send() 命令不能为空"));
    }
    if command.len() > MAX_COMMAND_BYTES {
        return Err(CommandFailure::invalid_argument(
            "send() 单次命令不能超过 64 KB",
        ));
    }
    if command.contains(['\r', '\n']) {
        return Err(CommandFailure::invalid_argument(
            "send() 命令不能包含换行符",
        ));
    }
    Ok(())
}

fn parse_command_timeout(value: Option<f64>) -> Result<Duration, CommandFailure> {
    let seconds = value.unwrap_or(DEFAULT_COMMAND_TIMEOUT.as_secs_f64());
    if !seconds.is_finite() || seconds <= 0.0 || seconds > MAX_COMMAND_TIMEOUT.as_secs_f64() {
        return Err(CommandFailure::invalid_argument(format!(
            "send() timeout 必须大于 0 且不超过 {} 秒",
            MAX_COMMAND_TIMEOUT.as_secs()
        )));
    }
    Ok(Duration::from_secs_f64(seconds))
}

fn acquire_command_lock<'a>(
    lock: &'a Mutex<()>,
    control: &AutomationRunControl,
    deadline: Instant,
    session_id: &str,
    command: &str,
) -> Result<std::sync::MutexGuard<'a, ()>, CommandFailure> {
    loop {
        if control.cancelled.load(Ordering::Acquire) {
            return Err(CommandFailure::cancelled("自动化运行已停止"));
        }
        if Instant::now() >= deadline {
            return Err(CommandFailure::timeout(format!(
                "终端 {session_id} 正在执行其他命令，等待 `{command}` 超时"
            )));
        }
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::WouldBlock) => thread::sleep(COMMAND_POLL),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
        }
    }
}

fn write_terminal_bytes(
    app: &AppHandle,
    target: &AutomationTargetRequest,
    data: &[u8],
) -> Result<(), String> {
    let session_id = target
        .session_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "目标终端已关闭或尚未建立连接".to_owned())?;
    match target.connection_type.as_str() {
        "local" | "ssh" => app.state::<TerminalManager>().write(session_id, data),
        "telnet" => app.state::<TelnetManager>().write(session_id, data),
        "serial" => app.state::<SerialManager>().write(session_id, data),
        _ => Err("该终端类型暂不支持自动化输入".to_owned()),
    }
}

struct CollectorSignal {
    prompt: Option<String>,
    more_markers: usize,
}

struct CommandCollector {
    raw: Vec<u8>,
    command: String,
    initial_prompt: Option<String>,
    pages_requested: usize,
    saw_output: bool,
}

impl CommandCollector {
    fn new(command: &str, initial_prompt: Option<String>) -> Self {
        Self {
            raw: Vec::new(),
            command: command.to_owned(),
            initial_prompt,
            pages_requested: 0,
            saw_output: false,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<CollectorSignal, CommandFailure> {
        self.saw_output = self.saw_output || !chunk.is_empty();
        if self.raw.len().saturating_add(chunk.len()) > MAX_COLLECTED_OUTPUT_BYTES {
            return Err(CommandFailure::io(format!(
                "命令 `{}` 输出超过 {} MB，已停止采集",
                self.command,
                MAX_COLLECTED_OUTPUT_BYTES / (1024 * 1024)
            )));
        }
        self.raw.extend_from_slice(chunk);
        let tail_start = self.raw.len().saturating_sub(8 * 1024);
        let tail = normalize_terminal_text(&self.raw[tail_start..]);
        let more_markers = count_more_markers(&tail);
        let prompt = if self.saw_output {
            detect_prompt(&tail).filter(|prompt| self.completion_ready(&tail, prompt))
        } else {
            None
        };
        Ok(CollectorSignal {
            prompt,
            more_markers,
        })
    }

    fn normalized_output(&self, final_prompt: Option<&str>) -> String {
        normalize_command_output(
            &self.raw,
            &self.command,
            self.initial_prompt.as_deref(),
            final_prompt,
        )
    }

    fn completion_ready(&self, text: &str, _prompt: &str) -> bool {
        let has_echo = text
            .lines()
            .any(|line| is_command_echo(line, &self.command, self.initial_prompt.as_deref()));
        if has_echo {
            return true;
        }
        // A delayed prompt that was already in the terminal stream should not
        // complete the first transaction by itself. If the device does not
        // echo commands, require at least one non-prompt, non-pagination line.
        text.lines().any(|line| {
            let line = line.trim();
            !line.is_empty() && !is_more_marker(line) && detect_prompt(line).is_none()
        })
    }
}

fn normalize_terminal_text(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == 0x1b {
            index += 1;
            if index >= bytes.len() {
                break;
            }
            match bytes[index] {
                b'[' => {
                    index += 1;
                    while index < bytes.len() {
                        let current = bytes[index];
                        index += 1;
                        if (0x40..=0x7e).contains(&current) {
                            break;
                        }
                    }
                }
                b']' => {
                    index += 1;
                    while index < bytes.len() {
                        if bytes[index] == 0x07 {
                            index += 1;
                            break;
                        }
                        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                            index += 2;
                            break;
                        }
                        index += 1;
                    }
                }
                _ => index += 1,
            }
            continue;
        }
        match byte {
            b'\r' => index += 1,
            b'\n' | b'\t' => {
                output.push(byte as char);
                index += 1;
            }
            0x08 => {
                output.pop();
                index += 1;
            }
            0x20..=0x7e | 0x80..=0xff => {
                let start = index;
                index += 1;
                while index < bytes.len() && bytes[index] >= 0x80 {
                    index += 1;
                }
                output.push_str(&String::from_utf8_lossy(&bytes[start..index]));
            }
            _ => index += 1,
        }
    }
    output
}

fn detect_prompt(text: &str) -> Option<String> {
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    if is_huawei_prompt(line)
        || (line.starts_with("PS ") && line.ends_with('>'))
        || (line.contains(":\\") && line.ends_with('>'))
        || (line.len() <= 256 && matches!(line.chars().last(), Some('$' | '#' | '%')))
    {
        return Some(line.to_owned());
    }
    None
}

fn is_huawei_prompt(line: &str) -> bool {
    let (open, close) = if line.starts_with('<') && line.ends_with('>') {
        ('<', '>')
    } else if line.starts_with('[') && line.ends_with(']') {
        ('[', ']')
    } else {
        return false;
    };
    let inner = &line[open.len_utf8()..line.len() - close.len_utf8()];
    !inner.is_empty()
        && inner.chars().all(|character| {
            character.is_alphanumeric() || matches!(character, '-' | '_' | '/' | '.' | ':')
        })
}

fn count_more_markers(text: &str) -> usize {
    text.lines().filter(|line| is_more_marker(line)).count()
}

fn is_more_marker(line: &str) -> bool {
    let trimmed = line.trim();
    let compact = trimmed
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    compact == "more"
        || compact == "--more--"
        || compact == "----more----"
        || (compact.len() <= 80
            && compact.contains("more")
            && (compact.starts_with('-') || compact.ends_with('-')))
}

fn normalize_command_output(
    raw: &[u8],
    command: &str,
    initial_prompt: Option<&str>,
    final_prompt: Option<&str>,
) -> String {
    let normalized = normalize_terminal_text(raw);
    let mut lines = normalized.lines().map(str::to_owned).collect::<Vec<_>>();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    if lines
        .first()
        .is_some_and(|line| is_command_echo(line, command, initial_prompt))
    {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    if lines.last().is_some_and(|line| {
        let candidate = line.trim();
        final_prompt.is_some_and(|prompt| candidate == prompt) || detect_prompt(candidate).is_some()
    }) {
        lines.pop();
    }
    lines.retain(|line| !is_more_marker(line));
    lines.join("\n").trim_matches('\n').to_owned()
}

fn is_command_echo(line: &str, command: &str, initial_prompt: Option<&str>) -> bool {
    let trimmed = line.trim();
    if trimmed == command {
        return true;
    }
    if initial_prompt.is_some_and(|prompt| {
        trimmed == format!("{prompt}{command}") || trimmed == format!("{prompt} {command}")
    }) {
        return true;
    }
    trimmed.ends_with(command)
        && trimmed.len() > command.len()
        && detect_prompt(&trimmed[..trimmed.len() - command.len()]).is_some()
}

fn emit_output_worker(
    app: &AppHandle,
    request: &AutomationRunRequestWorker,
    target: &AutomationTargetRequest,
    stream: &'static str,
    data: &[u8],
) {
    if data.is_empty() {
        return;
    }
    let _ = app.emit(
        OUTPUT_EVENT,
        AutomationOutputEvent {
            run_id: request.run_id.clone(),
            script_id: request.script_id.clone(),
            tab_id: target.tab_id.clone(),
            session_id: target.session_id.clone(),
            stream,
            data: String::from_utf8_lossy(data).into_owned(),
        },
    );
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

    #[test]
    fn command_output_removes_echo_and_dynamic_huawei_prompt() {
        let raw = b"<FW1>display health\r\nSlot  Card  Status\r\n0     MPU   Normal\r\n<FW1>\r\n";
        let normalized = normalize_terminal_text(raw);
        assert_eq!(detect_prompt(&normalized).as_deref(), Some("<FW1>"));
        assert_eq!(
            normalize_command_output(raw, "display health", None, Some("<FW1>")),
            "Slot  Card  Status\n0     MPU   Normal"
        );
    }

    #[test]
    fn prompt_detector_accepts_view_prompt_changes() {
        assert_eq!(detect_prompt("[FW1]\n"), Some("[FW1]".to_owned()));
        assert_eq!(
            detect_prompt("[FW1-GigabitEthernet0/0/1]\n"),
            Some("[FW1-GigabitEthernet0/0/1]".to_owned())
        );
        assert_eq!(detect_prompt("FW1 output\n"), None);
    }

    #[test]
    fn more_markers_are_detected_and_removed_from_output() {
        let raw = b"<FW1>display current-configuration\r\nline one\r\n---- More ----\r\nline two\r\n<FW1>\r\n";
        let normalized =
            normalize_command_output(raw, "display current-configuration", None, Some("<FW1>"));
        assert_eq!(normalized, "line one\nline two");
        assert_eq!(count_more_markers(&normalize_terminal_text(raw)), 1);
    }

    #[test]
    fn output_hub_isolates_subscribers_by_session() {
        let hub = AutomationOutputHub::default();
        let first = hub.subscribe("session-a");
        let second = hub.subscribe("session-b");
        hub.publish("session-a", b"a");
        assert_eq!(first.recv_timeout(Duration::from_millis(20)).unwrap(), b"a");
        assert!(matches!(
            second.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }

    #[test]
    fn command_timeout_is_bounded_and_defaults_to_thirty_seconds() {
        assert_eq!(
            parse_command_timeout(None).unwrap(),
            DEFAULT_COMMAND_TIMEOUT
        );
        assert!(parse_command_timeout(Some(0.0)).is_err());
        assert!(parse_command_timeout(Some(f64::NAN)).is_err());
        assert!(parse_command_timeout(Some(MAX_COMMAND_TIMEOUT.as_secs_f64() + 1.0)).is_err());
    }
}
