use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
};

use tauri::{AppHandle, Manager};

/// Shared raw terminal output fan-out keyed by the concrete session identity.
///
/// Text-terminal runtimes publish here once and any feature that needs a
/// lossless session stream (currently Automation) subscribes without making
/// the runtime depend on that feature.
#[derive(Clone, Default)]
pub(crate) struct TerminalOutputHub {
    inner: Arc<TerminalOutputHubInner>,
}

#[derive(Default)]
struct TerminalOutputHubInner {
    sessions: Mutex<HashMap<String, TerminalOutputSession>>,
    next_subscriber: AtomicU64,
}

struct TerminalOutputSession {
    subscribers: HashMap<u64, Sender<(u64, Vec<u8>)>>,
    command_lock: Arc<Mutex<()>>,
    prompt: Option<String>,
    cursor: u64,
    closed: bool,
}

pub(crate) struct TerminalOutputSubscription {
    receiver: Receiver<(u64, Vec<u8>)>,
    hub: TerminalOutputHub,
    session_id: String,
    subscriber_id: u64,
    start_cursor: u64,
}

impl TerminalOutputHub {
    pub(crate) fn subscribe(&self, session_id: &str) -> TerminalOutputSubscription {
        let (sender, receiver) = mpsc::channel();
        let subscriber_id = self.inner.next_subscriber.fetch_add(1, Ordering::Relaxed);
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        let session =
            sessions
                .entry(session_id.to_owned())
                .or_insert_with(|| TerminalOutputSession {
                    subscribers: HashMap::new(),
                    command_lock: Arc::new(Mutex::new(())),
                    prompt: None,
                    cursor: 0,
                    closed: false,
                });
        if !session.closed {
            session.subscribers.insert(subscriber_id, sender);
        }
        TerminalOutputSubscription {
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
                    .or_insert_with(|| TerminalOutputSession {
                        subscribers: HashMap::new(),
                        command_lock: Arc::new(Mutex::new(())),
                        prompt: None,
                        cursor: 0,
                        closed: false,
                    });
            if session.closed {
                return;
            }
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

    pub(crate) fn command_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| TerminalOutputSession {
                subscribers: HashMap::new(),
                command_lock: Arc::new(Mutex::new(())),
                prompt: None,
                cursor: 0,
                closed: false,
            })
            .command_lock
            .clone()
    }

    pub(crate) fn current_prompt(&self, session_id: &str) -> Option<String> {
        lock_unpoisoned(&self.inner.sessions)
            .get(session_id)
            .and_then(|session| session.prompt.clone())
    }

    pub(crate) fn set_prompt(&self, session_id: &str, prompt: String) {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        let session =
            sessions
                .entry(session_id.to_owned())
                .or_insert_with(|| TerminalOutputSession {
                    subscribers: HashMap::new(),
                    command_lock: Arc::new(Mutex::new(())),
                    prompt: None,
                    cursor: 0,
                    closed: false,
                });
        session.prompt = Some(prompt);
    }

    pub(crate) fn close_session(&self, session_id: &str) {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        let session =
            sessions
                .entry(session_id.to_owned())
                .or_insert_with(|| TerminalOutputSession {
                    subscribers: HashMap::new(),
                    command_lock: Arc::new(Mutex::new(())),
                    prompt: None,
                    cursor: 0,
                    closed: false,
                });
        session.closed = true;
        session.subscribers.clear();
    }

    fn remove_subscriber(&self, session_id: &str, subscriber_id: u64) {
        let mut sessions = lock_unpoisoned(&self.inner.sessions);
        if let Some(session) = sessions.get_mut(session_id) {
            session.subscribers.remove(&subscriber_id);
        }
    }
}

impl TerminalOutputSubscription {
    pub(crate) fn recv_timeout(
        &self,
        timeout: std::time::Duration,
    ) -> Result<Vec<u8>, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout).map(|(cursor, data)| {
            debug_assert!(cursor > self.start_cursor);
            data
        })
    }
}

impl Drop for TerminalOutputSubscription {
    fn drop(&mut self) {
        self.hub
            .remove_subscriber(&self.session_id, self.subscriber_id);
    }
}

pub(crate) fn publish_output(app: &AppHandle, session_id: &str, data: &[u8]) {
    app.state::<TerminalOutputHub>().publish(session_id, data);
}

/// Notify stream consumers that a terminal output stream has ended.
pub(crate) fn close_output_session(app: &AppHandle, session_id: &str) {
    app.state::<TerminalOutputHub>().close_session(session_id);
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
