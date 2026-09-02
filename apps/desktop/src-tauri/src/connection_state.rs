use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub(crate) const STATE_EVENT: &str = "connection:state";

/// The small, user-facing state vocabulary shared by Local, Telnet and Serial
/// runtimes.  This is deliberately separate from the internal lifecycle in
/// `lifecycle.rs`: lifecycle describes resource ownership, while this enum is
/// what the application can show to a user.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionState {
    Connecting,
    Connected,
    Closing,
    Disconnected,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DisconnectReason {
    UserRequested,
    RemoteClosed,
    ProcessExited,
    ConnectionFailed,
    ReadFailed,
    WriteFailed,
    Timeout,
    ProtocolError,
    DeviceDisconnected,
    ApplicationShutdown,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionErrorKind {
    Connection,
    Transport,
    Protocol,
    Configuration,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionStateEvent {
    pub(crate) session_id: String,
    pub(crate) state: ConnectionState,
    pub(crate) reason: Option<DisconnectReason>,
    pub(crate) error: Option<ConnectionErrorKind>,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StateSnapshot {
    state: ConnectionState,
    reason: Option<DisconnectReason>,
    error: Option<ConnectionErrorKind>,
    message: Option<String>,
    initial_emitted: bool,
}

/// Owns the state and terminal outcome for one concrete runtime instance.
/// State transitions are serialized here so a reader error, writer error and
/// user close cannot overwrite one another's terminal reason.
pub(crate) struct ConnectionStateTracker {
    session_id: String,
    snapshot: Mutex<StateSnapshot>,
    app: Mutex<Option<AppHandle>>,
}

impl ConnectionStateTracker {
    pub(crate) fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            snapshot: Mutex::new(StateSnapshot {
                state: ConnectionState::Connecting,
                reason: None,
                error: None,
                message: None,
                initial_emitted: false,
            }),
            app: Mutex::new(None),
        }
    }

    pub(crate) fn bind_app(&self, app: &AppHandle) {
        *lock_unpoisoned(&self.app) = Some(app.clone());
        let mut snapshot = lock_unpoisoned(&self.snapshot);
        if snapshot.initial_emitted {
            return;
        }
        snapshot.initial_emitted = true;
        self.emit_locked(&snapshot);
    }

    pub(crate) fn state(&self) -> ConnectionState {
        lock_unpoisoned(&self.snapshot).state
    }

    pub(crate) fn connected(&self) -> bool {
        let mut snapshot = lock_unpoisoned(&self.snapshot);
        if snapshot.state != ConnectionState::Connecting {
            return false;
        }
        snapshot.state = ConnectionState::Connected;
        snapshot.reason = None;
        snapshot.error = None;
        snapshot.message = None;
        self.emit_locked(&snapshot);
        true
    }

    pub(crate) fn closing(&self, reason: DisconnectReason) -> bool {
        let mut snapshot = lock_unpoisoned(&self.snapshot);
        if !matches!(
            snapshot.state,
            ConnectionState::Connecting | ConnectionState::Connected
        ) {
            return false;
        }
        snapshot.state = ConnectionState::Closing;
        snapshot.reason = Some(reason);
        snapshot.error = None;
        snapshot.message = None;
        self.emit_locked(&snapshot);
        true
    }

    pub(crate) fn failed(
        &self,
        reason: DisconnectReason,
        error: ConnectionErrorKind,
        message: Option<String>,
    ) -> bool {
        let mut snapshot = lock_unpoisoned(&self.snapshot);
        if !matches!(
            snapshot.state,
            ConnectionState::Connecting | ConnectionState::Connected
        ) {
            return false;
        }
        snapshot.state = ConnectionState::Failed;
        snapshot.reason = Some(reason);
        snapshot.error = Some(error);
        snapshot.message = message;
        self.emit_locked(&snapshot);
        true
    }

    pub(crate) fn disconnected(&self, reason: DisconnectReason) -> bool {
        let mut snapshot = lock_unpoisoned(&self.snapshot);
        if matches!(
            snapshot.state,
            ConnectionState::Failed | ConnectionState::Disconnected
        ) {
            return false;
        }
        let reason = if snapshot.state == ConnectionState::Closing {
            snapshot.reason.unwrap_or(reason)
        } else {
            reason
        };
        snapshot.state = ConnectionState::Disconnected;
        snapshot.reason = Some(reason);
        snapshot.error = None;
        snapshot.message = None;
        self.emit_locked(&snapshot);
        true
    }

    fn emit_locked(&self, snapshot: &StateSnapshot) {
        let Some(app) = lock_unpoisoned(&self.app).clone() else {
            return;
        };
        let _ = app.emit(
            STATE_EVENT,
            ConnectionStateEvent {
                session_id: self.session_id.clone(),
                state: snapshot.state,
                reason: snapshot.reason,
                error: snapshot.error,
                message: snapshot.message.clone(),
            },
        );
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_tracker_allows_only_forward_runtime_states() {
        let tracker = ConnectionStateTracker::new("session-1");
        assert_eq!(tracker.state(), ConnectionState::Connecting);
        assert!(tracker.connected());
        assert!(!tracker.connected());
        assert!(tracker.closing(DisconnectReason::UserRequested));
        assert!(!tracker.failed(
            DisconnectReason::WriteFailed,
            ConnectionErrorKind::Transport,
            Some("write failed".to_owned()),
        ));
        assert!(tracker.disconnected(DisconnectReason::UserRequested));
        assert_eq!(tracker.state(), ConnectionState::Disconnected);
        assert!(!tracker.connected());
    }

    #[test]
    fn first_terminal_outcome_is_preserved() {
        let tracker = ConnectionStateTracker::new("session-2");
        assert!(tracker.failed(
            DisconnectReason::ConnectionFailed,
            ConnectionErrorKind::Connection,
            Some("connection failed".to_owned()),
        ));
        assert!(!tracker.disconnected(DisconnectReason::RemoteClosed));
        assert_eq!(tracker.state(), ConnectionState::Failed);
    }

    #[test]
    fn close_reason_is_preserved_when_cleanup_finishes() {
        let tracker = ConnectionStateTracker::new("session-3");
        assert!(tracker.closing(DisconnectReason::ApplicationShutdown));
        assert!(tracker.disconnected(DisconnectReason::Unknown));
        assert_eq!(tracker.state(), ConnectionState::Disconnected);
    }
}
