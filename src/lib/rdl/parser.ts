import { Effect } from 'effect';
import type {
	EnumValue,
	RdlEnum,
	RdlWarning,
	Register,
	RegisterField,
	RegisterMap,
	SourceLocation
} from './types';
import { RdlError } from './types';

type TokenKind = 'identifier' | 'number' | 'string' | 'symbol' | 'eof';

type Token = SourceLocation & {
	readonly kind: TokenKind;
	readonly text: string;
};

type PropertyValue = string | number;
type Properties = Record<string, PropertyValue>;

type PendingField = Omit<RegisterField, 'reset' | 'encode'> & {
	readonly resetValue?: PropertyValue;
	readonly encodeName?: string;
	readonly enumScope: ReadonlyMap<string, RdlEnum>;
};

type PendingRegister = Omit<Register, 'reset' | 'fields'> & {
	readonly resetValue?: PropertyValue;
	readonly fields: readonly PendingField[];
};

class ParseFailure extends Error {
	constructor(
		message: string,
		readonly line: number,
		readonly column: number
	) {
		super(message);
	}
}

function isIdentifierStart(character: string): boolean {
	return (
		(character >= 'a' && character <= 'z') ||
		(character >= 'A' && character <= 'Z') ||
		character === '_'
	);
}

function isIdentifierPart(character: string): boolean {
	return isIdentifierStart(character) || (character >= '0' && character <= '9');
}

function isNumberPart(character: string): boolean {
	return isIdentifierPart(character) || character === "'";
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let offset = 0;
	let line = 1;
	let column = 1;

	const advance = (): string => {
		const character = source[offset++] ?? '';
		if (character === '\n') {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
		return character;
	};

	while (offset < source.length) {
		const character = source[offset];
		if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
			advance();
			continue;
		}

		if (character === '/' && source[offset + 1] === '/') {
			while (offset < source.length && advance() !== '\n') {
				// Consume the comment.
			}
			continue;
		}

		if (character === '/' && source[offset + 1] === '*') {
			const startLine = line;
			const startColumn = column;
			advance();
			advance();
			while (offset < source.length && !(source[offset] === '*' && source[offset + 1] === '/')) {
				advance();
			}
			if (offset >= source.length) {
				throw new ParseFailure('Unterminated block comment', startLine, startColumn);
			}
			advance();
			advance();
			continue;
		}

		const startLine = line;
		const startColumn = column;
		if (character === '"') {
			advance();
			let value = '';
			let closed = false;
			while (offset < source.length) {
				const next = advance();
				if (next === '"') {
					closed = true;
					break;
				}
				if (next === '\\') {
					const escaped = advance();
					if (escaped === 'n') value += '\n';
					else if (escaped === 'r') value += '\r';
					else if (escaped === 't') value += '\t';
					else value += escaped;
				} else {
					value += next;
				}
			}
			if (!closed) throw new ParseFailure('Unterminated string', startLine, startColumn);
			tokens.push({ kind: 'string', text: value, line: startLine, column: startColumn });
			continue;
		}

		if (isIdentifierStart(character)) {
			let text = '';
			while (offset < source.length && isIdentifierPart(source[offset])) text += advance();
			tokens.push({ kind: 'identifier', text, line: startLine, column: startColumn });
			continue;
		}

		if (character >= '0' && character <= '9') {
			let text = '';
			while (offset < source.length && isNumberPart(source[offset])) text += advance();
			tokens.push({ kind: 'number', text, line: startLine, column: startColumn });
			continue;
		}

		if ('{}[]:;=@,.'.includes(character)) {
			tokens.push({ kind: 'symbol', text: advance(), line: startLine, column: startColumn });
			continue;
		}

		throw new ParseFailure(`Unexpected character ${JSON.stringify(character)}`, line, column);
	}

	tokens.push({ kind: 'eof', text: '', line, column });
	return tokens;
}

function numericValue(token: Token): number {
	const text = token.text.split('_').join('');
	const apostrophe = text.indexOf("'");
	let value: number;
	if (apostrophe >= 0) {
		let encoded = text.slice(apostrophe + 1);
		if (encoded[0]?.toLowerCase() === 's') encoded = encoded.slice(1);
		const baseCode = encoded[0]?.toLowerCase();
		const base = baseCode === 'h' ? 16 : baseCode === 'b' ? 2 : baseCode === 'o' ? 8 : 10;
		value = Number.parseInt(encoded.slice(1), base);
	} else if (text.startsWith('0x') || text.startsWith('0X')) {
		value = Number.parseInt(text.slice(2), 16);
	} else if (text.startsWith('0b') || text.startsWith('0B')) {
		value = Number.parseInt(text.slice(2), 2);
	} else {
		value = Number.parseInt(text, 10);
	}
	if (!Number.isSafeInteger(value)) {
		throw new ParseFailure(`Invalid number '${token.text}'`, token.line, token.column);
	}
	return value;
}

class Parser {
	private index = 0;
	private readonly warnings: RdlWarning[] = [];
	private readonly enums = new Map<string, RdlEnum>();
	private readonly pendingRegisters: PendingRegister[] = [];
	private mapName = '';
	private mapProperties: Properties = {};
	private defaults: Properties = {};

	constructor(private readonly tokens: readonly Token[]) {}

	parse(): RegisterMap {
		while (!this.at('eof')) {
			if (this.atText('property')) this.skipPropertyDeclaration();
			else if (this.atText('enum')) this.parseEnum();
			else if (this.atText('addrmap')) this.parseAddressMap();
			else this.skipUnsupported('top-level construct');
		}
		if (!this.mapName) this.fail(this.current(), 'Expected an addrmap declaration');

		const registers = this.pendingRegisters
			.filter((register) => register.address >= 0 && register.address <= 0xff)
			.map((register): Register => ({
				name: register.name,
				displayName: register.displayName,
				description: register.description,
				address: register.address,
				width: register.width,
				softwareAccess: register.softwareAccess,
				reset: this.resolveReset(register.resetValue, undefined, this.enums),
				fields: register.fields.map((field): RegisterField => ({
					name: field.name,
					displayName: field.displayName,
					description: field.description,
					lowBit: field.lowBit,
					highBit: field.highBit,
					width: field.width,
					mask: field.mask,
					softwareAccess: field.softwareAccess,
					reset: this.resolveReset(field.resetValue, field.encodeName, field.enumScope),
					encode: field.encodeName ? field.enumScope.get(field.encodeName) : undefined
				}))
			}))
			.sort((left, right) => left.address - right.address);

		return {
			name: this.mapName,
			displayName: this.stringProperty(this.mapProperties, 'name'),
			description: this.stringProperty(this.mapProperties, 'desc'),
			addressWidth: 8,
			registers,
			warnings: this.warnings
		};
	}

	private parseAddressMap(): void {
		const declaration = this.take();
		if (this.mapName) {
			this.warning(declaration, 'unsupported', 'Only one addrmap is supported');
			this.skipThroughDeclaration();
			return;
		}
		this.mapName = this.expectKind('identifier', 'Expected addrmap name').text;
		this.expectText('{');
		while (!this.atText('}') && !this.at('eof')) {
			if (this.atText('default')) this.parseDefault(this.defaults);
			else if (this.atText('enum')) this.parseEnum();
			else if (this.atText('reg')) this.parseRegister();
			else if (this.atText('property')) this.skipPropertyDeclaration();
			else if (this.isPropertyAssignment()) Object.assign(this.mapProperties, this.parseProperty());
			else this.skipUnsupported('addrmap construct');
		}
		this.expectText('}');
		if (this.current().kind === 'identifier') this.take();
		this.takeIf(';');
	}

	private parseDefault(defaults: Properties, allowHardware = false): void {
		const token = this.take();
		const component = this.atText('field') || this.atText('reg') ? this.take().text : undefined;
		const name = this.expectKind('identifier', 'Expected default property name').text;
		this.expectText('=');
		const value = this.parseValue();
		this.expectText(';');
		if (component && component !== 'field') {
			this.warning(token, 'unsupported', `Component default '${component}' is not supported`);
			return;
		}
		if (name === 'sw' || name === 'reset') defaults[name] = value;
		else if (name === 'hw' && allowHardware) return;
		else if (name === 'regwidth' && value !== 8) {
			this.warning(token, 'unsupported', 'Only an 8-bit regwidth is supported');
		} else if (name !== 'regwidth') {
			this.warning(token, 'unsupported', `Default property '${name}' is not supported`);
		}
	}

	private parseRegister(): void {
		const declaration = this.take();
		this.expectText('{');
		const properties: Properties = {};
		const localDefaults: Properties = { ...this.defaults };
		const localEnums = new Map(this.enums);
		const fields: PendingField[] = [];
		while (!this.atText('}') && !this.at('eof')) {
			if (this.atText('default')) this.parseDefault(localDefaults, true);
			else if (this.atText('enum')) this.parseEnum(localEnums);
			else if (this.atText('field')) fields.push(this.parseField(localDefaults, localEnums));
			else if (this.isPropertyAssignment()) Object.assign(properties, this.parseProperty());
			else this.skipUnsupported('register construct');
		}
		this.expectText('}');
		const name = this.expectKind('identifier', 'Expected register instance name').text;
		if (!this.takeIf('@')) {
			this.warning(declaration, 'unsupported', `Register '${name}' has no explicit address`);
			this.skipUntil(';');
			this.takeIf(';');
			return;
		}
		const addressToken = this.expectKind('number', 'Expected register address');
		const address = numericValue(addressToken);
		this.expectText(';');
		if (address > 0xff) {
			this.warning(
				addressToken,
				'out-of-range',
				`Register '${name}' is outside address range 0x00..0xFF`
			);
		}
		this.pendingRegisters.push({
			name,
			displayName: this.stringProperty(properties, 'name'),
			description: this.stringProperty(properties, 'desc'),
			address,
			width: 8,
			softwareAccess: this.propertyText(properties, 'sw') ?? this.propertyText(localDefaults, 'sw'),
			resetValue: properties.reset,
			fields
		});
	}

	private parseField(defaults: Properties, enumScope: ReadonlyMap<string, RdlEnum>): PendingField {
		const declaration = this.take();
		const properties: Properties = {};
		if (this.takeIf('{')) {
			while (!this.atText('}') && !this.at('eof')) {
				if (this.isPropertyAssignment()) Object.assign(properties, this.parseProperty());
				else this.skipUnsupported('field construct');
			}
			this.expectText('}');
		}
		const name = this.expectKind('identifier', 'Expected field instance name').text;
		let lowBit = 0;
		let highBit = 0;
		if (this.takeIf('[')) {
			highBit = numericValue(this.expectKind('number', 'Expected field bit'));
			if (this.takeIf(':')) lowBit = numericValue(this.expectKind('number', 'Expected low bit'));
			else lowBit = highBit;
			this.expectText(']');
		} else {
			this.warning(declaration, 'unsupported', `Field '${name}' has no explicit bit range`);
		}
		this.expectText(';');
		if (lowBit > highBit) [lowBit, highBit] = [highBit, lowBit];
		if (highBit > 7) {
			this.warning(declaration, 'out-of-range', `Field '${name}' extends beyond an 8-bit register`);
		}
		const width = highBit - lowBit + 1;
		const mask = highBit < 32 ? ((2 ** width - 1) << lowBit) >>> 0 : 0xffffffff;
		return {
			name,
			displayName: this.stringProperty(properties, 'name'),
			description: this.stringProperty(properties, 'desc'),
			lowBit,
			highBit,
			width,
			mask,
			softwareAccess: this.propertyText(properties, 'sw') ?? this.propertyText(defaults, 'sw'),
			resetValue: properties.reset ?? defaults.reset,
			encodeName: this.propertyText(properties, 'encode'),
			enumScope
		};
	}

	private parseEnum(target = this.enums): void {
		this.take();
		const name = this.expectKind('identifier', 'Expected enum name').text;
		this.expectText('{');
		const values: EnumValue[] = [];
		while (!this.atText('}') && !this.at('eof')) {
			const member = this.expectKind('identifier', 'Expected enum member');
			this.expectText('=');
			const value = numericValue(this.expectKind('number', 'Expected enum value'));
			const properties: Properties = {};
			if (this.takeIf('{')) {
				while (!this.atText('}') && !this.at('eof')) {
					if (this.isPropertyAssignment()) Object.assign(properties, this.parseProperty());
					else this.skipUnsupported('enum member construct');
				}
				this.expectText('}');
			}
			this.expectText(';');
			values.push({
				name: member.text,
				value,
				displayName: this.stringProperty(properties, 'name'),
				description: this.stringProperty(properties, 'desc')
			});
		}
		this.expectText('}');
		this.takeIf(';');
		target.set(name, { name, values });
	}

	private parseProperty(): Properties {
		const name = this.take().text;
		this.expectText('=');
		const value = this.parseValue();
		this.expectText(';');
		return { [name]: value };
	}

	private parseValue(): PropertyValue {
		const token = this.current();
		if (token.kind === 'number') {
			this.take();
			return numericValue(token);
		}
		if (token.kind === 'string') {
			this.take();
			let value = token.text;
			while (this.current().kind === 'string') value += this.take().text;
			return value;
		}
		if (token.kind === 'identifier') {
			let value = this.take().text;
			while (this.atText('.') || this.atText(':')) {
				if (this.takeIf(':')) this.expectText(':');
				else this.take();
				value += `.${this.expectKind('identifier', 'Expected reference name').text}`;
			}
			return value;
		}
		this.fail(token, 'Expected property value');
	}

	private resolveReset(
		value: PropertyValue | undefined,
		enumName: string | undefined,
		enumScope: ReadonlyMap<string, RdlEnum>
	): number | undefined {
		if (typeof value === 'number' || value === undefined) return value;
		const pieces = value.split('.');
		const memberName = pieces[pieces.length - 1];
		const targetEnum =
			pieces.length > 1 ? enumScope.get(pieces[pieces.length - 2]) : enumScope.get(enumName ?? '');
		return targetEnum?.values.find((member) => member.name === memberName)?.value;
	}

	private skipPropertyDeclaration(): void {
		this.take();
		this.skipThroughDeclaration();
	}

	private skipUnsupported(label: string): void {
		const token = this.current();
		this.warning(token, 'unsupported', `Unsupported ${label} '${token.text}'`);
		this.skipThroughDeclaration();
	}

	private skipThroughDeclaration(): void {
		let depth = 0;
		while (!this.at('eof')) {
			const token = this.take();
			if (token.text === '{') depth += 1;
			else if (token.text === '}') {
				if (depth === 0) {
					this.index -= 1;
					return;
				}
				depth -= 1;
				if (depth === 0) {
					this.takeIf(';');
					return;
				}
			} else if (token.text === ';' && depth === 0) return;
		}
	}

	private skipUntil(text: string): void {
		while (!this.atText(text) && !this.at('eof')) this.take();
	}

	private isPropertyAssignment(): boolean {
		return this.current().kind === 'identifier' && this.tokens[this.index + 1]?.text === '=';
	}

	private propertyText(properties: Properties, name: string): string | undefined {
		const value = properties[name];
		return typeof value === 'string' ? value : undefined;
	}

	private stringProperty(properties: Properties, name: string): string | undefined {
		return this.propertyText(properties, name);
	}

	private warning(token: Token, code: RdlWarning['code'], message: string): void {
		this.warnings.push({ code, message, line: token.line, column: token.column });
	}

	private current(): Token {
		return this.tokens[this.index];
	}

	private at(kind: TokenKind): boolean {
		return this.current().kind === kind;
	}

	private atText(text: string): boolean {
		return this.current().text === text;
	}

	private take(): Token {
		return this.tokens[this.index++];
	}

	private takeIf(text: string): boolean {
		if (!this.atText(text)) return false;
		this.take();
		return true;
	}

	private expectText(text: string): Token {
		const token = this.current();
		if (!this.takeIf(text)) this.fail(token, `Expected '${text}'`);
		return token;
	}

	private expectKind(kind: TokenKind, message: string): Token {
		const token = this.current();
		if (token.kind !== kind) this.fail(token, message);
		return this.take();
	}

	private fail(token: Token, message: string): never {
		throw new ParseFailure(message, token.line, token.column);
	}
}

export function parseSystemRdl(source: string): Effect.Effect<RegisterMap, RdlError> {
	return Effect.try({
		try: () => new Parser(tokenize(source)).parse(),
		catch: (error) => {
			if (error instanceof ParseFailure) {
				return new RdlError({ message: error.message, line: error.line, column: error.column });
			}
			return new RdlError({
				message: error instanceof Error ? error.message : 'Unknown parser error',
				line: 1,
				column: 1
			});
		}
	});
}
