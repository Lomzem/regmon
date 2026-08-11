import { describe, expect, it } from 'vitest';
import {
	DEFAULT_OGP_POLL_INTERVAL_MS,
	DEFAULT_UART_POLL_INTERVAL_MS,
	normalizeSettings
} from './persistence';

describe('normalizeSettings', () => {
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
});
