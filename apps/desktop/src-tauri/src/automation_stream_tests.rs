//! Constructed streaming schedules, NOT captured Huawei output. Exercise the
//! real hub, collector, bounded PTY/SSH queue, writer loop and Write/flush path.
use super::*;
use std::io::Write;

struct Endpoint {
    writes: Arc<Mutex<Vec<Vec<u8>>>>,
    flushed: mpsc::Sender<()>,
    first_flush_gate: Option<mpsc::Receiver<()>>,
}

impl Write for Endpoint {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.writes.lock().unwrap().push(bytes.to_vec());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        // Controlled slow transport: no timing assumptions or production sleep.
        if let Some(gate) = self.first_flush_gate.take() {
            gate.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        self.flushed.send(()).unwrap();
        Ok(())
    }
}

fn streaming(pages: usize, serial: bool, burst: bool, telnet: bool, near_cap: bool) {
    let hub = TerminalOutputHub::default();
    let subscription = hub.subscribe("stream-test");
    let lock = hub.command_lock("stream-test");
    let _transaction_lock = lock.try_lock().unwrap();
    let (events, event_rx) = mpsc::channel();
    let (flushed, flush_rx) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let (chunk_ack, ack_rx) = mpsc::channel();
    let writes = Arc::new(Mutex::new(Vec::new()));
    let endpoint = Box::new(Endpoint {
        writes: writes.clone(),
        flushed,
        first_flush_gate: burst.then_some(gate),
    });
    let (enqueue, worker): (Box<dyn Fn(crate::io_pump::ControlWriteTrace) + Send>, _) = if serial {
        let (send, worker) = crate::serial::test_control_writer(endpoint);
        (Box::new(send), worker)
    } else if telnet {
        let (send, worker) = crate::telnet::test_control_writer(endpoint);
        (Box::new(send), worker)
    } else {
        let (send, worker) = crate::terminal::test_control_writer(endpoint);
        (Box::new(send), worker)
    };
    let producer_hub = hub.clone();
    let producer = thread::spawn(move || {
        let mut expected = String::new();
        let sizes = if serial {
            &[1, 2, 3, 5, 1, 7][..]
        } else {
            &[73, 4096, 2, 11, 8192][..]
        };
        for page in 1..=pages {
            let mut text = format!("Page {page} 设备状态 [UP]\r\nInterface   Address   Status\r\n");
            if near_cap {
                text.push_str(&"long business output [UP]\r\n".repeat(3100));
            }
            expected.push_str(&text.replace("\r\n", "\n"));
            // Pager has no newline; it is erased by terminal control bytes.
            let bytes = format!("{text}\x1b[7m---- More ----\x1b[0m").into_bytes();
            let mut position = 0;
            let mut index = 0;
            while position < bytes.len() {
                let end = (position + sizes[index % sizes.len()]).min(bytes.len());
                producer_hub.publish("stream-test", &bytes[position..end]);
                if serial {
                    ack_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                }
                position = end;
                index += 1;
            }
            if !burst {
                flush_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            }
            producer_hub.publish("stream-test", b"\r\x1b[2K\x08\r\n");
            if serial {
                ack_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            }
        }
        for part in [b"<FW".as_slice(), b"1>"] {
            producer_hub.publish("stream-test", part);
            if serial {
                ack_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            }
        }
        // Keep the receiver alive until the blocked writer drains all pages.
        if burst {
            for _ in 0..pages {
                flush_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            }
        }
        expected
    });
    let mut collector = CommandCollector::new("display current-configuration", None);
    let mut cursor = subscription.start_cursor();
    let mut requested = 0;
    let mut max_lag = 0;
    let final_prompt = loop {
        let (seq, bytes) = subscription
            .recv_with_cursor(Duration::from_secs(10))
            .unwrap();
        assert_eq!(seq, cursor + 1);
        cursor = seq;
        max_lag = max_lag.max(subscription.published_cursor().saturating_sub(seq));
        let signal = collector.push(&bytes).unwrap();
        assert!(collector.more_detector.window.len() <= 128);
        while requested < signal.more_markers {
            requested += 1;
            enqueue(crate::io_pump::ControlWriteTrace {
                events: Some(events.clone()),
                transaction: 1,
                occurrence: requested,
                limit: MAX_PAGINATION_COUNT,
                cursor,
                started: Instant::now(),
            });
            // Five pages must be ingested/enqueued while the first flush is
            // blocked. This detects collector/writer coupling and the 4→5 gap.
            if burst && requested == 5 {
                release.send(()).unwrap();
            }
        }
        if serial {
            chunk_ack.send(()).unwrap();
        }
        if let Some(prompt) = signal.prompt {
            break prompt;
        }
    };
    drop(enqueue);
    worker.join().unwrap();
    let expected = producer.join().unwrap();
    assert_eq!(requested, pages);
    assert_eq!(*writes.lock().unwrap(), vec![vec![0x20]; pages]);
    drop(events);
    let recorded: Vec<_> = event_rx.into_iter().collect();
    for stage in [
        "space_requested",
        "space_enqueued",
        "space_dequeued",
        "transport_write_attempt",
        "transport_write_ok",
        "flush_attempt",
        "flush_ok",
    ] {
        let occurrences: Vec<_> = recorded
            .iter()
            .filter(|(name, _)| *name == stage)
            .map(|(_, n)| *n)
            .collect();
        assert_eq!(occurrences, (1..=pages).collect::<Vec<_>>(), "{stage}");
    }
    let output = collector.normalized_output(Some(&final_prompt));
    // Erased pager rows may leave blank lines, but every business row must
    // remain intact and ordered, including multibyte UTF-8 split mid-character.
    assert_eq!(
        output
            .lines()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>(),
        expected.lines().collect::<Vec<_>>()
    );
    assert!(!output.contains("More"));
    if near_cap {
        assert!(collector.raw.len() > MAX_COLLECTED_OUTPUT_BYTES * 9 / 10);
        assert!(collector.raw.len() < MAX_COLLECTED_OUTPUT_BYTES);
    }
    assert_eq!(subscription.published_cursor(), cursor);
    eprintln!(
        "constructed stream pages={pages} serial={serial} burst={burst} max_backlog={max_lag} final_backlog=0"
    );
}

#[test]
fn fast_paged_stream_reaches_transport_across_four_to_five() {
    for pages in [4, 5, 6, 10, 50] {
        streaming(pages, false, false, false, false);
    }
}

#[test]
fn burst_output_continues_while_transport_flush_is_blocked() {
    for pages in [5, 6, 10, 50] {
        streaming(pages, false, true, false, false);
    }
}

#[test]
fn serial_character_stream_paces_each_chunk_without_newline_dependency() {
    streaming(10, true, false, false, false);
    streaming(50, true, false, false, false);
}

#[test]
fn fast_telnet_stream_passes_through_hub_queue_and_tcp_peer() {
    for pages in [4, 5, 6, 10, 50] {
        streaming(pages, false, false, true, false);
    }
}

#[test]
fn near_cap_stream_keeps_all_pages_and_transport_actions() {
    streaming(50, false, false, false, true);
}

#[test]
fn continuous_serial_output_does_not_reset_absolute_timeout() {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(1);
    let hub = TerminalOutputHub::default();
    let lock = hub.command_lock("timeout-test");
    let error = (|| -> Result<(), CommandFailure> {
        let _guard = lock.try_lock().unwrap();
        let subscription = hub.subscribe("timeout-test");
        let mut collector = CommandCollector::new("display current-configuration", None);
        for step in 0..=10 {
            // Deterministic logical time instead of scheduler-dependent sleep.
            let now = started + Duration::from_millis(step * 100);
            if command_poll_budget(deadline, now).is_none() {
                return Err(CommandFailure::timeout("absolute command deadline"));
            }
            hub.publish("timeout-test", b"slow output\r\n");
            let (_, chunk) = subscription
                .recv_with_cursor(Duration::from_secs(1))
                .unwrap();
            collector.push(&chunk).unwrap();
        }
        panic!("continuous RX must not postpone timeout")
    })()
    .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert!(lock.try_lock().is_ok());
    let fresh = hub.subscribe("timeout-test");
    hub.publish("timeout-test", b"manual command output");
    assert_eq!(
        fresh.recv_with_cursor(Duration::from_secs(1)).unwrap().1,
        b"manual command output"
    );
}
