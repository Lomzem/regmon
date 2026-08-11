import { describe, expect, it } from 'vitest';
import { mergeRegisterUpdates, NativeSessionGate } from './tauri';

describe('mergeRegisterUpdates', () => {
	it('preserves the prior snapshot when a new native connection sends partial results', () => {
		const previous = new Uint8Array(256).fill(0x55);
		const merged = mergeRegisterUpdates(previous, [{ address: 7, value: 0xaa }]);

		expect(merged[6]).toBe(0x55);
		expect(merged[7]).toBe(0xaa);
		expect(previous[7]).toBe(0x55);
	});

	it('ignores malformed updates', () => {
		const merged = mergeRegisterUpdates(null, [
			{ address: -1, value: 1 },
			{ address: 1, value: 300 }
		]);
		expect(merged).toEqual(new Uint8Array(256));
	});
});

describe('NativeSessionGate', () => {
	it('accepts a backend generation after repeated disconnected mode changes', () => {
		const gate = new NativeSessionGate();

		gate.invalidate();
		gate.invalidate();
		gate.invalidate();
		const attempt = gate.beginConnect();

		expect(gate.accept(attempt, 1)).toBe(true);
		expect(gate.generation).toBe(1);
		expect(gate.accept(attempt, 1)).toBe(true);
	});

	it('rejects callbacks from an invalidated connect attempt', () => {
		const gate = new NativeSessionGate();
		const staleAttempt = gate.beginConnect();
		gate.invalidate();
		const currentAttempt = gate.beginConnect();

		expect(gate.accept(staleAttempt, 1)).toBe(false);
		expect(gate.accept(currentAttempt, 2)).toBe(true);
	});
});
