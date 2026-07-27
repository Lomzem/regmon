import { Data } from 'effect';

export class SerialUnsupportedError extends Data.TaggedError('SerialUnsupportedError')<{
	readonly message: string;
}> {}

export class SerialSelectionError extends Data.TaggedError('SerialSelectionError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class SerialOpenError extends Data.TaggedError('SerialOpenError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class SerialReadError extends Data.TaggedError('SerialReadError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class SerialWriteError extends Data.TaggedError('SerialWriteError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export type SerialFailure =
	| SerialUnsupportedError
	| SerialSelectionError
	| SerialOpenError
	| SerialReadError
	| SerialWriteError;
