import { Effect, Scope } from 'effect';
import {
	SerialOpenError,
	SerialReadError,
	SerialSelectionError,
	SerialUnsupportedError,
	SerialWriteError
} from './errors';

export const SERIAL_OPTIONS: SerialOptions = Object.freeze({
	baudRate: 115_200,
	dataBits: 8,
	stopBits: 1,
	parity: 'none',
	flowControl: 'none'
});

export interface SerialConnection {
	readonly port: SerialPort;
	readonly readText: Effect.Effect<string, SerialReadError>;
	writeText(text: string): Effect.Effect<void, SerialWriteError>;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function getBrowserSerial(): Effect.Effect<Serial, SerialUnsupportedError> {
	return Effect.sync(() =>
		typeof navigator !== 'undefined' && 'serial' in navigator ? navigator.serial : undefined
	).pipe(
		Effect.flatMap((serial) =>
			serial
				? Effect.succeed(serial)
				: Effect.fail(
						new SerialUnsupportedError({ message: 'Web Serial is not supported by this browser' })
					)
		)
	);
}

export function listAuthorizedPorts(
	serial: Serial
): Effect.Effect<readonly SerialPort[], SerialSelectionError> {
	return Effect.tryPromise({
		try: () => serial.getPorts(),
		catch: (cause) =>
			new SerialSelectionError({ message: `Could not list serial ports: ${message(cause)}`, cause })
	});
}

export function choosePort(serial: Serial): Effect.Effect<SerialPort, SerialSelectionError> {
	return Effect.tryPromise({
		try: () => serial.requestPort(),
		catch: (cause) =>
			new SerialSelectionError({ message: `No serial port was selected: ${message(cause)}`, cause })
	});
}

class BrowserSerialConnection implements SerialConnection {
	readonly port: SerialPort;
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
	private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();
	private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

	constructor(
		port: SerialPort,
		reader: ReadableStreamDefaultReader<Uint8Array>,
		writer: WritableStreamDefaultWriter<Uint8Array>
	) {
		this.port = port;
		this.reader = reader;
		this.writer = writer;
	}

	get readText(): Effect.Effect<string, SerialReadError> {
		return Effect.tryPromise({
			// A timed-out Effect must not cancel the underlying read. The next poll adopts it.
			try: () => this.nextRead(),
			catch: (cause) =>
				new SerialReadError({ message: `Serial read failed: ${message(cause)}`, cause })
		}).pipe(
			Effect.flatMap(({ done, value }) =>
				done
					? Effect.fail(new SerialReadError({ message: 'The serial input stream was closed' }))
					: Effect.succeed(this.decoder.decode(value, { stream: true }))
			)
		);
	}

	writeText(text: string): Effect.Effect<void, SerialWriteError> {
		return Effect.tryPromise({
			try: () => this.writer.write(this.encoder.encode(text)),
			catch: (cause) =>
				new SerialWriteError({ message: `Serial write failed: ${message(cause)}`, cause })
		});
	}

	private nextRead(): Promise<ReadableStreamReadResult<Uint8Array>> {
		this.pendingRead ??= this.reader.read().finally(() => {
			this.pendingRead = undefined;
		});
		return this.pendingRead;
	}

	async release(): Promise<void> {
		try {
			await this.reader.cancel();
		} catch {
			// The device may already have disappeared.
		}
		try {
			this.reader.releaseLock();
		} catch {
			// Ignore a lock already released by the stream.
		}
		try {
			this.writer.releaseLock();
		} catch {
			// A write may have been interrupted by disconnect.
		}
		try {
			await this.port.close();
		} catch {
			// Scope cleanup is best-effort after detach.
		}
	}
}

/** Opens a Web Serial port and guarantees reader, writer and port cleanup with its Scope. */
export function openSerialPort(
	port: SerialPort
): Effect.Effect<SerialConnection, SerialOpenError, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.tryPromise({
			try: async () => {
				await port.open(SERIAL_OPTIONS);
				try {
					if (!port.readable || !port.writable) throw new Error('Port streams are unavailable');
					return new BrowserSerialConnection(
						port,
						port.readable.getReader(),
						port.writable.getWriter()
					);
				} catch (error) {
					await port.close().catch(() => undefined);
					throw error;
				}
			},
			catch: (cause) =>
				new SerialOpenError({ message: `Could not open serial port: ${message(cause)}`, cause })
		}),
		(connection) => Effect.promise(() => (connection as BrowserSerialConnection).release())
	);
}
