use std::{
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicU8, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager};

use crate::{serial::SerialManager, telnet::TelnetManager, terminal::TerminalManager};

const GLOBAL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const READY: u8 = 2;

/// Owns the one application-level shutdown worker.  A second exit request is
/// prevented while the first request is draining sessions, but never starts a
/// second cleanup pass.
pub(crate) struct ShutdownCoordinator {
    state: AtomicU8,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for ShutdownCoordinator {
    fn default() -> Self {
        Self {
            state: AtomicU8::new(IDLE),
            worker: Mutex::new(None),
        }
    }
}

impl ShutdownCoordinator {
    pub(crate) fn begin(&self) -> bool {
        self.state
            .compare_exchange(IDLE, RUNNING, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(crate) fn is_running(&self) -> bool {
        self.state.load(Ordering::Acquire) == RUNNING
    }

    pub(crate) fn start(&self, app: AppHandle) {
        let worker = thread::Builder::new()
            .name("neterminai-shutdown".to_owned())
            .spawn(move || {
                let deadline = Instant::now() + GLOBAL_SHUTDOWN_TIMEOUT;
                app.state::<TerminalManager>().shutdown(deadline);
                app.state::<TelnetManager>().shutdown(deadline);
                app.state::<SerialManager>().shutdown(deadline);
                app.state::<TerminalManager>().stop_cleanup();
                app.state::<TelnetManager>().stop_cleanup();
                app.state::<SerialManager>().stop_cleanup();

                let coordinator = app.state::<ShutdownCoordinator>();
                coordinator.state.store(READY, Ordering::Release);
                app.exit(0);
            })
            .expect("unable to start application shutdown worker");
        *lock_unpoisoned(&self.worker) = Some(worker);
    }
}

impl Drop for ShutdownCoordinator {
    fn drop(&mut self) {
        if let Some(worker) = lock_unpoisoned(&self.worker).take()
            && worker.thread().id() != thread::current().id()
        {
            let _ = worker.join();
        }
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_is_idempotent_until_shutdown_finishes() {
        let coordinator = ShutdownCoordinator::default();
        assert!(coordinator.begin());
        assert!(!coordinator.begin());
        assert!(coordinator.is_running());
        coordinator.state.store(READY, Ordering::Release);
        assert!(!coordinator.begin());
    }
}
