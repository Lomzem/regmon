import { describe, expect, it } from 'vitest';
import { RegisterDumpAssembler } from './dump';

function row(offset: number, value = offset): string {
	const bytes = Array.from({ length: 16 }, (_, index) =>
		((value + index) & 0xff).toString(16).padStart(2, '0')
	).join(' ');
	return `${offset.toString(16).padStart(2, '0')}: ${bytes}`;
}

describe('RegisterDumpAssembler', () => {
	it('assembles rows arriving in arbitrary chunks and order', () => {
		const assembler = new RegisterDumpAssembler();
		const text = [
			'register dump',
			'----------------',
			...Array.from({ length: 16 }, (_, index) => row((15 - index) * 16)),
			'prompt>'
		].join('\r\n');
		const snapshots = [
			...assembler.push(text.slice(0, 37)),
			...assembler.push(text.slice(37, 143)),
			...assembler.push(text.slice(143) + '\r'),
			...assembler.push('\n')
		];

		expect(snapshots).toHaveLength(1);
		expect([...snapshots[0]]).toEqual(Array.from({ length: 256 }, (_, index) => index));
	});

	it('uses the latest duplicate row and ignores malformed row-like lines', () => {
		const assembler = new RegisterDumpAssembler();
		const malformed = [
			'01: ' + '00 '.repeat(15) + '00',
			'20: ' + '00 '.repeat(15),
			'30: ' + '00 '.repeat(16) + '00',
			'40: ' + '00 '.repeat(15) + 'gg'
		];
		const lines = [
			row(0, 0xaa),
			...malformed,
			row(0, 0),
			...Array.from({ length: 15 }, (_, i) => row((i + 1) * 16))
		];

		const snapshots = assembler.push(lines.join('\n') + '\n');

		expect(snapshots).toHaveLength(1);
		expect([...snapshots[0].slice(0, 16)]).toEqual(Array.from({ length: 16 }, (_, i) => i));
	});

	it('returns every complete snapshot contained in one chunk', () => {
		const assembler = new RegisterDumpAssembler();
		const dump = (base: number) =>
			Array.from({ length: 16 }, (_, index) => row(index * 16, base)).join('\n') + '\n';

		const snapshots = assembler.push(dump(0x10) + 'read all\n' + dump(0x80));

		expect(snapshots).toHaveLength(2);
		expect(snapshots[0][0]).toBe(0x10);
		expect(snapshots[1][0]).toBe(0x80);
	});

	it('waits for all rows and can consume an unterminated final line on finish', () => {
		const assembler = new RegisterDumpAssembler();
		const lines = Array.from({ length: 16 }, (_, index) => row(index * 16));

		expect(assembler.push(lines.slice(0, 15).join('\n') + '\n' + lines[15])).toEqual([]);
		const snapshots = assembler.finish();
		expect(snapshots).toHaveLength(1);
	});
});
