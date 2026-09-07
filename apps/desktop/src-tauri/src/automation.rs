use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex, PoisonError, TryLockError,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::{
    output_stream::TerminalOutputHub, serial::SerialManager, telnet::TelnetManager,
    terminal::TerminalManager,
};

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
const MAX_INTERACTION_RESPONSES: usize = 32;
const MAX_INTERACTION_PATTERN_BYTES: usize = 8 * 1024;
const MAX_INTERACTION_RESPONSE_BYTES: usize = 8 * 1024;
const MAX_INTERACTION_COUNT: usize = 32;
// Pagination is a terminal-control interaction, not a scripted response.
// Huawei devices can emit dozens (or hundreds) of pages for one command, so
// keep a separate, deliberately generous guard instead of sharing the small
// Y/N interaction limit.
const MAX_PAGINATION_COUNT: usize = 512;
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

def force_utf8(stream):
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is not None:
        reconfigure(encoding="utf-8", errors="replace")

force_utf8(sys.stdout)
force_utf8(sys.stderr)
force_utf8(sys.stdin)

def send(command, timeout=None, responses=None):
    if not isinstance(command, str):
        command = str(command)
    if responses is None:
        responses = []
    if not isinstance(responses, (list, tuple)):
        raise TypeError("send() responses 必须是 (pattern, response) 对列表")
    normalized_responses = []
    for item in responses:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise ValueError("send() responses 中每一项必须是 (pattern, response)")
        pattern, response = item
        if not isinstance(pattern, str) or not isinstance(response, str):
            raise TypeError("send() responses 的 pattern 和 response 必须是字符串")
        normalized_responses.append([pattern, response])
    sys.stdout.write(SEND_PREFIX + json.dumps({"command": command, "timeout": timeout, "responses": normalized_responses}, ensure_ascii=False) + "\n")
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
                if response.get("code") == "interaction_required":
                    raise RuntimeError("[interaction_required] " + message)
                if response.get("code") == "pagination_limit":
                    raise RuntimeError("[pagination_limit] " + message)
                if response.get("code") == "output_overflow":
                    raise RuntimeError("[output_overflow] " + message)
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
    #[serde(default)]
    responses: Vec<(String, String)>,
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
        .env("PYTHONIOENCODING", "utf-8:replace")
        .env("PYTHONUTF8", "1")
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
        .env("PYTHONIOENCODING", "utf-8:replace")
        .env("PYTHONUTF8", "1")
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

    fn busy(message: impl Into<String>) -> Self {
        Self {
            code: "session_busy",
            message: message.into(),
        }
    }

    fn interaction_required(message: impl Into<String>) -> Self {
        Self {
            code: "interaction_required",
            message: message.into(),
        }
    }

    fn io(message: impl Into<String>) -> Self {
        Self {
            code: "io_error",
            message: message.into(),
        }
    }

    fn pagination_limit(message: impl Into<String>) -> Self {
        Self {
            code: "pagination_limit",
            message: message.into(),
        }
    }

    fn output_overflow(message: impl Into<String>) -> Self {
        Self {
            code: "output_overflow",
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
    let interaction_responses = compile_interaction_responses(&message.responses)?;
    let deadline = Instant::now() + timeout;
    let transaction_started = Instant::now();
    transaction_log(target, session_id, "started", transaction_started);
    if control.cancelled.load(Ordering::Acquire) {
        return Err(CommandFailure::cancelled("自动化运行已停止"));
    }

    let output_hub = app.state::<TerminalOutputHub>().clone();
    let command_lock = output_hub.command_lock(session_id);
    let _lock = acquire_command_lock(&command_lock, control, session_id, &message.command)?;
    if control.cancelled.load(Ordering::Acquire) {
        return Err(CommandFailure::cancelled("自动化运行已停止"));
    }

    let initial_prompt = output_hub.current_prompt(session_id);
    let subscription = output_hub.subscribe(session_id);
    static NEXT_TRANSACTION: AtomicU64 = AtomicU64::new(1);
    let transaction_id = NEXT_TRANSACTION.fetch_add(1, Ordering::Relaxed);
    let mut output_cursor = subscription.start_cursor();
    let mut collector = CommandCollector::new(&message.command, initial_prompt);
    let mut interaction_count: usize = 0;
    let mut command_bytes = message.command.as_bytes().to_vec();
    command_bytes.push(b'\r');
    write_terminal_bytes(app, target, &command_bytes).map_err(|error| {
        CommandFailure::io(format!("发送命令到终端失败（{session_id}）：{error}"))
    })?;

    loop {
        if control.cancelled.load(Ordering::Acquire) {
            transaction_log(target, session_id, "cancelled", transaction_started);
            return Err(CommandFailure::cancelled("自动化运行已停止"));
        }
        let Some(remaining) = command_poll_budget(deadline, Instant::now()) else {
            transaction_log(target, session_id, "timeout", transaction_started);
            return Err(CommandFailure::timeout(format!(
                "命令 `{}` 在终端 {session_id} 上等待超过 {} 秒",
                message.command,
                timeout.as_secs_f64(),
            )));
        };
        match subscription.recv_with_cursor(remaining.min(COMMAND_POLL)) {
            Ok((cursor, chunk)) => {
                pagination_trace(transaction_id, session_id, "rx", cursor, chunk.len());
                #[cfg(debug_assertions)]
                if std::env::var_os("NETERMINAI_PAGINATION_TRACE").is_some() {
                    let published = subscription.published_cursor();
                    eprintln!(
                        "[neterminai][pagination] transaction={transaction_id} session={session_id} stage=consumer_progress published={published} consumed={cursor} lag={} budget={}/{} elapsed_us={}",
                        published.saturating_sub(cursor),
                        collector.pages_requested,
                        MAX_PAGINATION_COUNT,
                        transaction_started.elapsed().as_micros()
                    );
                }
                if cursor != output_cursor.saturating_add(1) {
                    return Err(CommandFailure::io(
                        "终端输出序号不连续，已停止采集以避免返回不完整结果",
                    ));
                }
                output_cursor = cursor;
                let signal = collector.push(&chunk)?;
                if signal.more_markers > collector.pages_requested {
                    let pages = signal.more_markers - collector.pages_requested;
                    let requested_total = collector.pages_requested.saturating_add(pages);
                    if requested_total > MAX_PAGINATION_COUNT {
                        transaction_log(
                            target,
                            session_id,
                            "pagination_limit",
                            transaction_started,
                        );
                        return Err(CommandFailure::pagination_limit(format!(
                            "命令 `{}` 在终端 {session_id} 的分页次数超过安全上限 {}",
                            message.command, MAX_PAGINATION_COUNT
                        )));
                    }
                    for _ in 0..pages {
                        let occurrence = collector.pages_requested + 1;
                        pagination_trace(
                            transaction_id,
                            session_id,
                            "more_detected_space_requested",
                            cursor,
                            occurrence,
                        );
                        if control.cancelled.load(Ordering::Acquire) {
                            return Err(CommandFailure::cancelled("自动化运行已停止"));
                        }
                        let trace = crate::io_pump::ControlWriteTrace {
                            #[cfg(test)]
                            events: None,
                            transaction: transaction_id,
                            occurrence,
                            limit: MAX_PAGINATION_COUNT,
                            cursor,
                            started: transaction_started,
                        };
                        trace.log(session_id, "space_requested");
                        let result = match target.connection_type.as_str() {
                            "local" | "ssh" => app
                                .state::<TerminalManager>()
                                .write_control_space(session_id, trace),
                            "telnet" => app
                                .state::<TelnetManager>()
                                .write_control_space(session_id, trace),
                            "serial" => app
                                .state::<SerialManager>()
                                .write_control_space(session_id, trace),
                            _ => Err("该终端类型不支持分页输入".to_owned()),
                        };
                        result.map_err(|error| {
                            CommandFailure::io(format!("发送分页确认到终端失败：{error}"))
                        })?;
                        collector.pages_requested += 1;
                        // Manager::write acknowledges queue admission only;
                        // this must never be reported as transport completion.
                        pagination_trace(
                            transaction_id,
                            session_id,
                            "space_enqueued",
                            cursor,
                            occurrence,
                        );
                        transaction_log(target, session_id, "paging", transaction_started);
                    }
                }
                if let Some(interaction) = signal.interaction {
                    interaction_count = interaction_count.saturating_add(1);
                    transaction_log(
                        target,
                        session_id,
                        "interaction_detected",
                        transaction_started,
                    );
                    if interaction_count > MAX_INTERACTION_COUNT {
                        return Err(CommandFailure::interaction_required(format!(
                            "命令 `{}` 在终端 {session_id} 上需要的交互次数超过上限",
                            message.command
                        )));
                    }
                    let Some(response) = interaction_responses
                        .iter()
                        .find(|candidate| candidate.pattern.is_match(&interaction))
                    else {
                        return Err(CommandFailure::interaction_required(format!(
                            "命令 `{}` 在终端 {session_id} 上需要交互响应：{interaction}",
                            message.command
                        )));
                    };
                    let mut response_bytes = response.response.as_bytes().to_vec();
                    response_bytes.push(b'\r');
                    write_terminal_bytes(app, target, &response_bytes).map_err(|error| {
                        CommandFailure::io(format!(
                            "发送交互响应到终端失败（{session_id}）：{error}"
                        ))
                    })?;
                    collector.mark_interaction_handled();
                    transaction_log(
                        target,
                        session_id,
                        "interaction_responded",
                        transaction_started,
                    );
                    continue;
                }
                if let Some(prompt) = signal.prompt {
                    output_hub.set_prompt(session_id, prompt.clone());
                    transaction_log(target, session_id, "completed", transaction_started);
                    return Ok(collector.normalized_output(Some(&prompt)));
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                transaction_log(
                    target,
                    session_id,
                    "output_disconnected",
                    transaction_started,
                );
                return Err(CommandFailure::io("终端输出通道已关闭"));
            }
        }
    }
}

// The immutable command deadline is not refreshed by output or pagination.
fn command_poll_budget(deadline: Instant, now: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(now)
        .filter(|remaining| !remaining.is_zero())
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

#[derive(Debug)]
struct CompiledInteractionResponse {
    pattern: Regex,
    response: String,
}

fn compile_interaction_responses(
    responses: &[(String, String)],
) -> Result<Vec<CompiledInteractionResponse>, CommandFailure> {
    if responses.len() > MAX_INTERACTION_RESPONSES {
        return Err(CommandFailure::invalid_argument(format!(
            "send() 最多支持 {} 个交互响应",
            MAX_INTERACTION_RESPONSES
        )));
    }
    responses
        .iter()
        .enumerate()
        .map(|(index, (pattern, response))| {
            if pattern.trim().is_empty() {
                return Err(CommandFailure::invalid_argument(format!(
                    "send() 第 {} 个交互 pattern 不能为空",
                    index + 1
                )));
            }
            if pattern.len() > MAX_INTERACTION_PATTERN_BYTES {
                return Err(CommandFailure::invalid_argument(format!(
                    "send() 第 {} 个交互 pattern 不能超过 {} KB",
                    index + 1,
                    MAX_INTERACTION_PATTERN_BYTES / 1024
                )));
            }
            if response.len() > MAX_INTERACTION_RESPONSE_BYTES {
                return Err(CommandFailure::invalid_argument(format!(
                    "send() 第 {} 个交互 response 不能超过 {} KB",
                    index + 1,
                    MAX_INTERACTION_RESPONSE_BYTES / 1024
                )));
            }
            if response.contains(['\r', '\n']) {
                return Err(CommandFailure::invalid_argument(format!(
                    "send() 第 {} 个交互 response 不能包含换行符",
                    index + 1
                )));
            }
            let pattern = Regex::new(pattern).map_err(|_| {
                CommandFailure::invalid_argument(format!(
                    "send() 第 {} 个交互 pattern 不是有效的正则表达式",
                    index + 1
                ))
            })?;
            Ok(CompiledInteractionResponse {
                pattern,
                response: response.clone(),
            })
        })
        .collect()
}

fn acquire_command_lock<'a>(
    lock: &'a Mutex<()>,
    control: &AutomationRunControl,
    session_id: &str,
    command: &str,
) -> Result<std::sync::MutexGuard<'a, ()>, CommandFailure> {
    if control.cancelled.load(Ordering::Acquire) {
        return Err(CommandFailure::cancelled("自动化运行已停止"));
    }
    match lock.try_lock() {
        Ok(guard) => Ok(guard),
        Err(TryLockError::WouldBlock) => Err(CommandFailure::busy(format!(
            "终端 {session_id} 正在执行其他命令，无法同时执行 `{command}`"
        ))),
        Err(TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner()),
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
    interaction: Option<String>,
    more_markers: usize,
}

#[cfg(test)]
#[path = "automation_stream_tests.rs"]
mod stream_tests;

struct CommandCollector {
    raw: Vec<u8>,
    command: String,
    initial_prompt: Option<String>,
    pages_requested: usize,
    more_markers_seen: usize,
    more_detector: MoreDetector,
    saw_output: bool,
    interaction_start: usize,
}

impl CommandCollector {
    fn new(command: &str, initial_prompt: Option<String>) -> Self {
        Self {
            raw: Vec::new(),
            command: command.to_owned(),
            initial_prompt,
            pages_requested: 0,
            more_markers_seen: 0,
            more_detector: MoreDetector::default(),
            saw_output: false,
            interaction_start: 0,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<CollectorSignal, CommandFailure> {
        self.saw_output = self.saw_output || !chunk.is_empty();
        if self.raw.len().saturating_add(chunk.len()) > MAX_COLLECTED_OUTPUT_BYTES {
            return Err(CommandFailure::output_overflow(format!(
                "命令 `{}` 输出超过 {} MB，已停止采集",
                self.command,
                MAX_COLLECTED_OUTPUT_BYTES / (1024 * 1024)
            )));
        }
        self.raw.extend_from_slice(chunk);
        self.more_markers_seen = self
            .more_markers_seen
            .saturating_add(self.more_detector.feed(chunk));
        let tail_start = self.raw.len().saturating_sub(8 * 1024);
        let tail = normalize_terminal_text(&self.raw[tail_start..]);
        let interaction = if self.saw_output {
            // Only a new occurrence may request another response. A trailing
            // colon/ANSI reset in the next chunk is not a second question.
            detect_interaction(&normalize_terminal_text(
                &self.raw[self.interaction_start.max(tail_start)..],
            ))
        } else {
            None
        };
        let prompt = if self.saw_output && interaction.is_none() {
            detect_final_prompt(&tail).filter(|candidate| {
                prompt_matches_context(candidate, self.initial_prompt.as_deref(), &self.command)
            })
        } else {
            None
        };
        Ok(CollectorSignal {
            prompt,
            interaction,
            more_markers: self.more_markers_seen,
        })
    }

    fn mark_interaction_handled(&mut self) {
        self.interaction_start = self.raw.len();
    }

    fn normalized_output(&self, final_prompt: Option<&str>) -> String {
        normalize_command_output(
            &self.raw,
            &self.command,
            self.initial_prompt.as_deref(),
            final_prompt,
        )
    }
}

/// Incremental detector for terminal pagination prompts.
///
/// The device is free to split an ANSI-wrapped marker over any number of
/// output chunks and may overwrite it with carriage returns/backspaces rather
/// than terminating the logical line.  Keeping a small normalized character
/// window lets us recognize each occurrence exactly once without rescanning
/// the complete (potentially megabyte-sized) transaction buffer.
#[derive(Default)]
struct MoreDetector {
    escape: MoreEscapeState,
    window: String,
    occurrences: usize,
    marker_armed: bool,
}

#[derive(Default)]
enum MoreEscapeState {
    #[default]
    Normal,
    Escape,
    Csi,
    Osc,
    OscEscape,
}

impl MoreDetector {
    fn feed(&mut self, bytes: &[u8]) -> usize {
        let before = self.occurrences;
        for &byte in bytes {
            self.feed_byte(byte);
        }
        self.occurrences.saturating_sub(before)
    }

    fn feed_byte(&mut self, byte: u8) {
        match self.escape {
            MoreEscapeState::Normal => match byte {
                0x1b => self.escape = MoreEscapeState::Escape,
                0x08 => {
                    self.window.pop();
                }
                b'\r' | b'\n' => self.push_visible('\n'),
                0x20..=0x7e => self.push_visible(byte as char),
                _ => {}
            },
            MoreEscapeState::Escape => {
                self.escape = match byte {
                    b'[' => MoreEscapeState::Csi,
                    b']' => MoreEscapeState::Osc,
                    _ => MoreEscapeState::Normal,
                };
            }
            MoreEscapeState::Csi => {
                // CSI sequences end at a final byte in the @–~ range.
                if (0x40..=0x7e).contains(&byte) {
                    self.escape = MoreEscapeState::Normal;
                }
            }
            MoreEscapeState::Osc => match byte {
                0x07 => self.escape = MoreEscapeState::Normal,
                0x1b => self.escape = MoreEscapeState::OscEscape,
                _ => {}
            },
            MoreEscapeState::OscEscape => {
                self.escape = if byte == b'\\' || byte == 0x07 {
                    MoreEscapeState::Normal
                } else {
                    MoreEscapeState::Osc
                };
            }
        }
    }

    fn push_visible(&mut self, character: char) {
        self.window.push(character);
        // feed_byte admits ASCII only. Bound the byte window without counting
        // Unicode characters or rebuilding strings for every incoming byte.
        let excess = self.window.len().saturating_sub(128);
        if excess > 0 {
            self.window.drain(..excess);
        }
        if !character.is_whitespace() {
            self.marker_armed = false;
        }
        let dashed_marker = [b"----more----".as_slice(), b"--more--"]
            .into_iter()
            .any(|marker| {
                let mut visible = self
                    .window
                    .bytes()
                    .rev()
                    .filter(|byte| !byte.is_ascii_whitespace());
                marker.iter().rev().all(|expected| {
                    visible
                        .next()
                        .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
                }) && visible.next() != Some(b'-')
            });
        let plain_marker = self
            .window
            .rsplit('\n')
            .next()
            .is_some_and(|line| line.trim().eq_ignore_ascii_case("more"));
        if (dashed_marker || plain_marker) && !self.marker_armed {
            self.occurrences = self.occurrences.saturating_add(1);
            self.marker_armed = true;
            // A marker has been consumed.  Keeping it in the detector window
            // would make a following occurrence look like the suffix of the
            // previous one (especially after CR/backspace pagination).
            self.window.clear();
        }
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
            b'\r' => {
                index += 1;
                // CRLF is handled by the following LF. A bare CR is common
                // on serial/Telnet devices and still represents a line break
                // for command-output normalization.
                if bytes.get(index) != Some(&b'\n') && !output.ends_with('\n') {
                    output.push('\n');
                }
            }
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

/// A prompt is only a completion marker when the stream has already supplied
/// some command activity before it.  In particular, a PTY can echo the
/// current prompt as a separate chunk before the command echo arrives.  That
/// chunk must not complete the transaction by itself.  A prompt on a line
/// following output (with or without its final line break) remains valid.
fn detect_final_prompt(text: &str) -> Option<String> {
    let candidate = detect_prompt(text)?;
    let position = text.rfind(&candidate)?;
    let prefix = &text[..position];
    if prefix.trim().is_empty() && !text.ends_with('\r') && !text.ends_with('\n') {
        return None;
    }
    Some(candidate)
}

fn prompt_matches_context(candidate: &str, initial_prompt: Option<&str>, command: &str) -> bool {
    if !is_huawei_prompt(candidate) {
        // Huawei configuration separators are standalone '#', not shell
        // prompts. A page ending at a separator must not finalize collection.
        if initial_prompt.is_some_and(is_huawei_prompt) {
            return false;
        }
        return !matches!(candidate, "#" | "$" | "%") || initial_prompt == Some(candidate);
    }
    let Some(initial_prompt) = initial_prompt.filter(|prompt| is_huawei_prompt(prompt)) else {
        // A first transaction may start before the terminal has exposed its
        // prompt state.  Angle-bracket prompts are unambiguous in Huawei user
        // view; for bracket prompts, require either a view separator/digit or
        // an explicit sysname command.  This prevents a final business line
        // such as `[UP]` from completing a transaction while still accepting
        // arbitrary, previously unknown view names.
        if huawei_prompt_is_user_view(candidate) {
            return true;
        }
        if huawei_prompt_inner(candidate).contains('-')
            || huawei_prompt_inner(candidate)
                .chars()
                .any(|character| character.is_ascii_digit())
        {
            return true;
        }
        let mut command_parts = command.split_whitespace();
        if command_parts
            .next()
            .is_some_and(|part| part.eq_ignore_ascii_case("sysname"))
            && command_parts
                .next()
                .is_some_and(|name| prompt_root_matches(huawei_prompt_inner(candidate), name))
        {
            return true;
        }
        return false;
    };
    if candidate == initial_prompt {
        return true;
    }
    let initial_inner = huawei_prompt_inner(initial_prompt);
    let candidate_inner = huawei_prompt_inner(candidate);
    let initial_root = initial_inner.split('-').next().unwrap_or(initial_inner);
    if prompt_root_matches(candidate_inner, initial_root) {
        return true;
    }

    // A sysname command is the one supported way to intentionally change the
    // prompt root. Keep this narrow and data-driven; no Huawei view names are
    // enumerated here.
    let mut command_parts = command.split_whitespace();
    if command_parts
        .next()
        .is_some_and(|part| part.eq_ignore_ascii_case("sysname"))
        && let Some(new_name) = command_parts.next()
    {
        return prompt_root_matches(candidate_inner, new_name);
    }
    false
}

fn huawei_prompt_inner(prompt: &str) -> &str {
    let prompt = huawei_prompt_body(prompt);
    &prompt[1..prompt.len() - 1]
}

fn huawei_prompt_is_user_view(prompt: &str) -> bool {
    let prompt = huawei_prompt_body(prompt);
    prompt.starts_with('<') && prompt.ends_with('>')
}

fn huawei_prompt_body(prompt: &str) -> &str {
    prompt
        .strip_prefix("HRP_M")
        .or_else(|| prompt.strip_prefix("HRP_S"))
        .unwrap_or(prompt)
}

fn prompt_root_matches(candidate: &str, root: &str) -> bool {
    candidate == root
        || candidate
            .strip_prefix(root)
            .and_then(|suffix| suffix.chars().next())
            .is_some_and(|separator| !separator.is_alphanumeric())
}

/// Detect an interactive question only when it is the current logical line.
/// Keeping this check at the stream tail prevents ordinary output such as
/// `Status: [UP]` from pausing a transaction, while still handling prompts
/// that do not end with a line break.
fn detect_interaction(text: &str) -> Option<String> {
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let lower = line.to_ascii_lowercase();
    let compact: String = lower.chars().filter(|ch| !ch.is_whitespace()).collect();
    let has_choice = compact.contains("y/n") || compact.contains("yes/no");
    let question_ending = line.ends_with('?') || line.ends_with(':');
    let named_question =
        (lower.contains("continue") || lower.contains("are you sure") || lower.contains("confirm"))
            && question_ending;
    if (has_choice && (question_ending || lower.ends_with(']') || lower.ends_with(')')))
        || named_question
    {
        Some(line.to_owned())
    } else {
        None
    }
}

fn is_huawei_prompt(line: &str) -> bool {
    let line = line.trim();
    let body = huawei_prompt_body(line);
    let (open, close) = if body.starts_with('<') && body.ends_with('>') {
        ('<', '>')
    } else if body.starts_with('[') && body.ends_with(']') {
        ('[', ']')
    } else {
        return false;
    };
    let inner = &body[open.len_utf8()..body.len() - close.len_utf8()];
    !inner.is_empty()
        && inner.chars().all(|character| {
            !character.is_control() && !character.is_whitespace() && !matches!(character, '<' | '>')
        })
}

#[cfg(test)]
fn count_more_markers(text: &str) -> usize {
    text.lines().filter(|line| is_more_marker(line)).count()
}

#[cfg(test)]
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
        .is_some_and(|line| initial_prompt.is_some_and(|prompt| line.trim() == prompt))
    {
        lines.remove(0);
        while lines.first().is_some_and(|line| line.trim().is_empty()) {
            lines.remove(0);
        }
    } else if lines.len() > 1
        && prompt_matches_context(lines[0].trim(), initial_prompt, command)
        && is_command_echo(&lines[1], command, initial_prompt)
    {
        // Some serial/Telnet servers put the prompt and command echo on
        // separate lines. Treat that leading prompt as terminal framing too.
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
        final_prompt.is_some_and(|prompt| candidate == prompt)
            || (final_prompt.is_none() && detect_prompt(candidate).is_some())
    }) {
        lines.pop();
    }
    lines = lines
        .into_iter()
        .filter_map(|line| {
            if is_standalone_more_marker(&line) {
                return None;
            }
            Some(strip_inline_more_marker(&line))
        })
        .collect();
    lines.join("\n").trim_matches('\n').to_owned()
}

/// Removes an ANSI-normalized pagination marker even when the device keeps it
/// on the same logical line as the next page.  Ordinary words containing
/// `more` are left untouched; only a marker surrounded by at least two dashes
/// is removed inline (a plain `More` is removed above when it is its own line).
fn strip_inline_more_marker(line: &str) -> String {
    let mut value = line.to_owned();
    let mut search_from = 0;
    loop {
        let lower = value.to_ascii_lowercase();
        let Some(relative) = lower[search_from..].find("more") else {
            break;
        };
        let more_start = search_from + relative;
        let more_end = more_start + "more".len();
        let bytes = value.as_bytes();

        let mut left = more_start;
        while left > 0 && bytes[left - 1].is_ascii_whitespace() {
            left -= 1;
        }
        let dash_end = left;
        while left > 0 && bytes[left - 1] == b'-' {
            left -= 1;
        }
        if dash_end - left < 2 {
            search_from = more_end;
            continue;
        }

        let mut right = more_end;
        while right < bytes.len() && bytes[right].is_ascii_whitespace() {
            right += 1;
        }
        let dash_start = right;
        while right < bytes.len() && bytes[right] == b'-' {
            right += 1;
        }
        if right - dash_start < 2 {
            search_from = more_end;
            continue;
        }

        value.replace_range(left..right, "");
        search_from = left;
    }
    value
}

fn is_standalone_more_marker(line: &str) -> bool {
    let compact = line
        .trim()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(compact.as_str(), "more" | "--more--" | "----more----")
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

fn transaction_log(
    target: &AutomationTargetRequest,
    session_id: &str,
    stage: &str,
    started_at: Instant,
) {
    #[cfg(debug_assertions)]
    eprintln!(
        "[neterminai][automation] session={} type={} stage={} duration_ms={} command_transaction",
        session_id,
        target.connection_type,
        stage,
        started_at.elapsed().as_millis()
    );
    #[cfg(not(debug_assertions))]
    let _ = (target, session_id, stage, started_at);
}

fn pagination_trace(transaction_id: u64, session_id: &str, stage: &str, cursor: u64, count: usize) {
    #[cfg(debug_assertions)]
    if std::env::var_os("NETERMINAI_PAGINATION_TRACE").is_some() {
        eprintln!(
            "[neterminai][pagination] transaction={transaction_id} session={session_id} stage={stage} cursor={cursor} count={count}"
        );
    }
    #[cfg(not(debug_assertions))]
    let _ = (transaction_id, session_id, stage, cursor, count);
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
    fn prompt_normalization_handles_ansi_and_line_endings() {
        let raw =
            b"\x1b[32m<FW1>\x1b[0mdisplay health\r\n\x1b[36mNormal\x1b[0m\r\x1b[?25h<FW1>\x1b[0m\r";
        assert_eq!(
            normalize_command_output(raw, "display health", Some("<FW1>"), Some("<FW1>")),
            "Normal"
        );
    }

    #[test]
    fn prompt_detector_ignores_prompt_like_output_lines() {
        let text = "display output\n[not a prompt, still data]\n[FW1]";
        assert_eq!(detect_prompt(text), Some("[FW1]".to_owned()));
        assert_eq!(
            normalize_command_output(
                b"<FW1>display output\r\n[not a prompt, still data]\r\n<FW1>\r\n",
                "display output",
                Some("<FW1>"),
                Some("<FW1>"),
            ),
            "[not a prompt, still data]"
        );
    }

    #[test]
    fn prompt_detector_handles_chunks_split_inside_prompt_and_echo() {
        let mut collector = CommandCollector::new("display health", Some("<FW1>".to_owned()));
        assert!(
            collector
                .push(b"<FW1>display hea")
                .unwrap()
                .prompt
                .is_none()
        );
        assert!(
            collector
                .push(b"lth\r\nNormal\r\n<FW")
                .unwrap()
                .prompt
                .is_none()
        );
        let signal = collector.push(b"1>\r\n").unwrap();
        assert_eq!(signal.prompt.as_deref(), Some("<FW1>"));
        assert_eq!(
            collector.normalized_output(signal.prompt.as_deref()),
            "Normal"
        );
    }

    #[test]
    fn an_echoed_prompt_chunk_does_not_complete_before_command_activity() {
        let mut collector = CommandCollector::new("display health", Some("<FW1>".to_owned()));
        assert!(collector.push(b"<FW1>").unwrap().prompt.is_none());
        assert!(
            collector
                .push(b"display health\r\nNormal\r\n")
                .unwrap()
                .prompt
                .is_none()
        );
        let signal = collector.push(b"<FW1>").unwrap();
        assert_eq!(signal.prompt.as_deref(), Some("<FW1>"));
    }

    #[test]
    fn first_prompt_can_complete_after_a_line_break_without_command_echo() {
        let mut collector = CommandCollector::new("display version", Some("<FW1>".to_owned()));
        assert!(collector.push(b"\r\n<FW1>\r\n").unwrap().prompt.is_some());
    }

    #[test]
    fn prompt_completion_does_not_require_a_command_echo() {
        let mut collector = CommandCollector::new("display health", Some("<FW1>".to_owned()));
        let signal = collector
            .push(b"Slot  Card  Status\r\n0     MPU   Normal\r\n<FW1>\r\n")
            .unwrap();
        assert_eq!(signal.prompt.as_deref(), Some("<FW1>"));
        assert_eq!(
            collector.normalized_output(signal.prompt.as_deref()),
            "Slot  Card  Status\n0     MPU   Normal"
        );
    }

    #[test]
    fn command_echo_normalization_handles_prompt_on_a_separate_line() {
        let raw = b"<FW1>\r\ndisplay health\r\nNormal\r\n<FW1>\r\n";
        assert_eq!(
            normalize_command_output(raw, "display health", Some("<FW1>"), Some("<FW1>")),
            "Normal"
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
        assert_eq!(
            normalize_command_output(
                b"<FW1>system-view\nEnter system view\n[FW1]\n",
                "system-view",
                Some("<FW1>"),
                Some("[FW1]"),
            ),
            "Enter system view"
        );
        assert_eq!(
            normalize_command_output(
                b"[FW1]interface GE0/0/1\r\n[FW1-GigabitEthernet0/0/1]\r\n",
                "interface GE0/0/1",
                Some("[FW1]"),
                Some("[FW1-GigabitEthernet0/0/1]"),
            ),
            ""
        );
    }

    #[test]
    fn prompt_detector_accepts_hrp_role_prefixes_and_role_changes() {
        assert_eq!(
            detect_prompt("HRP_M<FW1>\r\n"),
            Some("HRP_M<FW1>".to_owned())
        );
        assert_eq!(
            detect_prompt("HRP_S[FW1-GigabitEthernet0/0/1]\r\n"),
            Some("HRP_S[FW1-GigabitEthernet0/0/1]".to_owned())
        );

        let mut collector = CommandCollector::new("display health", Some("HRP_M<FW1>".to_owned()));
        assert!(
            collector
                .push(b"Slot  Card  Status\r\n0     MPU   Normal\r\nHRP_S[")
                .unwrap()
                .prompt
                .is_none()
        );
        let signal = collector.push(b"FW1]\r\n").unwrap();
        assert_eq!(signal.prompt.as_deref(), Some("HRP_S[FW1]"));
        assert_eq!(
            collector.normalized_output(signal.prompt.as_deref()),
            "Slot  Card  Status\n0     MPU   Normal"
        );
    }

    #[test]
    fn prompt_detection_is_tail_only_for_bracketed_status_text() {
        let mut collector = CommandCollector::new("display health", Some("<FW1>".to_owned()));
        assert!(
            collector
                .push(b"Status: [UP]\r\n")
                .unwrap()
                .prompt
                .is_none()
        );
        assert!(
            collector
                .push(b"Result: [OK]\r\nPeer: [Established]\r\n")
                .unwrap()
                .prompt
                .is_none()
        );
        assert!(collector.push(b"[UP]\r\n").unwrap().prompt.is_none());
        let signal = collector
            .push(b"Normal\r\n[FW1-arbitrary-future-view]\r\n")
            .unwrap();
        assert_eq!(
            signal.prompt.as_deref(),
            Some("[FW1-arbitrary-future-view]")
        );
    }

    #[test]
    fn first_transaction_does_not_treat_bracketed_status_as_prompt() {
        let mut collector = CommandCollector::new("display health", None);
        assert!(
            collector
                .push(b"Status: [UP]\r\n[UP]\r\n")
                .unwrap()
                .prompt
                .is_none()
        );
        let signal = collector.push(b"[FW1]\r\n").unwrap();
        assert_eq!(signal.prompt.as_deref(), Some("[FW1]"));
    }

    #[test]
    fn normalization_keeps_standalone_status_lines_before_the_final_prompt() {
        let raw = b"<FW1>display health\r\n[UP]\r\n[OK]\r\n[Established]\r\n<FW1>\r\n";
        assert_eq!(
            normalize_command_output(raw, "display health", Some("<FW1>"), Some("<FW1>")),
            "[UP]\n[OK]\n[Established]"
        );
    }

    #[test]
    fn sysname_change_updates_prompt_context_without_view_enumeration() {
        let mut collector = CommandCollector::new("sysname NEWNAME", Some("<FW1>".to_owned()));
        let signal = collector.push(b"sysname NEWNAME\r\n[NEWNAME]\r\n").unwrap();
        assert_eq!(signal.prompt.as_deref(), Some("[NEWNAME]"));
        assert_eq!(collector.normalized_output(signal.prompt.as_deref()), "");
    }

    #[test]
    fn interaction_prompt_is_detected_across_chunks_and_can_repeat() {
        let mut collector = CommandCollector::new("reset", Some("<FW1>".to_owned()));
        assert!(
            collector
                .push(b"Continue? [Y")
                .unwrap()
                .interaction
                .is_none()
        );
        let signal = collector.push(b"/N]:").unwrap();
        assert_eq!(signal.interaction.as_deref(), Some("Continue? [Y/N]:"));
        collector.mark_interaction_handled();
        assert!(collector.push(b"y\r\n").unwrap().interaction.is_none());
        let signal = collector.push(b"Continue? [Y/N]:").unwrap();
        assert_eq!(signal.interaction.as_deref(), Some("Continue? [Y/N]:"));
    }

    #[test]
    fn more_and_interaction_can_be_seen_in_one_stream_update() {
        let mut collector = CommandCollector::new("display current-configuration", None);
        let signal = collector
            .push(b"line one\r\n---- More ----\r\nContinue? [Y/N]:")
            .unwrap();
        assert_eq!(signal.more_markers, 1);
        assert_eq!(signal.interaction.as_deref(), Some("Continue? [Y/N]:"));
        collector.mark_interaction_handled();
        let next = collector.push(b"y\r\n<FW1>\r\n").unwrap();
        assert_eq!(next.prompt.as_deref(), Some("<FW1>"));
    }

    #[test]
    fn more_markers_are_detected_and_removed_from_output() {
        let raw = b"<FW1>display current-configuration\r\nline one\r\n\x1b[7m---- More ----\x1b[0m\r\nline two\r\n<FW1>\r\n";
        let normalized =
            normalize_command_output(raw, "display current-configuration", None, Some("<FW1>"));
        assert_eq!(normalized, "line one\nline two");
        assert_eq!(count_more_markers(&normalize_terminal_text(raw)), 1);
    }

    #[test]
    fn more_markers_are_counted_across_chunks_without_tail_double_counting() {
        let mut collector = CommandCollector::new("display current-configuration", None);
        let first = collector
            .push(b"<FW1>display current-configuration\r\nline one\r\n\x1b[7m---- More")
            .unwrap();
        assert_eq!(first.more_markers, 0);
        let second = collector.push(b" ----\x1b[0m\r\nline two\r\n").unwrap();
        assert_eq!(second.more_markers, 1);

        let mut large_chunk = vec![b'x'; 9 * 1024];
        large_chunk.extend_from_slice(b"\r\n---- More ----\r\n");
        let third = collector.push(&large_chunk).unwrap();
        assert_eq!(third.more_markers, 2);
    }

    #[test]
    fn repeated_more_markers_are_rearmed_and_counted_once_each() {
        let mut collector = CommandCollector::new("display current-configuration", None);
        for index in 0..50 {
            let first = collector.push(b"\x1b[7m---- Mo").unwrap();
            assert_eq!(first.more_markers, index);
            let signal = collector.push(b"re ----\x1b[0m\r").unwrap();
            assert_eq!(signal.more_markers, index + 1);
        }
        assert_eq!(collector.more_markers_seen, 50);
    }

    #[test]
    fn pagination_detector_covers_common_page_lengths() {
        for expected in [1, 2, 4, 5, 6, 10, 50] {
            let mut collector = CommandCollector::new("display current-configuration", None);
            let mut transport = Vec::new();
            for index in 0..expected {
                let signal = collector.push(b"---- More ----\r").unwrap();
                assert_eq!(signal.more_markers, index + 1);
                crate::io_pump::ControlWriteTrace {
                    events: None,
                    transaction: 1,
                    occurrence: index + 1,
                    limit: MAX_PAGINATION_COUNT,
                    cursor: index as u64 + 1,
                    started: Instant::now(),
                }
                .write("test-session", &mut transport)
                .unwrap();
            }
            assert_eq!(collector.more_markers_seen, expected);
            assert_eq!(transport, vec![0x20; expected]);
        }
    }

    #[test]
    fn long_output_keeps_pagination_detector_window_bounded() {
        let mut collector = CommandCollector::new("display current-configuration", None);
        let business = "设备状态 [UP] 保留业务文本\r\n".repeat(1000);
        for page in 1..=50 {
            for chunk in business.as_bytes().chunks(127) {
                collector.push(chunk).unwrap();
                assert!(collector.more_detector.window.len() <= 128);
            }
            for chunk in b"\x1b[7m---- More ----\x1b[0m\r".chunks(1) {
                collector.push(chunk).unwrap();
            }
            assert_eq!(collector.more_markers_seen, page);
        }
        let signal = collector.push(b"\r\n<FW1>").unwrap();
        assert_eq!(signal.prompt.as_deref(), Some("<FW1>"));
        let output = collector.normalized_output(Some("<FW1>"));
        assert_eq!(output.matches("设备状态 [UP] 保留业务文本").count(), 50_000);
        assert!(!output.contains("More"));
    }

    #[test]
    fn more_markers_without_newlines_and_with_backspace_are_each_detected() {
        let mut collector = CommandCollector::new("display current-configuration", None);
        assert_eq!(collector.push(b"---- More ----").unwrap().more_markers, 1);
        assert_eq!(
            collector
                .push(b"\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08\x08")
                .unwrap()
                .more_markers,
            1
        );
        assert_eq!(collector.push(b"\x1b[7m-- Mo").unwrap().more_markers, 1);
        assert_eq!(collector.push(b"re --\x1b[0m").unwrap().more_markers, 2);
    }

    #[test]
    fn inline_more_marker_is_removed_without_dropping_adjacent_page_output() {
        assert_eq!(
            normalize_command_output(
                b"<FW1>display current-configuration\r\nline one\r\n---- More ----line two\r\n<FW1>\r\n",
                "display current-configuration",
                Some("<FW1>"),
                Some("<FW1>"),
            ),
            "line one\nline two"
        );
    }

    #[test]
    fn trailing_more_marker_is_detected_before_its_line_break() {
        let mut collector = CommandCollector::new("display current-configuration", None);
        let first = collector.push(b"line one\r\n---- More ----").unwrap();
        assert_eq!(first.more_markers, 1);
        let second = collector.push(b"\r\nline two\r\n<FW1>\r\n").unwrap();
        assert_eq!(second.more_markers, 1);
        assert_eq!(second.prompt.as_deref(), Some("<FW1>"));
    }

    #[test]
    fn interaction_responses_compile_as_regex_and_reject_invalid_patterns() {
        let responses =
            compile_interaction_responses(&[(r"Continue.*\[Y/N\]".to_owned(), "y".to_owned())])
                .unwrap();
        assert!(responses[0].pattern.is_match("Continue? [Y/N]:"));
        let error = compile_interaction_responses(&[("[".to_owned(), "y".to_owned())])
            .expect_err("invalid interaction regex should be rejected");
        assert_eq!(error.code, "invalid_argument");
    }

    #[test]
    fn cli_error_text_is_returned_as_output_when_prompt_returns() {
        let raw = b"<FW1>this-command-does-not-exist\r\nError: Unrecognized command\r\n<FW1>\r\n";
        assert_eq!(
            normalize_command_output(
                raw,
                "this-command-does-not-exist",
                Some("<FW1>"),
                Some("<FW1>"),
            ),
            "Error: Unrecognized command"
        );
    }

    #[test]
    fn output_hub_isolates_subscribers_by_session() {
        let hub = TerminalOutputHub::default();
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
    fn closing_output_hub_unblocks_waiting_subscriber() {
        let hub = TerminalOutputHub::default();
        let subscription = hub.subscribe("session-a");
        hub.close_session("session-a");
        assert!(matches!(
            subscription.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Disconnected)
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

    #[test]
    fn command_collector_rejects_unbounded_output() {
        let mut collector = CommandCollector::new("display huge", None);
        let chunk = vec![b'x'; MAX_COLLECTED_OUTPUT_BYTES];
        collector.push(&chunk).unwrap();
        assert!(collector.push(b"x").is_err());
    }

    #[test]
    fn command_lock_reports_busy_without_leaking_the_lock() {
        let lock = Mutex::new(());
        let _guard = lock.lock().unwrap();
        let control = AutomationRunControl {
            cancelled: AtomicBool::new(false),
            child_pids: Mutex::new(HashSet::new()),
        };
        let error = acquire_command_lock(&lock, &control, "session-1", "display health")
            .expect_err("a held session lock should be rejected");
        assert_eq!(error.code, "session_busy");
    }
}
