import { Effect, Either } from 'effect';
import { describe, expect, it } from 'vitest';
import { decodeRegister, decodeRegisterMap } from './decode';
import { parseSystemRdl } from './parser';

const fixture = `
// A generic byte-oriented register map.
property documentation { type = string; component = field; };
enum state_e {
  OFF = 2'b00 { name = "Off"; };
  ON = 2'b01 { name = "On"; desc = "Active state"; };
};
addrmap example_map {
  name = "Example";
  desc = "First line
second line";
  default regwidth = 8;
  default sw = rw;

  reg {
    name = "Control";
    field { encode = state_e; reset = state_e.ON; } STATE[1:0];
    field { sw = r; reset = 1'b0; } READY[7];
  } CONTROL @ 0x10;

  reg { field {} VALUE[7:0]; } DATA @ 8'h20;
};
`;

describe('parseSystemRdl', () => {
	it('parses and normalizes the focused 8-bit profile', () => {
		const result = Effect.runSync(parseSystemRdl(fixture));

		expect(result).toMatchObject({
			name: 'example_map',
			displayName: 'Example',
			description: 'First line\nsecond line',
			addressWidth: 8,
			warnings: [],
			registers: [
				{
					name: 'CONTROL',
					displayName: 'Control',
					address: 0x10,
					width: 8,
					fields: [
						{
							name: 'STATE',
							lowBit: 0,
							highBit: 1,
							width: 2,
							mask: 0x03,
							softwareAccess: 'rw',
							reset: 1,
							encode: { name: 'state_e' }
						},
						{ name: 'READY', lowBit: 7, highBit: 7, mask: 0x80, softwareAccess: 'r' }
					]
				},
				{ name: 'DATA', address: 0x20 }
			]
		});
	});

	it('retains located warnings and omits registers outside the byte address space', () => {
		const source = `addrmap map {
  signal flag;
  reg { field {} BIT[8]; } TOO_FAR @ 0x100;
};`;
		const result = Effect.runSync(parseSystemRdl(source));

		expect(result.registers).toEqual([]);
		expect(result.warnings).toEqual([
			expect.objectContaining({ code: 'unsupported', line: 2, column: 3 }),
			expect.objectContaining({ code: 'out-of-range', line: 3, column: 9 }),
			expect.objectContaining({ code: 'out-of-range', line: 3, column: 38 })
		]);
	});

	it('returns a located tagged error for malformed input', () => {
		const result = Effect.runSync(Effect.either(parseSystemRdl('addrmap map { reg {')));

		expect(Either.isLeft(result)).toBe(true);
		if (Either.isLeft(result)) {
			expect(result.left).toMatchObject({ _tag: 'RdlError', line: 1 });
		}
	});

	it('supports register-local defaults, nested enums, scoped resets, and hexadecimal addresses', () => {
		const source = `
property note_property {
  type = string;
  component = field;
};
addrmap scoped_map {
  reg {
    default sw = r;
    default hw = w;
    enum local_mode {
      IDLE = 3'h0;
      RUN = 3'h5 { name = "Running"; };
    };
    field {
      encode = local_mode;
      reset = local_mode::RUN;
    } MODE[7:0];
  } STATUS @ 0xA5;
};`;
		const result = Effect.runSync(parseSystemRdl(source));

		expect(result.warnings).toEqual([]);
		expect(result.registers).toHaveLength(1);
		expect(result.registers[0]).toMatchObject({
			name: 'STATUS',
			address: 0xa5,
			fields: [
				{
					name: 'MODE',
					lowBit: 0,
					highBit: 7,
					softwareAccess: 'r',
					reset: 5,
					encode: {
						name: 'local_mode',
						values: [
							{ name: 'IDLE', value: 0 },
							{ name: 'RUN', value: 5, displayName: 'Running' }
						]
					}
				}
			]
		});
		expect(decodeRegisterMap(result, 0xa5, 5)?.fields[0].enumValue?.name).toBe('RUN');
	});
});

describe('register decoding', () => {
	it('extracts fields and resolves enum labels from a byte', () => {
		const map = Effect.runSync(parseSystemRdl(fixture));
		const decoded = decodeRegisterMap(map, 0x10, 0x81);

		expect(decoded?.value).toBe(0x81);
		expect(decoded?.fields.map(({ value, enumValue }) => [value, enumValue?.name])).toEqual([
			[1, 'ON'],
			[1, undefined]
		]);
		expect(decodeRegister(map.registers[0], 0x181).value).toBe(0x81);
		expect(decodeRegisterMap(map, 0xff, 0)).toBeUndefined();
	});
});
