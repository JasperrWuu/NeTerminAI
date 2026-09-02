use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const BINARY: u8 = 0;
const ECHO: u8 = 1;
const SUPPRESS_GO_AHEAD: u8 = 3;
const TERMINAL_TYPE: u8 = 24;
const NAWS: u8 = 31;

const OUTPUT_EVENT: &str = "telnet:output";
const EXIT_EVENT: &str = "telnet:exit";

mod runtime;
pub use runtime::TelnetManager;

#[derive(Default)]
enum ParseState {
    #[default]
    Data,
    Command,
    Negotiation(u8),
    SubNegotiation(Vec<u8>),
    SubNegotiationCommand(Vec<u8>),
}

#[derive(Default)]
struct ProtocolFrame {
    output: Vec<u8>,
    responses: Vec<Vec<u8>>,
}

struct TelnetProtocol {
    state: ParseState,
    columns: u16,
    rows: u16,
    remote_enabled: HashSet<u8>,
    remote_rejected: HashSet<u8>,
    local_enabled: HashSet<u8>,
    local_rejected: HashSet<u8>,
    window_size_enabled: Arc<AtomicBool>,
}

impl TelnetProtocol {
    fn new(columns: u16, rows: u16, window_size_enabled: Arc<AtomicBool>) -> Self {
        Self {
            state: ParseState::Data,
            columns,
            rows,
            remote_enabled: HashSet::new(),
            remote_rejected: HashSet::new(),
            local_enabled: HashSet::new(),
            local_rejected: HashSet::new(),
            window_size_enabled,
        }
    }

    fn decode(&mut self, input: &[u8]) -> ProtocolFrame {
        let mut frame = ProtocolFrame {
            output: Vec::with_capacity(input.len()),
            responses: Vec::new(),
        };
        for &byte in input {
            self.state = match std::mem::take(&mut self.state) {
                ParseState::Data if byte == IAC => ParseState::Command,
                ParseState::Data => {
                    frame.output.push(byte);
                    ParseState::Data
                }
                ParseState::Command if byte == IAC => {
                    frame.output.push(IAC);
                    ParseState::Data
                }
                ParseState::Command if matches!(byte, WILL | WONT | DO | DONT) => {
                    ParseState::Negotiation(byte)
                }
                ParseState::Command if byte == SB => ParseState::SubNegotiation(Vec::new()),
                ParseState::Command => ParseState::Data,
                ParseState::Negotiation(command) => {
                    self.negotiate(command, byte, &mut frame.responses);
                    ParseState::Data
                }
                ParseState::SubNegotiation(bytes) if byte == IAC => {
                    ParseState::SubNegotiationCommand(bytes)
                }
                ParseState::SubNegotiation(mut bytes) => {
                    bytes.push(byte);
                    ParseState::SubNegotiation(bytes)
                }
                ParseState::SubNegotiationCommand(bytes) if byte == SE => {
                    if let Some(response) = terminal_type_response(&bytes) {
                        frame.responses.push(response);
                    }
                    ParseState::Data
                }
                ParseState::SubNegotiationCommand(mut bytes) if byte == IAC => {
                    bytes.push(IAC);
                    ParseState::SubNegotiation(bytes)
                }
                ParseState::SubNegotiationCommand(bytes) => ParseState::SubNegotiation(bytes),
            };
        }
        frame
    }

    fn negotiate(&mut self, command: u8, option: u8, responses: &mut Vec<Vec<u8>>) {
        match command {
            WILL if matches!(option, ECHO | SUPPRESS_GO_AHEAD | BINARY) => {
                if self.remote_enabled.insert(option) {
                    responses.push(vec![IAC, DO, option]);
                }
            }
            WILL => {
                if self.remote_rejected.insert(option) {
                    responses.push(vec![IAC, DONT, option]);
                }
            }
            DO if matches!(option, SUPPRESS_GO_AHEAD | BINARY | TERMINAL_TYPE | NAWS) => {
                if self.local_enabled.insert(option) {
                    responses.push(vec![IAC, WILL, option]);
                    if option == NAWS {
                        self.window_size_enabled.store(true, Ordering::Release);
                        responses.push(window_size_message(self.columns, self.rows));
                    }
                }
            }
            DO => {
                if self.local_rejected.insert(option) {
                    responses.push(vec![IAC, WONT, option]);
                }
            }
            WONT => {
                self.remote_enabled.remove(&option);
            }
            DONT => {
                self.local_enabled.remove(&option);
                if option == NAWS {
                    self.window_size_enabled.store(false, Ordering::Release);
                }
            }
            _ => {}
        }
    }
}

fn terminal_type_response(bytes: &[u8]) -> Option<Vec<u8>> {
    if !bytes.starts_with(&[TERMINAL_TYPE, 1]) {
        return None;
    }
    let mut response = vec![IAC, SB, TERMINAL_TYPE, 0];
    response.extend_from_slice(b"XTERM-256COLOR");
    response.extend_from_slice(&[IAC, SE]);
    Some(response)
}

fn window_size_message(columns: u16, rows: u16) -> Vec<u8> {
    let mut message = vec![IAC, SB, NAWS];
    message.extend(escape_iac(&columns.to_be_bytes()));
    message.extend(escape_iac(&rows.to_be_bytes()));
    message.extend_from_slice(&[IAC, SE]);
    message
}

fn escape_iac(data: &[u8]) -> Vec<u8> {
    let mut escaped = Vec::with_capacity(data.len());
    for &byte in data {
        escaped.push(byte);
        if byte == IAC {
            escaped.push(IAC);
        }
    }
    escaped
}

fn line_message(value: &str) -> Vec<u8> {
    let mut bytes = escape_iac(value.as_bytes());
    bytes.extend_from_slice(b"\r\n");
    bytes
}

fn append_prompt_text(prompt: &mut String, output: &[u8]) {
    prompt.extend(output.iter().map(|byte| {
        if byte.is_ascii() {
            byte.to_ascii_lowercase() as char
        } else {
            ' '
        }
    }));
    if prompt.len() > 512 {
        prompt.drain(..prompt.len() - 512);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protocol() -> TelnetProtocol {
        TelnetProtocol::new(80, 24, Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn user_input_escapes_telnet_command_byte() {
        assert_eq!(escape_iac(&[b'a', IAC, b'b']), vec![b'a', IAC, IAC, b'b']);
    }

    #[test]
    fn protocol_separates_display_data_from_negotiation() {
        let mut protocol = protocol();
        let frame = protocol.decode(&[b'h', b'i', IAC, WILL, ECHO, b'!']);

        assert_eq!(frame.output, b"hi!");
        assert_eq!(frame.responses, vec![vec![IAC, DO, ECHO]]);
    }

    #[test]
    fn negative_negotiation_does_not_create_a_response_loop() {
        let mut protocol = protocol();
        let frame = protocol.decode(&[IAC, WONT, ECHO, IAC, DONT, NAWS]);

        assert!(frame.output.is_empty());
        assert!(frame.responses.is_empty());
    }

    #[test]
    fn repeated_negotiation_is_acknowledged_only_once() {
        let mut protocol = protocol();
        let first = protocol.decode(&[IAC, WILL, ECHO]);
        let repeated = protocol.decode(&[IAC, WILL, ECHO]);

        assert_eq!(first.responses, vec![vec![IAC, DO, ECHO]]);
        assert!(repeated.responses.is_empty());
    }

    #[test]
    fn window_size_updates_require_server_negotiation() {
        let enabled = Arc::new(AtomicBool::new(false));
        let mut protocol = TelnetProtocol::new(80, 24, Arc::clone(&enabled));

        protocol.decode(&[IAC, DO, NAWS]);
        assert!(enabled.load(Ordering::Acquire));

        protocol.decode(&[IAC, DONT, NAWS]);
        assert!(!enabled.load(Ordering::Acquire));
    }

    #[test]
    fn prompt_scanner_handles_non_ascii_output_without_invalid_string_boundaries() {
        let mut prompt = String::new();
        let output = "设备登录提示".repeat(200);

        append_prompt_text(&mut prompt, output.as_bytes());

        assert_eq!(prompt.len(), 512);
        assert!(prompt.is_ascii());
    }
}
