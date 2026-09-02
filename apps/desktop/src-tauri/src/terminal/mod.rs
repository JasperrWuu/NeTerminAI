use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::lifecycle::{
    AdmissionGate, AdmissionPermit, CancellationToken, CloseOnce, Lifecycle, LifecycleStage,
    WorkerKind, WorkerSupervisor,
};

const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const OUTPUT_EVENT: &str = "terminal:output";
const EXIT_EVENT: &str = "terminal:exit";

pub struct TerminalManager {
    cleanup: CleanupCoordinator,
    inner: Arc<TerminalManagerInner>,
}

struct TerminalManagerInner {
    sessions: Mutex<HashMap<String, SessionState>>,
    admission: AdmissionGate,
}

enum SessionState {
    Starting(Arc<TerminalRuntime>),
    Running(Arc<TerminalRuntime>),
    Closing(Arc<TerminalRuntime>),
}

#[derive(Clone, Copy, Deserialize)]
pub enum TerminalProfile {
    #[serde(rename = "powershell")]
    PowerShell,
    #[serde(rename = "commandPrompt")]
    CommandPrompt,
    #[serde(rename = "gitBash")]
    GitBash,
}

struct TerminalRuntime {
    control: Arc<SessionControl>,
    resources: Mutex<Option<TerminalResources>>,
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
}

struct TerminalResources {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    writer: Sender<TerminalWriterMessage>,
}

struct OpenResources {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    writer_receiver: Receiver<TerminalWriterMessage>,
    resources: TerminalResources,
}

enum TerminalWriterMessage {
    Bytes(Vec<u8>),
    Shutdown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
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
    fn new() -> Self {
        Self {
            lifecycle: Lifecycle::new(),
            cancellation: CancellationToken::new(),
            close_once: CloseOnce::default(),
            instance: Arc::new(()),
        }
    }

    fn request_close(&self) -> bool {
        let first_request = self.close_once.request();
        self.cancellation.cancel();
        if first_request {
            let _ = self.lifecycle.begin_close();
        }
        first_request
    }

    fn mark_failed(&self) {
        if matches!(
            self.lifecycle.stage(),
            LifecycleStage::Starting | LifecycleStage::Running
        ) {
            let _ = self.lifecycle.transition(LifecycleStage::Failed);
        }
    }

    fn publish_running(&self) -> bool {
        if self.close_once.is_requested() || self.cancellation.is_cancelled() {
            return false;
        }
        self.lifecycle.transition(LifecycleStage::Running).is_ok()
    }

    fn writable(&self) -> bool {
        self.lifecycle.stage() == LifecycleStage::Running
            && !self.close_once.is_requested()
            && !self.cancellation.is_cancelled()
    }
}

impl TerminalRuntime {
    fn new(creation_permit: AdmissionPermit, cleanup_sender: Sender<CleanupRequest>) -> Self {
        Self {
            control: Arc::new(SessionControl::new()),
            resources: Mutex::new(None),
            workers: WorkerSupervisor::new(),
            start_gate: Arc::new(StartGate::new()),
            initializing: AtomicBool::new(true),
            creation_permit: Mutex::new(Some(creation_permit)),
            cleanup: Mutex::new(CleanupProgress::Idle),
            cleanup_sender,
        }
    }

    fn finish_initialization(&self) {
        self.initializing.store(false, Ordering::Release);
        lock_unpoisoned(&self.creation_permit).take();
    }

    fn try_begin_cleanup(&self) -> bool {
        let mut progress = lock_unpoisoned(&self.cleanup);
        if *progress != CleanupProgress::Idle {
            return false;
        }
        *progress = CleanupProgress::Running;
        true
    }

    fn finish_cleanup(&self, completed: bool) {
        *lock_unpoisoned(&self.cleanup) = if completed {
            CleanupProgress::Completed
        } else {
            CleanupProgress::Idle
        };
    }

    fn request_cleanup(&self, session_id: &str, deadline: Instant) {
        let _ = self.cleanup_sender.send(CleanupRequest::Session {
            session_id: session_id.to_owned(),
            instance: Arc::clone(&self.control.instance),
            deadline,
        });
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        let inner = Arc::new(TerminalManagerInner {
            sessions: Mutex::new(HashMap::new()),
            admission: AdmissionGate::new(),
        });
        let cleanup = CleanupCoordinator::new(&inner);
        Self { cleanup, inner }
    }
}

impl TerminalManager {
    pub(crate) fn begin(&self, session_id: &str) -> Result<Arc<SessionControl>, String> {
        let permit = self
            .inner
            .admission
            .try_enter()
            .ok_or_else(|| "应用正在退出，无法创建终端会话".to_owned())?;
        let runtime = Arc::new(TerminalRuntime::new(permit, self.cleanup.sender.clone()));
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        if sessions.contains_key(session_id) {
            return Err("终端会话已存在".to_owned());
        }
        sessions.insert(
            session_id.to_owned(),
            SessionState::Starting(Arc::clone(&runtime)),
        );
        lifecycle_log(session_id, "local", "session create");
        Ok(Arc::clone(&runtime.control))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create(
        &self,
        app: AppHandle,
        session_id: String,
        profile: TerminalProfile,
        columns: u16,
        rows: u16,
        control: Arc<SessionControl>,
    ) -> Result<(), String> {
        let runtime = self.runtime_for_control(&session_id, &control)?;
        let _initialization_guard = InitializationGuard::new(Arc::clone(&runtime));
        let open =
            match self.open_command_resources(shell_command(profile), columns, rows, "本地终端")
            {
                Ok(resources) => resources,
                Err(error) => {
                    runtime.control.mark_failed();
                    runtime.control.request_close();
                    runtime.request_cleanup(&session_id, Instant::now() + SESSION_CLOSE_TIMEOUT);
                    return Err(error);
                }
            };

        if control.close_once.is_requested() || control.cancellation.is_cancelled() {
            shutdown_terminal_resources(open.resources);
            runtime.control.request_close();
            runtime.request_cleanup(&session_id, Instant::now() + SESSION_CLOSE_TIMEOUT);
            return Err("本地终端启动已取消".to_owned());
        }

        let OpenResources {
            reader,
            writer,
            writer_receiver,
            resources,
        } = open;
        *lock_unpoisoned(&runtime.resources) = Some(resources);

        let writer_control = Arc::clone(&runtime.control);
        let writer_gate = Arc::clone(&runtime.start_gate);
        let writer_session = session_id.clone();
        let writer_sender = self.cleanup.sender.clone();
        if runtime
            .workers
            .spawn(WorkerKind::Writer, move |worker_cancel| {
                run_terminal_writer(
                    writer,
                    writer_receiver,
                    worker_cancel,
                    writer_control,
                    writer_gate,
                    writer_session,
                    writer_sender,
                );
            })
            .is_err()
        {
            runtime.control.request_close();
            runtime.start_gate.cancel();
            let resources = lock_unpoisoned(&runtime.resources).take();
            shutdown_terminal_resources(
                resources.expect("resources installed before worker spawn"),
            );
            return Err("本地终端写入线程启动失败".to_owned());
        }

        let reader_control = Arc::clone(&runtime.control);
        let reader_gate = Arc::clone(&runtime.start_gate);
        let reader_session = session_id.clone();
        let reader_sender = self.cleanup.sender.clone();
        if runtime
            .workers
            .spawn(WorkerKind::Reader, move |worker_cancel| {
                run_terminal_reader(
                    app,
                    reader_session,
                    reader,
                    worker_cancel,
                    reader_control,
                    reader_gate,
                    reader_sender,
                );
            })
            .is_err()
        {
            runtime.control.request_close();
            runtime.start_gate.cancel();
            runtime.workers.stop_accepting();
            runtime.workers.request_shutdown();
            let resources = lock_unpoisoned(&runtime.resources).take();
            shutdown_terminal_resources(
                resources.expect("resources installed before worker spawn"),
            );
            runtime.request_cleanup(&session_id, Instant::now() + SESSION_CLOSE_TIMEOUT);
            return Err("本地终端读取线程启动失败".to_owned());
        }

        if !(self.is_current_starting(&session_id, &runtime) && runtime.control.publish_running()) {
            runtime.control.request_close();
            runtime.start_gate.cancel();
            runtime.workers.stop_accepting();
            runtime.workers.request_shutdown();
            let resources = lock_unpoisoned(&runtime.resources).take();
            shutdown_terminal_resources(resources.expect("resources installed before publish"));
            runtime.request_cleanup(&session_id, Instant::now() + SESSION_CLOSE_TIMEOUT);
            return Err("本地终端启动已取消".to_owned());
        }
        self.promote_running(&session_id, &runtime);
        runtime.start_gate.release();
        lifecycle_log(&session_id, "local", "session running");
        Ok(())
    }

    fn open_command_resources(
        &self,
        mut command: CommandBuilder,
        columns: u16,
        rows: u16,
        label: &str,
    ) -> Result<OpenResources, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("无法创建{label}：{error}"))?;
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("无法启动{label}：{error}"))?;
        drop(pair.slave);
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("无法读取终端输出：{error}"));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("无法写入终端：{error}"));
            }
        };
        let (writer_sender, writer_receiver) = mpsc::channel();
        Ok(OpenResources {
            reader,
            writer,
            writer_receiver,
            resources: TerminalResources {
                master: pair.master,
                child,
                writer: writer_sender,
            },
        })
    }

    pub(crate) fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let runtime = self.running_runtime(session_id)?;
        let writer = lock_unpoisoned(&runtime.resources)
            .as_ref()
            .filter(|_| runtime.control.writable())
            .map(|resources| resources.writer.clone())
            .ok_or_else(|| "终端输入通道已关闭".to_owned())?;
        writer
            .send(TerminalWriterMessage::Bytes(data.to_vec()))
            .map_err(|_| "终端输入通道已关闭".to_owned())
    }

    pub(crate) fn resize(&self, session_id: &str, columns: u16, rows: u16) -> Result<(), String> {
        let runtime = self.running_runtime(session_id)?;
        let resources = lock_unpoisoned(&runtime.resources);
        let master = resources
            .as_ref()
            .ok_or_else(|| "终端资源已关闭".to_owned())?;
        master
            .master
            .resize(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("调整终端尺寸失败：{error}"))
    }

    pub(crate) fn close(&self, session_id: &str) -> Result<(), String> {
        let runtime = {
            let sessions = lock_unpoisoned(&self.inner.sessions);
            match sessions.get(session_id) {
                Some(SessionState::Starting(runtime))
                | Some(SessionState::Running(runtime))
                | Some(SessionState::Closing(runtime)) => Arc::clone(runtime),
                None => return Ok(()),
            }
        };
        runtime.control.request_close();
        runtime.start_gate.cancel();
        self.mark_closing(session_id, &runtime);
        runtime.request_cleanup(session_id, Instant::now() + SESSION_CLOSE_TIMEOUT);
        lifecycle_log(session_id, "local", "close requested");
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn shutdown(&self, deadline: Instant) {
        self.inner.admission.close();
        let _ = self.inner.admission.wait_for_drain(deadline);
        let runtimes = {
            let sessions = lock_unpoisoned(&self.inner.sessions);
            sessions
                .values()
                .map(|state| match state {
                    SessionState::Starting(runtime)
                    | SessionState::Running(runtime)
                    | SessionState::Closing(runtime) => Arc::clone(runtime),
                })
                .collect::<Vec<_>>()
        };
        for runtime in &runtimes {
            runtime.control.request_close();
            runtime.start_gate.cancel();
        }
        for runtime in runtimes {
            let session_id = self.session_id_for(&runtime);
            self.cleanup_one(&session_id, &runtime.control.instance, deadline);
        }
    }

    pub(crate) fn stop_cleanup(&self) {
        self.cleanup.stop_and_join();
    }

    fn runtime_for_control(
        &self,
        session_id: &str,
        control: &Arc<SessionControl>,
    ) -> Result<Arc<TerminalRuntime>, String> {
        let sessions = lock_unpoisoned(&self.inner.sessions);
        match sessions.get(session_id) {
            Some(SessionState::Starting(runtime)) if Arc::ptr_eq(&runtime.control, control) => {
                Ok(Arc::clone(runtime))
            }
            Some(SessionState::Closing(runtime)) if Arc::ptr_eq(&runtime.control, control) => {
                Ok(Arc::clone(runtime))
            }
            _ => Err("终端会话已关闭或不存在".to_owned()),
        }
    }

    fn running_runtime(&self, session_id: &str) -> Result<Arc<TerminalRuntime>, String> {
        let sessions = lock_unpoisoned(&self.inner.sessions);
        match sessions.get(session_id) {
            Some(SessionState::Running(runtime)) if runtime.control.writable() => {
                Ok(Arc::clone(runtime))
            }
            Some(SessionState::Starting(_)) => Err("终端仍在启动中".to_owned()),
            Some(SessionState::Closing(_)) => Err("终端会话已关闭".to_owned()),
            Some(SessionState::Running(_)) => Err("终端会话已关闭".to_owned()),
            None => Err("终端会话不存在".to_owned()),
        }
    }

    fn is_current_starting(&self, session_id: &str, runtime: &Arc<TerminalRuntime>) -> bool {
        matches!(
            lock_unpoisoned(&self.inner.sessions).get(session_id),
            Some(SessionState::Starting(current)) if Arc::ptr_eq(current, runtime)
        )
    }

    fn promote_running(&self, session_id: &str, runtime: &Arc<TerminalRuntime>) {
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

    fn mark_closing(&self, session_id: &str, runtime: &Arc<TerminalRuntime>) {
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
    fn session_id_for(&self, runtime: &Arc<TerminalRuntime>) -> String {
        let sessions = lock_unpoisoned(&self.inner.sessions);
        sessions
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

    #[allow(dead_code)]
    fn cleanup_one(&self, session_id: &str, instance: &Arc<()>, deadline: Instant) -> bool {
        cleanup_one(&self.inner, session_id, instance, deadline)
    }
}

struct InitializationGuard(Arc<TerminalRuntime>);

impl InitializationGuard {
    fn new(runtime: Arc<TerminalRuntime>) -> Self {
        Self(runtime)
    }
}

impl Drop for InitializationGuard {
    fn drop(&mut self) {
        self.0.finish_initialization();
    }
}

impl CleanupCoordinator {
    fn new(inner: &Arc<TerminalManagerInner>) -> Self {
        let (sender, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let weak_inner = Arc::downgrade(inner);
        let loop_stop = Arc::clone(&stop);
        let retry_sender = sender.clone();
        let join = thread::Builder::new()
            .name("neterminai-local-cleanup".to_owned())
            .spawn(move || cleanup_loop(weak_inner, receiver, retry_sender, loop_stop))
            .expect("unable to start terminal cleanup coordinator");
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
    inner: std::sync::Weak<TerminalManagerInner>,
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
    inner: &TerminalManagerInner,
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
    if !runtime.try_begin_cleanup() {
        return false;
    }
    runtime.control.request_close();
    runtime.start_gate.cancel();
    runtime.workers.stop_accepting();
    runtime.workers.request_shutdown();
    if let Some(resources) = lock_unpoisoned(&runtime.resources).take() {
        shutdown_terminal_resources(resources);
    }
    let report = runtime.workers.wait_until(deadline);
    let complete = !runtime.initializing.load(Ordering::Acquire)
        && report.timed_out == 0
        && runtime.workers.active_count() == 0;
    if complete {
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
            lifecycle_log(session_id, "local", "session removed");
        }
        true
    } else {
        lifecycle_log(session_id, "local", "cleanup timeout");
        runtime.finish_cleanup(false);
        false
    }
}

fn run_terminal_writer(
    mut writer: Box<dyn Write + Send>,
    receiver: Receiver<TerminalWriterMessage>,
    worker_cancellation: CancellationToken,
    control: Arc<SessionControl>,
    start_gate: Arc<StartGate>,
    session_id: String,
    cleanup_sender: Sender<CleanupRequest>,
) {
    if !start_gate.wait(&control.cancellation) {
        return;
    }
    while let Ok(message) = receiver.recv() {
        match message {
            TerminalWriterMessage::Bytes(bytes) => {
                if worker_cancellation.is_cancelled() || !control.writable() {
                    break;
                }
                if writer
                    .write_all(&bytes)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    control.mark_failed();
                    control.request_close();
                    let _ = cleanup_sender.send(CleanupRequest::Session {
                        session_id: session_id.clone(),
                        instance: Arc::clone(&control.instance),
                        deadline: Instant::now() + SESSION_CLOSE_TIMEOUT,
                    });
                    break;
                }
            }
            TerminalWriterMessage::Shutdown => break,
        }
    }
}

fn run_terminal_reader(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    worker_cancellation: CancellationToken,
    control: Arc<SessionControl>,
    start_gate: Arc<StartGate>,
    cleanup_sender: Sender<CleanupRequest>,
) {
    if !start_gate.wait(&control.cancellation) {
        return;
    }
    let mut buffer = [0_u8; 8192];
    loop {
        if worker_cancellation.is_cancelled() || control.cancellation.is_cancelled() {
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                if control.writable() {
                    let _ = app.emit(
                        OUTPUT_EVENT,
                        TerminalOutput {
                            session_id: session_id.clone(),
                            data: STANDARD.encode(&buffer[..length]),
                        },
                    );
                }
            }
            Err(_) => break,
        }
    }
    if !control.close_once.is_requested() {
        let _ = app.emit(
            EXIT_EVENT,
            TerminalExit {
                session_id: session_id.clone(),
            },
        );
        control.mark_failed();
        control.request_close();
    }
    let _ = cleanup_sender.send(CleanupRequest::Session {
        session_id,
        instance: Arc::clone(&control.instance),
        deadline: Instant::now() + SESSION_CLOSE_TIMEOUT,
    });
}

fn shutdown_terminal_resources(mut resources: TerminalResources) {
    let _ = resources.writer.send(TerminalWriterMessage::Shutdown);
    let _ = resources.child.kill();
    let _ = resources.child.wait();
    drop(resources.master);
}

fn shell_command(profile: TerminalProfile) -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        match profile {
            TerminalProfile::PowerShell => {
                let mut command = CommandBuilder::new("powershell.exe");
                command.arg("-NoLogo");
                command
            }
            TerminalProfile::CommandPrompt => CommandBuilder::new("cmd.exe"),
            TerminalProfile::GitBash => {
                let mut command = CommandBuilder::new(git_bash_executable());
                command.arg("--login");
                command.arg("-i");
                command
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = profile;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned());
        CommandBuilder::new(shell)
    }
}

#[cfg(target_os = "windows")]
fn git_bash_executable() -> std::path::PathBuf {
    let candidates = [
        std::env::var_os("ProgramFiles")
            .map(|root| std::path::PathBuf::from(root).join("Git/bin/bash.exe")),
        std::env::var_os("ProgramFiles(x86)")
            .map(|root| std::path::PathBuf::from(root).join("Git/bin/bash.exe")),
        std::env::var_os("LOCALAPPDATA")
            .map(|root| std::path::PathBuf::from(root).join("Programs/Git/bin/bash.exe")),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .unwrap_or_else(|| std::path::PathBuf::from("bash.exe"))
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn lifecycle_log(session_id: &str, connection_type: &str, stage: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[lifecycle] session={session_id} type={connection_type} stage={stage}");
    #[cfg(not(debug_assertions))]
    let _ = (session_id, connection_type, stage);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn begin_rejects_duplicate_session_ids_without_replacing_runtime() {
        let manager = TerminalManager::default();
        let first = manager.begin("same").expect("first session");
        assert!(manager.begin("same").is_err());
        assert!(!first.cancellation.is_cancelled());
    }

    #[test]
    fn shutdown_closes_admission_and_reclaims_ready_starting_sessions() {
        let manager = TerminalManager::default();
        let control = manager.begin("shutdown").expect("session");
        let runtime = manager
            .runtime_for_control("shutdown", &control)
            .expect("runtime");
        runtime.finish_initialization();
        manager.shutdown(Instant::now() + Duration::from_secs(1));
        assert!(lock_unpoisoned(&manager.inner.sessions).is_empty());
        assert!(manager.begin("after-shutdown").is_err());
    }

    #[test]
    fn close_is_idempotent_and_keeps_starting_identity_until_cleanup() {
        let manager = TerminalManager::default();
        let control = manager.begin("pending").expect("session");
        manager.close("pending").expect("first close");
        manager.close("pending").expect("second close");
        assert!(control.close_once.is_requested());
        assert!(control.cancellation.is_cancelled());
        assert_eq!(control.lifecycle.stage(), LifecycleStage::Closing);
        assert!(lock_unpoisoned(&manager.inner.sessions).contains_key("pending"));
    }

    #[test]
    fn start_gate_wakes_when_cancelled() {
        let gate = StartGate::new();
        let token = CancellationToken::new();
        token.cancel();
        assert!(!gate.wait(&token));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn local_profiles_keep_their_existing_shell_commands() {
        let powershell = shell_command(TerminalProfile::PowerShell);
        let command_prompt = shell_command(TerminalProfile::CommandPrompt);
        let git_bash = shell_command(TerminalProfile::GitBash);

        assert_eq!(powershell.get_argv()[0].to_string_lossy(), "powershell.exe");
        assert_eq!(command_prompt.get_argv()[0].to_string_lossy(), "cmd.exe");
        assert!(
            git_bash.get_argv()[0]
                .to_string_lossy()
                .ends_with("bash.exe")
        );
        assert_eq!(git_bash.get_argv()[1].to_string_lossy(), "--login");
        assert_eq!(git_bash.get_argv()[2].to_string_lossy(), "-i");
    }

    #[test]
    fn cleanup_reclaims_a_closed_runtime_after_initialization_finishes() {
        let manager = TerminalManager::default();
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
}
