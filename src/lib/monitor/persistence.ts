import { Data, Effect } from 'effect';
import {
	isSoftwareAccess,
	type Register,
	type RegisterField,
	type RegisterMap
} from '$lib/rdl/types';

const STORAGE_KEY = 'regmon.monitor.v1';

export const UART_POLL_INTERVALS = [250, 500, 1_000, 2_000, 5_000] as const;
export const OGP_POLL_INTERVALS = [5_000, 10_000, 30_000, 60_000] as const;
export const DEFAULT_UART_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_OGP_POLL_INTERVAL_MS = 10_000;

export interface MonitorSettings {
	readonly mode: 'uart' | 'ogp';
	readonly selectedPortId: string | null;
	readonly host: string;
	readonly port: number;
	readonly slot: number;
	readonly forceConnect: boolean;
	readonly uartIntervalMs: number;
	readonly ogpIntervalMs: number;
	readonly watchlist: readonly number[];
	readonly filter: string;
	readonly rdlSource: string;
	readonly rdlFileName: string;
	readonly registerMap: RegisterMap | null;
}

interface LegacySettings extends Partial<MonitorSettings> {
	readonly intervalMs?: unknown;
}

function integerInRange(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number
): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.max(minimum, Math.min(maximum, Math.round(value)))
		: fallback;
}

function supportedInterval(value: unknown, values: readonly number[], fallback: number): number {
	const interval =
		typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
	return values.includes(interval) ? interval : fallback;
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function isOptionalReset(value: unknown, maximum: number): boolean {
	return (
		value === undefined ||
		(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum)
	);
}

function isRegisterField(value: unknown): value is RegisterField {
	if (typeof value !== 'object' || value === null) return false;
	const field = value as Partial<RegisterField>;
	if (
		!Number.isInteger(field.lowBit) ||
		!Number.isInteger(field.highBit) ||
		!Number.isInteger(field.width) ||
		!Number.isInteger(field.mask)
	) {
		return false;
	}
	const lowBit = field.lowBit as number;
	const highBit = field.highBit as number;
	const width = field.width as number;
	const mask = field.mask as number;
	const maximum = 2 ** width - 1;
	return (
		typeof field.name === 'string' &&
		isOptionalString(field.displayName) &&
		isOptionalString(field.description) &&
		lowBit >= 0 &&
		highBit <= 7 &&
		lowBit <= highBit &&
		width === highBit - lowBit + 1 &&
		mask === maximum << lowBit &&
		(field.softwareAccess === undefined || isSoftwareAccess(field.softwareAccess)) &&
		isOptionalReset(field.reset, maximum) &&
		(field.encode === undefined ||
			(typeof field.encode === 'object' &&
				field.encode !== null &&
				typeof field.encode.name === 'string' &&
				Array.isArray(field.encode.values) &&
				field.encode.values.every(
					(entry) =>
						typeof entry === 'object' &&
						entry !== null &&
						typeof entry.name === 'string' &&
						Number.isInteger(entry.value) &&
						entry.value >= 0 &&
						entry.value <= maximum &&
						isOptionalString(entry.displayName) &&
						isOptionalString(entry.description)
				)))
	);
}

function isRegister(value: unknown): value is Register {
	if (typeof value !== 'object' || value === null) return false;
	const register = value as Partial<Register>;
	return (
		typeof register.name === 'string' &&
		isOptionalString(register.displayName) &&
		isOptionalString(register.description) &&
		Number.isInteger(register.address) &&
		register.address! >= 0 &&
		register.address! <= 0xff &&
		register.width === 8 &&
		(register.softwareAccess === undefined || isSoftwareAccess(register.softwareAccess)) &&
		isOptionalReset(register.reset, 0xff) &&
		Array.isArray(register.fields) &&
		register.fields.every(isRegisterField)
	);
}

function isWarning(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const warning = value as Record<string, unknown>;
	return (
		(warning.code === 'unsupported' ||
			warning.code === 'out-of-range' ||
			warning.code === 'invalid-value') &&
		typeof warning.message === 'string' &&
		Number.isInteger(warning.line) &&
		(warning.line as number) >= 1 &&
		Number.isInteger(warning.column) &&
		(warning.column as number) >= 1
	);
}

function isRegisterMap(value: unknown): value is RegisterMap {
	if (typeof value !== 'object' || value === null) return false;
	const map = value as Partial<RegisterMap>;
	const addresses = new Set<number>();
	return (
		typeof map.name === 'string' &&
		isOptionalString(map.displayName) &&
		isOptionalString(map.description) &&
		map.addressWidth === 8 &&
		Array.isArray(map.registers) &&
		map.registers.every((register) => {
			if (!isRegister(register) || addresses.has(register.address)) return false;
			addresses.add(register.address);
			return true;
		}) &&
		Array.isArray(map.warnings) &&
		map.warnings.every(isWarning)
	);
}

export function normalizeSettings(value: LegacySettings): MonitorSettings {
	const mode = value.mode === 'ogp' ? 'ogp' : 'uart';
	const legacyUart = mode === 'uart' ? value.intervalMs : undefined;
	const legacyOgp = mode === 'ogp' ? value.intervalMs : undefined;
	const selectedPortId =
		typeof value.selectedPortId === 'string' && value.selectedPortId.length <= 1_024
			? value.selectedPortId || null
			: null;
	const watchlist = Array.isArray(value.watchlist)
		? [
				...new Set(
					value.watchlist.filter(
						(address): address is number =>
							typeof address === 'number' &&
							Number.isInteger(address) &&
							address >= 0 &&
							address <= 0xff
					)
				)
			].sort((left, right) => left - right)
		: [];

	return {
		mode,
		selectedPortId,
		host: typeof value.host === 'string' ? value.host.slice(0, 253) : '',
		port: integerInRange(value.port, 5_253, 1, 65_535),
		slot: integerInRange(value.slot, 1, 1, 20),
		forceConnect: value.forceConnect === true,
		uartIntervalMs: supportedInterval(
			value.uartIntervalMs ?? legacyUart,
			UART_POLL_INTERVALS,
			DEFAULT_UART_POLL_INTERVAL_MS
		),
		ogpIntervalMs: supportedInterval(
			value.ogpIntervalMs ?? legacyOgp,
			OGP_POLL_INTERVALS,
			DEFAULT_OGP_POLL_INTERVAL_MS
		),
		watchlist,
		filter: typeof value.filter === 'string' ? value.filter : '',
		rdlSource: typeof value.rdlSource === 'string' ? value.rdlSource : '',
		rdlFileName: typeof value.rdlFileName === 'string' ? value.rdlFileName : '',
		registerMap: isRegisterMap(value.registerMap) ? value.registerMap : null
	};
}

export class PersistenceError extends Data.TaggedError('PersistenceError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export function loadSettings(storage: Storage): Effect.Effect<MonitorSettings, PersistenceError> {
	return Effect.try({
		try: () => {
			const value = storage.getItem(STORAGE_KEY);
			const parsed: unknown = value ? JSON.parse(value) : {};
			return normalizeSettings(
				typeof parsed === 'object' && parsed !== null ? (parsed as LegacySettings) : {}
			);
		},
		catch: (cause) => new PersistenceError({ message: 'Could not load monitor settings', cause })
	});
}

export function saveSettings(
	storage: Storage,
	settings: MonitorSettings
): Effect.Effect<void, PersistenceError> {
	return Effect.try({
		try: () => storage.setItem(STORAGE_KEY, JSON.stringify(settings)),
		catch: (cause) => new PersistenceError({ message: 'Could not save monitor settings', cause })
	});
}
