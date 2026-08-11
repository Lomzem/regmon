mod protocol;

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant as StdInstant};

use protocol::{Frame, FrameDecoder, PrintParser, ScanState};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpStream};
use tokio::sync::mpsc;
use tokio::time::{timeout, Instant};
use tokio_util::sync::CancellationToken;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
const ACK_TIMEOUT: Duration = Duration::from_secs(2);
const UART_SCAN_TIMEOUT: Duration = Duration::from_secs(3);
const OGP_SCAN_TIMEOUT: Duration = Duration::from_secs(120);
const OGP_QUIET_DRAIN_MAX: Duration = Duration::from_secs(1);
const MAX_DEFERRED_HANDSHAKE_FRAMES: usize = 64;
const MAX_DEFERRED_HANDSHAKE_BYTES: usize = 64 * 1024;
const UART_COMMAND: &[u8] = b"r 1 1\r\n";

#[derive(Debug)]
struct QuietDrain {
    deadline: Instant,
    limit: Instant,
}

impl QuietDrain {
    fn new(now: Instant) -> Self {
        Self {
            deadline: now + protocol::SETTLE_TIME,
            limit: now + OGP_QUIET_DRAIN_MAX,
        }
    }

    fn observe_output(&mut self, output: &protocol::PrintOutput, now: Instant) {
        if !output.results.is_empty() {
            self.deadline = (now + protocol::SETTLE_TIME).min(self.limit);
        }
    }

    fn ready(&self, now: Instant) -> bool {
        now >= self.deadline
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialEndpoint {
    id: String,
    label: String,
    path: String,
    usb_vendor_id: Option<u16>,
    usb_product_id: Option<u16>,
    serial_number: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterUpdate {
    address: u8,
    value: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ConnectionConfig {
    Uart {
        port_id: String,
    },
    Ogp {
        host: String,
        port: u16,
        slot: u8,
        force: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TransportEvent {
    Status {
        generation: u64,
        status: ConnectionStatus,
    },
    ScanStarted {
        generation: u64,
        addresses: Vec<u8>,
    },
    Registers {
        generation: u64,
        updates: Vec<RegisterUpdate>,
        missing: Vec<u8>,
    },
    ScanComplete {
        generation: u64,
        missing: Vec<u8>,
    },
    Log {
        generation: u64,
        text: String,
    },
    Error {
        generation: u64,
        error: ErrorPayload,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    kind: &'static str,
    message: String,
    recoverable: bool,
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error("invalid connection configuration: {0}")]
    InvalidConfig(String),
    #[error("serial port is not one of the enumerated ports")]
    UnknownSerialPort,
    #[error("serial operation failed: {0}")]
    Serial(String),
    #[error("TCP operation failed: {0}")]
    Network(String),
    #[error("OGP protocol failed: {0}")]
    Protocol(String),
    #[error("connection operation timed out: {0}")]
    Timeout(&'static str),
    #[error("connection handshake was rejected: {0}")]
    HandshakeRejected(String),
    #[error("there is no active session")]
    NoSession,
    #[error("the requested session is stale")]
    StaleSession,
    #[error("a scan is already active")]
    ScanBusy,
}

impl AppError {
    fn payload(&self) -> ErrorPayload {
        let (kind, recoverable) = match self {
            Self::InvalidConfig(_) => ("invalidConfig", false),
            Self::UnknownSerialPort => ("unknownSerialPort", true),
            Self::Serial(_) => ("serial", true),
            Self::Network(_) => ("network", true),
            Self::Protocol(_) => ("protocol", true),
            Self::Timeout(_) => ("timeout", true),
            Self::HandshakeRejected(_) => ("handshakeRejected", false),
            Self::NoSession => ("noSession", true),
            Self::StaleSession => ("staleSession", true),
            Self::ScanBusy => ("scanBusy", true),
        };
        ErrorPayload {
            kind,
            message: self.to_string(),
            recoverable,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.payload().serialize(serializer)
    }
}

enum Control {
    Scan(Vec<u8>),
    Stop,
}

enum ControlSender {
    Async(mpsc::Sender<Control>),
    Blocking(std_mpsc::Sender<Control>),
}

struct SessionHandle {
    generation: u64,
    cancellation: CancellationToken,
    control: ControlSender,
}

#[derive(Default)]
struct AppState {
    next_generation: AtomicU64,
    session: Mutex<Option<SessionHandle>>,
}

fn send_event(channel: &Channel<TransportEvent>, event: TransportEvent) {
    let _ = channel.send(event);
}

fn send_scan_failure(
    channel: &Channel<TransportEvent>,
    generation: u64,
    error: AppError,
    missing: Vec<u8>,
) {
    send_event(
        channel,
        TransportEvent::Error {
            generation,
            error: error.payload(),
        },
    );
    send_event(
        channel,
        TransportEvent::ScanComplete {
            generation,
            missing,
        },
    );
}

fn serial_endpoints() -> Result<Vec<SerialEndpoint>, AppError> {
    let ports =
        serialport::available_ports().map_err(|error| AppError::Serial(error.to_string()))?;
    Ok(ports
        .into_iter()
        .map(|port| {
            let (vendor, product, serial) = match port.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    (Some(info.vid), Some(info.pid), info.serial_number)
                }
                _ => (None, None, None),
            };
            let id = format!(
                "{}|{}|{}|{}",
                port.port_name,
                vendor.map_or_else(String::new, |value| format!("{value:04X}")),
                product.map_or_else(String::new, |value| format!("{value:04X}")),
                serial.as_deref().unwrap_or_default()
            );
            let label = match (vendor, product) {
                (Some(vendor), Some(product)) => {
                    format!("{} (USB {vendor:04X}:{product:04X})", port.port_name)
                }
                _ => port.port_name.clone(),
            };
            SerialEndpoint {
                id,
                label,
                path: port.port_name,
                usb_vendor_id: vendor,
                usb_product_id: product,
                serial_number: serial,
            }
        })
        .collect())
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialEndpoint>, AppError> {
    serial_endpoints()
}

#[tauri::command]
async fn connect_transport(
    config: ConnectionConfig,
    on_event: Channel<TransportEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<u64, AppError> {
    validate_config(&config).await?;
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
    let cancellation = CancellationToken::new();

    let mut guard = state.session.lock().expect("session mutex poisoned");
    if let Some(previous) = guard.take() {
        previous.cancellation.cancel();
        match previous.control {
            ControlSender::Async(sender) => {
                let _ = sender.try_send(Control::Stop);
            }
            ControlSender::Blocking(sender) => {
                let _ = sender.send(Control::Stop);
            }
        }
    }

    send_event(
        &on_event,
        TransportEvent::Status {
            generation,
            status: ConnectionStatus::Connecting,
        },
    );

    match config {
        ConnectionConfig::Uart { port_id } => {
            let endpoint = serial_endpoints()?
                .into_iter()
                .find(|endpoint| endpoint.id == port_id)
                .ok_or(AppError::UnknownSerialPort)?;
            let (sender, receiver) = std_mpsc::channel();
            let worker_cancel = cancellation.clone();
            let worker_events = on_event.clone();
            thread::Builder::new()
                .name("regmon-uart".to_owned())
                .spawn(move || {
                    run_uart_worker(
                        endpoint.path,
                        generation,
                        receiver,
                        worker_cancel,
                        worker_events,
                    )
                })
                .map_err(|error| AppError::Serial(error.to_string()))?;
            *guard = Some(SessionHandle {
                generation,
                cancellation,
                control: ControlSender::Blocking(sender),
            });
        }
        ConnectionConfig::Ogp {
            host,
            port,
            slot,
            force,
        } => {
            let (sender, receiver) = mpsc::channel(4);
            let actor_cancel = cancellation.clone();
            let actor_events = on_event.clone();
            tauri::async_runtime::spawn(async move {
                let result = run_ogp_actor(
                    host,
                    port,
                    slot,
                    force,
                    generation,
                    receiver,
                    actor_cancel,
                    actor_events.clone(),
                )
                .await;
                if let Err(error) = result {
                    send_event(
                        &actor_events,
                        TransportEvent::Error {
                            generation,
                            error: error.payload(),
                        },
                    );
                }
                send_event(
                    &actor_events,
                    TransportEvent::Status {
                        generation,
                        status: ConnectionStatus::Disconnected,
                    },
                );
            });
            *guard = Some(SessionHandle {
                generation,
                cancellation,
                control: ControlSender::Async(sender),
            });
        }
    }
    Ok(generation)
}

#[tauri::command]
async fn scan_transport(
    generation: u64,
    addresses: Vec<u8>,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let sender = {
        let guard = state.session.lock().expect("session mutex poisoned");
        let session = guard.as_ref().ok_or(AppError::NoSession)?;
        if session.generation != generation {
            return Err(AppError::StaleSession);
        }
        match &session.control {
            ControlSender::Async(sender) => EitherSender::Async(sender.clone()),
            ControlSender::Blocking(sender) => EitherSender::Blocking(sender.clone()),
        }
    };
    let addresses =
        normalize_scan_addresses(matches!(&sender, EitherSender::Blocking(_)), addresses)?;
    match sender {
        EitherSender::Async(sender) => sender
            .send(Control::Scan(addresses))
            .await
            .map_err(|_| AppError::NoSession),
        EitherSender::Blocking(sender) => sender
            .send(Control::Scan(addresses))
            .map_err(|_| AppError::NoSession),
    }
}

fn normalize_scan_addresses(uart: bool, addresses: Vec<u8>) -> Result<Vec<u8>, AppError> {
    if uart && !addresses.is_empty() {
        return Err(AppError::InvalidConfig(
            "UART supports full register scans only".to_owned(),
        ));
    }
    Ok(if addresses.is_empty() {
        (0..=u8::MAX).collect()
    } else {
        addresses
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    })
}

enum EitherSender {
    Async(mpsc::Sender<Control>),
    Blocking(std_mpsc::Sender<Control>),
}

#[tauri::command]
fn disconnect_transport(
    generation: u64,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let mut guard = state.session.lock().expect("session mutex poisoned");
    let Some(session) = guard.take() else {
        return Ok(());
    };
    if session.generation != generation {
        *guard = Some(session);
        return Err(AppError::StaleSession);
    }
    session.cancellation.cancel();
    match session.control {
        ControlSender::Async(sender) => {
            let _ = sender.try_send(Control::Stop);
        }
        ControlSender::Blocking(sender) => {
            let _ = sender.send(Control::Stop);
        }
    }
    Ok(())
}

async fn validate_config(config: &ConnectionConfig) -> Result<(), AppError> {
    match config {
        ConnectionConfig::Uart { port_id } => {
            if port_id.is_empty() || port_id.len() > 1024 {
                return Err(AppError::InvalidConfig(
                    "invalid serial endpoint ID".to_owned(),
                ));
            }
        }
        ConnectionConfig::Ogp {
            host, port, slot, ..
        } => {
            let trimmed_host = host.trim();
            if trimmed_host.len() != host.len()
                || trimmed_host.is_empty()
                || trimmed_host.len() > 253
                || trimmed_host.contains(['/', '\\', '\0'])
            {
                return Err(AppError::InvalidConfig("invalid host".to_owned()));
            }
            if *port == 0 {
                return Err(AppError::InvalidConfig(
                    "port must be 1 through 65535".to_owned(),
                ));
            }
            if !(1..=20).contains(slot) {
                return Err(AppError::InvalidConfig(
                    "slot must be 1 through 20".to_owned(),
                ));
            }
            if IpAddr::from_str(trimmed_host).is_err() {
                timeout(CONNECT_TIMEOUT, lookup_host((trimmed_host, *port)))
                    .await
                    .map_err(|_| AppError::Timeout("host lookup"))?
                    .map_err(|error| AppError::Network(error.to_string()))?
                    .next()
                    .ok_or_else(|| AppError::Network("host did not resolve".to_owned()))?;
            }
        }
    }
    Ok(())
}

fn run_uart_worker(
    path: String,
    generation: u64,
    controls: std_mpsc::Receiver<Control>,
    cancellation: CancellationToken,
    events: Channel<TransportEvent>,
) {
    let mut port = match serialport::new(&path, 115_200)
        .data_bits(serialport::DataBits::Eight)
        .stop_bits(serialport::StopBits::One)
        .parity(serialport::Parity::None)
        .flow_control(serialport::FlowControl::None)
        .timeout(Duration::from_millis(50))
        .open()
    {
        Ok(port) => port,
        Err(error) => {
            send_event(
                &events,
                TransportEvent::Error {
                    generation,
                    error: AppError::Serial(error.to_string()).payload(),
                },
            );
            send_event(
                &events,
                TransportEvent::Status {
                    generation,
                    status: ConnectionStatus::Disconnected,
                },
            );
            return;
        }
    };
    send_event(
        &events,
        TransportEvent::Status {
            generation,
            status: ConnectionStatus::Connected,
        },
    );
    let mut buffer = [0u8; 1024];
    let mut parser = UartDumpParser::default();
    let mut scanning = false;
    let mut scan_deadline: Option<StdInstant> = None;
    let mut active_addresses = Vec::new();
    'worker: loop {
        if cancellation.is_cancelled() {
            break;
        }
        while let Ok(control) = controls.try_recv() {
            match control {
                Control::Stop => break 'worker,
                Control::Scan(addresses) => {
                    if scanning {
                        send_event(
                            &events,
                            TransportEvent::Error {
                                generation,
                                error: AppError::ScanBusy.payload(),
                            },
                        );
                        continue;
                    }
                    parser.reset();
                    scanning = true;
                    active_addresses = addresses.clone();
                    scan_deadline = Some(StdInstant::now() + UART_SCAN_TIMEOUT);
                    send_event(
                        &events,
                        TransportEvent::ScanStarted {
                            generation,
                            addresses,
                        },
                    );
                    if let Err(error) = port.write_all(UART_COMMAND) {
                        send_scan_failure(
                            &events,
                            generation,
                            AppError::Serial(error.to_string()),
                            active_addresses.clone(),
                        );
                        scanning = false;
                        scan_deadline = None;
                        parser.reset();
                    }
                }
            }
        }
        match port.read(&mut buffer) {
            Ok(count) if count > 0 => {
                let text = String::from_utf8_lossy(&buffer[..count]);
                send_event(
                    &events,
                    TransportEvent::Log {
                        generation,
                        text: text.to_string(),
                    },
                );
                if scanning {
                    if let Some(values) = parser.push(&text) {
                        let updates = values
                            .into_iter()
                            .enumerate()
                            .map(|(address, value)| RegisterUpdate {
                                address: address as u8,
                                value,
                            })
                            .collect();
                        send_event(
                            &events,
                            TransportEvent::Registers {
                                generation,
                                updates,
                                missing: Vec::new(),
                            },
                        );
                        send_event(
                            &events,
                            TransportEvent::ScanComplete {
                                generation,
                                missing: Vec::new(),
                            },
                        );
                        scanning = false;
                        scan_deadline = None;
                    }
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                if scanning {
                    send_scan_failure(
                        &events,
                        generation,
                        AppError::Serial(error.to_string()),
                        active_addresses.clone(),
                    );
                } else {
                    send_event(
                        &events,
                        TransportEvent::Error {
                            generation,
                            error: AppError::Serial(error.to_string()).payload(),
                        },
                    );
                }
                break;
            }
        }
        if scanning && scan_deadline.is_some_and(|deadline| StdInstant::now() >= deadline) {
            scanning = false;
            scan_deadline = None;
            parser.reset();
            send_scan_failure(
                &events,
                generation,
                AppError::Timeout("UART register dump"),
                active_addresses.clone(),
            );
        }
    }
    send_event(
        &events,
        TransportEvent::Status {
            generation,
            status: ConnectionStatus::Disconnected,
        },
    );
}

#[derive(Default)]
struct UartDumpParser {
    buffer: String,
    rows: BTreeMap<u8, [u8; 16]>,
}

impl UartDumpParser {
    fn reset(&mut self) {
        self.buffer.clear();
        self.rows.clear();
    }

    fn push(&mut self, text: &str) -> Option<[u8; 256]> {
        self.buffer.push_str(text);
        while let Some(index) = self.buffer.find('\n') {
            let line = self.buffer[..index].trim_end_matches('\r').to_owned();
            self.buffer.drain(..=index);
            let Some((offset, bytes)) = line.split_once(':') else {
                continue;
            };
            let Ok(offset) = u8::from_str_radix(offset.trim(), 16) else {
                continue;
            };
            if offset % 16 != 0 {
                continue;
            }
            let values = bytes
                .split_whitespace()
                .map(|value| u8::from_str_radix(value, 16))
                .collect::<Result<Vec<_>, _>>();
            let Ok(values) = values else { continue };
            let Ok(row) = <[u8; 16]>::try_from(values) else {
                continue;
            };
            self.rows.insert(offset, row);
            if self.rows.len() == 16 {
                let mut snapshot = [0u8; 256];
                for (offset, row) in &self.rows {
                    snapshot[*offset as usize..*offset as usize + 16].copy_from_slice(row);
                }
                self.rows.clear();
                return Some(snapshot);
            }
        }
        None
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_ogp_actor(
    host: String,
    port: u16,
    slot: u8,
    force: bool,
    generation: u64,
    mut controls: mpsc::Receiver<Control>,
    cancellation: CancellationToken,
    events: Channel<TransportEvent>,
) -> Result<(), AppError> {
    let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| AppError::Timeout("TCP connect"))?
        .map_err(|error| AppError::Network(error.to_string()))?;
    stream
        .set_nodelay(true)
        .map_err(|error| AppError::Network(error.to_string()))?;
    let mut decoder = FrameDecoder::default();
    let deferred = perform_handshake(&mut stream, &mut decoder, force, &cancellation).await?;
    send_event(
        &events,
        TransportEvent::Status {
            generation,
            status: ConnectionStatus::Connected,
        },
    );

    let selected_source = protocol::FRAME_CONTROLLER_ADDRESS + slot;
    let mut scan: Option<ScanState> = None;
    let mut pending_scan: Option<Vec<u8>> = None;
    let mut print_parser = PrintParser::default();
    let mut quiet_drain: Option<QuietDrain> = None;
    let mut settle_deadline: Option<Instant> = None;
    let mut ack_deadline: Option<Instant> = None;
    let mut scan_deadline: Option<Instant> = None;
    let mut queued_frames = deferred
        .into_iter()
        .collect::<std::collections::VecDeque<_>>();
    let mut read_buffer = [0u8; 4096];

    loop {
        while let Some(frame) = queued_frames.pop_front() {
            route_ogp_frame(
                frame,
                selected_source,
                generation,
                &events,
                &mut stream,
                &mut scan,
                &mut print_parser,
                &mut quiet_drain,
                &mut settle_deadline,
                &mut ack_deadline,
            )
            .await?;
        }

        let idle_deadline = || Instant::now() + Duration::from_secs(86_400);
        let start = quiet_drain
            .as_ref()
            .map(|drain| drain.deadline)
            .unwrap_or_else(idle_deadline);
        let settle = settle_deadline.unwrap_or_else(idle_deadline);
        let ack = ack_deadline.unwrap_or_else(idle_deadline);
        let total = scan_deadline.unwrap_or_else(idle_deadline);
        tokio::select! {
            _ = cancellation.cancelled() => break,
            control = controls.recv() => match control {
                None | Some(Control::Stop) => break,
                Some(Control::Scan(addresses)) => {
                    if scan.is_some() || pending_scan.is_some() {
                        send_event(&events, TransportEvent::Error { generation, error: AppError::ScanBusy.payload() });
                        continue;
                    }
                    let addresses = if addresses.is_empty() { (0..=u8::MAX).collect() } else { addresses };
                    send_event(&events, TransportEvent::ScanStarted { generation, addresses: addresses.clone() });
                    pending_scan = Some(addresses);
                    quiet_drain = Some(QuietDrain::new(Instant::now()));
                    scan_deadline = Some(Instant::now() + OGP_SCAN_TIMEOUT);
                }
            },
            result = stream.read(&mut read_buffer) => {
                let count = result.map_err(|error| AppError::Network(error.to_string()))?;
                if count == 0 {
                    return Err(AppError::Network("connection closed by peer".to_owned()));
                }
                decoder.push(&read_buffer[..count]);
                loop {
                    match decoder.next_frame() {
                        Ok(Some(frame)) => queued_frames.push_back(frame),
                        Ok(None) => break,
                        Err(error) => {
                            send_event(&events, TransportEvent::Log { generation, text: format!("[OGP codec] {error}\n") });
                        }
                    }
                }
            },
            _ = tokio::time::sleep_until(start), if quiet_drain.is_some() => {
                debug_assert!(quiet_drain.as_ref().is_some_and(|drain| drain.ready(Instant::now())));
                quiet_drain = None;
                print_parser.reset();
                if let Some(addresses) = pending_scan.take() {
                    scan = Some(ScanState::new(addresses));
                    send_next_command(&mut stream, selected_source, scan.as_mut().expect("scan was just set"), &mut ack_deadline).await?;
                }
            },
            _ = tokio::time::sleep_until(settle), if settle_deadline.is_some() => {
                settle_deadline = None;
                let flushed = print_parser.flush();
                apply_print_output(flushed, generation, &events, &mut scan);
                let retry = scan.as_mut().is_some_and(ScanState::retry_missing);
                if retry {
                    send_next_command(&mut stream, selected_source, scan.as_mut().unwrap(), &mut ack_deadline).await?;
                } else if let Some(finished) = scan.take() {
                    let missing = finished.missing.into_iter().collect();
                    send_event(&events, TransportEvent::ScanComplete { generation, missing });
                    scan_deadline = None;
                }
            },
            _ = tokio::time::sleep_until(ack), if ack_deadline.is_some() => {
                ack_deadline = None;
                settle_deadline = None;
                scan_deadline = None;
                print_parser.reset();
                if let Some(finished) = scan.take() {
                    let missing = finished.missing.into_iter().collect();
                    send_scan_failure(&events, generation, AppError::Timeout("OGP command acknowledgment"), missing);
                }
            },
            _ = tokio::time::sleep_until(total), if scan_deadline.is_some() => {
                scan_deadline = None;
                quiet_drain = None;
                settle_deadline = None;
                ack_deadline = None;
                print_parser.reset();
                let missing = if let Some(finished) = scan.take() {
                    finished.missing.into_iter().collect()
                } else {
                    pending_scan.take().unwrap_or_default()
                };
                send_scan_failure(&events, generation, AppError::Timeout("OGP register scan"), missing);
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn route_ogp_frame(
    frame: Frame,
    selected_source: u8,
    generation: u64,
    events: &Channel<TransportEvent>,
    stream: &mut TcpStream,
    scan: &mut Option<ScanState>,
    print_parser: &mut PrintParser,
    quiet_drain: &mut Option<QuietDrain>,
    settle_deadline: &mut Option<Instant>,
    ack_deadline: &mut Option<Instant>,
) -> Result<(), AppError> {
    if frame.source != selected_source {
        send_event(
            events,
            TransportEvent::Log {
                generation,
                text: format!(
                    "[OGP source 0x{:02X} type 0x{:02X}] {} bytes\n",
                    frame.source,
                    frame.message_type,
                    frame.content.len()
                ),
            },
        );
        return Ok(());
    }
    match frame.message_type {
        protocol::OGP_PRINT => {
            let raw = String::from_utf8_lossy(&frame.content).replace('\0', "\n");
            if !raw.is_empty() {
                send_event(
                    events,
                    TransportEvent::Log {
                        generation,
                        text: raw.clone(),
                    },
                );
            }
            let output = print_parser.push(&frame.content);
            if output.overflowed {
                send_event(
                    events,
                    TransportEvent::Log {
                        generation,
                        text: format!(
                            "[OGP print] unterminated record exceeded {} bytes and was discarded\n",
                            protocol::MAX_PRINT_RECORD_LEN
                        ),
                    },
                );
            }
            if let Some(drain) = quiet_drain.as_mut() {
                drain.observe_output(&output, Instant::now());
            }
            if output.results.is_empty() && output.unmatched.is_empty() && !raw.is_empty() {
                return Ok(());
            }
            apply_print_output(output, generation, events, scan);
        }
        protocol::OGP_COMMAND_ACK => {
            let code = frame.content.first().copied().unwrap_or(1);
            if code != 0 {
                return Err(AppError::Protocol(format!(
                    "OGP command was rejected with code {code}"
                )));
            }
            let Some(active) = scan.as_mut() else {
                send_event(
                    events,
                    TransportEvent::Log {
                        generation,
                        text: "[OGP] late command acknowledgment\n".to_owned(),
                    },
                );
                return Ok(());
            };
            if !active.acknowledge() {
                send_event(
                    events,
                    TransportEvent::Log {
                        generation,
                        text: "[OGP] unrelated command acknowledgment\n".to_owned(),
                    },
                );
                return Ok(());
            }
            *ack_deadline = None;
            if active.commands_done() {
                *settle_deadline = Some(Instant::now() + protocol::SETTLE_TIME);
            } else {
                send_next_command(stream, selected_source, active, ack_deadline).await?;
            }
        }
        _ => send_event(
            events,
            TransportEvent::Log {
                generation,
                text: format!(
                    "[OGP selected card type 0x{:02X}] {} bytes\n",
                    frame.message_type,
                    frame.content.len()
                ),
            },
        ),
    }
    Ok(())
}

fn apply_print_output(
    output: protocol::PrintOutput,
    generation: u64,
    events: &Channel<TransportEvent>,
    scan: &mut Option<ScanState>,
) {
    for result in output.results {
        let in_scan = is_scoped_register_result(scan, &result);
        if in_scan {
            let missing = scan
                .as_ref()
                .map(|active| active.missing.iter().copied().collect())
                .unwrap_or_default();
            send_event(
                events,
                TransportEvent::Registers {
                    generation,
                    updates: vec![RegisterUpdate {
                        address: result.address,
                        value: result.value,
                    }],
                    missing,
                },
            );
        } else {
            send_event(
                events,
                TransportEvent::Log {
                    generation,
                    text: format!(
                        "[OGP] register 0x{:02X} was outside the active scan\n",
                        result.address
                    ),
                },
            );
        }
    }
}

fn is_scoped_register_result(
    scan: &mut Option<ScanState>,
    result: &protocol::RegisterResult,
) -> bool {
    scan.as_mut().is_some_and(|active| active.record(result))
}

async fn send_next_command(
    stream: &mut TcpStream,
    destination: u8,
    scan: &mut ScanState,
    ack_deadline: &mut Option<Instant>,
) -> Result<(), AppError> {
    if let Some(address) = scan.next_to_send() {
        write_frame(stream, &protocol::command_request(destination, address)).await?;
        *ack_deadline = Some(Instant::now() + ACK_TIMEOUT);
    }
    Ok(())
}

async fn perform_handshake(
    stream: &mut TcpStream,
    decoder: &mut FrameDecoder,
    force: bool,
    cancellation: &CancellationToken,
) -> Result<Vec<Frame>, AppError> {
    write_frame(stream, &protocol::handshake_request(force)).await?;
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let mut deferred = Vec::new();
    let mut deferred_bytes = 0;
    let mut buffer = [0u8; 2048];
    loop {
        loop {
            let frame = match decoder.next_frame() {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(_) => continue,
            };
            if is_connect_verify_candidate(&frame) {
                validate_connect_verify(&frame)?;
                return Ok(deferred);
            }
            defer_handshake_frame(&mut deferred, &mut deferred_bytes, frame)?;
        }
        tokio::select! {
            _ = cancellation.cancelled() => return Err(AppError::Network("connection cancelled".to_owned())),
            _ = tokio::time::sleep_until(deadline) => return Err(AppError::Timeout("OGP handshake")),
            result = stream.read(&mut buffer) => {
                let count = result.map_err(|error| AppError::Network(error.to_string()))?;
                if count == 0 {
                    return Err(AppError::Network("connection closed during handshake".to_owned()));
                }
                decoder.push(&buffer[..count]);
            }
        }
    }
}

fn defer_handshake_frame(
    deferred: &mut Vec<Frame>,
    deferred_bytes: &mut usize,
    frame: Frame,
) -> Result<(), AppError> {
    let frame_bytes = protocol::HEADER_LEN + frame.content.len();
    if deferred.len() >= MAX_DEFERRED_HANDSHAKE_FRAMES
        || deferred_bytes.saturating_add(frame_bytes) > MAX_DEFERRED_HANDSHAKE_BYTES
    {
        return Err(AppError::Protocol(
            "too much unrelated traffic arrived during OGP handshake".to_owned(),
        ));
    }
    *deferred_bytes += frame_bytes;
    deferred.push(frame);
    Ok(())
}

fn is_connect_verify_candidate(frame: &Frame) -> bool {
    frame.source == protocol::FRAME_CONTROLLER_ADDRESS
        && frame.destination == protocol::CLIENT_ADDRESS
        && frame.message_type == protocol::SET_PARAM_RESPONSE
        && frame.content.get(1..3) == Some(&protocol::CONNECT_VERIFY_OID.to_be_bytes())
}

fn validate_connect_verify(frame: &Frame) -> Result<(), AppError> {
    let response = protocol::parse_connect_verify_response(frame)
        .map_err(|error| AppError::Protocol(error.to_string()))?;
    if response.return_code == 0 && response.allow != 0 {
        return Ok(());
    }

    let mut details = vec![
        format!("return code {}", response.return_code),
        format!("allow 0x{:04X}", response.allow),
    ];
    if let Some(state) = response.state {
        details.push(format!("state 0x{state:04X}"));
    }
    if let Some(reason) = response.reason {
        details.push(format!("reason 0x{reason:04X}"));
    }
    Err(AppError::HandshakeRejected(details.join(", ")))
}

async fn write_frame(stream: &mut TcpStream, frame: &Frame) -> Result<(), AppError> {
    let bytes = frame
        .encode()
        .map_err(|error| AppError::Protocol(error.to_string()))?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|error| AppError::Network(error.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            connect_transport,
            scan_transport,
            disconnect_transport
        ])
        .run(tauri::generate_context!())
        .expect("error while running RegMon");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn handshake_defers_unrelated_ca_frames_before_connect_verify() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let unrelated = Frame {
            source: 0x11,
            destination: protocol::CLIENT_ADDRESS,
            message_type: protocol::SET_PARAM_RESPONSE,
            content: vec![0, 0xFF, 0x03, 2, 0, 1],
        };
        let expected_unrelated = unrelated.clone();
        let wrong_oid = Frame {
            source: protocol::FRAME_CONTROLLER_ADDRESS,
            destination: protocol::CLIENT_ADDRESS,
            message_type: protocol::SET_PARAM_RESPONSE,
            content: vec![0, 0xFF, 0x04, 2, 0, 1],
        };
        let expected_wrong_oid = wrong_oid.clone();
        let response = Frame {
            source: protocol::FRAME_CONTROLLER_ADDRESS,
            destination: protocol::CLIENT_ADDRESS,
            message_type: protocol::SET_PARAM_RESPONSE,
            content: vec![0, 0xFF, 0x03, 2, 0, 1],
        };
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 64];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let bytes = [
                unrelated.encode().unwrap(),
                wrong_oid.encode().unwrap(),
                response.encode().unwrap(),
            ]
            .concat();
            socket.write_all(&bytes).await.unwrap();
        });

        let mut stream = TcpStream::connect(address).await.unwrap();
        let deferred = perform_handshake(
            &mut stream,
            &mut FrameDecoder::default(),
            false,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(deferred, [expected_unrelated, expected_wrong_oid]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn ogp_config_rejects_whitespace_padded_hosts() {
        let config = ConnectionConfig::Ogp {
            host: " 127.0.0.1 ".to_owned(),
            port: 5253,
            slot: 1,
            force: false,
        };

        assert!(matches!(
            validate_config(&config).await,
            Err(AppError::InvalidConfig(message)) if message == "invalid host"
        ));
    }

    #[test]
    fn uart_scan_requests_are_full_scan_only() {
        let full_scan = normalize_scan_addresses(true, Vec::new()).unwrap();
        assert_eq!(full_scan.len(), 256);
        assert_eq!(full_scan[0], 0);
        assert_eq!(full_scan[255], 255);
        assert!(matches!(
            normalize_scan_addresses(true, vec![1, 2]),
            Err(AppError::InvalidConfig(message)) if message == "UART supports full register scans only"
        ));
    }

    #[test]
    fn ogp_scan_requests_are_sorted_and_deduplicated() {
        assert_eq!(
            normalize_scan_addresses(false, vec![3, 1, 3]).unwrap(),
            [1, 3]
        );
    }

    #[test]
    fn handshake_deferred_frames_are_bounded_by_count_and_bytes() {
        let small = Frame {
            source: 0x11,
            destination: 0,
            message_type: protocol::OGP_PRINT,
            content: Vec::new(),
        };
        let mut deferred = Vec::new();
        let mut bytes = 0;
        for _ in 0..MAX_DEFERRED_HANDSHAKE_FRAMES {
            defer_handshake_frame(&mut deferred, &mut bytes, small.clone()).unwrap();
        }
        assert!(matches!(
            defer_handshake_frame(&mut deferred, &mut bytes, small),
            Err(AppError::Protocol(_))
        ));

        let large = Frame {
            source: 0x11,
            destination: 0,
            message_type: protocol::OGP_PRINT,
            content: vec![0; protocol::MAX_CONTENT_LEN],
        };
        let mut deferred = Vec::new();
        let mut bytes = 0;
        while bytes + protocol::HEADER_LEN + large.content.len() <= MAX_DEFERRED_HANDSHAKE_BYTES {
            defer_handshake_frame(&mut deferred, &mut bytes, large.clone()).unwrap();
        }
        assert!(matches!(
            defer_handshake_frame(&mut deferred, &mut bytes, large),
            Err(AppError::Protocol(_))
        ));
    }

    #[test]
    fn continuous_unmatched_prints_do_not_delay_pending_scan() {
        let started = Instant::now();
        let mut drain = QuietDrain::new(started);
        let initial_deadline = drain.deadline;
        let mut parser = PrintParser::default();

        for step in 1..=20 {
            let output = parser.push(b"continuous debug output\0");
            drain.observe_output(&output, started + Duration::from_millis(step * 100));
        }

        assert_eq!(drain.deadline, initial_deadline);
        assert!(drain.ready(started + protocol::SETTLE_TIME));
    }

    #[test]
    fn stale_register_prints_cannot_extend_quiet_drain_past_limit() {
        let started = Instant::now();
        let mut drain = QuietDrain::new(started);
        let mut parser = PrintParser::default();

        for step in 1..=20 {
            let output = parser.push(b"Register 0x01 = 0x02\0");
            drain.observe_output(&output, started + Duration::from_millis(step * 100));
        }

        assert_eq!(drain.deadline, started + OGP_QUIET_DRAIN_MAX);
        assert!(drain.ready(started + OGP_QUIET_DRAIN_MAX));
    }

    #[test]
    fn uart_parser_accepts_the_example_shape_in_fragments() {
        let text = (0..16)
            .map(|row| {
                let offset = row * 16;
                let values = (0..16)
                    .map(|column| format!("{:02x}", offset + column))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("{offset:02x}: {values}\r\n")
            })
            .collect::<String>();
        let mut parser = UartDumpParser::default();
        assert!(parser.push(&text[..100]).is_none());
        let snapshot = parser.push(&text[100..]).unwrap();
        assert_eq!(snapshot[0], 0);
        assert_eq!(snapshot[255], 255);
    }

    #[test]
    fn uart_parser_reset_discards_partial_or_malformed_dump() {
        let mut parser = UartDumpParser::default();
        assert!(parser.push("00: 00 01 02\nmalformed\n").is_none());
        parser.reset();
        assert!(parser.push("10: 10 11 12\n").is_none());
        assert!(parser.rows.is_empty());
    }

    #[test]
    fn connect_verify_rejects_zero_allow_with_safe_details() {
        let frame = Frame {
            source: protocol::FRAME_CONTROLLER_ADDRESS,
            destination: protocol::CLIENT_ADDRESS,
            message_type: protocol::SET_PARAM_RESPONSE,
            content: vec![0, 0xFF, 0x03, 6, 0, 0, 0, 2, 0, 9],
        };
        let error = validate_connect_verify(&frame).unwrap_err();
        assert!(matches!(error, AppError::HandshakeRejected(_)));
        assert_eq!(
            error.to_string(),
            "connection handshake was rejected: return code 0, allow 0x0000, state 0x0002, reason 0x0009"
        );
    }

    #[test]
    fn old_prints_are_not_scoped_after_completion_or_before_the_next_issue() {
        let result = protocol::RegisterResult {
            address: 4,
            value: 9,
        };
        let mut scan = None;
        assert!(!is_scoped_register_result(&mut scan, &result));

        scan = Some(ScanState::new([4]));
        assert!(!is_scoped_register_result(&mut scan, &result));
        assert_eq!(scan.as_mut().unwrap().next_to_send(), Some(4));
        assert!(is_scoped_register_result(&mut scan, &result));
    }
}
