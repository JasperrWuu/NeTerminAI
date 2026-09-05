use std::{
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    thread,
    time::Duration,
};

use crate::lifecycle::CancellationToken;

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
    Closed,
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
        if cancellation.is_cancelled() {
            return Err(QueueReceiveError::Cancelled);
        }
        if maximum_batch_bytes == 0 {
            return Ok(None);
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
