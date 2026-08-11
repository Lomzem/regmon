import { describe, expect, it, vi } from 'vitest';
import {
	connectionStatusLabel,
	copyToClipboard,
	isStaleAddress,
	registerMatchesFilter,
	unsupportedTransportMessage
} from './presentation';

describe('monitor presentation', () => {
	it('uses transport-specific browser messages', () => {
		expect(unsupportedTransportMessage('ogp', false, 'unsupported')).toEqual({
			key: 'ogp-desktop-only',
			title: 'TCP OGP requires the desktop app',
			detail: 'The browser preview cannot open native TCP connections. Use RegMon Desktop for OGP.'
		});
		expect(unsupportedTransportMessage('uart', false, 'unsupported')?.detail).toContain('Chromium');
	});

	it('labels connection and scan states explicitly', () => {
		expect(connectionStatusLabel({ status: 'disconnected', polling: false, error: null })).toBe(
			'Disconnected'
		);
		expect(connectionStatusLabel({ status: 'connecting', polling: false, error: null })).toBe(
			'Connecting...'
		);
		expect(connectionStatusLabel({ status: 'connected', polling: true, error: null })).toBe(
			'Scanning'
		);
		expect(connectionStatusLabel({ status: 'connected', polling: false, error: {} })).toBe('Error');
	});

	it('identifies stale addresses and filters without changing address layout', () => {
		expect(isStaleAddress(0x10, [0x10, 0x20])).toBe(true);
		expect(isStaleAddress(0x11, [0x10, 0x20])).toBe(false);
		expect(registerMatchesFilter(0x2a, 0x7f, '0x2a', null)).toBe(true);
		expect(registerMatchesFilter(0x2a, 0x7f, 'value 0x7f', null)).toBe(true);
		expect(registerMatchesFilter(0x2a, 0x7f, '0x30', null)).toBe(false);
	});

	it('returns an inline error state when clipboard access rejects', async () => {
		const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('denied')) };
		expect(await copyToClipboard(clipboard, 'text')).toBe('error');
		expect(await copyToClipboard(undefined, 'text')).toBe('error');
	});
});
