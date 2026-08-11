import { Channel, invoke } from '@tauri-apps/api/core';

export type NativeConnectionConfig =
	| { readonly mode: 'uart'; readonly portId: string }
	| {
			readonly mode: 'ogp';
			readonly host: string;
			readonly port: number;
			readonly slot: number;
			readonly force: boolean;
	  };

function integer(value: number, fallback: number, minimum: number, maximum: number): number {
	return Number.isFinite(value)
		? Math.max(minimum, Math.min(maximum, Math.round(value)))
		: fallback;
}

export interface SerialEndpoint {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly usbVendorId: number | null;
	readonly usbProductId: number | null;
	readonly serialNumber: string | null;
}

export interface NativeError {
	readonly kind: string;
	readonly message: string;
	readonly recoverable: boolean;
}

export interface NativeRegisterUpdate {
	readonly address: number;
	readonly value: number;
}

export type NativeTransportEvent =
	| { readonly type: 'status'; readonly generation: number; readonly status: NativeStatus }
	| { readonly type: 'scanStarted'; readonly generation: number; readonly addresses: number[] }
	| {
			readonly type: 'registers';
			readonly generation: number;
			readonly updates: NativeRegisterUpdate[];
			readonly missing: number[];
	  }
	| { readonly type: 'scanComplete'; readonly generation: number; readonly missing: number[] }
	| { readonly type: 'log'; readonly generation: number; readonly text: string }
	| { readonly type: 'error'; readonly generation: number; readonly error: NativeError };

export type NativeStatus = 'connecting' | 'connected' | 'disconnected';

export class NativeSessionGate {
	private attempt = 0;
	private backendGeneration: number | null = null;

	get generation(): number | null {
		return this.backendGeneration;
	}

	beginConnect(): number {
		this.backendGeneration = null;
		this.attempt += 1;
		return this.attempt;
	}

	isCurrent(attempt: number): boolean {
		return attempt === this.attempt;
	}

	accept(attempt: number, generation: number): boolean {
		if (!this.isCurrent(attempt)) return false;
		if (this.backendGeneration !== null && this.backendGeneration !== generation) return false;
		this.backendGeneration = generation;
		return true;
	}

	invalidate(): number | null {
		const generation = this.backendGeneration;
		this.backendGeneration = null;
		this.attempt += 1;
		return generation;
	}
}

export function mergeRegisterUpdates(
	current: Uint8Array | null,
	updates: readonly NativeRegisterUpdate[]
): Uint8Array {
	const snapshot = current?.slice() ?? new Uint8Array(256);
	for (const update of updates) {
		if (
			Number.isInteger(update.address) &&
			update.address >= 0 &&
			update.address <= 0xff &&
			Number.isInteger(update.value) &&
			update.value >= 0 &&
			update.value <= 0xff
		) {
			snapshot[update.address] = update.value;
		}
	}
	return snapshot;
}

export function isTauriRuntime(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function listNativeSerialPorts(): Promise<SerialEndpoint[]> {
	return invoke<SerialEndpoint[]>('list_serial_ports');
}

export function connectNativeTransport(
	config: NativeConnectionConfig,
	onEvent: (event: NativeTransportEvent) => void
): Promise<number> {
	const channel = new Channel<NativeTransportEvent>();
	channel.onmessage = onEvent;
	const normalized =
		config.mode === 'uart'
			? { mode: 'uart' as const, portId: config.portId.slice(0, 1_024) }
			: {
					mode: 'ogp' as const,
					host: config.host.slice(0, 253),
					port: integer(config.port, 5_253, 1, 65_535),
					slot: integer(config.slot, 1, 1, 20),
					force: config.force === true
				};
	return invoke<number>('connect_transport', { config: normalized, onEvent: channel });
}

export function scanNativeTransport(
	generation: number,
	addresses: readonly number[]
): Promise<void> {
	return invoke('scan_transport', { generation, addresses: [...addresses] });
}

export function disconnectNativeTransport(generation: number): Promise<void> {
	return invoke('disconnect_transport', { generation });
}
