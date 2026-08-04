import { Data, Effect } from 'effect';
import type { RegisterMap } from '$lib/rdl/types';

const STORAGE_KEY = 'regmon.monitor.v1';

export interface MonitorSettings {
	readonly intervalMs: number;
	readonly watchlist: readonly number[];
	readonly filter: string;
	readonly rdlSource: string;
	readonly rdlFileName: string;
	readonly registerMap: RegisterMap | null;
}

export class PersistenceError extends Data.TaggedError('PersistenceError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export function loadSettings(
	storage: Storage
): Effect.Effect<Partial<MonitorSettings>, PersistenceError> {
	return Effect.try({
		try: () => {
			const value = storage.getItem(STORAGE_KEY);
			return value ? (JSON.parse(value) as Partial<MonitorSettings>) : {};
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
