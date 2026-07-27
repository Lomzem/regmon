import { Data } from 'effect';

export type SourceLocation = {
	readonly line: number;
	readonly column: number;
};

export type RdlWarning = SourceLocation & {
	readonly code: 'unsupported' | 'out-of-range' | 'invalid-value';
	readonly message: string;
};

export type EnumValue = {
	readonly name: string;
	readonly value: number;
	readonly displayName?: string;
	readonly description?: string;
};

export type RdlEnum = {
	readonly name: string;
	readonly values: readonly EnumValue[];
};

export type RegisterField = {
	readonly name: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly lowBit: number;
	readonly highBit: number;
	readonly width: number;
	readonly mask: number;
	readonly softwareAccess?: string;
	readonly reset?: number;
	readonly encode?: RdlEnum;
};

export type Register = {
	readonly name: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly address: number;
	readonly width: 8;
	readonly softwareAccess?: string;
	readonly reset?: number;
	readonly fields: readonly RegisterField[];
};

export type RegisterMap = {
	readonly name: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly addressWidth: 8;
	readonly registers: readonly Register[];
	readonly warnings: readonly RdlWarning[];
};

export class RdlError extends Data.TaggedError('RdlError')<{
	readonly message: string;
	readonly line: number;
	readonly column: number;
}> {}
