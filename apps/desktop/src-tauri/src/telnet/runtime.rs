use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::connection_state::{ConnectionErrorKind, ConnectionStateTracker, DisconnectReason};
use crate::io_pump::{
    MAX_IO_CHUNK_BYTES, OUTPUT_BATCH_BYTES, OutputReceiver, OutputSender, QueueSendError,
    output_queue,
};
use crate::lifecycle::{
    AdmissionGate, AdmissionPermit, CancellationToken, CloseOnce, Lifecycle, LifecycleStage,
    WorkerKind, WorkerSupervisor,
};

use super::{
    EXIT_EVENT, OUTPUT_EVENT, TelnetProtocol, append_prompt_text, escape_iac, line_message,
    window_size_message,
};

const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONTROL_QUEUE_CAPACITY: usize = 16;

pub struct TelnetManager {
    cleanup: CleanupCoordinator,
    inner: Arc<TelnetManagerInner>,
}

struct TelnetManagerInner {
    sessions: Mutex<HashMap<String, SessionState>>,
    admission: AdmissionGate,
}

enum SessionState {
    Starting(Arc<TelnetRuntime>),
    Running(Arc<TelnetRuntime>),
    Closing(Arc<TelnetRuntime>),
}

struct TelnetRuntime {
    control: Arc<SessionControl>,
    resources: Mutex<Option<TelnetResources>>,
    output_sender: Mutex<Option<OutputSender>>,
    workers: WorkerSupervisor,
    start_gate: Arc<StartGate>,
    initializing: AtomicBool,
    creation_permit: Mutex<Option<AdmissionPermit>>,
    cleanup: Mutex<CleanupProgress>,
    cleanup_sender: Sender<CleanupRequest>,
}

pub(crate) struct SessionControl {
    lifecycle: Lifecycle,
    cancellation: CancellationToken,
    close_once: CloseOnce,
    instance: Arc<()>,
    connection_state: ConnectionStateTracker,
    transition_lock: Mutex<()>,
}

struct TelnetResources {
    control: TcpStream,
    writer: SyncSender<WriterMessage>,
    control_writer: SyncSender<WriterMessage>,
    window_size_enabled: Arc<AtomicBool>,
}

struct LoginCredentials {
    username: String,
    password: String,
}

struct TerminalGeometry {
    columns: u16,
    rows: u16,
    window_size_enabled: Arc<AtomicBool>,
}

enum WriterMessage {
    Bytes(Vec<u8>),
    Shutdown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelnetOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelnetExit {
    session_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CleanupProgress {
    Idle,
    Running,
    Completed,
}

enum CleanupRequest {
    Session {
        session_id: String,
        instance: Arc<()>,
        deadline: Instant,
    },
    Stop,
}

struct CleanupCoordinator {
    sender: Sender<CleanupRequest>,
    stop: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

struct StartGate {
    open: AtomicBool,
    cancelled: AtomicBool,
}

impl StartGate {
    fn new() -> Self {
        Self {
            open: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
        }
    }

    fn release(&self) {
        self.open.store(true, Ordering::Release);
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn wait(&self, cancellation: &CancellationToken) -> bool {
        while !self.open.load(Ordering::Acquire) {
            if self.cancelled.load(Ordering::Acquire) || cancellation.is_cancelled() {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        !self.cancelled.load(Ordering::Acquire) && !cancellation.is_cancelled()
    }
}

impl SessionControl {
    fn new(session_id: &str) -> Self {
        let instance = Arc::new(());
        let instance_token = format!("{:p}", Arc::as_ptr(&instance));
        Self {
            lifecycle: Lifecycle::new(),
            cancellation: CancellationToken::new(),
            close_once: CloseOnce::default(),
            instance,
            connection_state: ConnectionStateTracker::new(session_id, "telnet", instance_token),
            transition_lock: Mutex::new(()),
        }
    }

    fn request_close_with(&self, reason: DisconnectReason) -> bool {
        let _transition = lock_unpoisoned(&self.transition_lock);
        let first = self.close_once.request();
        self.cancellation.cancel();
        if first {
            let _ = self.lifecycle.begin_close();
            self.connection_state.closing(reason);
        }
        first
    }

    fn mark_failed_with(
        &self,
        reason: DisconnectReason,
        error: ConnectionErrorKind,
        message: Option<String>,
    ) {
        let _transition = lock_unpoisoned(&self.transition_lock);
        if matches!(
            self.lifecycle.stage(),
            LifecycleStage::Starting | LifecycleStage::Running
        ) {
            let _ = self.lifecycle.transition(LifecycleStage::Failed);
            self.cancellation.cancel();
            self.connection_state.failed(reason, error, message);
        }
    }

    fn publish_running(&self) -> bool {
        let _transition = lock_unpoisoned(&self.transition_lock);
        if self.close_once.is_requested() || self.cancellation.is_cancelled() {
            return false;
        }
        if self.lifecycle.transition(LifecycleStage::Running).is_err() {
            return false;
        }
        self.connection_state.connected()
    }

    fn mark_disconnected(&self, reason: DisconnectReason) {
        let _transition = lock_unpoisoned(&self.transition_lock);
        self.close_once.request();
        self.cancellation.cancel();
        let _ = self.lifecycle.begin_close();
        self.connection_state.disconnected(reason);
    }

    fn bind_app(&self, app: &AppHandle) {
        self.connection_state.bind_app(app);
    }

    fn writable(&self) -> bool {
        self.lifecycle.stage() == LifecycleStage::Running
            && !self.close_once.is_requested()
            && !self.cancellation.is_cancelled()
    }
}

impl TelnetRuntime {
    fn new(session_id: &str, permit: AdmissionPermit, sender: Sender<CleanupRequest>) -> Self {
        Self {
            control: Arc::new(SessionControl::new(session_id)),
            resources: Mutex::new(None),
            output_sender: Mutex::new(None),
            workers: WorkerSupervisor::new(),
            start_gate: Arc::new(StartGate::new()),
            initializing: AtomicBool::new(true),
            creation_permit: Mutex::new(Some(permit)),
            cleanup: Mutex::new(CleanupProgress::Idle),
            cleanup_sender: sender,
        }
    }

    fn finish_initialization(&self) {
        self.initializing.store(false, Ordering::Release);
        lock_unpoisoned(&self.creation_permit).take();
    }

    fn begin_cleanup(&self) -> bool {
        let mut progress = lock_unpoisoned(&self.cleanup);
        if *progress != CleanupProgress::Idle {
            return false;
        }
        *progress = CleanupProgress::Running;
        true
    }

    fn finish_cleanup(&self, complete: bool) {
        *lock_unpoisoned(&self.cleanup) = if complete {
            CleanupProgress::Completed
        } else {
            CleanupProgress::Idle
        };
    }

    fn queue_cleanup(&self, session_id: &str) {
        let _ = self.cleanup_sender.send(CleanupRequest::Session {
            session_id: session_id.to_owned(),
            instance: Arc::clone(&self.control.instance),
            deadline: Instant::now() + SESSION_CLOSE_TIMEOUT,
        });
    }
}

impl Default for TelnetManager {
    fn default() -> Self {
        let inner = Arc::new(TelnetManagerInner {
            sessions: Mutex::new(HashMap::new()),
            admission: AdmissionGate::new(),
        });
        let cleanup = CleanupCoordinator::new(&inner);
        Self { cleanup, inner }
    }
}

impl TelnetManager {
    pub(crate) fn begin(&self, session_id: &str) -> Result<Arc<SessionControl>, String> {
        let permit = self
            .inner
            .admission
            .try_enter()
            .ok_or_else(|| "应用正在退出，无法创建 Telnet 会话".to_owned())?;
        let runtime = Arc::new(TelnetRuntime::new(
            session_id,
            permit,
            self.cleanup.sender.clone(),
        ));
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        if sessions.contains_key(session_id) {
            return Err("Telnet 会话已存在".to_owned());
        }
        sessions.insert(
            session_id.to_owned(),
            SessionState::Starting(Arc::clone(&runtime)),
        );
        lifecycle_log(session_id, "telnet", "session create");
        Ok(Arc::clone(&runtime.control))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create(
        &self,
        app: AppHandle,
        session_id: String,
        host: String,
        port: u16,
        username: String,
        password: String,
        columns: u16,
        rows: u16,
        control: Arc<SessionControl>,
    ) -> Result<(), String> {
        let runtime = self.runtime_for_control(&session_id, &control)?;
        runtime.control.bind_app(&app);
        let _guard = InitializationGuard(Arc::clone(&runtime));
        let stream = match connect(&host, port, &control.cancellation) {
            Ok(stream) => stream,
            Err(failure) => {
                if control.close_once.is_requested() || control.cancellation.is_cancelled() {
                    runtime
                        .control
                        .request_close_with(DisconnectReason::UserRequested);
                    runtime.queue_cleanup(&session_id);
                    return Err("Telnet 连接已取消".to_owned());
                }
                let reason = failure.reason;
                runtime.control.mark_failed_with(
                    reason,
                    failure.error,
                    Some(failure.message.clone()),
                );
                runtime.control.request_close_with(reason);
                runtime.queue_cleanup(&session_id);
                return Err(failure.message);
            }
        };
        if control.close_once.is_requested() || control.cancellation.is_cancelled() {
            let _ = stream.shutdown(Shutdown::Both);
            runtime
                .control
                .request_close_with(DisconnectReason::UserRequested);
            runtime.queue_cleanup(&session_id);
            return Err("Telnet 连接已取消".to_owned());
        }
        let reader = match stream.try_clone() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = stream.shutdown(Shutdown::Both);
                runtime.control.mark_failed_with(
                    DisconnectReason::ReadFailed,
                    ConnectionErrorKind::Transport,
                    Some(error.to_string()),
                );
                runtime
                    .control
                    .request_close_with(DisconnectReason::ReadFailed);
                runtime.queue_cleanup(&session_id);
                return Err(format!("无法读取 Telnet 连接：{error}"));
            }
        };
        let control_stream = match stream.try_clone() {
            Ok(control_stream) => control_stream,
            Err(error) => {
                let _ = stream.shutdown(Shutdown::Both);
                runtime.control.mark_failed_with(
                    DisconnectReason::ConnectionFailed,
                    ConnectionErrorKind::Transport,
                    Some(error.to_string()),
                );
                runtime
                    .control
                    .request_close_with(DisconnectReason::ConnectionFailed);
                runtime.queue_cleanup(&session_id);
                return Err(format!("无法管理 Telnet 连接：{error}"));
            }
        };
        let (writer, writer_receiver) = mpsc::sync_channel(crate::io_pump::INPUT_QUEUE_CAPACITY);
        let (control_writer, control_receiver) = mpsc::sync_channel(CONTROL_QUEUE_CAPACITY);
        let window_size_enabled = Arc::new(AtomicBool::new(false));
        *lock_unpoisoned(&runtime.resources) = Some(TelnetResources {
            control: control_stream,
            writer: writer.clone(),
            control_writer: control_writer.clone(),
            window_size_enabled: Arc::clone(&window_size_enabled),
        });
        let (output_sender, output_receiver) = output_queue();
        *lock_unpoisoned(&runtime.output_sender) = Some(output_sender.clone());

        let output_control = Arc::clone(&runtime.control);
        let output_gate = Arc::clone(&runtime.start_gate);
        let output_session = session_id.clone();
        let output_cleanup = self.cleanup.sender.clone();
        let output_app = app.clone();
        if runtime
            .workers
            .spawn(WorkerKind::Other, move |worker_cancel| {
                run_output_pump(
                    output_app,
                    output_session,
                    output_receiver,
                    worker_cancel,
                    output_control,
                    output_gate,
                    output_cleanup,
                );
            })
            .is_err()
        {
            runtime.control.mark_failed_with(
                DisconnectReason::ReadFailed,
                ConnectionErrorKind::Transport,
                Some("Telnet 输出线程启动失败".to_owned()),
            );
            runtime
                .control
                .request_close_with(DisconnectReason::ReadFailed);
            runtime.start_gate.cancel();
            runtime.workers.stop_accepting();
            runtime.workers.request_shutdown();
            lock_unpoisoned(&runtime.output_sender).take();
            let resources = lock_unpoisoned(&runtime.resources).take();
            shutdown_resources(resources.expect("Telnet resources installed"));
            runtime.queue_cleanup(&session_id);
            return Err("Telnet 输出线程启动失败".to_owned());
        }

        let writer_control = Arc::clone(&runtime.control);
        let writer_gate = Arc::clone(&runtime.start_gate);
        let writer_session = session_id.clone();
        let writer_cleanup = self.cleanup.sender.clone();
        if runtime
            .workers
            .spawn(WorkerKind::Writer, move |worker_cancel| {
                run_writer(
                    stream,
                    writer_receiver,
                    control_receiver,
                    worker_cancel,
                    writer_control,
                    writer_gate,
                    writer_session,
                    writer_cleanup,
                )
            })
            .is_err()
        {
            runtime.control.mark_failed_with(
                DisconnectReason::WriteFailed,
                ConnectionErrorKind::Transport,
                Some("Telnet 写入线程启动失败".to_owned()),
            );
            runtime
                .control
                .request_close_with(DisconnectReason::WriteFailed);
            runtime.start_gate.cancel();
            runtime.workers.stop_accepting();
            runtime.workers.request_shutdown();
            let resources = lock_unpoisoned(&runtime.resources).take();
            shutdown_resources(resources.expect("Telnet resources installed"));
            runtime.queue_cleanup(&session_id);
            return Err("Telnet 写入线程启动失败".to_owned());
        }

        let reader_control = Arc::clone(&runtime.control);
        let reader_gate = Arc::clone(&runtime.start_gate);
        let reader_session = session_id.clone();
        let reader_cleanup = self.cleanup.sender.clone();
        let credentials = LoginCredentials { username, password };
        let geometry = TerminalGeometry {
            columns,
            rows,
            window_size_enabled,
        };
        if runtime
            .workers
            .spawn(WorkerKind::Reader, move |worker_cancel| {
                run_reader(
                    app,
                    reader_session,
                    reader,
                    control_writer,
                    output_sender,
                    credentials,
                    geometry,
                    worker_cancel,
                    reader_control,
                    reader_gate,
                    reader_cleanup,
                )
            })
            .is_err()
        {
            runtime.control.mark_failed_with(
                DisconnectReason::ReadFailed,
                ConnectionErrorKind::Transport,
                Some("Telnet 读取线程启动失败".to_owned()),
            );
            runtime
                .control
                .request_close_with(DisconnectReason::ReadFailed);
            runtime.start_gate.cancel();
            runtime.workers.stop_accepting();
            runtime.workers.request_shutdown();
            let resources = lock_unpoisoned(&runtime.resources).take();
            shutdown_resources(resources.expect("Telnet resources installed"));
            runtime.queue_cleanup(&session_id);
            return Err("Telnet 读取线程启动失败".to_owned());
        }

        if !(self.is_current_starting(&session_id, &runtime) && runtime.control.publish_running()) {
            runtime
                .control
                .request_close_with(DisconnectReason::UserRequested);
            runtime.start_gate.cancel();
            runtime.workers.stop_accepting();
            runtime.workers.request_shutdown();
            let resources = lock_unpoisoned(&runtime.resources).take();
            shutdown_resources(resources.expect("Telnet resources installed"));
            runtime.queue_cleanup(&session_id);
            return Err("Telnet 连接已取消".to_owned());
        }
        self.promote_running(&session_id, &runtime);
        runtime.start_gate.release();
        lifecycle_log(&session_id, "telnet", "session running");
        Ok(())
    }

    pub(crate) fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let escaped = escape_iac(data);
        if escaped.len() > MAX_IO_CHUNK_BYTES {
            return Err(format!(
                "Telnet 单次输入超过 {} KB，请分段粘贴",
                MAX_IO_CHUNK_BYTES / 1024
            ));
        }
        self.send(session_id, WriterMessage::Bytes(escaped))
    }

    pub(crate) fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let runtime = self.running_runtime(session_id)?;
        let resources = lock_unpoisoned(&runtime.resources);
        let resources = resources
            .as_ref()
            .ok_or_else(|| "Telnet 连接已关闭".to_owned())?;
        if !resources.window_size_enabled.load(Ordering::Acquire) {
            return Ok(());
        }
        resources
            .control_writer
            .try_send(WriterMessage::Bytes(window_size_message(columns, rows)))
            .map_err(|error| match error {
                TrySendError::Full(_) => "Telnet 协议控制队列繁忙，请稍后重试".to_owned(),
                TrySendError::Disconnected(_) => "Telnet 连接已关闭".to_owned(),
            })
    }

    pub(crate) fn close(&self, session_id: &str) -> Result<(), String> {
        let runtime = self.runtime(session_id)?;
        runtime
            .control
            .request_close_with(DisconnectReason::UserRequested);
        runtime.start_gate.cancel();
        self.mark_closing(session_id, &runtime);
        runtime.queue_cleanup(session_id);
        lifecycle_log(session_id, "telnet", "close requested");
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn shutdown(&self, deadline: Instant) {
        self.inner.admission.close();
        let _ = self.inner.admission.wait_for_drain(deadline);
        let runtimes = lock_unpoisoned(&self.inner.sessions)
            .values()
            .map(|state| match state {
                SessionState::Starting(runtime)
                | SessionState::Running(runtime)
                | SessionState::Closing(runtime) => Arc::clone(runtime),
            })
            .collect::<Vec<_>>();
        for runtime in &runtimes {
            runtime
                .control
                .request_close_with(DisconnectReason::ApplicationShutdown);
            runtime.start_gate.cancel();
        }
        for runtime in runtimes {
            let session_id = self.session_id_for(&runtime);
            cleanup_one(
                &self.inner,
                &session_id,
                &runtime.control.instance,
                deadline,
            );
        }
    }

    pub(crate) fn stop_cleanup(&self) {
        self.cleanup.stop_and_join();
    }

    fn runtime(&self, session_id: &str) -> Result<Arc<TelnetRuntime>, String> {
        let sessions = lock_unpoisoned(&self.inner.sessions);
        match sessions.get(session_id) {
            Some(
                SessionState::Starting(runtime)
                | SessionState::Running(runtime)
                | SessionState::Closing(runtime),
            ) => Ok(Arc::clone(runtime)),
            None => Err("Telnet 会话不存在".to_owned()),
        }
    }

    fn runtime_for_control(
        &self,
        session_id: &str,
        control: &Arc<SessionControl>,
    ) -> Result<Arc<TelnetRuntime>, String> {
        let runtime = self.runtime(session_id)?;
        if Arc::ptr_eq(&runtime.control, control) {
            Ok(runtime)
        } else {
            Err("Telnet 会话已被替换".to_owned())
        }
    }

    fn running_runtime(&self, session_id: &str) -> Result<Arc<TelnetRuntime>, String> {
        let runtime = self.runtime(session_id)?;
        if runtime.control.writable() {
            Ok(runtime)
        } else {
            Err("Telnet 会话仍在连接中或已关闭".to_owned())
        }
    }

    fn send(&self, session_id: &str, message: WriterMessage) -> Result<(), String> {
        let runtime = self.running_runtime(session_id)?;
        let writer = lock_unpoisoned(&runtime.resources)
            .as_ref()
            .filter(|_| runtime.control.writable())
            .map(|resources| resources.writer.clone())
            .ok_or_else(|| "Telnet 连接已关闭".to_owned())?;
        match writer.try_send(message) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err("Telnet 输入队列繁忙，请稍后重试".to_owned()),
            Err(TrySendError::Disconnected(_)) => Err("Telnet 连接已关闭".to_owned()),
        }
    }

    fn is_current_starting(&self, session_id: &str, runtime: &Arc<TelnetRuntime>) -> bool {
        matches!(
            lock_unpoisoned(&self.inner.sessions).get(session_id),
            Some(SessionState::Starting(current)) if Arc::ptr_eq(current, runtime)
        )
    }

    fn promote_running(&self, session_id: &str, runtime: &Arc<TelnetRuntime>) {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        if matches!(
            sessions.get(session_id),
            Some(SessionState::Starting(current)) if Arc::ptr_eq(current, runtime)
        ) {
            sessions.insert(
                session_id.to_owned(),
                SessionState::Running(Arc::clone(runtime)),
            );
        }
    }

    fn mark_closing(&self, session_id: &str, runtime: &Arc<TelnetRuntime>) {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        if matches!(
            sessions.get(session_id),
            Some(SessionState::Starting(current) | SessionState::Running(current))
                if Arc::ptr_eq(current, runtime)
        ) {
            sessions.insert(
                session_id.to_owned(),
                SessionState::Closing(Arc::clone(runtime)),
            );
        }
    }

    #[allow(dead_code)]
    fn session_id_for(&self, runtime: &Arc<TelnetRuntime>) -> String {
        lock_unpoisoned(&self.inner.sessions)
            .iter()
            .find_map(|(id, state)| {
                let current = match state {
                    SessionState::Starting(value)
                    | SessionState::Running(value)
                    | SessionState::Closing(value) => value,
                };
                Arc::ptr_eq(current, runtime).then(|| id.clone())
            })
            .unwrap_or_default()
    }
}

impl CleanupCoordinator {
    fn new(inner: &Arc<TelnetManagerInner>) -> Self {
        let (sender, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let weak = Arc::downgrade(inner);
        let loop_stop = Arc::clone(&stop);
        let retry_sender = sender.clone();
        let join = thread::Builder::new()
            .name("neterminai-telnet-cleanup".to_owned())
            .spawn(move || cleanup_loop(weak, receiver, retry_sender, loop_stop))
            .expect("unable to start Telnet cleanup coordinator");
        Self {
            sender,
            stop,
            join: Mutex::new(Some(join)),
        }
    }
}

impl Drop for CleanupCoordinator {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}

impl CleanupCoordinator {
    fn stop_and_join(&self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.sender.send(CleanupRequest::Stop);
        if let Some(join) = lock_unpoisoned(&self.join).take()
            && join.thread().id() != thread::current().id()
        {
            let _ = join.join();
        }
    }
}

fn cleanup_loop(
    inner: std::sync::Weak<TelnetManagerInner>,
    receiver: Receiver<CleanupRequest>,
    retry_sender: Sender<CleanupRequest>,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::Acquire) {
        let request = match receiver.recv() {
            Ok(request) => request,
            Err(_) => break,
        };
        let CleanupRequest::Session {
            session_id,
            instance,
            deadline,
        } = request
        else {
            break;
        };
        let Some(inner) = inner.upgrade() else {
            break;
        };
        if !cleanup_one(&inner, &session_id, &instance, deadline) && !stop.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(50));
            let _ = retry_sender.send(CleanupRequest::Session {
                session_id,
                instance,
                deadline: Instant::now() + SESSION_CLOSE_TIMEOUT,
            });
        }
    }
}

fn cleanup_one(
    inner: &TelnetManagerInner,
    session_id: &str,
    instance: &Arc<()>,
    deadline: Instant,
) -> bool {
    let runtime = {
        let sessions = lock_unpoisoned(&inner.sessions);
        match sessions.get(session_id) {
            Some(
                SessionState::Starting(runtime)
                | SessionState::Running(runtime)
                | SessionState::Closing(runtime),
            ) if Arc::ptr_eq(&runtime.control.instance, instance) => Arc::clone(runtime),
            _ => return true,
        }
    };
    {
        let mut sessions = lock_unpoisoned(&inner.sessions);
        if matches!(
            sessions.get(session_id),
            Some(SessionState::Starting(current) | SessionState::Running(current))
                if Arc::ptr_eq(current, &runtime)
        ) {
            sessions.insert(
                session_id.to_owned(),
                SessionState::Closing(Arc::clone(&runtime)),
            );
        }
    }
    if !runtime.begin_cleanup() {
        return false;
    }
    runtime
        .control
        .request_close_with(DisconnectReason::Unknown);
    runtime.start_gate.cancel();
    runtime.workers.stop_accepting();
    runtime.workers.request_shutdown();
    lock_unpoisoned(&runtime.output_sender).take();
    if let Some(resources) = lock_unpoisoned(&runtime.resources).take() {
        shutdown_resources(resources);
    }
    let report = runtime.workers.wait_until(deadline);
    let complete = !runtime.initializing.load(Ordering::Acquire)
        && report.timed_out == 0
        && runtime.workers.active_count() == 0;
    if complete {
        runtime.control.mark_disconnected(DisconnectReason::Unknown);
        let _ = runtime.control.lifecycle.finish_close();
        runtime.finish_cleanup(true);
        let mut sessions = lock_unpoisoned(&inner.sessions);
        if matches!(
            sessions.get(session_id),
            Some(SessionState::Closing(current))
                if Arc::ptr_eq(current, &runtime)
                    && Arc::ptr_eq(&current.control.instance, instance)
        ) {
            sessions.remove(session_id);
            lifecycle_log(session_id, "telnet", "session removed");
        }
        true
    } else {
        lifecycle_log(session_id, "telnet", "cleanup timeout");
        runtime.finish_cleanup(false);
        false
    }
}

#[allow(clippy::too_many_arguments)]
fn run_writer(
    mut stream: TcpStream,
    receiver: Receiver<WriterMessage>,
    control_receiver: Receiver<WriterMessage>,
    worker_cancel: CancellationToken,
    control: Arc<SessionControl>,
    start_gate: Arc<StartGate>,
    session_id: String,
    cleanup_sender: Sender<CleanupRequest>,
) {
    if !start_gate.wait(&control.cancellation) {
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    loop {
        if worker_cancel.is_cancelled() || !control.writable() {
            break;
        }
        let message = match control_receiver.try_recv() {
            Ok(message) => message,
            Err(mpsc::TryRecvError::Empty) | Err(mpsc::TryRecvError::Disconnected) => {
                match receiver.recv_timeout(crate::io_pump::QUEUE_RETRY_INTERVAL) {
                    Ok(message) => message,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        };
        match message {
            WriterMessage::Bytes(bytes) => {
                if worker_cancel.is_cancelled() || !control.writable() {
                    break;
                }
                if let Err(error) = stream.write_all(&bytes).and_then(|_| stream.flush()) {
                    control.mark_failed_with(
                        DisconnectReason::WriteFailed,
                        ConnectionErrorKind::Transport,
                        Some(error.to_string()),
                    );
                    control.request_close_with(DisconnectReason::WriteFailed);
                    let _ = cleanup_sender.send(CleanupRequest::Session {
                        session_id: session_id.clone(),
                        instance: Arc::clone(&control.instance),
                        deadline: Instant::now() + SESSION_CLOSE_TIMEOUT,
                    });
                    break;
                }
            }
            WriterMessage::Shutdown => break,
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}

#[allow(clippy::too_many_arguments)]
fn run_reader(
    app: AppHandle,
    session_id: String,
    mut reader: TcpStream,
    control_writer: SyncSender<WriterMessage>,
    output_sender: OutputSender,
    credentials: LoginCredentials,
    geometry: TerminalGeometry,
    worker_cancel: CancellationToken,
    control: Arc<SessionControl>,
    start_gate: Arc<StartGate>,
    cleanup_sender: Sender<CleanupRequest>,
) {
    if !start_gate.wait(&control.cancellation) {
        let _ = reader.shutdown(Shutdown::Both);
        return;
    }
    let mut buffer = [0_u8; 8192];
    let mut protocol = TelnetProtocol::new(
        geometry.columns,
        geometry.rows,
        geometry.window_size_enabled,
    );
    let mut prompt = String::new();
    let mut username_sent = credentials.username.is_empty();
    let mut password_sent = credentials.password.is_empty();
    let mut terminal_reason = None;
    let mut terminal_error = None;

    'read: loop {
        if worker_cancel.is_cancelled() || control.cancellation.is_cancelled() {
            break;
        }
        let length = match reader.read(&mut buffer) {
            Ok(0) => {
                terminal_reason = Some(DisconnectReason::RemoteClosed);
                break;
            }
            Err(error) => {
                terminal_reason = Some(
                    if matches!(
                        error.kind(),
                        ErrorKind::ConnectionReset
                            | ErrorKind::UnexpectedEof
                            | ErrorKind::NotConnected
                    ) {
                        DisconnectReason::RemoteClosed
                    } else {
                        DisconnectReason::ReadFailed
                    },
                );
                terminal_error = Some(error.to_string());
                break;
            }
            Ok(length) => length,
        };
        let frame = protocol.decode(&buffer[..length]);
        for response in frame.responses {
            if !control.writable() {
                break 'read;
            }
            if send_control(&control_writer, response, &worker_cancel).is_err() {
                if control.writable() && !worker_cancel.is_cancelled() {
                    terminal_reason = Some(DisconnectReason::ReadFailed);
                    terminal_error = Some("Telnet 协议控制消息发送失败".to_owned());
                }
                break 'read;
            }
        }
        if frame.output.is_empty() {
            continue;
        }
        append_prompt_text(&mut prompt, &frame.output);
        if !username_sent && (prompt.contains("login:") || prompt.contains("username:")) {
            if send_control(
                &control_writer,
                line_message(&credentials.username),
                &worker_cancel,
            )
            .is_err()
            {
                if control.writable() && !worker_cancel.is_cancelled() {
                    terminal_reason = Some(DisconnectReason::ReadFailed);
                    terminal_error = Some("Telnet 登录消息发送失败".to_owned());
                }
                break 'read;
            }
            username_sent = true;
            prompt.clear();
        } else if username_sent && !password_sent && prompt.contains("password:") {
            if send_control(
                &control_writer,
                line_message(&credentials.password),
                &worker_cancel,
            )
            .is_err()
            {
                if control.writable() && !worker_cancel.is_cancelled() {
                    terminal_reason = Some(DisconnectReason::ReadFailed);
                    terminal_error = Some("Telnet 登录消息发送失败".to_owned());
                }
                break 'read;
            }
            password_sent = true;
            prompt.clear();
        }
        if control.writable() {
            match output_sender.send(frame.output, &worker_cancel) {
                Ok(()) => {}
                Err(QueueSendError::Cancelled) => break,
                Err(QueueSendError::Closed) => {
                    terminal_reason = Some(DisconnectReason::ReadFailed);
                    terminal_error = Some("Telnet 输出通道已关闭".to_owned());
                    break;
                }
                Err(QueueSendError::ChunkTooLarge { .. }) => {
                    terminal_reason = Some(DisconnectReason::ReadFailed);
                    terminal_error = Some("Telnet 输出块超过队列限制".to_owned());
                    break;
                }
            }
        }
    }
    if !control.close_once.is_requested() {
        let _ = app.emit(
            EXIT_EVENT,
            TelnetExit {
                session_id: session_id.clone(),
            },
        );
        match terminal_reason.unwrap_or(DisconnectReason::Unknown) {
            DisconnectReason::RemoteClosed => {
                control.mark_disconnected(DisconnectReason::RemoteClosed);
            }
            reason => {
                control.mark_failed_with(reason, ConnectionErrorKind::Transport, terminal_error);
                control.request_close_with(reason);
            }
        }
    }
    let _ = cleanup_sender.send(CleanupRequest::Session {
        session_id,
        instance: Arc::clone(&control.instance),
        deadline: Instant::now() + SESSION_CLOSE_TIMEOUT,
    });
}

fn send_control(
    sender: &SyncSender<WriterMessage>,
    bytes: Vec<u8>,
    cancellation: &CancellationToken,
) -> Result<(), ()> {
    let mut message = WriterMessage::Bytes(bytes);
    loop {
        if cancellation.is_cancelled() {
            return Err(());
        }
        match sender.try_send(message) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Full(next)) => {
                message = next;
                thread::sleep(crate::io_pump::QUEUE_RETRY_INTERVAL);
            }
            Err(TrySendError::Disconnected(_)) => return Err(()),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_output_pump(
    app: AppHandle,
    session_id: String,
    mut receiver: OutputReceiver,
    worker_cancellation: CancellationToken,
    control: Arc<SessionControl>,
    start_gate: Arc<StartGate>,
    cleanup_sender: Sender<CleanupRequest>,
) {
    if !start_gate.wait(&control.cancellation) {
        return;
    }
    while let Ok(Some(batch)) = receiver.next_batch(&worker_cancellation, OUTPUT_BATCH_BYTES) {
        if !control.writable() {
            break;
        }
        if app
            .emit(
                OUTPUT_EVENT,
                TelnetOutput {
                    session_id: session_id.clone(),
                    data: STANDARD.encode(batch),
                },
            )
            .is_err()
        {
            control.mark_failed_with(
                DisconnectReason::ReadFailed,
                ConnectionErrorKind::Transport,
                Some("Telnet 输出事件发送失败".to_owned()),
            );
            control.request_close_with(DisconnectReason::ReadFailed);
            let _ = cleanup_sender.send(CleanupRequest::Session {
                session_id,
                instance: Arc::clone(&control.instance),
                deadline: Instant::now() + SESSION_CLOSE_TIMEOUT,
            });
            break;
        }
    }
}

fn shutdown_resources(resources: TelnetResources) {
    let _ = resources.writer.try_send(WriterMessage::Shutdown);
    let _ = resources.control_writer.try_send(WriterMessage::Shutdown);
    let _ = resources.control.shutdown(Shutdown::Both);
}

#[derive(Debug)]
struct TelnetConnectFailure {
    reason: DisconnectReason,
    error: ConnectionErrorKind,
    message: String,
}

impl TelnetConnectFailure {
    fn new(reason: DisconnectReason, error: ConnectionErrorKind, message: String) -> Self {
        Self {
            reason,
            error,
            message,
        }
    }
}

fn connect(
    host: &str,
    port: u16,
    cancellation: &CancellationToken,
) -> Result<TcpStream, TelnetConnectFailure> {
    let host = host.trim();
    if host.is_empty() || port == 0 {
        return Err(TelnetConnectFailure::new(
            DisconnectReason::ConnectionFailed,
            ConnectionErrorKind::Configuration,
            "Telnet 主机地址或端口无效".to_owned(),
        ));
    }
    let address = format!("{host}:{port}");
    if cancellation.is_cancelled() {
        return Err(TelnetConnectFailure::new(
            DisconnectReason::ConnectionFailed,
            ConnectionErrorKind::Connection,
            "Telnet 连接已取消".to_owned(),
        ));
    }
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| {
            TelnetConnectFailure::new(
                DisconnectReason::ConnectionFailed,
                ConnectionErrorKind::Connection,
                format!("无法解析 Telnet 地址：{error}"),
            )
        })?
        .collect::<Vec<_>>();
    if cancellation.is_cancelled() {
        return Err(TelnetConnectFailure::new(
            DisconnectReason::ConnectionFailed,
            ConnectionErrorKind::Connection,
            "Telnet 连接已取消".to_owned(),
        ));
    }
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut last_error = None;
    for socket_address in addresses {
        if cancellation.is_cancelled() {
            return Err(TelnetConnectFailure::new(
                DisconnectReason::ConnectionFailed,
                ConnectionErrorKind::Connection,
                "Telnet 连接已取消".to_owned(),
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&socket_address, remaining) {
            Ok(stream) => {
                if cancellation.is_cancelled() {
                    let _ = stream.shutdown(Shutdown::Both);
                    return Err(TelnetConnectFailure::new(
                        DisconnectReason::ConnectionFailed,
                        ConnectionErrorKind::Connection,
                        "Telnet 连接已取消".to_owned(),
                    ));
                }
                stream.set_nodelay(true).map_err(|error| {
                    TelnetConnectFailure::new(
                        DisconnectReason::ConnectionFailed,
                        ConnectionErrorKind::Transport,
                        format!("无法配置 Telnet 连接：{error}"),
                    )
                })?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .map_err(|error| {
                        TelnetConnectFailure::new(
                            DisconnectReason::ConnectionFailed,
                            ConnectionErrorKind::Transport,
                            format!("无法配置 Telnet 写入超时：{error}"),
                        )
                    })?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }
    let Some(error) = last_error else {
        return Err(TelnetConnectFailure::new(
            DisconnectReason::ConnectionFailed,
            ConnectionErrorKind::Connection,
            "没有找到可用的 Telnet 地址".to_owned(),
        ));
    };
    let reason = if error.kind() == ErrorKind::TimedOut {
        DisconnectReason::Timeout
    } else {
        DisconnectReason::ConnectionFailed
    };
    Err(TelnetConnectFailure::new(
        reason,
        ConnectionErrorKind::Connection,
        format!("无法连接到 {address}：{error}"),
    ))
}

fn lifecycle_log(session_id: &str, connection_type: &str, stage: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[lifecycle] session={session_id} type={connection_type} stage={stage}");
    #[cfg(not(debug_assertions))]
    let _ = (session_id, connection_type, stage);
}

struct InitializationGuard(Arc<TelnetRuntime>);

impl Drop for InitializationGuard {
    fn drop(&mut self) {
        self.0.finish_initialization();
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_endpoint_is_reported_as_configuration_failure() {
        let failure = connect("", 23, &CancellationToken::new()).expect_err("empty host must fail");
        assert_eq!(failure.reason, DisconnectReason::ConnectionFailed);
        assert_eq!(failure.error, ConnectionErrorKind::Configuration);
    }

    #[test]
    fn cancelled_connect_is_rejected_before_dns_or_socket_work() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let failure =
            connect("localhost", 23, &cancellation).expect_err("cancelled connect must not start");
        assert_eq!(failure.reason, DisconnectReason::ConnectionFailed);
        assert_eq!(failure.error, ConnectionErrorKind::Connection);
        assert_eq!(failure.message, "Telnet 连接已取消");
    }

    #[test]
    fn duplicate_session_ids_are_rejected_until_old_runtime_is_reclaimed() {
        let manager = TelnetManager::default();
        let control = manager.begin("same").expect("session");
        assert!(manager.begin("same").is_err());
        assert!(!control.cancellation.is_cancelled());
    }

    #[test]
    fn cleanup_reclaims_a_closed_runtime_after_initialization_finishes() {
        let manager = TelnetManager::default();
        let control = manager.begin("cleanup").expect("session");
        let runtime = manager
            .runtime_for_control("cleanup", &control)
            .expect("runtime");
        runtime.finish_initialization();
        manager.close("cleanup").expect("close");
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            if lock_unpoisoned(&manager.inner.sessions).is_empty() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("closed runtime was not reclaimed");
    }

    #[test]
    fn shutdown_closes_admission_and_reclaims_ready_starting_sessions() {
        let manager = TelnetManager::default();
        let control = manager.begin("shutdown").expect("session");
        let runtime = manager
            .runtime_for_control("shutdown", &control)
            .expect("runtime");
        runtime.finish_initialization();
        manager.shutdown(Instant::now() + Duration::from_secs(1));
        assert!(lock_unpoisoned(&manager.inner.sessions).is_empty());
        assert!(manager.begin("after-shutdown").is_err());
    }
}
