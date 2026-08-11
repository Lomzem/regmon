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

interface RegisterIndexCache {
	readonly registers: readonly Register[];
	readonly entries: readonly Register[];
	readonly addresses: readonly number[];
	readonly index: ReadonlyMap<number, Register>;
}

const registerIndexes = new WeakMap<RegisterMap, RegisterIndexCache>();

export function indexRegisters(registers: readonly Register[]): ReadonlyMap<number, Register> {
	const indexed = new Map<number, Register>();
	for (const register of registers) {
		if (!indexed.has(register.address)) indexed.set(register.address, register);
	}
	return indexed;
}

export function indexRegisterMap(registerMap: RegisterMap): ReadonlyMap<number, Register> {
	const cached = registerIndexes.get(registerMap);
	if (
		cached?.registers === registerMap.registers &&
		cached.entries.length === registerMap.registers.length &&
		cached.entries.every(
			(register, index) =>
				register === registerMap.registers[index] &&
				cached.addresses[index] === registerMap.registers[index].address
		)
	) {
		return cached.index;
	}
	const index = indexRegisters(registerMap.registers);
	registerIndexes.set(registerMap, {
		registers: registerMap.registers,
		entries: [...registerMap.registers],
		addresses: registerMap.registers.map((register) => register.address),
		index
	});
	return index;
}

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
	const register = indexRegisterMap(registerMap).get(address);
	return register && decodeRegister(register, byte);
}
