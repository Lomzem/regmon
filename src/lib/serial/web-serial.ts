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

export function isSerialSelectionCancelled(error: SerialSelectionError): boolean {
	return (
		typeof DOMException !== 'undefined' &&
		error.cause instanceof DOMException &&
		(error.cause.name === 'NotFoundError' || error.cause.name === 'AbortError')
	);
}

class BrowserSerialConnection implements SerialConnection {
	readonly port: SerialPort;
	private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
	private readonly decoder = new TextDecoder();
	private readonly encoder = new TextEncoder();
	private readonly reads: QueuedRead[] = [];
	private readonly waiters: Array<(read: QueuedRead) => void> = [];
	private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	private readonly pumpDone: Promise<void>;
	private closed = false;

	constructor(port: SerialPort, writer: WritableStreamDefaultWriter<Uint8Array>) {
		this.port = port;
		this.writer = writer;
		this.pumpDone = this.pump();
	}

	get readText(): Effect.Effect<string, SerialReadError> {
		return Effect.async<string, SerialReadError>((resume) => {
			const queued = this.reads.shift();
			if (queued) {
				resume(queued.error ? Effect.fail(queued.error) : Effect.succeed(queued.text));
				return;
			}

			const waiter = (read: QueuedRead) =>
				resume(read.error ? Effect.fail(read.error) : Effect.succeed(read.text));
			this.waiters.push(waiter);
			return Effect.sync(() => {
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
			});
		});
	}

	writeText(text: string): Effect.Effect<void, SerialWriteError> {
		return Effect.tryPromise({
			try: () => {
				// A command starts a new frame. Discard stale noise and any partial response.
				this.reads.length = 0;
				return this.writer.write(this.encoder.encode(text));
			},
			catch: (cause) =>
				new SerialWriteError({ message: `Serial write failed: ${message(cause)}`, cause })
		});
	}

	private async pump(): Promise<void> {
		while (!this.closed) {
			try {
				const readable = this.port.readable;
				if (!readable) {
					await delay(50);
					continue;
				}

				const reader = readable.getReader();
				this.reader = reader;
				while (!this.closed) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = this.decoder.decode(value, { stream: true });
					if (text) this.enqueue({ text });
				}
			} catch (cause) {
				if (!this.closed) {
					this.reads.length = 0;
					this.enqueue({
						error: new SerialReadError({
							message: `Serial read failed: ${message(cause)}`,
							cause
						})
					});
				}
			} finally {
				this.releaseReader();
			}

			// Web Serial creates a fresh readable stream after non-fatal UART errors.
			if (!this.closed) await delay(10);
		}
	}

	private enqueue(read: QueuedRead): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(read);
			return;
		}

		this.reads.push(read);
		if (this.reads.length > 256) this.reads.shift();
	}

	private releaseReader(): void {
		const reader = this.reader;
		this.reader = undefined;
		if (!reader) return;
		try {
			reader.releaseLock();
		} catch {
			// A pending read or detached device can retain the lock briefly.
		}
	}

	async release(): Promise<void> {
		this.closed = true;
		const closedError = new SerialReadError({ message: 'The serial input stream was closed' });
		for (const waiter of this.waiters.splice(0)) waiter({ error: closedError });
		try {
			await this.reader?.cancel();
		} catch {
			// The device may already have disappeared.
		}
		await this.pumpDone;
		this.releaseReader();
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

type QueuedRead =
	{ readonly text: string; readonly error?: never } | { readonly error: SerialReadError };

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
					return new BrowserSerialConnection(port, port.writable.getWriter());
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
