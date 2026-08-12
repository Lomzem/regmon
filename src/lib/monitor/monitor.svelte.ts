import { Cause, Effect, Either, Fiber } from 'effect';
import { SvelteMap } from 'svelte/reactivity';
import mockOutput from '../../../examples/example_output.txt?raw';
import { parseSystemRdl } from '$lib/rdl/parser';
import type { RdlError, RegisterMap } from '$lib/rdl/types';
import { RegisterDumpAssembler } from '$lib/registers/dump';
import type { RegisterSnapshot } from '$lib/registers/types';
import {
	choosePort,
	getBrowserSerial,
	isSerialSelectionCancelled,
	listAuthorizedPorts,
	openSerialPort,
	type SerialConnection,
	type SerialFailure
} from '$lib/serial';
import {
	connectNativeTransport,
	disconnectNativeTransport,
	isTauriRuntime,
	listNativeSerialPorts,
	mergeRegisterUpdates,
	NativeSessionGate,
	scanNativeTransport,
	type NativeError,
	type NativeTransportEvent
} from '$lib/transport/tauri';
import {
	DEFAULT_OGP_POLL_INTERVAL_MS,
	DEFAULT_UART_POLL_INTERVAL_MS,
	loadSettings,
	OGP_POLL_INTERVALS,
	saveSettings,
	type MonitorSettings,
	PersistenceError,
	UART_POLL_INTERVALS
} from './persistence';
import {
	DEFAULT_RESPONSE_TIMEOUT_MS,
	RawLogBuffer,
	requestRegisterSnapshot,
	type ProtocolFailure
} from './protocol';

export const DEFAULT_POLL_INTERVAL_MS = DEFAULT_UART_POLL_INTERVAL_MS;
export const FILTER_PERSIST_DELAY_MS = 300;
export { DEFAULT_OGP_POLL_INTERVAL_MS, OGP_POLL_INTERVALS, UART_POLL_INTERVALS };
export type TransportMode = 'uart' | 'ogp';
export type ConnectionStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected';

export interface PortOption {
	readonly id: string;
	readonly label: string;
}

export interface TransportFailure {
	readonly _tag: string;
	readonly message: string;
	readonly recoverable?: boolean;
}

export interface MonitorView {
	readonly native: boolean;
	readonly mode: TransportMode;
	readonly status: ConnectionStatus;
	readonly ports: readonly PortOption[];
	readonly selectedPortId: string | null;
	readonly host: string;
	readonly port: number;
	readonly slot: number;
	readonly forceConnect: boolean;
	readonly paused: boolean;
	readonly polling: boolean;
	readonly intervalMs: number;
	readonly missingAddresses: readonly number[];
	readonly watchlist: readonly number[];
	readonly filter: string;
	readonly snapshot: RegisterSnapshot | null;
	readonly previousSnapshot: RegisterSnapshot | null;
	readonly snapshotAt: number | null;
	readonly snapshotSource: string | null;
	readonly selectedAddress: number | null;
	readonly rawLog: string;
	readonly rdlSource: string;
	readonly rdlFileName: string;
	readonly registerMap: RegisterMap | null;
	readonly error: MonitorFailure | null;
}

export type MonitorFailure =
	SerialFailure | ProtocolFailure | PersistenceError | RdlError | TransportFailure;

export type MonitorAction =
	| { readonly type: 'set-mode'; readonly mode: TransportMode }
	| { readonly type: 'refresh-ports' }
	| { readonly type: 'choose-port' }
	| { readonly type: 'select-port'; readonly portId: string | null }
	| { readonly type: 'set-host'; readonly host: string }
	| { readonly type: 'set-port'; readonly port: number }
	| { readonly type: 'set-slot'; readonly slot: number }
	| { readonly type: 'set-force-connect'; readonly force: boolean }
	| { readonly type: 'connect' }
	| { readonly type: 'disconnect' }
	| { readonly type: 'set-paused'; readonly paused: boolean }
	| { readonly type: 'refresh' }
	| { readonly type: 'set-interval'; readonly intervalMs: number }
	| { readonly type: 'set-watchlist'; readonly addresses: readonly number[] }
	| { readonly type: 'set-filter'; readonly filter: string }
	| { readonly type: 'set-rdl-source'; readonly source: string; readonly fileName: string }
	| { readonly type: 'clear-rdl' }
	| { readonly type: 'select-address'; readonly address: number | null }
	| { readonly type: 'clear-log' };

const initialView: MonitorView = {
	native: false,
	mode: 'uart',
	status: 'disconnected',
	ports: [],
	selectedPortId: null,
	host: '',
	port: 5253,
	slot: 1,
	forceConnect: false,
	paused: false,
	polling: false,
	intervalMs: DEFAULT_POLL_INTERVAL_MS,
	missingAddresses: [],
	watchlist: [],
	filter: '',
	snapshot: null,
	previousSnapshot: null,
	snapshotAt: null,
	snapshotSource: null,
	selectedAddress: null,
	rawLog: '',
	rdlSource: '',
	rdlFileName: '',
	registerMap: null,
	error: null
};

function immutableView(view: MonitorView): MonitorView {
	return Object.freeze({
		...view,
		ports: Object.freeze([...view.ports]),
		missingAddresses: Object.freeze([...view.missingAddresses]),
		watchlist: Object.freeze([...view.watchlist])
	});
}

function errorFromCause(cause: Cause.Cause<MonitorFailure>): MonitorFailure | null {
	return Cause.failureOption(cause).pipe((option) =>
		option._tag === 'Some' ? option.value : null
	);
}

function transportFailure(error: unknown): TransportFailure {
	if (typeof error === 'object' && error !== null && 'message' in error) {
		const value = error as Partial<NativeError>;
		return {
			_tag: value.kind ?? 'TransportError',
			message: String(value.message),
			recoverable: value.recoverable
		};
	}
	return { _tag: 'TransportError', message: String(error) };
}

function normalizeWatchlist(addresses: readonly number[]): readonly number[] {
	return [
		...new Set(
			addresses.filter((address) => Number.isInteger(address) && address >= 0 && address <= 0xff)
		)
	].sort((left, right) => left - right);
}

function integerInRange(value: number, fallback: number, minimum: number, maximum: number): number {
	return Number.isFinite(value)
		? Math.max(minimum, Math.min(maximum, Math.round(value)))
		: fallback;
}

export function disconnectedStatus(
	mode: TransportMode,
	native: boolean,
	serialAvailable: boolean
): ConnectionStatus {
	return !native && (mode === 'ogp' || !serialAvailable) ? 'unsupported' : 'disconnected';
}

export function pollDelayAfterResult(
	refreshQueued: boolean,
	intervalMs: number,
	failed: boolean
): number {
	return !failed && refreshQueued ? 0 : intervalMs;
}

export class BrowserMonitor {
	private _view = $state.raw<MonitorView>(immutableView(initialView));
	private readonly rawLog = new RawLogBuffer();
	private readonly native: boolean;
	private readonly serial: Serial | undefined;
	private readonly storage: Storage | undefined;
	private readonly browserPorts = new SvelteMap<string, SerialPort>();
	private connection: SerialConnection | undefined;
	private connectionFiber: Fiber.RuntimeFiber<void, never> | undefined;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly intervals = {
		uart: DEFAULT_UART_POLL_INTERVAL_MS,
		ogp: DEFAULT_OGP_POLL_INTERVAL_MS
	};
	private browserGeneration = 0;
	private readonly nativeSession = new NativeSessionGate();
	private closed = false;
	private refreshQueued = false;
	private nativeScanFailed = false;
	private readonly serialChange = () => this.refreshPorts();

	constructor() {
		if (typeof window === 'undefined') {
			this.native = false;
			this.serial = undefined;
			this.storage = undefined;
			return;
		}
		this.native = isTauriRuntime();
		this.serial = !this.native && 'serial' in navigator ? navigator.serial : undefined;
		this.storage = window.localStorage;
		this.patch({ native: this.native });
		if (import.meta.env.DEV) this.loadDevelopmentFixture();
		this.restore();
		if (this.native) {
			this.refreshPorts();
			return;
		}
		if (!this.serial) {
			this.patch({ status: 'unsupported' });
			return;
		}
		this.serial.addEventListener('connect', this.serialChange);
		this.serial.addEventListener('disconnect', this.serialChange);
		this.refreshPorts();
	}

	get view(): MonitorView {
		return this._view;
	}

	dispatch(action: MonitorAction): void {
		if (this.closed) return;
		switch (action.type) {
			case 'set-mode':
				if (action.mode !== this._view.mode) this.disconnect();
				this.patch({
					mode: action.mode,
					status: disconnectedStatus(action.mode, this.native, this.serial !== undefined),
					intervalMs: this.intervals[action.mode]
				});
				this.persist();
				break;
			case 'refresh-ports':
				this.refreshPorts();
				break;
			case 'choose-port':
				this.choosePort();
				break;
			case 'select-port':
				this.updateEndpoint({ selectedPortId: action.portId });
				break;
			case 'set-host':
				this.updateEndpoint({ host: action.host });
				break;
			case 'set-port':
				this.updateEndpoint({
					port: integerInRange(action.port, this._view.port, 1, 65_535)
				});
				break;
			case 'set-slot':
				this.updateEndpoint({ slot: integerInRange(action.slot, this._view.slot, 1, 20) });
				break;
			case 'set-force-connect':
				this.updateEndpoint({ forceConnect: action.force });
				break;
			case 'connect':
				this.connect();
				break;
			case 'disconnect':
				this.disconnect();
				break;
			case 'set-paused':
				this.patch({ paused: action.paused });
				if (action.paused) this.clearPollTimer();
				else this.schedulePoll(0);
				break;
			case 'refresh':
				this.manualRefresh();
				break;
			case 'set-interval':
				{
					const supported = this._view.mode === 'ogp' ? OGP_POLL_INTERVALS : UART_POLL_INTERVALS;
					const fallback = this.intervals[this._view.mode];
					const intervalMs = supported.some((interval) => interval === action.intervalMs)
						? action.intervalMs
						: fallback;
					const intervalChanged = intervalMs !== this._view.intervalMs;
					this.intervals[this._view.mode] = intervalMs;
					this.patch({ intervalMs });
					if (
						intervalChanged &&
						this.pollTimer !== undefined &&
						this._view.status === 'connected' &&
						!this._view.paused &&
						!this._view.polling
					) {
						this.schedulePoll(intervalMs);
					}
				}
				this.persist();
				break;
			case 'set-watchlist':
				this.patch({ watchlist: normalizeWatchlist(action.addresses) });
				this.persist();
				break;
			case 'set-filter':
				this.patch({ filter: action.filter });
				this.schedulePersist();
				break;
			case 'set-rdl-source':
				this.setRdlSource(action.source, action.fileName);
				break;
			case 'clear-rdl':
				this.patch({ rdlSource: '', rdlFileName: '', registerMap: null, error: null });
				this.persist();
				break;
			case 'select-address':
				this.patch({
					selectedAddress:
						action.address === null ? null : Math.max(0, Math.min(0xff, Math.round(action.address)))
				});
				break;
			case 'clear-log':
				this.patch({ rawLog: this.rawLog.clear() });
		}
	}

	close(): void {
		if (this.closed) return;
		this.flushPersist();
		this.closed = true;
		this.serial?.removeEventListener('connect', this.serialChange);
		this.serial?.removeEventListener('disconnect', this.serialChange);
		this.disconnect();
	}

	private patch(patch: Partial<MonitorView>): void {
		this._view = immutableView({ ...this._view, ...patch });
	}

	private updateEndpoint(patch: Partial<MonitorView>): void {
		if (this._view.status === 'connected' || this._view.status === 'connecting') this.disconnect();
		this.patch({ ...patch, error: null });
		this.persist();
	}

	private loadDevelopmentFixture(): void {
		const assembler = new RegisterDumpAssembler();
		const snapshot = assembler.push(`${mockOutput}\n`)[0];
		if (snapshot)
			this.patch({
				snapshot,
				snapshotAt: Date.now(),
				snapshotSource: 'Example fixture',
				rawLog: this.rawLog.append(mockOutput)
			});
	}

	private run<A>(effect: Effect.Effect<A, MonitorFailure>, success?: (value: A) => void): void {
		void Effect.runPromiseExit(effect).then((exit) => {
			if (this.closed) return;
			if (exit._tag === 'Success') success?.(exit.value);
			else {
				const error = errorFromCause(exit.cause);
				if (error) this.patch({ error });
			}
		});
	}

	private restore(): void {
		if (!this.storage) return;
		const result = Effect.runSync(Effect.either(loadSettings(this.storage)));
		if (Either.isLeft(result)) {
			this.patch({ error: result.left });
			return;
		}
		const value = result.right;
		const mode = value.mode;
		this.intervals.uart = value.uartIntervalMs;
		this.intervals.ogp = value.ogpIntervalMs;
		this.patch({
			mode,
			selectedPortId: value.selectedPortId,
			host: value.host,
			port: value.port,
			slot: value.slot,
			forceConnect: value.forceConnect,
			intervalMs: this.intervals[mode],
			watchlist: value.watchlist,
			filter: value.filter,
			rdlSource: value.rdlSource,
			rdlFileName: value.rdlFileName,
			registerMap: value.registerMap,
			status: disconnectedStatus(mode, this.native, this.serial !== undefined)
		});
	}

	private persist(): void {
		this.clearPersistTimer();
		if (!this.storage) return;
		const settings: MonitorSettings = {
			mode: this._view.mode,
			selectedPortId: this._view.selectedPortId,
			host: this._view.host,
			port: this._view.port,
			slot: this._view.slot,
			forceConnect: this._view.forceConnect,
			uartIntervalMs: this.intervals.uart,
			ogpIntervalMs: this.intervals.ogp,
			watchlist: this._view.watchlist,
			filter: this._view.filter,
			rdlSource: this._view.rdlSource,
			rdlFileName: this._view.rdlFileName,
			registerMap: this._view.registerMap
		};
		this.run(saveSettings(this.storage, settings));
	}

	private schedulePersist(): void {
		this.clearPersistTimer();
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			this.persist();
		}, FILTER_PERSIST_DELAY_MS);
	}

	private flushPersist(): void {
		if (this.persistTimer === undefined) return;
		this.clearPersistTimer();
		this.persist();
	}

	private clearPersistTimer(): void {
		if (this.persistTimer !== undefined) clearTimeout(this.persistTimer);
		this.persistTimer = undefined;
	}

	private refreshPorts(): void {
		if (this.native) {
			void listNativeSerialPorts()
				.then((ports) => {
					if (this.closed) return;
					const selectedPortId = ports.some((port) => port.id === this._view.selectedPortId)
						? this._view.selectedPortId
						: (ports[0]?.id ?? null);
					this.patch({ ports: ports.map(({ id, label }) => ({ id, label })), selectedPortId });
				})
				.catch((error) => this.patch({ error: transportFailure(error) }));
			return;
		}
		if (!this.serial) return;
		this.run(listAuthorizedPorts(this.serial), (ports) => {
			this.browserPorts.clear();
			const options = ports.map((port, index) => {
				const info = port.getInfo();
				const id = `browser-${index}-${info.usbVendorId ?? ''}-${info.usbProductId ?? ''}`;
				this.browserPorts.set(id, port);
				const label =
					info.usbVendorId && info.usbProductId
						? `USB ${info.usbVendorId.toString(16).padStart(4, '0').toUpperCase()}:${info.usbProductId.toString(16).padStart(4, '0').toUpperCase()}`
						: `Authorized serial device ${index + 1}`;
				return { id, label };
			});
			const selectedPortId = options.some((option) => option.id === this._view.selectedPortId)
				? this._view.selectedPortId
				: (options[0]?.id ?? null);
			this.patch({ ports: options, selectedPortId });
			if (this.connection && !ports.includes(this.connection.port)) this.disconnect();
		});
	}

	private choosePort(): void {
		if (this.native) {
			this.refreshPorts();
			return;
		}
		if (!this.serial) {
			this.run(getBrowserSerial());
			return;
		}
		this.run(
			choosePort(this.serial).pipe(
				Effect.catchAll((error) =>
					isSerialSelectionCancelled(error) ? Effect.succeed(null) : Effect.fail(error)
				)
			),
			(port) => {
				if (!port) {
					this.patch({ error: null });
					return;
				}
				this.refreshPorts();
			}
		);
	}

	private connect(): void {
		if (this._view.status === 'connecting' || this._view.status === 'connected') return;
		if (this.native) {
			const attempt = this.nativeSession.beginConnect();
			const config =
				this._view.mode === 'uart'
					? { mode: 'uart' as const, portId: this._view.selectedPortId ?? '' }
					: {
							mode: 'ogp' as const,
							host: this._view.host.trim(),
							port: this._view.port,
							slot: this._view.slot,
							force: this._view.forceConnect
						};
			this.patch({ status: 'connecting', error: null });
			void connectNativeTransport(config, (event) => {
				if (this.nativeSession.accept(attempt, event.generation)) this.onNativeEvent(event);
			})
				.then((generation) => {
					if (this.closed || !this.nativeSession.accept(attempt, generation))
						void disconnectNativeTransport(generation).catch(() => undefined);
				})
				.catch((error) => {
					if (this.nativeSession.isCurrent(attempt))
						this.patch({ status: 'disconnected', error: transportFailure(error) });
				});
			return;
		}
		const port = this.browserPorts.get(this._view.selectedPortId ?? '');
		if (!port) return;
		const generation = ++this.browserGeneration;
		this.patch({ status: 'connecting', error: null });
		const program = Effect.scoped(
			Effect.gen(this, function* () {
				const connection = yield* openSerialPort(port);
				if (this.closed || generation !== this.browserGeneration) return yield* Effect.interrupt;
				this.connection = connection;
				this.patch({ status: 'connected' });
				this.schedulePoll(0);
				return yield* Effect.never;
			})
		).pipe(
			Effect.catchAll((error) => Effect.sync(() => this.patch({ error }))),
			Effect.ensuring(
				Effect.sync(() => {
					if (generation !== this.browserGeneration) return;
					this.connection = undefined;
					this.clearPollTimer();
					this.patch({ status: this.serial ? 'disconnected' : 'unsupported', polling: false });
				})
			)
		);
		this.connectionFiber = Effect.runFork(program);
	}

	private onNativeEvent(event: NativeTransportEvent): void {
		if (this.closed || event.generation !== this.nativeSession.generation) return;
		switch (event.type) {
			case 'status':
				this.patch({ status: event.status });
				if (event.status === 'connected') this.schedulePoll(0);
				if (event.status === 'disconnected') {
					this.clearPollTimer();
					this.nativeScanFailed = false;
					this.patch({ polling: false });
				}
				break;
			case 'scanStarted':
				this.nativeScanFailed = false;
				this.patch({
					previousSnapshot: this._view.snapshot,
					polling: true,
					missingAddresses: event.addresses,
					error: null
				});
				break;
			case 'registers':
				this.patch({
					snapshot: mergeRegisterUpdates(this._view.snapshot, event.updates),
					snapshotAt: Date.now(),
					snapshotSource: this._view.mode === 'ogp' ? 'TCP OGP' : 'Native UART',
					missingAddresses: event.missing
				});
				break;
			case 'scanComplete':
				this.patch({ missingAddresses: event.missing, snapshotAt: Date.now() });
				if (this.nativeScanFailed) {
					this.nativeScanFailed = false;
					this.patch({ polling: false });
				} else this.finishPoll();
				break;
			case 'log':
				this.patch({ rawLog: this.rawLog.append(event.text) });
				break;
			case 'error':
				{
					const terminal = event.error.kind !== 'scanBusy';
					this.patch({
						error: {
							_tag: event.error.kind,
							message: event.error.message,
							recoverable: event.error.recoverable
						},
						polling: terminal ? false : this._view.polling
					});
					if (terminal) {
						this.nativeScanFailed = true;
						this.finishFailedPoll();
					}
				}
				break;
		}
	}

	private disconnect(): void {
		const nativeGeneration = this.nativeSession.invalidate();
		this.clearPollTimer();
		this.refreshQueued = false;
		this.nativeScanFailed = false;
		this.connection = undefined;
		this.patch({
			status: disconnectedStatus(this._view.mode, this.native, this.serial !== undefined),
			polling: false
		});
		if (this.native && nativeGeneration !== null)
			void disconnectNativeTransport(nativeGeneration).catch(() => undefined);
		const fiber = this.connectionFiber;
		this.connectionFiber = undefined;
		if (fiber) Effect.runFork(Fiber.interrupt(fiber));
		if (!this.native) this.browserGeneration += 1;
	}

	private manualRefresh(): void {
		if (this._view.status !== 'connected') return;
		if (this._view.polling) {
			this.refreshQueued = true;
			return;
		}
		this.clearPollTimer();
		this.poll();
	}

	private schedulePoll(delay: number): void {
		this.clearPollTimer();
		if (this._view.status !== 'connected' || this._view.paused || this.closed) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined;
			this.poll();
		}, delay);
	}

	private clearPollTimer(): void {
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
	}

	private finishPoll(): void {
		const delay = pollDelayAfterResult(this.refreshQueued, this._view.intervalMs, false);
		this.refreshQueued = false;
		this.patch({ polling: false });
		this.schedulePoll(delay);
	}

	private finishFailedPoll(): void {
		const delay = pollDelayAfterResult(this.refreshQueued, this._view.intervalMs, true);
		this.refreshQueued = false;
		this.patch({ polling: false });
		this.schedulePoll(delay);
	}

	private failNativePoll(error: unknown): void {
		this.nativeScanFailed = false;
		this.patch({ error: transportFailure(error) });
		this.finishFailedPoll();
	}

	private poll(): void {
		if (this._view.status !== 'connected' || this._view.polling) return;
		if (this.native) {
			const generation = this.nativeSession.generation;
			if (generation === null) return;
			this.patch({ polling: true, error: null });
			void scanNativeTransport(generation, []).catch((error) => {
				if (this.closed || generation !== this.nativeSession.generation) return;
				this.failNativePoll(error);
			});
			return;
		}
		const connection = this.connection;
		if (!connection) return;
		this.patch({ polling: true, error: null, previousSnapshot: this._view.snapshot });
		const request = requestRegisterSnapshot(connection, {
			timeoutMs: DEFAULT_RESPONSE_TIMEOUT_MS,
			onRawText: (text) => this.patch({ rawLog: this.rawLog.append(text) })
		});
		void Effect.runPromiseExit(request).then((exit) => {
			if (this.closed || connection !== this.connection) return;
			if (exit._tag === 'Success') {
				this.patch({
					snapshot: exit.value.slice(),
					snapshotAt: Date.now(),
					snapshotSource: 'Browser UART',
					polling: false,
					missingAddresses: []
				});
				this.finishPoll();
			} else {
				this.patch({ error: errorFromCause(exit.cause), polling: false });
				this.finishFailedPoll();
			}
		});
	}

	private setRdlSource(source: string, fileName: string): void {
		const result = Effect.runSync(Effect.either(parseSystemRdl(source)));
		if (Either.isLeft(result))
			this.patch({ rdlSource: source, rdlFileName: fileName, error: result.left });
		else
			this.patch({
				rdlSource: source,
				rdlFileName: fileName,
				registerMap: result.right,
				error: null
			});
		this.persist();
	}
}
