export const REGISTER_COUNT = 0x100;
export const ROW_SIZE = 0x10;

export type RegisterSnapshot = Uint8Array;

export interface RegisterValue {
	address: number;
	value: number;
}

export interface AddressExpressionError {
	input: string;
	message: string;
	position: number;
}

export type AddressExpressionResult =
	{ ok: true; addresses: readonly number[] } | { ok: false; error: AddressExpressionError };
