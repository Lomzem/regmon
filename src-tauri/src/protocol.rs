use std::collections::{BTreeSet, VecDeque};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use thiserror::Error;

pub const SYNC: [u8; 4] = [0xBA, 0xD2, 0xAC, 0xE5];
pub const HEADER_LEN: usize = 9;
pub const MAX_CONTENT_LEN: usize = 8192;
pub const MAX_PRINT_RECORD_LEN: usize = 64 * 1024;
pub const CLIENT_ADDRESS: u8 = 0x00;
pub const FRAME_CONTROLLER_ADDRESS: u8 = 0x10;
pub const CONNECT_VERIFY_OID: u16 = 0xFF03;
pub const SET_PARAM: u8 = 0x4A;
pub const OGP_PRINT: u8 = 0x00;
pub const OGP_COMMAND: u8 = 0x44;
pub const OGP_COMMAND_ACK: u8 = 0xC4;
pub const SETTLE_TIME: Duration = Duration::from_millis(350);
pub const MAX_MISSING_RETRIES: u8 = 2;
pub const SET_PARAM_RESPONSE: u8 = SET_PARAM | 0x80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub source: u8,
    pub destination: u8,
    pub message_type: u8,
    pub content: Vec<u8>,
}

impl Frame {
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        if self.content.len() > MAX_CONTENT_LEN {
            return Err(ProtocolError::ContentTooLarge(self.content.len()));
        }
        let mut bytes = Vec::with_capacity(HEADER_LEN + self.content.len());
        bytes.extend_from_slice(&SYNC);
        bytes.push(self.source);
        bytes.push(self.destination);
        bytes.push(self.message_type);
        bytes.extend_from_slice(&(self.content.len() as u16).to_be_bytes());
        bytes.extend_from_slice(&self.content);
        Ok(bytes)
    }
}

#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    pub fn next_frame(&mut self) -> Result<Option<Frame>, ProtocolError> {
        self.align_to_sync();
        if self.buffer.len() < HEADER_LEN {
            return Ok(None);
        }
        let content_len = u16::from_be_bytes([self.buffer[7], self.buffer[8]]) as usize;
        if content_len > MAX_CONTENT_LEN {
            self.buffer.drain(..4);
            return Err(ProtocolError::ContentTooLarge(content_len));
        }
        let frame_len = HEADER_LEN + content_len;
        if self.buffer.len() < frame_len {
            return Ok(None);
        }
        let frame = Frame {
            source: self.buffer[4],
            destination: self.buffer[5],
            message_type: self.buffer[6],
            content: self.buffer[HEADER_LEN..frame_len].to_vec(),
        };
        self.buffer.drain(..frame_len);
        Ok(Some(frame))
    }

    fn align_to_sync(&mut self) {
        if self.buffer.starts_with(&SYNC) {
            return;
        }
        if let Some(position) = self
            .buffer
            .windows(SYNC.len())
            .position(|item| item == SYNC)
        {
            self.buffer.drain(..position);
        } else if self.buffer.len() > SYNC.len() - 1 {
            self.buffer.drain(..self.buffer.len() - (SYNC.len() - 1));
        }
    }
}

pub fn handshake_request(force: bool) -> Frame {
    let mut content = vec![0];
    content.extend_from_slice(&CONNECT_VERIFY_OID.to_be_bytes());
    content.push(4);
    content.extend_from_slice(&u16::from(force).to_be_bytes());
    content.extend_from_slice(&0u16.to_be_bytes());
    Frame {
        source: CLIENT_ADDRESS,
        destination: FRAME_CONTROLLER_ADDRESS,
        message_type: SET_PARAM,
        content,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectVerifyResponse {
    pub return_code: u8,
    pub allow: u16,
    pub state: Option<u16>,
    pub reason: Option<u16>,
}

pub fn parse_connect_verify_response(
    frame: &Frame,
) -> Result<ConnectVerifyResponse, ProtocolError> {
    if frame.source != FRAME_CONTROLLER_ADDRESS {
        return Err(ProtocolError::InvalidHandshakeResponse(format!(
            "source was 0x{:02X}, expected 0x{FRAME_CONTROLLER_ADDRESS:02X}",
            frame.source
        )));
    }
    if frame.destination != CLIENT_ADDRESS {
        return Err(ProtocolError::InvalidHandshakeResponse(format!(
            "destination was 0x{:02X}, expected 0x{CLIENT_ADDRESS:02X}",
            frame.destination
        )));
    }
    if frame.message_type != SET_PARAM_RESPONSE {
        return Err(ProtocolError::InvalidHandshakeResponse(format!(
            "type was 0x{:02X}, expected 0x{SET_PARAM_RESPONSE:02X}",
            frame.message_type
        )));
    }
    if frame.content.len() < 4 {
        return Err(ProtocolError::InvalidHandshakeResponse(
            "content was truncated before the OID and data length".to_owned(),
        ));
    }

    let oid = u16::from_be_bytes([frame.content[1], frame.content[2]]);
    if oid != CONNECT_VERIFY_OID {
        return Err(ProtocolError::InvalidHandshakeResponse(format!(
            "OID was 0x{oid:04X}, expected 0x{CONNECT_VERIFY_OID:04X}"
        )));
    }
    let data_len = frame.content[3] as usize;
    if !matches!(data_len, 2 | 4 | 6) {
        return Err(ProtocolError::InvalidHandshakeResponse(format!(
            "data length was {data_len}, expected 2, 4, or 6"
        )));
    }
    if frame.content.len() != 4 + data_len {
        return Err(ProtocolError::InvalidHandshakeResponse(format!(
            "content length was {}, expected {} from data length {data_len}",
            frame.content.len(),
            4 + data_len
        )));
    }

    Ok(ConnectVerifyResponse {
        return_code: frame.content[0],
        allow: u16::from_be_bytes([frame.content[4], frame.content[5]]),
        state: (data_len >= 4).then(|| u16::from_be_bytes([frame.content[6], frame.content[7]])),
        reason: (data_len >= 6).then(|| u16::from_be_bytes([frame.content[8], frame.content[9]])),
    })
}

pub fn command_request(destination: u8, address: u8) -> Frame {
    let mut content = format!("fpgarr 0x{address:02X}").into_bytes();
    content.push(0);
    Frame {
        source: CLIENT_ADDRESS,
        destination,
        message_type: OGP_COMMAND,
        content,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterResult {
    pub address: u8,
    pub value: u8,
}

#[derive(Debug, Default)]
pub struct PrintParser {
    buffer: Vec<u8>,
    discarding_record: bool,
}

impl PrintParser {
    pub fn push(&mut self, bytes: &[u8]) -> PrintOutput {
        let mut output = PrintOutput::default();
        for byte in bytes {
            if matches!(byte, 0 | b'\r' | b'\n') {
                if self.discarding_record {
                    self.discarding_record = false;
                } else if !self.buffer.is_empty() {
                    let bytes = std::mem::take(&mut self.buffer);
                    self.consume_line(String::from_utf8_lossy(&bytes).into_owned(), &mut output);
                }
                continue;
            }
            if self.discarding_record {
                continue;
            }
            if self.buffer.len() == MAX_PRINT_RECORD_LEN {
                self.buffer.clear();
                self.discarding_record = true;
                output.overflowed = true;
                continue;
            }
            self.buffer.push(*byte);
        }
        output
    }

    pub fn flush(&mut self) -> PrintOutput {
        let mut output = PrintOutput::default();
        if self.discarding_record {
            self.discarding_record = false;
            return output;
        }
        if !self.buffer.is_empty() {
            let bytes = std::mem::take(&mut self.buffer);
            let line = String::from_utf8_lossy(&bytes).into_owned();
            self.consume_line(line, &mut output);
        }
        output
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
        self.discarding_record = false;
    }

    fn consume_line(&self, line: String, output: &mut PrintOutput) {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        let pattern = PATTERN.get_or_init(|| {
            Regex::new(r"(?i)^\s*Register\s+0x([0-9a-f]+)\s*=\s*0x([0-9a-f]+)\s*$")
                .expect("register pattern is valid")
        });
        let Some(captures) = pattern.captures(&line) else {
            if !line.trim().is_empty() {
                output.unmatched.push(line);
            }
            return;
        };
        let address = u16::from_str_radix(&captures[1], 16);
        let value = u16::from_str_radix(&captures[2], 16);
        match (address, value) {
            (Ok(address @ 0..=0xFF), Ok(value @ 0..=0xFF)) => {
                output.results.push(RegisterResult {
                    address: address as u8,
                    value: value as u8,
                });
            }
            _ => output.unmatched.push(line),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PrintOutput {
    pub results: Vec<RegisterResult>,
    pub unmatched: Vec<String>,
    pub overflowed: bool,
}

#[derive(Debug)]
pub struct ScanState {
    pub missing: BTreeSet<u8>,
    queue: VecDeque<u8>,
    issued: BTreeSet<u8>,
    awaiting_ack: Option<u8>,
    retries: u8,
}

impl ScanState {
    pub fn new(addresses: impl IntoIterator<Item = u8>) -> Self {
        let requested = addresses.into_iter().collect::<BTreeSet<_>>();
        Self {
            missing: requested.clone(),
            queue: requested.iter().copied().collect(),
            issued: BTreeSet::new(),
            awaiting_ack: None,
            retries: 0,
        }
    }

    pub fn next_to_send(&mut self) -> Option<u8> {
        if self.awaiting_ack.is_some() {
            return None;
        }
        let address = self.queue.pop_front()?;
        self.issued.insert(address);
        self.awaiting_ack = Some(address);
        Some(address)
    }

    pub fn acknowledge(&mut self) -> bool {
        self.awaiting_ack.take().is_some()
    }

    pub fn record(&mut self, result: &RegisterResult) -> bool {
        if !self.issued.contains(&result.address) {
            return false;
        }
        self.missing.remove(&result.address);
        true
    }

    pub fn commands_done(&self) -> bool {
        self.queue.is_empty() && self.awaiting_ack.is_none()
    }

    pub fn retry_missing(&mut self) -> bool {
        if self.missing.is_empty() || self.retries >= MAX_MISSING_RETRIES {
            return false;
        }
        self.retries += 1;
        self.queue = self.missing.iter().copied().collect();
        true
    }
}

#[derive(Debug, Clone, Serialize, Error)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum ProtocolError {
    #[error("OGP content is too large: {0} bytes")]
    ContentTooLarge(usize),
    #[error("invalid CONNECT_VERIFY response: {0}")]
    InvalidHandshakeResponse(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(message_type: u8, content: &[u8]) -> Vec<u8> {
        Frame {
            source: 0x11,
            destination: 0,
            message_type,
            content: content.to_vec(),
        }
        .encode()
        .unwrap()
    }

    #[test]
    fn decoder_handles_fragmented_and_coalesced_frames() {
        let first = frame(0xC4, &[0]);
        let second = frame(0, b"hello");
        let mut decoder = FrameDecoder::default();
        decoder.push(&first[..5]);
        assert!(decoder.next_frame().unwrap().is_none());
        decoder.push(&[&first[5..], &second].concat());
        assert_eq!(decoder.next_frame().unwrap().unwrap().message_type, 0xC4);
        assert_eq!(decoder.next_frame().unwrap().unwrap().content, b"hello");
    }

    #[test]
    fn decoder_recovers_from_noise_and_oversize_header() {
        let mut bytes = vec![1, 2, 3];
        bytes.extend_from_slice(&SYNC);
        bytes.extend_from_slice(&[0, 0x11, 0, 0x20, 0x01]);
        bytes.extend_from_slice(&frame(0xC4, &[0]));
        let mut decoder = FrameDecoder::default();
        decoder.push(&bytes);
        assert!(matches!(
            decoder.next_frame(),
            Err(ProtocolError::ContentTooLarge(_))
        ));
        assert_eq!(decoder.next_frame().unwrap().unwrap().message_type, 0xC4);
    }

    #[test]
    fn handshake_and_command_have_canonical_wire_bytes() {
        assert_eq!(
            handshake_request(false).encode().unwrap(),
            [
                SYNC.as_slice(),
                &[0, 0x10, 0x4A, 0, 8, 0, 0xFF, 3, 4, 0, 0, 0, 0]
            ]
            .concat()
        );
        assert_eq!(command_request(0x15, 0xA7).content, b"fpgarr 0xA7\0");
    }

    fn connect_response(content: &[u8]) -> Frame {
        Frame {
            source: FRAME_CONTROLLER_ADDRESS,
            destination: CLIENT_ADDRESS,
            message_type: SET_PARAM_RESPONSE,
            content: content.to_vec(),
        }
    }

    #[test]
    fn connect_verify_response_parses_allow_and_refusal_details() {
        let allowed =
            parse_connect_verify_response(&connect_response(&[0, 0xFF, 0x03, 2, 0, 1])).unwrap();
        assert_eq!(allowed.allow, 1);
        assert_eq!(allowed.state, None);

        let refused = parse_connect_verify_response(&connect_response(&[
            7, 0xFF, 0x03, 6, 0, 0, 0x12, 0x34, 0x56, 0x78,
        ]))
        .unwrap();
        assert_eq!(refused.return_code, 7);
        assert_eq!(refused.allow, 0);
        assert_eq!(refused.state, Some(0x1234));
        assert_eq!(refused.reason, Some(0x5678));
    }

    #[test]
    fn connect_verify_response_rejects_wrong_oid_and_truncated_data() {
        let wrong_oid = connect_response(&[0, 0xFF, 0x04, 2, 0, 1]);
        assert!(matches!(
            parse_connect_verify_response(&wrong_oid),
            Err(ProtocolError::InvalidHandshakeResponse(_))
        ));

        let truncated = connect_response(&[0, 0xFF, 0x03, 6, 0, 0]);
        assert!(matches!(
            parse_connect_verify_response(&truncated),
            Err(ProtocolError::InvalidHandshakeResponse(_))
        ));

        let mut wrong_address = connect_response(&[0, 0xFF, 0x03, 2, 0, 1]);
        wrong_address.destination = 0x22;
        assert!(matches!(
            parse_connect_verify_response(&wrong_address),
            Err(ProtocolError::InvalidHandshakeResponse(_))
        ));

        let mut wrong_type = connect_response(&[0, 0xFF, 0x03, 2, 0, 1]);
        wrong_type.message_type = OGP_COMMAND_ACK;
        assert!(matches!(
            parse_connect_verify_response(&wrong_type),
            Err(ProtocolError::InvalidHandshakeResponse(_))
        ));
    }

    #[test]
    fn print_parser_handles_splits_duplicates_and_unrelated_lines() {
        let mut parser = PrintParser::default();
        assert!(parser.push(b"Regis").results.is_empty());
        let output = parser.push(b"ter 0x0a = 0x1F\r\nnoise\nRegister 0x0A = 0x20\n");
        assert_eq!(output.results.len(), 2);
        assert_eq!(
            output.results[1],
            RegisterResult {
                address: 10,
                value: 32
            }
        );
        assert_eq!(output.unmatched, ["noise"]);
    }

    #[test]
    fn print_parser_uses_nul_boundaries_for_fragmented_and_coalesced_records() {
        let mut parser = PrintParser::default();
        assert!(parser.push(b"Register 0x01 =").results.is_empty());
        let output = parser.push(b" 0x02\0Register 0x03 = 0x04\0noise\0");
        assert_eq!(
            output.results,
            [
                RegisterResult {
                    address: 1,
                    value: 2
                },
                RegisterResult {
                    address: 3,
                    value: 4
                }
            ]
        );
        assert_eq!(output.unmatched, ["noise"]);
    }

    #[test]
    fn print_parser_bounds_unterminated_records_and_recovers_at_boundary() {
        let mut parser = PrintParser::default();
        let output = parser.push(&vec![b'x'; MAX_PRINT_RECORD_LEN + 1]);
        assert!(output.overflowed);
        assert!(parser.buffer.is_empty());

        let output = parser.push(b"\0Register 0x01 = 0x02\0");
        assert_eq!(
            output.results,
            [RegisterResult {
                address: 1,
                value: 2
            }]
        );
        assert!(!output.overflowed);
    }

    #[test]
    fn scan_accepts_print_before_or_after_ack_and_retries_only_missing() {
        let mut scan = ScanState::new([1, 2]);
        assert!(!scan.record(&RegisterResult {
            address: 2,
            value: 8
        }));
        assert_eq!(scan.next_to_send(), Some(1));
        assert!(scan.record(&RegisterResult {
            address: 1,
            value: 9
        }));
        assert!(scan.record(&RegisterResult {
            address: 1,
            value: 10
        }));
        assert!(scan.acknowledge());
        assert_eq!(scan.next_to_send(), Some(2));
        assert!(scan.acknowledge());
        assert!(scan.commands_done());
        assert!(scan.retry_missing());
        assert_eq!(scan.next_to_send(), Some(2));
    }
}
