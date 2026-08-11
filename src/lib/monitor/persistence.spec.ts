import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { parseSystemRdl } from '$lib/rdl/parser';
import {
	DEFAULT_OGP_POLL_INTERVAL_MS,
	DEFAULT_UART_POLL_INTERVAL_MS,
	normalizeSettings
} from './persistence';

describe('normalizeSettings', () => {
	const field = {
		name: 'STATE',
		displayName: 'State',
		description: 'Current state',
		lowBit: 1,
		highBit: 2,
		width: 2,
		mask: 0x06,
		softwareAccess: 'r' as const,
		reset: 1,
		encode: {
			name: 'state_e',
			values: [
				{ name: 'IDLE', value: 0, displayName: 'Idle' },
				{ name: 'RUN', value: 1, description: 'Running' }
			]
		}
	};
	const register = {
		name: 'STATUS',
		displayName: 'Status',
		description: 'Device status',
		address: 1,
		width: 8 as const,
		softwareAccess: 'rw' as const,
		reset: 2,
		fields: [field]
	};
	const registerMap = {
		name: 'map',
		displayName: 'Device map',
		description: 'Register definitions',
		addressWidth: 8 as const,
		registers: [register],
		warnings: [{ code: 'unsupported' as const, message: 'Ignored signal', line: 2, column: 3 }]
	};

	it('normalizes persisted IPC values and removes invalid watch addresses', () => {
		const settings = normalizeSettings({
			mode: 'ogp',
			selectedPortId: 'x'.repeat(1_025),
			port: Number.NaN,
			slot: 99,
			ogpIntervalMs: 12_345,
			watchlist: [2, -1, 2, 1.5, 255]
		});

		expect(settings.selectedPortId).toBeNull();
		expect(settings.port).toBe(5_253);
		expect(settings.slot).toBe(20);
		expect(settings.ogpIntervalMs).toBe(DEFAULT_OGP_POLL_INTERVAL_MS);
		expect(settings.watchlist).toEqual([2, 255]);
	});

	it('migrates the old interval only to its saved transport mode', () => {
		const settings = normalizeSettings({ mode: 'uart', intervalMs: 500 });
		expect(settings.uartIntervalMs).toBe(500);
		expect(settings.ogpIntervalMs).toBe(DEFAULT_OGP_POLL_INTERVAL_MS);

		const invalid = normalizeSettings({ mode: 'uart', intervalMs: 10_000 });
		expect(invalid.uartIntervalMs).toBe(DEFAULT_UART_POLL_INTERVAL_MS);
	});

	it('retains a valid persisted register map', () => {
		expect(normalizeSettings({ registerMap }).registerMap).toEqual(registerMap);
	});

	it('retains a representative map produced by the SystemRDL parser', () => {
		const parsed = Effect.runSync(
			parseSystemRdl(`enum state_e {
  IDLE = 2'b00;
  RUN = 2'b01 { name = "Running"; };
};
addrmap device {
  name = "Device";
  default sw = rw;
  signal ignored;
  reg {
    reset = 8'h01;
    field { encode = state_e; reset = state_e::RUN; } STATE[1:0];
    field { sw = r; reset = 0; } READY[7];
  } STATUS @ 8'h20;
};`)
		);

		expect(parsed.warnings).toHaveLength(1);
		expect(normalizeSettings({ registerMap: parsed }).registerMap).toEqual(parsed);
	});

	it.each([
		['missing map shape', {}],
		['registers collection', { ...registerMap, registers: 'invalid' }],
		['fields collection', { ...registerMap, registers: [{ ...register, fields: null }] }],
		[
			'field range',
			{ ...registerMap, registers: [{ ...register, fields: [{ ...field, lowBit: 7 }] }] }
		],
		[
			'field mask',
			{ ...registerMap, registers: [{ ...register, fields: [{ ...field, mask: 0x03 }] }] }
		],
		[
			'field software access',
			{ ...registerMap, registers: [{ ...register, fields: [{ ...field, softwareAccess: 'rx' }] }] }
		],
		[
			'field reset',
			{ ...registerMap, registers: [{ ...register, fields: [{ ...field, reset: 4 }] }] }
		],
		[
			'register software access',
			{ ...registerMap, registers: [{ ...register, softwareAccess: 'rx' }] }
		],
		['register reset', { ...registerMap, registers: [{ ...register, reset: 256 }] }],
		[
			'enum integer value',
			{
				...registerMap,
				registers: [
					{
						...register,
						fields: [
							{ ...field, encode: { ...field.encode, values: [{ name: 'BAD', value: 1.5 }] } }
						]
					}
				]
			}
		],
		[
			'enum value range',
			{
				...registerMap,
				registers: [
					{
						...register,
						fields: [{ ...field, encode: { ...field.encode, values: [{ name: 'BAD', value: 4 }] } }]
					}
				]
			}
		],
		['warning object', { ...registerMap, warnings: [null] }],
		['warning code', { ...registerMap, warnings: [{ ...registerMap.warnings[0], code: 'other' }] }],
		['warning message', { ...registerMap, warnings: [{ ...registerMap.warnings[0], message: 1 }] }],
		['warning line', { ...registerMap, warnings: [{ ...registerMap.warnings[0], line: 0 }] }],
		['warning column', { ...registerMap, warnings: [{ ...registerMap.warnings[0], column: 1.5 }] }],
		[
			'duplicate register address',
			{ ...registerMap, registers: [register, { ...register, name: 'ALIAS' }] }
		]
	])('discards a malformed persisted register map: %s', (_name, malformed) => {
		expect(normalizeSettings({ registerMap: malformed as never }).registerMap).toBeNull();
	});
});
