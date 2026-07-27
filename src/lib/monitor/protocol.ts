import { Data, Duration, Effect } from 'effect';
import { RegisterDumpAssembler } from '$lib/registers/dump';
import type { RegisterSnapshot } from '$lib/registers/types';
import type { SerialConnection } from '$lib/serial/web-serial';
import type { SerialReadError, SerialWriteError } from '$lib/serial/errors';

export const READ_ALL_COMMAND = 'r 1 1\r\n';
export const DEFAULT_RESPONSE_TIMEOUT_MS = 2_000;

export class ResponseTimeoutError extends Data.TaggedError('ResponseTimeoutError')<{
	readonly message: string;
	readonly timeoutMs: number;
}> {}

export type ProtocolFailure = SerialReadError | SerialWriteError | ResponseTimeoutError;

export interface SnapshotRequestOptions {
	readonly timeoutMs?: number;
	readonly onRawText?: (text: string) => void;
}

/** Sends one request and succeeds only after the dump parser emits a complete 256-byte snapshot. */
export function requestRegisterSnapshot(
	connection: Pick<SerialConnection, 'readText' | 'writeText'>,
	options: SnapshotRequestOptions = {}
): Effect.Effect<RegisterSnapshot, ProtocolFailure> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
	const assembler = new RegisterDumpAssembler();

	const receive: Effect.Effect<RegisterSnapshot, SerialReadError> = Effect.suspend(() =>
		connection.readText.pipe(
			Effect.flatMap((chunk) => {
				options.onRawText?.(chunk);
				const snapshot = assembler.push(chunk)[0];
				return snapshot ? Effect.succeed(snapshot) : receive;
			})
		)
	);

	return connection.writeText(READ_ALL_COMMAND).pipe(
		Effect.zipRight(
			receive.pipe(
				Effect.timeoutFail({
					duration: Duration.millis(timeoutMs),
					onTimeout: () =>
						new ResponseTimeoutError({
							message: `Register response timed out after ${timeoutMs} ms`,
							timeoutMs
						})
				})
			)
		)
	);
}

export class RawLogBuffer {
	private text = '';

	constructor(readonly capacity = 32_768) {}

	append(chunk: string): string {
		this.text = (this.text + chunk).slice(-this.capacity);
		return this.text;
	}

	clear(): string {
		this.text = '';
		return this.text;
	}

	get value(): string {
		return this.text;
	}
}
