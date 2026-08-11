import type { RegisterMap } from '$lib/rdl/types';

interface StatusView {
	readonly status: 'unsupported' | 'disconnected' | 'connecting' | 'connected';
	readonly polling: boolean;
	readonly error: unknown;
}

export interface UnsupportedMessage {
	readonly key: string;
	readonly title: string;
	readonly detail: string;
}

export function connectionStatusLabel(view: StatusView): string {
	if (view.error) return 'Error';
	if (view.status === 'connecting') return 'Connecting...';
	if (view.polling) return 'Scanning';
	if (view.status === 'connected') return 'Connected';
	return 'Disconnected';
}

export function unsupportedTransportMessage(
	mode: 'uart' | 'ogp',
	native: boolean,
	status: StatusView['status']
): UnsupportedMessage | null {
	if (native || status !== 'unsupported') return null;
	if (mode === 'ogp') {
		return {
			key: 'ogp-desktop-only',
			title: 'TCP OGP requires the desktop app',
			detail: 'The browser preview cannot open native TCP connections. Use RegMon Desktop for OGP.'
		};
	}
	return {
		key: 'web-serial-unavailable',
		title: 'Web Serial unavailable',
		detail: 'Web Serial may be blocked by browser settings or policy. Use a Chromium-based browser.'
	};
}

export function registerMatchesFilter(
	address: number,
	value: number,
	filter: string,
	registerMap: RegisterMap | null
): boolean {
	const needle = filter.trim().toLowerCase();
	if (!needle) return true;
	const hexAddress = address.toString(16).padStart(2, '0');
	const hexValue = value.toString(16).padStart(2, '0');
	const register = registerMap?.registers.find((candidate) => candidate.address === address);
	const fields = register?.fields
		.flatMap((field) => [field.name, field.displayName, field.description])
		.filter(Boolean)
		.join(' ');
	const text = [
		`0x${hexAddress}`,
		hexAddress,
		String(address),
		`value 0x${hexValue}`,
		hexValue,
		register?.name,
		register?.displayName,
		register?.description,
		fields
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
	return text.includes(needle);
}

export function isStaleAddress(address: number, missingAddresses: readonly number[]): boolean {
	return missingAddresses.includes(address);
}

export async function copyToClipboard(
	clipboard: Pick<Clipboard, 'writeText'> | undefined,
	text: string
): Promise<'success' | 'error'> {
	try {
		if (!clipboard) throw new Error('Clipboard is unavailable');
		await clipboard.writeText(text);
		return 'success';
	} catch {
		return 'error';
	}
}

export function formatUpdateTime(timestamp: number | null): string {
	return timestamp === null
		? 'No updates yet'
		: new Intl.DateTimeFormat(undefined, {
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit'
			}).format(timestamp);
}
