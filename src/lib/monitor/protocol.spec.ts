import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { SerialReadError } from '$lib/serial/errors';
import { READ_ALL_COMMAND, RawLogBuffer, requestRegisterSnapshot } from './protocol';
import exampleOutput from '../../../examples/example_output.txt?raw';

function dump(): string {
	return Array.from({ length: 16 }, (_, row) => {
		const offset = row * 16;
		const bytes = Array.from({ length: 16 }, (_, column) =>
			((offset + column) & 0xff).toString(16).padStart(2, '0')
		).join(' ');
		return `${offset.toString(16).padStart(2, '0')}: ${bytes}\r\n`;
	}).join('');
}

describe('requestRegisterSnapshot', () => {
	it('parses the checked-in UART example directly', async () => {
		const chunks = [exampleOutput];
		const connection = {
			get readText() {
				const chunk = chunks.shift();
				return chunk === undefined
					? Effect.fail(new SerialReadError({ message: 'example output exhausted' }))
					: Effect.succeed(chunk);
			},
			writeText: () => Effect.void
		};
		const snapshot = await Effect.runPromise(requestRegisterSnapshot(connection));
		expect(snapshot).toHaveLength(256);
		expect(snapshot[0xc0]).toBe(0x3a);
	});

	it('writes the command and ignores noise and chunk boundaries', async () => {
		const chunks = ['noise\r\n' + dump().slice(0, 100), dump().slice(100)];
		const writes: string[] = [];
		const connection = {
			get readText() {
				const chunk = chunks.shift();
				return chunk === undefined
					? Effect.fail(new SerialReadError({ message: 'unexpected read' }))
					: Effect.succeed(chunk);
			},
			writeText(text: string) {
				writes.push(text);
				return Effect.void;
			}
		};

		const snapshot = await Effect.runPromise(requestRegisterSnapshot(connection));
		expect(writes).toEqual([READ_ALL_COMMAND]);
		expect(snapshot).toEqual(Uint8Array.from({ length: 256 }, (_, index) => index));
	});
});

describe('RawLogBuffer', () => {
	it('retains only its configured tail', () => {
		const log = new RawLogBuffer(5);
		log.append('abc');
		expect(log.append('def')).toBe('bcdef');
	});
});
