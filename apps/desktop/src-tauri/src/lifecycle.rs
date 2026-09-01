use std::{
    collections::HashMap,
    fmt, io,
    sync::{
        Arc, Condvar, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::Instant,
};

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LifecycleStage {
    Starting = 0,
    Running = 1,
    Failed = 2,
    Closing = 3,
    Closed = 4,
}

impl LifecycleStage {
    fn from_raw(value: u8) -> Self {
        match value {
            0 => Self::Starting,
            1 => Self::Running,
            2 => Self::Failed,
            3 => Self::Closing,
            4 => Self::Closed,
            _ => Self::Closed,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Lifecycle {
    stage: AtomicU8,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl Lifecycle {
    pub(crate) fn new() -> Self {
        Self {
            stage: AtomicU8::new(LifecycleStage::Starting as u8),
        }
    }

    pub(crate) fn stage(&self) -> LifecycleStage {
        LifecycleStage::from_raw(self.stage.load(Ordering::Acquire))
    }

    pub(crate) fn transition(
        &self,
        next: LifecycleStage,
    ) -> Result<(), InvalidLifecycleTransition> {
        loop {
            let current = self.stage();
            if current == next {
                return Ok(());
            }
            if !is_valid_transition(current, next) {
                return Err(InvalidLifecycleTransition {
                    current,
                    requested: next,
                });
            }

            match self.stage.compare_exchange(
                current as u8,
                next as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(()),
                Err(_) => continue,
            }
        }
    }

    pub(crate) fn begin_close(&self) -> bool {
        loop {
            let current = self.stage();
            match current {
                LifecycleStage::Closing | LifecycleStage::Closed => return false,
                LifecycleStage::Starting | LifecycleStage::Running | LifecycleStage::Failed => {
                    match self.stage.compare_exchange(
                        current as u8,
                        LifecycleStage::Closing as u8,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    ) {
                        Ok(_) => return true,
                        Err(_) => continue,
                    }
                }
            }
        }
    }

    pub(crate) fn finish_close(&self) -> Result<(), InvalidLifecycleTransition> {
        self.transition(LifecycleStage::Closed)
    }
}

fn is_valid_transition(current: LifecycleStage, next: LifecycleStage) -> bool {
    match current {
        LifecycleStage::Starting => {
            matches!(
                next,
                LifecycleStage::Running | LifecycleStage::Failed | LifecycleStage::Closing
            )
        }
        LifecycleStage::Running => {
            matches!(next, LifecycleStage::Failed | LifecycleStage::Closing)
        }
        LifecycleStage::Failed => next == LifecycleStage::Closing,
        LifecycleStage::Closing => next == LifecycleStage::Closed,
        LifecycleStage::Closed => false,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidLifecycleTransition {
    pub(crate) current: LifecycleStage,
    pub(crate) requested: LifecycleStage,
}

impl fmt::Display for InvalidLifecycleTransition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid lifecycle transition: {:?} -> {:?}",
            self.current, self.requested
        )
    }
}

#[derive(Debug, Default)]
pub(crate) struct CloseOnce {
    requested: AtomicBool,
}

impl CloseOnce {
    pub(crate) fn request(&self) -> bool {
        !self.requested.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn is_requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AdmissionGate {
    inner: Arc<AdmissionGateInner>,
}

#[derive(Debug)]
struct AdmissionGateInner {
    state: Mutex<AdmissionState>,
    drained: Condvar,
}

#[derive(Debug)]
struct AdmissionState {
    accepting: bool,
    active: usize,
}

impl Default for AdmissionGate {
    fn default() -> Self {
        Self::new()
    }
}

impl AdmissionGate {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(AdmissionGateInner {
                state: Mutex::new(AdmissionState {
                    accepting: true,
                    active: 0,
                }),
                drained: Condvar::new(),
            }),
        }
    }

    pub(crate) fn is_accepting(&self) -> bool {
        lock_unpoisoned(&self.inner.state).accepting
    }

    pub(crate) fn active_count(&self) -> usize {
        lock_unpoisoned(&self.inner.state).active
    }

    pub(crate) fn close(&self) -> bool {
        let mut state = lock_unpoisoned(&self.inner.state);
        if !state.accepting {
            return false;
        }
        state.accepting = false;
        self.inner.drained.notify_all();
        true
    }

    pub(crate) fn try_enter(&self) -> Option<AdmissionPermit> {
        let mut state = lock_unpoisoned(&self.inner.state);
        if !state.accepting {
            return None;
        }
        state.active += 1;
        Some(AdmissionPermit {
            inner: Arc::clone(&self.inner),
        })
    }

    pub(crate) fn wait_for_drain(&self, deadline: Instant) -> bool {
        let mut state = lock_unpoisoned(&self.inner.state);
        while state.active != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            match self.inner.drained.wait_timeout(state, remaining) {
                Ok((next_state, timeout)) => {
                    state = next_state;
                    if timeout.timed_out() && state.active != 0 {
                        return false;
                    }
                }
                Err(poisoned) => {
                    let (next_state, timeout) = poisoned.into_inner();
                    state = next_state;
                    if timeout.timed_out() && state.active != 0 {
                        return false;
                    }
                }
            }
        }
        true
    }
}

#[derive(Debug)]
pub(crate) struct AdmissionPermit {
    inner: Arc<AdmissionGateInner>,
}

impl Drop for AdmissionPermit {
    fn drop(&mut self) {
        let mut state = lock_unpoisoned(&self.inner.state);
        state.active = state.active.saturating_sub(1);
        if state.active == 0 {
            self.inner.drained.notify_all();
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn cancel(&self) -> bool {
        !self.cancelled.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct WorkerId(u64);

impl WorkerId {
    pub(crate) fn value(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorkerKind {
    Reader,
    Writer,
    Other,
}

impl fmt::Display for WorkerKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Reader => "reader",
            Self::Writer => "writer",
            Self::Other => "worker",
        };
        formatter.write_str(name)
    }
}

#[derive(Debug)]
pub(crate) enum WorkerSpawnError {
    SupervisorClosed,
    Thread(io::Error),
}

impl fmt::Display for WorkerSpawnError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SupervisorClosed => formatter.write_str("worker supervisor is closed"),
            Self::Thread(source) => write!(formatter, "unable to start worker thread: {source}"),
        }
    }
}

impl std::error::Error for WorkerSpawnError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct WorkerInfo {
    pub(crate) id: WorkerId,
    pub(crate) kind: WorkerKind,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct WorkerWaitReport {
    pub(crate) joined: usize,
    pub(crate) timed_out: usize,
    pub(crate) panicked: usize,
    pub(crate) timed_out_workers: Vec<WorkerInfo>,
}

#[derive(Debug)]
pub(crate) struct WorkerSupervisor {
    next_id: AtomicU64,
    accepting: AtomicBool,
    spawn_lock: Mutex<()>,
    workers: Mutex<HashMap<WorkerId, WorkerRecord>>,
}

impl Default for WorkerSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
struct WorkerRecord {
    kind: WorkerKind,
    cancellation: CancellationToken,
    completion: Arc<CompletionSignal>,
    join: Option<JoinHandle<()>>,
}

#[derive(Debug, Default)]
struct CompletionSignal {
    finished: Mutex<bool>,
    changed: Condvar,
}

impl CompletionSignal {
    fn mark_finished(&self) {
        let mut finished = lock_unpoisoned(&self.finished);
        *finished = true;
        self.changed.notify_all();
    }

    fn is_finished(&self) -> bool {
        *lock_unpoisoned(&self.finished)
    }

    fn wait_until(&self, deadline: Instant) -> bool {
        let mut finished = lock_unpoisoned(&self.finished);
        while !*finished {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            match self.changed.wait_timeout(finished, remaining) {
                Ok((next_finished, timeout)) => {
                    finished = next_finished;
                    if timeout.timed_out() && !*finished {
                        return false;
                    }
                }
                Err(poisoned) => {
                    let (next_finished, timeout) = poisoned.into_inner();
                    finished = next_finished;
                    if timeout.timed_out() && !*finished {
                        return false;
                    }
                }
            }
        }
        true
    }
}

struct CompletionGuard {
    signal: Arc<CompletionSignal>,
}

impl Drop for CompletionGuard {
    fn drop(&mut self) {
        self.signal.mark_finished();
    }
}

impl WorkerSupervisor {
    pub(crate) fn new() -> Self {
        Self {
            next_id: AtomicU64::new(0),
            accepting: AtomicBool::new(true),
            spawn_lock: Mutex::new(()),
            workers: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn stop_accepting(&self) -> bool {
        let _spawn_guard = lock_unpoisoned(&self.spawn_lock);
        self.accepting.swap(false, Ordering::AcqRel)
    }

    pub(crate) fn is_accepting(&self) -> bool {
        self.accepting.load(Ordering::Acquire)
    }

    pub(crate) fn spawn<F>(&self, kind: WorkerKind, task: F) -> Result<WorkerId, WorkerSpawnError>
    where
        F: FnOnce(CancellationToken) + Send + 'static,
    {
        let _spawn_guard = lock_unpoisoned(&self.spawn_lock);
        if !self.accepting.load(Ordering::Acquire) {
            return Err(WorkerSpawnError::SupervisorClosed);
        }

        let id = WorkerId(self.next_id.fetch_add(1, Ordering::Relaxed));
        let cancellation = CancellationToken::new();
        let completion = Arc::new(CompletionSignal::default());
        let worker_cancellation = cancellation.clone();
        let worker_completion = Arc::clone(&completion);
        let thread_name = format!("neterminai-{kind}-{id:?}");
        let join = thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let _completion_guard = CompletionGuard {
                    signal: worker_completion,
                };
                task(worker_cancellation);
            })
            .map_err(WorkerSpawnError::Thread)?;

        lock_unpoisoned(&self.workers).insert(
            id,
            WorkerRecord {
                kind,
                cancellation,
                completion,
                join: Some(join),
            },
        );
        Ok(id)
    }

    pub(crate) fn request_shutdown(&self) {
        for worker in lock_unpoisoned(&self.workers).values() {
            worker.cancellation.cancel();
        }
    }

    pub(crate) fn active_count(&self) -> usize {
        lock_unpoisoned(&self.workers).len()
    }

    pub(crate) fn wait_for_shutdown(&self, deadline: Instant) -> WorkerWaitReport {
        self.stop_accepting();
        self.request_shutdown();
        self.wait_until(deadline)
    }

    pub(crate) fn wait_until(&self, deadline: Instant) -> WorkerWaitReport {
        loop {
            let next_signal = {
                let workers = lock_unpoisoned(&self.workers);
                workers
                    .values()
                    .find(|worker| !worker.completion.is_finished())
                    .map(|worker| Arc::clone(&worker.completion))
            };

            let Some(signal) = next_signal else {
                break;
            };
            if !signal.wait_until(deadline) {
                break;
            }
        }

        let finished_workers = {
            let mut workers = lock_unpoisoned(&self.workers);
            let finished_ids = workers
                .iter()
                .filter_map(|(id, worker)| worker.completion.is_finished().then_some(*id))
                .collect::<Vec<_>>();
            finished_ids
                .into_iter()
                .filter_map(|id| {
                    workers.remove(&id).and_then(|mut worker| {
                        worker.join.take().map(|join| (id, worker.kind, join))
                    })
                })
                .collect::<Vec<_>>()
        };

        let mut report = WorkerWaitReport::default();
        for (_id, _kind, join) in finished_workers {
            report.joined += 1;
            if join.join().is_err() {
                report.panicked += 1;
            }
        }
        report.timed_out_workers = {
            let workers = lock_unpoisoned(&self.workers);
            workers
                .iter()
                .map(|(id, worker)| WorkerInfo {
                    id: *id,
                    kind: worker.kind,
                })
                .collect()
        };
        report.timed_out = report.timed_out_workers.len();
        report
    }
}

fn lock_unpoisoned<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, Barrier},
        thread,
        time::Duration,
    };

    #[test]
    fn lifecycle_allows_only_forward_transitions() {
        let lifecycle = Lifecycle::new();
        assert_eq!(lifecycle.stage(), LifecycleStage::Starting);
        lifecycle.transition(LifecycleStage::Running).unwrap();
        lifecycle.transition(LifecycleStage::Failed).unwrap();
        assert!(lifecycle.transition(LifecycleStage::Running).is_err());
        assert!(lifecycle.begin_close());
        assert!(!lifecycle.begin_close());
        lifecycle.finish_close().unwrap();
        assert_eq!(lifecycle.stage(), LifecycleStage::Closed);
        assert!(lifecycle.finish_close().is_ok());
        assert!(!lifecycle.begin_close());
    }

    #[test]
    fn close_once_has_one_winner_under_contention() {
        let close_once = Arc::new(CloseOnce::default());
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let close_once = Arc::clone(&close_once);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    close_once.request()
                })
            })
            .collect::<Vec<_>>();

        let winners = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
        assert!(close_once.is_requested());
        assert!(!close_once.request());
    }

    #[test]
    fn admission_gate_drains_existing_entries_and_rejects_new_entries_after_close() {
        let gate = AdmissionGate::new();
        let permit = gate.try_enter().expect("gate should initially accept");
        assert_eq!(gate.active_count(), 1);
        assert!(gate.close());
        assert!(!gate.is_accepting());
        assert!(gate.try_enter().is_none());
        assert!(!gate.wait_for_drain(Instant::now() + Duration::from_millis(5)));

        drop(permit);
        assert!(gate.wait_for_drain(Instant::now() + Duration::from_millis(50)));
        assert_eq!(gate.active_count(), 0);
        assert!(!gate.close());
    }

    #[test]
    fn worker_supervisor_cancels_waits_and_joins_workers() {
        let supervisor = WorkerSupervisor::default();
        supervisor
            .spawn(WorkerKind::Reader, |cancellation| {
                while !cancellation.is_cancelled() {
                    thread::sleep(Duration::from_millis(2));
                }
            })
            .unwrap();
        assert_eq!(supervisor.active_count(), 1);

        let report = supervisor.wait_for_shutdown(Instant::now() + Duration::from_secs(1));
        assert_eq!(report.joined, 1);
        assert_eq!(report.timed_out, 0);
        assert_eq!(report.panicked, 0);
        assert_eq!(supervisor.active_count(), 0);
    }

    #[test]
    fn worker_supervisor_keeps_timed_out_join_handles_for_later_reaping() {
        let supervisor = WorkerSupervisor::default();
        let worker_id = supervisor
            .spawn(WorkerKind::Other, |_cancellation| {
                thread::sleep(Duration::from_millis(60));
            })
            .unwrap();

        let first_report = supervisor.wait_for_shutdown(Instant::now() + Duration::from_millis(5));
        assert_eq!(first_report.joined, 0);
        assert_eq!(first_report.timed_out, 1);
        assert_eq!(first_report.timed_out_workers[0].id, worker_id);
        assert_eq!(first_report.timed_out_workers[0].kind, WorkerKind::Other);
        assert_eq!(supervisor.active_count(), 1);
        assert!(!supervisor.is_accepting());
        assert!(supervisor.spawn(WorkerKind::Reader, |_| {}).is_err());

        let second_report = supervisor.wait_for_shutdown(Instant::now() + Duration::from_secs(1));
        assert_eq!(second_report.joined, 1);
        assert_eq!(second_report.timed_out, 0);
        assert_eq!(supervisor.active_count(), 0);
    }

    #[test]
    fn worker_supervisor_reports_panicking_workers_after_completion() {
        let supervisor = WorkerSupervisor::default();
        supervisor
            .spawn(WorkerKind::Writer, |_cancellation| {
                panic!("test worker panic")
            })
            .unwrap();

        let report = supervisor.wait_for_shutdown(Instant::now() + Duration::from_secs(1));
        assert_eq!(report.joined, 1);
        assert_eq!(report.timed_out, 0);
        assert_eq!(report.panicked, 1);
    }
}
