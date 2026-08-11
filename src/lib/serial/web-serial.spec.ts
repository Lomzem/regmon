import { Effect, Either } from 'effect';
import { describe, expect, it } from 'vitest';
import { requestRegisterSnapshot } from '$lib/monitor/protocol';
import { SerialSelectionError } from './errors';
import { isSerialSelectionCancelled, openSerialPort } from './web-serial';

function dump(): Uint8Array {
	const text = Array.from({ length: 16 }, (_, row) => {
		const offset = row * 16;
		const bytes = Array.from({ length: 16 }, (_, column) =>
			((offset + column) & 0xff).toString(16).padStart(2, '0')
		).join(' ');
		return `${offset.toString(16).padStart(2, '0')}: ${bytes}\r\n`;
	}).join('');
	return new TextEncoder().encode(text);
}

function recoverablePort(errorMessage: string): { port: SerialPort; writes: string[] } {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let readable = makeReadable();
	let writeCount = 0;
	const writes: string[] = [];

	function makeReadable(): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start(nextController) {
				controller = nextController;
			}
		});
	}

	const writable = new WritableStream<Uint8Array>({
		write(value) {
			writes.push(new TextDecoder().decode(value));
			writeCount += 1;
			if (writeCount === 1) {
				const failedController = controller;
				readable = makeReadable();
				failedController.error(new Error(errorMessage));
			} else {
				controller.enqueue(dump());
			}
		}
	});

	const port = {
		get readable() {
			return readable;
		},
		writable,
		open: async () => undefined,
		close: async () => undefined
	} as unknown as SerialPort;

	return { port, writes };
}

describe.each(['Framing error', 'Buffer overrun'])('recoverable serial error: %s', (message) => {
	it('reacquires the readable stream and frames the next command response', async () => {
		const { port, writes } = recoverablePort(message);

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* openSerialPort(port);
					const first = yield* Effect.either(
						requestRegisterSnapshot(connection, { timeoutMs: 500 })
					);
					expect(Either.isLeft(first)).toBe(true);
					if (Either.isLeft(first)) expect(first.left.message).toContain(message);

					yield* Effect.sleep('30 millis');
					const snapshot = yield* requestRegisterSnapshot(connection, { timeoutMs: 500 });
					expect(snapshot).toEqual(Uint8Array.from({ length: 256 }, (_, index) => index));
				})
			)
		);

		expect(writes).toEqual(['r 1 1\r\n', 'r 1 1\r\n']);
	});
});

it('removes a timed-out read before framing the next response', async () => {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let writeCount = 0;
	const readable = new ReadableStream<Uint8Array>({
		start(nextController) {
			controller = nextController;
		}
	});
	const writable = new WritableStream<Uint8Array>({
		write() {
			writeCount += 1;
			if (writeCount === 2) controller.enqueue(dump());
		}
	});
	const port = {
		readable,
		writable,
		open: async () => undefined,
		close: async () => undefined
	} as unknown as SerialPort;

	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const connection = yield* openSerialPort(port);
				const first = yield* Effect.either(requestRegisterSnapshot(connection, { timeoutMs: 10 }));
				expect(Either.isLeft(first)).toBe(true);

				const snapshot = yield* requestRegisterSnapshot(connection, { timeoutMs: 500 });
				expect(snapshot).toEqual(Uint8Array.from({ length: 256 }, (_, index) => index));
			})
		)
	);
});

it('distinguishes user cancellation from other port selection failures', () => {
	expect(
		isSerialSelectionCancelled(
			new SerialSelectionError({
				message: 'cancelled',
				cause: new DOMException('No port selected', 'NotFoundError')
			})
		)
	).toBe(true);
	expect(
		isSerialSelectionCancelled(
			new SerialSelectionError({
				message: 'aborted',
				cause: new DOMException('Selection aborted', 'AbortError')
			})
		)
	).toBe(true);
	expect(
		isSerialSelectionCancelled(
			new SerialSelectionError({
				message: 'blocked',
				cause: new DOMException('Blocked by policy', 'SecurityError')
			})
		)
	).toBe(false);
});
