import { REGISTER_COUNT, ROW_SIZE, type RegisterSnapshot } from './types';

const ROW_COUNT = REGISTER_COUNT / ROW_SIZE;
const ROW_PATTERN = /^\s*([0-9a-fA-F]{2}):\s*([0-9a-fA-F]{2}(?:\s+[0-9a-fA-F]{2}){15})\s*$/;

export class RegisterDumpAssembler {
	private buffer = '';
	private readonly rows = new Map<number, Uint8Array>();

	push(chunk: string): RegisterSnapshot[] {
		this.buffer += chunk;
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop() ?? '';

		const snapshots: RegisterSnapshot[] = [];
		for (const line of lines) {
			this.consumeLine(line.endsWith('\r') ? line.slice(0, -1) : line, snapshots);
		}
		return snapshots;
	}

	finish(): RegisterSnapshot[] {
		const snapshots: RegisterSnapshot[] = [];
		if (this.buffer.length > 0) {
			this.consumeLine(
				this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer,
				snapshots
			);
		}
		this.buffer = '';
		return snapshots;
	}

	reset(): void {
		this.buffer = '';
		this.rows.clear();
	}

	private consumeLine(line: string, snapshots: RegisterSnapshot[]): void {
		const match = ROW_PATTERN.exec(line);
		if (!match) return;

		const offset = Number.parseInt(match[1], 16);
		if (offset % ROW_SIZE !== 0) return;

		this.rows.set(
			offset,
			Uint8Array.from(match[2].split(/\s+/), (byte) => Number.parseInt(byte, 16))
		);

		if (this.rows.size !== ROW_COUNT) return;

		const snapshot = new Uint8Array(REGISTER_COUNT);
		for (const [rowOffset, row] of this.rows) snapshot.set(row, rowOffset);
		snapshots.push(snapshot);
		this.rows.clear();
	}
}

export function createRegisterDumpAssembler(): RegisterDumpAssembler {
	return new RegisterDumpAssembler();
}
