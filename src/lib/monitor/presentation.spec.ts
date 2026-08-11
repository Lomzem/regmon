import { describe, expect, it, vi } from 'vitest';
import { indexRegisters } from '$lib/rdl/decode';
import type { Register } from '$lib/rdl/types';
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
		const staleAddresses = new Set([0x10, 0x20]);
		expect(isStaleAddress(0x10, staleAddresses)).toBe(true);
		expect(isStaleAddress(0x11, staleAddresses)).toBe(false);
		expect(registerMatchesFilter(0x2a, 0x7f, '0x2a', undefined)).toBe(true);
		expect(registerMatchesFilter(0x2a, 0x7f, 'value 0x7f', undefined)).toBe(true);
		expect(registerMatchesFilter(0x2a, 0x7f, '0x30', undefined)).toBe(false);
	});

	it('indexes duplicate addresses first-wins and filters mapped register fields', () => {
		const first = {
			name: 'STATUS',
			address: 0x20,
			width: 8,
			fields: [{ name: 'READY', lowBit: 0, highBit: 0, width: 1, mask: 1 }]
		} satisfies Register;
		const duplicate = { ...first, name: 'ALIAS', fields: [] } satisfies Register;
		const indexed = indexRegisters([first, duplicate]);

		expect(indexed.get(0x20)).toBe(first);
		expect(registerMatchesFilter(0x20, 1, 'status', indexed.get(0x20))).toBe(true);
		expect(registerMatchesFilter(0x20, 1, 'ready', indexed.get(0x20))).toBe(true);
		expect(registerMatchesFilter(0x20, 1, 'alias', indexed.get(0x20))).toBe(false);
	});

	it('returns an inline error state when clipboard access rejects', async () => {
		const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('denied')) };
		expect(await copyToClipboard(clipboard, 'text')).toBe('error');
		expect(await copyToClipboard(undefined, 'text')).toBe('error');
	});
});
