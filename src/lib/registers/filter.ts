import {
	REGISTER_COUNT,
	type AddressExpressionResult,
	type RegisterSnapshot,
	type RegisterValue
} from './types';

const ADDRESS_PATTERN = /^(?:0[xX])?([0-9a-fA-F]{1,2})$/;

export function parseAddressExpression(input: string): AddressExpressionResult {
	const selected = new Set<number>();
	let partStart = 0;

	for (const part of input.split(',')) {
		const leadingWhitespace = part.length - part.trimStart().length;
		const expression = part.trim();
		const position = partStart + leadingWhitespace;

		if (expression.length === 0) {
			return invalid(input, position, 'Expected an address or address range');
		}

		const rangeParts = expression.split('-');
		if (rangeParts.length > 2) {
			return invalid(input, position, `Invalid address range "${expression}"`);
		}

		const startText = rangeParts[0].trim();
		const start = parseAddress(startText);
		if (start === undefined) {
			return invalid(input, position, `Invalid address "${startText}"`);
		}

		let end = start;
		if (rangeParts.length === 2) {
			const endText = rangeParts[1].trim();
			end = parseAddress(endText) ?? -1;
			if (end < 0) {
				const endPosition = position + expression.indexOf('-') + 1;
				return invalid(input, endPosition, `Invalid address "${endText}"`);
			}
			if (start > end) {
				return invalid(input, position, `Range start must not exceed range end`);
			}
		}

		for (let address = start; address <= end; address += 1) selected.add(address);
		partStart += part.length + 1;
	}

	return { ok: true, addresses: [...selected].sort((left, right) => left - right) };
}

export function filterSnapshot(
	snapshot: RegisterSnapshot,
	addresses: Iterable<number>
): RegisterValue[] {
	const values: RegisterValue[] = [];
	for (const address of addresses) {
		if (!Number.isInteger(address) || address < 0 || address >= REGISTER_COUNT) {
			throw new RangeError(`Register address must be an integer from 0x00 through 0xFF`);
		}
		if (address >= snapshot.length) {
			throw new RangeError(
				`Snapshot does not contain address 0x${address.toString(16).padStart(2, '0')}`
			);
		}
		values.push({ address, value: snapshot[address] });
	}
	return values;
}

function parseAddress(value: string): number | undefined {
	const match = ADDRESS_PATTERN.exec(value);
	if (!match) return undefined;
	return Number.parseInt(match[1], 16);
}

function invalid(input: string, position: number, message: string): AddressExpressionResult {
	return { ok: false, error: { input, position, message } };
}
