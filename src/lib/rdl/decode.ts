import type { Register, RegisterField, RegisterMap } from './types';

export type DecodedField = {
	readonly field: RegisterField;
	readonly value: number;
	readonly enumValue?: {
		readonly name: string;
		readonly displayName?: string;
		readonly description?: string;
	};
};

export type DecodedRegister = {
	readonly register: Register;
	readonly value: number;
	readonly fields: readonly DecodedField[];
};

export function decodeRegister(register: Register, byte: number): DecodedRegister {
	const value = byte & 0xff;
	return {
		register,
		value,
		fields: register.fields.map((field) => {
			const fieldValue = (value & field.mask) >>> field.lowBit;
			const encoded = field.encode?.values.find((candidate) => candidate.value === fieldValue);
			return {
				field,
				value: fieldValue,
				enumValue: encoded && {
					name: encoded.name,
					displayName: encoded.displayName,
					description: encoded.description
				}
			};
		})
	};
}

export function decodeRegisterMap(
	registerMap: RegisterMap,
	address: number,
	byte: number
): DecodedRegister | undefined {
	const register = registerMap.registers.find((candidate) => candidate.address === address);
	return register && decodeRegister(register, byte);
}
