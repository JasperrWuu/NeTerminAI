use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use tauri::{AppHandle, Emitter};

use crate::lifecycle::{
    AdmissionGate, AdmissionPermit, CancellationToken, CloseOnce, Lifecycle, LifecycleStage,
    WorkerKind, WorkerSupervisor,
};

const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const READER_TIMEOUT: Duration = Duration::from_millis(100);
const OUTPUT_EVENT: &str = "serial:output";
const EXIT_EVENT: &str = "serial:exit";

pub struct SerialManager {
    cleanup: CleanupCoordinator,
    inner: Arc<SerialManagerInner>,
}

struct SerialManagerInner {
    sessions: Mutex<HashMap<String, SessionState>>,
    admission: AdmissionGate,
}

enum SessionState {
    Starting(Arc<SerialRuntime>),
    Running(Arc<SerialRuntime>),
    Closing(Arc<SerialRuntime>),
}

struct SerialRuntime {
    control: Arc<SessionControl>,
    resources: Mutex<Option<SerialResources>>,
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

struct SerialResources {
    writer: Sender<WriterMessage>,
}

enum WriterMessage {
    Bytes(Vec<u8>),
    Shutdown,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialParity {
    None,
    Odd,
    Even,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SerialFlowControl {
    None,
    Software,
    Hardware,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialExit {
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
        let first = self.close_once.request();
        self.cancellation.cancel();
        if first {
            let _ = self.lifecycle.begin_close();
        }
        first
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

impl SerialRuntime {
    fn new(permit: AdmissionPermit, sender: Sender<CleanupRequest>) -> Self {
        Self {
            control: Arc::new(SessionControl::new()),
            resources: Mutex::new(None),
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

impl Default for SerialManager {
    fn default() -> Self {
        let inner = Arc::new(SerialManagerInner {
            sessions: Mutex::new(HashMap::new()),
            admission: AdmissionGate::new(),
        });
        let cleanup = CleanupCoordinator::new(&inner);
        Self { cleanup, inner }
    }
}

impl SerialManager {
    pub(crate) fn begin(&self, session_id: &str) -> Result<Arc<SessionControl>, String> {
        let permit = self
            .inner
            .admission
            .try_enter()
            .ok_or_else(|| "应用正在退出，无法创建串口会话".to_owned())?;
        let runtime = Arc::new(SerialRuntime::new(permit, self.cleanup.sender.clone()));
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        if sessions.contains_key(session_id) {
            return Err("串口会话已存在".to_owned());
        }
        sessions.insert(
            session_id.to_owned(),
            SessionState::Starting(Arc::clone(&runtime)),
        );
        lifecycle_log(session_id, "serial", "session create");
        Ok(Arc::clone(&runtime.control))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create(
        &self,
        app: AppHandle,
        session_id: String,
        port_name: String,
        baud_rate: u32,
        data_bits: u8,
        stop_bits: u8,
        parity: SerialParity,
        flow_control: SerialFlowControl,
        control: Arc<SessionControl>,
    ) -> Result<(), String> {
        let runtime = self.runtime_for_control(&session_id, &control)?;
        let _guard = InitializationGuard(Arc::clone(&runtime));
        let data_bits = match map_data_bits(data_bits) {
            Ok(value) => value,
            Err(error) => {
                runtime.control.mark_failed();
                runtime.control.request_close();
                runtime.queue_cleanup(&session_id);
                return Err(error);
            }
        };
        let stop_bits = match map_stop_bits(stop_bits) {
            Ok(value) => value,
            Err(error) => {
                runtime.control.mark_failed();
                runtime.control.request_close();
                runtime.queue_cleanup(&session_id);
                return Err(error);
            }
        };
        let port = match serialport::new(&port_name, baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(map_parity(parity))
            .flow_control(map_flow_control(flow_control))
            .timeout(READER_TIMEOUT)
            .open()
        {
            Ok(port) => port,
            Err(error) => {
                runtime.control.mark_failed();
                runtime.control.request_close();
                runtime.queue_cleanup(&session_id);
                return Err(format!("无法打开串口 {port_name}：{error}"));
            }
        };
        if control.close_once.is_requested() || control.cancellation.is_cancelled() {
            drop(port);
            runtime.control.request_close();
            runtime.queue_cleanup(&session_id);
            return Err("串口连接已取消".to_owned());
        }
        let reader = match port.try_clone() {
            Ok(reader) => reader,
            Err(error) => {
                drop(port);
                runtime.control.mark_failed();
                runtime.control.request_close();
                runtime.queue_cleanup(&session_id);
                return Err(format!("无法读取串口 {port_name}：{error}"));
            }
        };
        let (writer, writer_receiver) = mpsc::channel();
        *lock_unpoisoned(&runtime.resources) = Some(SerialResources {
            writer: writer.clone(),
        });

        let writer_control = Arc::clone(&runtime.control);
        let writer_gate = Arc::clone(&runtime.start_gate);
        let writer_session = session_id.clone();
        let writer_cleanup = self.cleanup.sender.clone();
        if runtime
            .workers
            .spawn(WorkerKind::Writer, move |worker_cancel| {
                run_writer(
                    port,
                    writer_receiver,
                    worker_cancel,
                    writer_control,
                    writer_gate,
                    writer_session,
                    writer_cleanup,
                )
            })
            .is_err()
        {
            runtime.control.request_close();
            runtime.start_gate.cancel();
            let resources = lock_unpoisoned(&runtime.resources).take();
            drop(resources);
            runtime.queue_cleanup(&session_id);
            return Err("串口写入线程启动失败".to_owned());
        }

        let reader_control = Arc::clone(&runtime.control);
        let reader_gate = Arc::clone(&runtime.start_gate);
        let reader_session = session_id.clone();
        let reader_cleanup = self.cleanup.sender.clone();
        if runtime
            .workers
            .spawn(WorkerKind::Reader, move |worker_cancel| {
                run_reader(
                    app,
                    reader_session,
                    reader,
                    worker_cancel,
                    reader_control,
                    reader_gate,
                    reader_cleanup,
                )
            })
            .is_err()
        {
            runtime.control.request_close();
            runtime.start_gate.cancel();
            runtime.workers.stop_accepting();
            runtime.workers.request_shutdown();
            let resources = lock_unpoisoned(&runtime.resources).take();
            drop(resources);
            runtime.queue_cleanup(&session_id);
            return Err("串口读取线程启动失败".to_owned());
        }

        if !(self.is_current_starting(&session_id, &runtime) && runtime.control.publish_running()) {
            runtime.control.request_close();
            runtime.start_gate.cancel();
            runtime.workers.stop_accepting();
            runtime.workers.request_shutdown();
            let resources = lock_unpoisoned(&runtime.resources).take();
            drop(resources);
            runtime.queue_cleanup(&session_id);
            return Err("串口连接已取消".to_owned());
        }
        self.promote_running(&session_id, &runtime);
        runtime.start_gate.release();
        lifecycle_log(&session_id, "serial", "session running");
        Ok(())
    }

    pub(crate) fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let runtime = self.running_runtime(session_id)?;
        let writer = lock_unpoisoned(&runtime.resources)
            .as_ref()
            .filter(|_| runtime.control.writable())
            .map(|resources| resources.writer.clone())
            .ok_or_else(|| "串口连接已关闭".to_owned())?;
        writer
            .send(WriterMessage::Bytes(data.to_vec()))
            .map_err(|_| "串口连接已关闭".to_owned())
    }

    pub(crate) fn close(&self, session_id: &str) -> Result<(), String> {
        let runtime = self.runtime(session_id)?;
        runtime.control.request_close();
        runtime.start_gate.cancel();
        self.mark_closing(session_id, &runtime);
        runtime.queue_cleanup(session_id);
        lifecycle_log(session_id, "serial", "close requested");
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
            runtime.control.request_close();
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

    fn runtime(&self, session_id: &str) -> Result<Arc<SerialRuntime>, String> {
        let sessions = lock_unpoisoned(&self.inner.sessions);
        match sessions.get(session_id) {
            Some(
                SessionState::Starting(runtime)
                | SessionState::Running(runtime)
                | SessionState::Closing(runtime),
            ) => Ok(Arc::clone(runtime)),
            None => Err("串口会话不存在".to_owned()),
        }
    }

    fn runtime_for_control(
        &self,
        session_id: &str,
        control: &Arc<SessionControl>,
    ) -> Result<Arc<SerialRuntime>, String> {
        let runtime = self.runtime(session_id)?;
        if Arc::ptr_eq(&runtime.control, control) {
            Ok(runtime)
        } else {
            Err("串口会话已被替换".to_owned())
        }
    }

    fn running_runtime(&self, session_id: &str) -> Result<Arc<SerialRuntime>, String> {
        let runtime = self.runtime(session_id)?;
        if runtime.control.writable() {
            Ok(runtime)
        } else {
            Err("串口仍在连接中或已关闭".to_owned())
        }
    }

    fn is_current_starting(&self, session_id: &str, runtime: &Arc<SerialRuntime>) -> bool {
        matches!(
            lock_unpoisoned(&self.inner.sessions).get(session_id),
            Some(SessionState::Starting(current)) if Arc::ptr_eq(current, runtime)
        )
    }

    fn promote_running(&self, session_id: &str, runtime: &Arc<SerialRuntime>) {
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

    fn mark_closing(&self, session_id: &str, runtime: &Arc<SerialRuntime>) {
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
    fn session_id_for(&self, runtime: &Arc<SerialRuntime>) -> String {
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
    fn new(inner: &Arc<SerialManagerInner>) -> Self {
        let (sender, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let weak = Arc::downgrade(inner);
        let loop_stop = Arc::clone(&stop);
        let retry_sender = sender.clone();
        let join = thread::Builder::new()
            .name("neterminai-serial-cleanup".to_owned())
            .spawn(move || cleanup_loop(weak, receiver, retry_sender, loop_stop))
            .expect("unable to start serial cleanup coordinator");
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
    inner: std::sync::Weak<SerialManagerInner>,
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
    inner: &SerialManagerInner,
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
    if !runtime.begin_cleanup() {
        return false;
    }
    runtime.control.request_close();
    runtime.start_gate.cancel();
    runtime.workers.stop_accepting();
    runtime.workers.request_shutdown();
    if let Some(resources) = lock_unpoisoned(&runtime.resources).take() {
        let _ = resources.writer.send(WriterMessage::Shutdown);
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
            lifecycle_log(session_id, "serial", "session removed");
        }
        true
    } else {
        runtime.finish_cleanup(false);
        false
    }
}

fn run_writer(
    mut port: Box<dyn SerialPort>,
    receiver: Receiver<WriterMessage>,
    worker_cancel: CancellationToken,
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
            WriterMessage::Bytes(bytes) => {
                if worker_cancel.is_cancelled() || !control.writable() {
                    break;
                }
                if port.write_all(&bytes).and_then(|_| port.flush()).is_err() {
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
            WriterMessage::Shutdown => break,
        }
    }
}

fn run_reader(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn SerialPort>,
    worker_cancel: CancellationToken,
    control: Arc<SessionControl>,
    start_gate: Arc<StartGate>,
    cleanup_sender: Sender<CleanupRequest>,
) {
    if !start_gate.wait(&control.cancellation) {
        return;
    }
    let mut buffer = [0_u8; 8192];
    loop {
        if worker_cancel.is_cancelled() || control.cancellation.is_cancelled() {
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => {}
            Ok(length) => {
                if control.writable()
                    && app
                        .emit(
                            OUTPUT_EVENT,
                            SerialOutput {
                                session_id: session_id.clone(),
                                data: STANDARD.encode(&buffer[..length]),
                            },
                        )
                        .is_err()
                {
                    break;
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
            Err(_) => break,
        }
    }
    if !control.close_once.is_requested() {
        let _ = app.emit(
            EXIT_EVENT,
            SerialExit {
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

fn map_data_bits(value: u8) -> Result<DataBits, String> {
    match value {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err("数据位仅支持 5、6、7 或 8".to_owned()),
    }
}

fn map_stop_bits(value: u8) -> Result<StopBits, String> {
    match value {
        1 => Ok(StopBits::One),
        2 => Ok(StopBits::Two),
        _ => Err("停止位仅支持 1 或 2".to_owned()),
    }
}

fn map_parity(value: SerialParity) -> Parity {
    match value {
        SerialParity::None => Parity::None,
        SerialParity::Odd => Parity::Odd,
        SerialParity::Even => Parity::Even,
    }
}

fn map_flow_control(value: SerialFlowControl) -> FlowControl {
    match value {
        SerialFlowControl::None => FlowControl::None,
        SerialFlowControl::Software => FlowControl::Software,
        SerialFlowControl::Hardware => FlowControl::Hardware,
    }
}

pub(crate) fn available_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|port| port.port_name).collect())
        .map_err(|error| format!("无法读取串口列表：{error}"))
}

fn lifecycle_log(session_id: &str, connection_type: &str, stage: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[lifecycle] session={session_id} type={connection_type} stage={stage}");
    #[cfg(not(debug_assertions))]
    let _ = (session_id, connection_type, stage);
}

struct InitializationGuard(Arc<SerialRuntime>);

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
    fn validates_serial_word_size() {
        assert!(matches!(map_data_bits(8), Ok(DataBits::Eight)));
        assert!(map_data_bits(9).is_err());
        assert!(matches!(map_stop_bits(1), Ok(StopBits::One)));
    }

    #[test]
    fn close_is_idempotent_for_starting_session() {
        let manager = SerialManager::default();
        let control = manager.begin("pending").expect("session");
        manager.close("pending").expect("first close");
        manager.close("pending").expect("second close");
        assert!(control.close_once.is_requested());
        assert!(control.cancellation.is_cancelled());
        assert_eq!(control.lifecycle.stage(), LifecycleStage::Closing);
    }
}
