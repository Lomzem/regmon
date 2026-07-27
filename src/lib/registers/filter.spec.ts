import { describe, expect, it } from 'vitest';
import { filterSnapshot, parseAddressExpression } from './filter';

describe('parseAddressExpression', () => {
	it('expands ranges, accepts optional 0x, and removes duplicates', () => {
		const result = parseAddressExpression('00-0x0F, 33, 0XC0-CF, 0x33');

		expect(result).toEqual({
			ok: true,
			addresses: [
				...Array.from({ length: 16 }, (_, i) => i),
				0x33,
				...Array.from({ length: 16 }, (_, i) => 0xc0 + i)
			]
		});
	});

	it.each(['', '00,', ',01', '0x', '100', '0g', '20-10', '00-01-02', '01 nope'])(
		'reports invalid input: %s',
		(input) => {
			const result = parseAddressExpression(input);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.input).toBe(input);
				expect(result.error.message.length).toBeGreaterThan(0);
				expect(result.error.position).toBeGreaterThanOrEqual(0);
			}
		}
	);
});

describe('filterSnapshot', () => {
	it('returns address-value pairs in requested order', () => {
		const snapshot = Uint8Array.from({ length: 256 }, (_, index) => 255 - index);

		expect(filterSnapshot(snapshot, [0xc0, 0x00, 0x33])).toEqual([
			{ address: 0xc0, value: 0x3f },
			{ address: 0x00, value: 0xff },
			{ address: 0x33, value: 0xcc }
		]);
	});

	it('rejects addresses outside a snapshot', () => {
		expect(() => filterSnapshot(new Uint8Array(16), [0x10])).toThrow(RangeError);
		expect(() => filterSnapshot(new Uint8Array(256), [-1])).toThrow(RangeError);
	});
});
