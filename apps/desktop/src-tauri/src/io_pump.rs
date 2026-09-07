use std::{
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    thread,
    time::Duration,
};

use crate::lifecycle::CancellationToken;

/// Correlates an internal input with its actual writer operation. Contains no
/// command or credential data and does not depend on the producing feature.
#[derive(Debug)]
pub(crate) struct ControlWriteTrace {
    #[cfg(test)]
    pub events: Option<std::sync::mpsc::Sender<(&'static str, usize)>>,
    pub transaction: u64,
    pub occurrence: usize,
    pub limit: usize,
    pub cursor: u64,
    pub started: std::time::Instant,
}

impl ControlWriteTrace {
    pub(crate) fn log(&self, session: &str, stage: &'static str) {
        #[cfg(test)]
        if let Some(events) = &self.events {
            let _ = events.send((stage, self.occurrence));
        }
        #[cfg(debug_assertions)]
        if std::env::var_os("NETERMINAI_PAGINATION_TRACE").is_some() {
            eprintln!(
                "[neterminai][control] transaction={} session={} occurrence={} budget={}/{} cursor={} stage={} elapsed_us={} payload=20",
                self.transaction,
                session,
                self.occurrence,
                self.occurrence,
                self.limit,
                self.cursor,
                stage,
                self.started.elapsed().as_micros()
            );
        }
        #[cfg(not(debug_assertions))]
        let _ = (
            self.transaction,
            self.occurrence,
            self.limit,
            self.cursor,
            self.started,
            session,
            stage,
        );
    }

    pub(crate) fn write(
        &self,
        session: &str,
        writer: &mut (impl std::io::Write + ?Sized),
    ) -> std::io::Result<()> {
        self.log(session, "transport_write_attempt");
        let result = writer.write_all(b" ");
        self.log(
            session,
            if result.is_ok() {
                "transport_write_ok"
            } else {
                "transport_write_error"
            },
        );
        result?;
        self.log(session, "flush_attempt");
        let result = writer.flush();
        self.log(
            session,
            if result.is_ok() {
                "flush_ok"
            } else {
                "flush_error"
            },
        );
        result
    }
}

pub(crate) const MAX_IO_CHUNK_BYTES: usize = 16 * 1024;
pub(crate) const OUTPUT_QUEUE_CAPACITY: usize = 64;
pub(crate) const OUTPUT_BATCH_BYTES: usize = 64 * 1024;
pub(crate) const INPUT_QUEUE_CAPACITY: usize = 64;
pub(crate) const QUEUE_RETRY_INTERVAL: Duration = Duration::from_millis(2);

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum QueueSendError {
    Cancelled,
    Closed,
    ChunkTooLarge { actual: usize, maximum: usize },
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum QueueReceiveError {
    Cancelled,
}

#[derive(Clone)]
pub(crate) struct OutputSender {
    sender: SyncSender<Vec<u8>>,
    maximum_chunk_bytes: usize,
}

pub(crate) struct OutputReceiver {
    receiver: Receiver<Vec<u8>>,
    pending: Option<Vec<u8>>,
    closed: bool,
}

pub(crate) fn output_queue() -> (OutputSender, OutputReceiver) {
    let (sender, receiver) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
    (
        OutputSender {
            sender,
            maximum_chunk_bytes: MAX_IO_CHUNK_BYTES,
        },
        OutputReceiver {
            receiver,
            pending: None,
            closed: false,
        },
    )
}

impl OutputSender {
    pub(crate) fn send(
        &self,
        mut chunk: Vec<u8>,
        cancellation: &CancellationToken,
    ) -> Result<(), QueueSendError> {
        if chunk.len() > self.maximum_chunk_bytes {
            return Err(QueueSendError::ChunkTooLarge {
                actual: chunk.len(),
                maximum: self.maximum_chunk_bytes,
            });
        }

        loop {
            if cancellation.is_cancelled() {
                return Err(QueueSendError::Cancelled);
            }
            match self.sender.try_send(chunk) {
                Ok(()) => return Ok(()),
                Err(TrySendError::Full(next)) => {
                    chunk = next;
                    thread::sleep(QUEUE_RETRY_INTERVAL);
                }
                Err(TrySendError::Disconnected(_)) => return Err(QueueSendError::Closed),
            }
        }
    }
}

impl OutputReceiver {
    pub(crate) fn next_batch(
        &mut self,
        cancellation: &CancellationToken,
        maximum_batch_bytes: usize,
    ) -> Result<Option<Vec<u8>>, QueueReceiveError> {
        if maximum_batch_bytes == 0 {
            return Ok(None);
        }

        // A reader can enqueue its final bytes immediately before it observes
        // EOF and requests cleanup.  Cleanup cancels the output worker, but
        // already queued bytes still belong to the session and must be
        // delivered before the receiver exits.  Drain those bytes
        // non-blockingly after cancellation; once the queue is empty, return
        // the cancellation signal so a closed session cannot keep waiting.
        if cancellation.is_cancelled() {
            return self
                .try_next_batch(maximum_batch_bytes)
                .map_or(Err(QueueReceiveError::Cancelled), |batch| Ok(Some(batch)));
        }

        let first = match self.pending.take() {
            Some(chunk) => chunk,
            None if self.closed => return Ok(None),
            None => loop {
                if cancellation.is_cancelled() {
                    return Err(QueueReceiveError::Cancelled);
                }
                match self.receiver.recv_timeout(QUEUE_RETRY_INTERVAL) {
                    Ok(chunk) => break chunk,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        self.closed = true;
                        return Ok(None);
                    }
                }
            },
        };

        let mut batch = first;
        while batch.len() < maximum_batch_bytes {
            match self.receiver.try_recv() {
                Ok(chunk) if batch.len() + chunk.len() <= maximum_batch_bytes => {
                    batch.extend_from_slice(&chunk);
                }
                Ok(chunk) => {
                    self.pending = Some(chunk);
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.closed = true;
                    break;
                }
            }
        }
        Ok(Some(batch))
    }

    fn try_next_batch(&mut self, maximum_batch_bytes: usize) -> Option<Vec<u8>> {
        let first = match self.pending.take() {
            Some(chunk) => chunk,
            None if self.closed => return None,
            None => match self.receiver.try_recv() {
                Ok(chunk) => chunk,
                Err(TryRecvError::Empty) => return None,
                Err(TryRecvError::Disconnected) => {
                    self.closed = true;
                    return None;
                }
            },
        };

        let mut batch = first;
        while batch.len() < maximum_batch_bytes {
            match self.receiver.try_recv() {
                Ok(chunk) if batch.len() + chunk.len() <= maximum_batch_bytes => {
                    batch.extend_from_slice(&chunk);
                }
                Ok(chunk) => {
                    self.pending = Some(chunk);
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.closed = true;
                    break;
                }
            }
        }
        Some(batch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_space_reports_actual_flush_failure() {
        struct FailingFlush(Vec<u8>);
        impl std::io::Write for FailingFlush {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.0.extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::other("test flush failure"))
            }
        }
        let mut writer = FailingFlush(Vec::new());
        let trace = ControlWriteTrace {
            events: None,
            transaction: 1,
            occurrence: 5,
            limit: 512,
            cursor: 5,
            started: std::time::Instant::now(),
        };
        assert!(trace.write("test-session", &mut writer).is_err());
        assert_eq!(writer.0, [0x20]);
    }

    #[test]
    fn output_queue_preserves_fifo_and_exact_bytes_when_coalescing() {
        let (sender, mut receiver) = output_queue();
        let cancellation = CancellationToken::new();
        sender.send(vec![0, 1, 2], &cancellation).unwrap();
        sender.send(vec![3, 4], &cancellation).unwrap();

        assert_eq!(
            receiver
                .next_batch(&cancellation, OUTPUT_BATCH_BYTES)
                .unwrap(),
            Some(vec![0, 1, 2, 3, 4])
        );
    }

    #[test]
    fn output_queue_keeps_the_next_chunk_when_batch_limit_is_reached() {
        let (sender, mut receiver) = output_queue();
        let cancellation = CancellationToken::new();
        sender.send(vec![1; 4], &cancellation).unwrap();
        sender.send(vec![2; 4], &cancellation).unwrap();

        assert_eq!(
            receiver.next_batch(&cancellation, 5).unwrap(),
            Some(vec![1; 4])
        );
        assert_eq!(
            receiver.next_batch(&cancellation, 5).unwrap(),
            Some(vec![2; 4])
        );
    }

    #[test]
    fn input_queue_reports_backpressure_instead_of_dropping_bytes() {
        let (sender, _receiver) = mpsc::sync_channel(INPUT_QUEUE_CAPACITY);
        for _ in 0..INPUT_QUEUE_CAPACITY {
            sender.try_send(vec![1]).unwrap();
        }
        assert!(matches!(
            sender.try_send(vec![2]),
            Err(TrySendError::Full(_))
        ));
    }

    #[test]
    fn output_queue_rejects_oversized_chunks_without_truncating() {
        let (sender, _receiver) = output_queue();
        let cancellation = CancellationToken::new();
        let error = sender
            .send(vec![0; MAX_IO_CHUNK_BYTES + 1], &cancellation)
            .expect_err("oversized output must be rejected");
        assert_eq!(
            error,
            QueueSendError::ChunkTooLarge {
                actual: MAX_IO_CHUNK_BYTES + 1,
                maximum: MAX_IO_CHUNK_BYTES,
            }
        );
    }

    #[test]
    fn cancellation_wakes_a_producer_blocked_by_queue_capacity() {
        let (sender, _receiver) = output_queue();
        let cancellation = CancellationToken::new();
        for _ in 0..OUTPUT_QUEUE_CAPACITY {
            sender.send(vec![1], &cancellation).unwrap();
        }
        let blocked_sender = sender.clone();
        let blocked_cancellation = cancellation.clone();
        let handle = thread::spawn(move || blocked_sender.send(vec![2], &blocked_cancellation));

        thread::sleep(Duration::from_millis(10));
        cancellation.cancel();
        assert_eq!(handle.join().unwrap(), Err(QueueSendError::Cancelled));
    }

    #[test]
    fn cancellation_wakes_a_consumer_waiting_for_output() {
        let (_sender, mut receiver) = output_queue();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            receiver.next_batch(&cancellation, OUTPUT_BATCH_BYTES),
            Err(QueueReceiveError::Cancelled)
        );
    }

    #[test]
    fn receiver_reports_end_of_stream_after_all_senders_drop() {
        let (sender, mut receiver) = output_queue();
        let cancellation = CancellationToken::new();
        drop(sender);
        assert_eq!(
            receiver
                .next_batch(&cancellation, OUTPUT_BATCH_BYTES)
                .unwrap(),
            None
        );
        assert_eq!(
            receiver
                .next_batch(&cancellation, OUTPUT_BATCH_BYTES)
                .unwrap(),
            None
        );
    }

    #[test]
    fn cancellation_drains_bytes_already_queued_by_reader() {
        let (sender, mut receiver) = output_queue();
        let cancellation = CancellationToken::new();
        sender.send(b"first".to_vec(), &cancellation).unwrap();
        sender.send(b"second".to_vec(), &cancellation).unwrap();
        cancellation.cancel();

        assert_eq!(
            receiver
                .next_batch(&cancellation, OUTPUT_BATCH_BYTES)
                .unwrap(),
            Some(b"firstsecond".to_vec())
        );
        assert_eq!(
            receiver.next_batch(&cancellation, OUTPUT_BATCH_BYTES),
            Err(QueueReceiveError::Cancelled)
        );
    }
}
