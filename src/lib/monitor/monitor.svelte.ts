import { Cause, Effect, Either, Fiber } from 'effect';
import mockOutput from '../../../examples/example_output.txt?raw';
import { parseSystemRdl } from '$lib/rdl/parser';
import type { RdlError, RegisterMap } from '$lib/rdl/types';
import { RegisterDumpAssembler } from '$lib/registers/dump';
import type { RegisterSnapshot } from '$lib/registers/types';
import {
	choosePort,
	getBrowserSerial,
	listAuthorizedPorts,
	openSerialPort,
	type SerialConnection,
	type SerialFailure
} from '$lib/serial';
import { loadSettings, saveSettings, type MonitorSettings, PersistenceError } from './persistence';
import {
	DEFAULT_RESPONSE_TIMEOUT_MS,
	RawLogBuffer,
	requestRegisterSnapshot,
	type ProtocolFailure
} from './protocol';

export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export type ConnectionStatus = 'unsupported' | 'disconnected' | 'connecting' | 'connected';

export interface PortOption {
	readonly port: SerialPort;
	readonly info: SerialPortInfo;
}

export interface MonitorView {
	readonly status: ConnectionStatus;
	readonly ports: readonly PortOption[];
	readonly selectedPort: SerialPort | null;
	readonly paused: boolean;
	readonly polling: boolean;
	readonly intervalMs: number;
	readonly watchlist: readonly number[];
	readonly filter: string;
	readonly snapshot: RegisterSnapshot | null;
	readonly previousSnapshot: RegisterSnapshot | null;
	readonly snapshotAt: number | null;
	readonly selectedAddress: number | null;
	readonly rawLog: string;
	readonly rdlSource: string;
	readonly registerMap: RegisterMap | null;
	readonly error: MonitorFailure | null;
}

export type MonitorFailure = SerialFailure | ProtocolFailure | PersistenceError | RdlError;

export type MonitorAction =
	| { readonly type: 'refresh-ports' }
	| { readonly type: 'choose-port' }
	| { readonly type: 'select-port'; readonly port: SerialPort | null }
	| { readonly type: 'connect'; readonly port?: SerialPort }
	| { readonly type: 'disconnect' }
	| { readonly type: 'set-paused'; readonly paused: boolean }
	| { readonly type: 'refresh' }
	| { readonly type: 'set-interval'; readonly intervalMs: number }
	| { readonly type: 'set-watchlist'; readonly addresses: readonly number[] }
	| { readonly type: 'set-filter'; readonly filter: string }
	| { readonly type: 'set-rdl-source'; readonly source: string }
	| { readonly type: 'clear-rdl' }
	| { readonly type: 'select-address'; readonly address: number | null }
	| { readonly type: 'clear-log' };

const initialView: MonitorView = {
	status: 'disconnected',
	ports: [],
	selectedPort: null,
	paused: false,
	polling: false,
	intervalMs: DEFAULT_POLL_INTERVAL_MS,
	watchlist: [],
	filter: '',
	snapshot: null,
	previousSnapshot: null,
	snapshotAt: null,
	selectedAddress: null,
	rawLog: '',
	rdlSource: '',
	registerMap: null,
	error: null
};

function immutableView(view: MonitorView): MonitorView {
	return Object.freeze({
		...view,
		ports: Object.freeze([...view.ports]),
		watchlist: Object.freeze([...view.watchlist])
	});
}

function errorFromCause(cause: Cause.Cause<MonitorFailure>): MonitorFailure | null {
	return Cause.failureOption(cause).pipe((option) =>
		option._tag === 'Some' ? option.value : null
	);
}

function normalizeWatchlist(addresses: readonly number[]): readonly number[] {
	const result: number[] = [];
	for (const address of addresses) {
		if (address >= 0 && address <= 0xff && !result.includes(address)) result.push(address);
	}
	return result;
}

export class BrowserMonitor {
	private _view = $state.raw<MonitorView>(immutableView(initialView));
	private readonly rawLog = new RawLogBuffer();
	private readonly serial: Serial | undefined;
	private readonly storage: Storage | undefined;
	private connection: SerialConnection | undefined;
	private connectionFiber: Fiber.RuntimeFiber<void, never> | undefined;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private closed = false;
	private refreshQueued = false;
	private readonly serialChange = () => this.refreshPorts();

	constructor() {
		if (typeof window === 'undefined') {
			this.serial = undefined;
			this.storage = undefined;
			return;
		}

		this.serial = 'serial' in navigator ? navigator.serial : undefined;
		this.storage = window.localStorage;
		if (import.meta.env.DEV) this.loadDevelopmentFixture();

		if (!this.serial) {
			this.patch({ status: 'unsupported' });
			return;
		}

		this.serial.addEventListener('connect', this.serialChange);
		this.serial.addEventListener('disconnect', this.serialChange);
		this.restore();
		this.refreshPorts();
	}

	get view(): MonitorView {
		return this._view;
	}

	dispatch(action: MonitorAction): void {
		if (this.closed) return;
		switch (action.type) {
			case 'refresh-ports':
				this.refreshPorts();
				break;
			case 'choose-port':
				this.choosePort();
				break;
			case 'select-port':
				this.patch({ selectedPort: action.port });
				break;
			case 'connect':
				this.connect(action.port ?? this._view.selectedPort);
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
				this.patch({ intervalMs: Math.max(100, Math.round(action.intervalMs)) });
				this.persist();
				break;
			case 'set-watchlist':
				this.patch({ watchlist: normalizeWatchlist(action.addresses) });
				this.persist();
				break;
			case 'set-filter':
				this.patch({ filter: action.filter });
				this.persist();
				break;
			case 'set-rdl-source':
				this.setRdlSource(action.source);
				break;
			case 'clear-rdl':
				this.patch({ rdlSource: '', registerMap: null, error: null });
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
		this.closed = true;
		this.serial?.removeEventListener('connect', this.serialChange);
		this.serial?.removeEventListener('disconnect', this.serialChange);
		this.disconnect();
	}

	private patch(patch: Partial<MonitorView>): void {
		this._view = immutableView({ ...this._view, ...patch });
	}

	private loadDevelopmentFixture(): void {
		const assembler = new RegisterDumpAssembler();
		const snapshot = assembler.push(`${mockOutput}\n`)[0];
		if (!snapshot) return;
		this.patch({
			snapshot,
			snapshotAt: Date.now(),
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
		this.patch({
			intervalMs:
				typeof value.intervalMs === 'number' && value.intervalMs >= 100
					? value.intervalMs
					: DEFAULT_POLL_INTERVAL_MS,
			watchlist: Array.isArray(value.watchlist) ? value.watchlist : [],
			filter: typeof value.filter === 'string' ? value.filter : '',
			rdlSource: typeof value.rdlSource === 'string' ? value.rdlSource : '',
			registerMap: value.registerMap ?? null
		});
	}

	private persist(): void {
		if (!this.storage) return;
		const settings: MonitorSettings = {
			intervalMs: this._view.intervalMs,
			watchlist: this._view.watchlist,
			filter: this._view.filter,
			rdlSource: this._view.rdlSource,
			registerMap: this._view.registerMap
		};
		this.run(saveSettings(this.storage, settings));
	}

	private refreshPorts(): void {
		if (!this.serial) return;
		this.run(listAuthorizedPorts(this.serial), (ports) => {
			const selectedPort = ports.includes(this._view.selectedPort as SerialPort)
				? this._view.selectedPort
				: (ports[0] ?? null);
			this.patch({
				ports: ports.map((port) => Object.freeze({ port, info: port.getInfo() })),
				selectedPort
			});
			if (this.connection && !ports.includes(this.connection.port)) this.disconnect();
		});
	}

	private choosePort(): void {
		if (!this.serial) {
			this.run(getBrowserSerial());
			return;
		}
		const selection = choosePort(this.serial).pipe(
			Effect.catchIf(
				(error) => error.cause instanceof DOMException && error.cause.name === 'AbortError',
				() => Effect.succeed(null)
			)
		);
		this.run(selection, (port) => {
			if (!port) {
				this.patch({ error: null });
				return;
			}
			this.patch({ selectedPort: port });
			this.refreshPorts();
		});
	}

	private connect(port: SerialPort | null): void {
		if (!port || this._view.status === 'connecting' || this.connection) return;
		const generation = ++this.generation;
		this.patch({ status: 'connecting', selectedPort: port, error: null });

		const program = Effect.scoped(
			Effect.gen(this, function* () {
				const connection = yield* openSerialPort(port);
				if (this.closed || generation !== this.generation) return yield* Effect.interrupt;
				this.connection = connection;
				this.patch({ status: 'connected' });
				this.schedulePoll(0);
				return yield* Effect.never;
			})
		).pipe(
			Effect.catchAll((error) => Effect.sync(() => this.patch({ error }))),
			Effect.ensuring(
				Effect.sync(() => {
					if (generation !== this.generation) return;
					this.connection = undefined;
					this.clearPollTimer();
					this.patch({ status: this.serial ? 'disconnected' : 'unsupported', polling: false });
				})
			)
		);
		this.connectionFiber = Effect.runFork(program);
	}

	private disconnect(): void {
		this.generation += 1;
		this.clearPollTimer();
		this.connection = undefined;
		this.patch({ status: this.serial ? 'disconnected' : 'unsupported', polling: false });
		const fiber = this.connectionFiber;
		this.connectionFiber = undefined;
		if (fiber) Effect.runFork(Fiber.interrupt(fiber));
	}

	private manualRefresh(): void {
		if (!this.connection) return;
		if (this._view.polling) {
			this.refreshQueued = true;
			return;
		}
		this.clearPollTimer();
		this.poll();
	}

	private schedulePoll(delay: number): void {
		this.clearPollTimer();
		if (!this.connection || this._view.paused || this.closed) return;
		this.pollTimer = setTimeout(() => this.poll(), delay);
	}

	private clearPollTimer(): void {
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
	}

	private poll(): void {
		const connection = this.connection;
		if (!connection || this._view.polling) return;
		this.patch({ polling: true, error: null });
		const request = requestRegisterSnapshot(connection, {
			timeoutMs: DEFAULT_RESPONSE_TIMEOUT_MS,
			onRawText: (text) => this.patch({ rawLog: this.rawLog.append(text) })
		});
		void Effect.runPromiseExit(request).then((exit) => {
			if (this.closed || connection !== this.connection) return;
			let retryImmediately = false;
			if (exit._tag === 'Success') {
				this.patch({
					previousSnapshot: this._view.snapshot,
					snapshot: exit.value.slice(),
					snapshotAt: Date.now(),
					polling: false
				});
			} else {
				const error = errorFromCause(exit.cause);
				retryImmediately =
					error?._tag === 'SerialReadError' && /framing error|buffer overrun/i.test(error.message);
				this.patch({ error, polling: false });
			}

			if (this.refreshQueued) {
				this.refreshQueued = false;
				this.schedulePoll(0);
			} else {
				this.schedulePoll(retryImmediately ? 0 : this._view.intervalMs);
			}
		});
	}

	private setRdlSource(source: string): void {
		const result = Effect.runSync(Effect.either(parseSystemRdl(source)));
		if (Either.isLeft(result)) {
			this.patch({ rdlSource: source, error: result.left });
		} else {
			this.patch({ rdlSource: source, registerMap: result.right, error: null });
		}
		this.persist();
	}
}
