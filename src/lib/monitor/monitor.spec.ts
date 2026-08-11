import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeSessionGate, type NativeTransportEvent } from '$lib/transport/tauri';
import {
	BrowserMonitor,
	disconnectedStatus,
	FILTER_PERSIST_DELAY_MS,
	pollDelayAfterResult
} from './monitor.svelte';

afterEach(() => vi.useRealTimers());

interface MonitorHarness {
	_view: BrowserMonitor['view'];
	native: boolean;
	nativeSession: NativeSessionGate;
	onNativeEvent(event: NativeTransportEvent): void;
	poll(): void;
}

function nativePollingMonitor(): {
	monitor: BrowserMonitor;
	harness: MonitorHarness;
	poll: ReturnType<typeof vi.fn>;
} {
	const monitor = new BrowserMonitor();
	const harness = monitor as unknown as MonitorHarness;
	const poll = vi.fn();
	Object.assign(harness, {
		native: true,
		poll,
		_view: { ...monitor.view, native: true, status: 'connected', polling: true, intervalMs: 1_000 }
	});
	const attempt = harness.nativeSession.beginConnect();
	harness.nativeSession.accept(attempt, 1);
	return { monitor, harness, poll };
}

const nativeError: NativeTransportEvent = {
	type: 'error',
	generation: 1,
	error: { kind: 'timeout', message: 'scan failed', recoverable: true }
};

const nativeScanComplete: NativeTransportEvent = {
	type: 'scanComplete',
	generation: 1,
	missing: [1]
};

describe('monitor state policies', () => {
	it('marks unsupported browser transports without changing native behavior', () => {
		expect(disconnectedStatus('uart', false, false)).toBe('unsupported');
		expect(disconnectedStatus('uart', false, true)).toBe('disconnected');
		expect(disconnectedStatus('ogp', false, true)).toBe('unsupported');
		expect(disconnectedStatus('ogp', true, false)).toBe('disconnected');
	});

	it('runs a queued refresh immediately and otherwise waits for the interval', () => {
		expect(pollDelayAfterResult(true, 1_000, false)).toBe(0);
		expect(pollDelayAfterResult(false, 1_000, false)).toBe(1_000);
		expect(pollDelayAfterResult(true, 1_000, true)).toBe(1_000);
	});

	it('keeps one interval retry for error then scanComplete with a queued refresh', () => {
		vi.useFakeTimers();
		const { monitor, harness, poll } = nativePollingMonitor();
		monitor.dispatch({ type: 'refresh' });

		harness.onNativeEvent(nativeError);
		vi.advanceTimersByTime(100);
		harness.onNativeEvent(nativeScanComplete);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(899);
		expect(poll).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(poll).toHaveBeenCalledOnce();
	});

	it('replaces a queued zero-delay scan when legacy scanComplete then error arrives', () => {
		vi.useFakeTimers();
		const { monitor, harness, poll } = nativePollingMonitor();
		monitor.dispatch({ type: 'refresh' });

		harness.onNativeEvent(nativeScanComplete);
		harness.onNativeEvent(nativeError);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(0);
		expect(poll).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1_000);
		expect(poll).toHaveBeenCalledOnce();
	});

	it('debounces filter persistence and flushes it when closed', () => {
		vi.useFakeTimers();
		const setItem = vi.fn();
		const storage = {
			length: 0,
			clear: vi.fn(),
			getItem: vi.fn(() => null),
			key: vi.fn(() => null),
			removeItem: vi.fn(),
			setItem
		} satisfies Storage;
		const monitor = new BrowserMonitor();
		Object.assign(monitor, { storage });

		monitor.dispatch({ type: 'set-filter', filter: 'sta' });
		monitor.dispatch({ type: 'set-filter', filter: 'status' });
		expect(monitor.view.filter).toBe('status');
		expect(setItem).not.toHaveBeenCalled();

		vi.advanceTimersByTime(FILTER_PERSIST_DELAY_MS - 1);
		expect(setItem).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(setItem).toHaveBeenCalledTimes(1);
		expect(JSON.parse(setItem.mock.calls[0][1]).filter).toBe('status');

		monitor.dispatch({ type: 'set-filter', filter: 'control' });
		monitor.close();
		expect(setItem).toHaveBeenCalledTimes(2);
		expect(JSON.parse(setItem.mock.calls[1][1]).filter).toBe('control');
	});
});
