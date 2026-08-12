#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const SYNC = Buffer.from([0xba, 0xd2, 0xac, 0xe5]);
const HEADER_LENGTH = 9;
const MAX_CONTENT_LENGTH = 8192;
const CLIENT_ADDRESS = 0x00;
const PRINT_ADDRESS = 0x01;
const FRAME_CONTROLLER_ADDRESS = 0x10;

function usage() {
	console.log(`Usage: bun run mock:ogp [options]

Options:
  --host <address>       Listen address (default: 127.0.0.1)
  --port <number>        TCP port (default: 5253)
  --slot <number>        Mock card slot, 1 through 20 (default: 1)
  --start-id <hex>       First dump ID (default: 00)
  --omit-offset <hex>    Omit 00, 40, 80, or c0 to test retries
  --out-of-order         Send dump records in reverse order
  --prints-before-ack    Send print records before the command acknowledgment
  --help                 Show this help`);
}

function fail(message) {
	console.error(`mock-ogp-device: ${message}`);
	process.exit(1);
}

function parseInteger(value, name, minimum, maximum, radix = 10) {
	if (value === undefined || !new RegExp(radix === 16 ? '^[0-9a-fA-F]+$' : '^\\d+$').test(value)) {
		fail(`${name} must be an integer`);
	}
	const parsed = Number.parseInt(value, radix);
	if (parsed < minimum || parsed > maximum) {
		fail(`${name} must be ${minimum} through ${maximum}`);
	}
	return parsed;
}

function parseOptions(args) {
	const options = {
		host: '127.0.0.1',
		port: 5253,
		slot: 1,
		startId: 0,
		omitOffset: null,
		outOfOrder: false,
		printsBeforeAck: false
	};

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		switch (argument) {
			case '--host':
				options.host = args[++index] ?? fail('--host needs a value');
				break;
			case '--port':
				options.port = parseInteger(args[++index], '--port', 1, 65535);
				break;
			case '--slot':
				options.slot = parseInteger(args[++index], '--slot', 1, 20);
				break;
			case '--start-id':
				options.startId = parseInteger(args[++index], '--start-id', 0, 255, 16);
				break;
			case '--omit-offset': {
				const offset = parseInteger(args[++index], '--omit-offset', 0, 255, 16);
				if (![0x00, 0x40, 0x80, 0xc0].includes(offset)) {
					fail('--omit-offset must be 00, 40, 80, or c0');
				}
				options.omitOffset = offset;
				break;
			}
			case '--out-of-order':
				options.outOfOrder = true;
				break;
			case '--prints-before-ack':
				options.printsBeforeAck = true;
				break;
			case '--help':
				usage();
				process.exit(0);
			default:
				fail(`unknown option: ${argument}`);
		}
	}

	return options;
}

function loadRegisters() {
	const text = readFileSync(new URL('../examples/example_output.txt', import.meta.url), 'utf8');
	const registers = [];
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^[0-9A-Fa-f]{2}:\s+((?:[0-9A-Fa-f]{2}\s*){16})$/);
		if (match)
			registers.push(
				...match[1]
					.trim()
					.split(/\s+/)
					.map((value) => Number.parseInt(value, 16))
			);
	}
	if (registers.length !== 256)
		fail('examples/example_output.txt does not contain 256 register bytes');
	return Buffer.from(registers);
}

function encodeFrame(source, destination, messageType, content) {
	const header = Buffer.alloc(HEADER_LENGTH);
	SYNC.copy(header);
	header[4] = source;
	header[5] = destination;
	header[6] = messageType;
	header.writeUInt16BE(content.length, 7);
	return Buffer.concat([header, content]);
}

function takeFrames(state, bytes) {
	state.buffer = Buffer.concat([state.buffer, bytes]);
	const frames = [];

	while (true) {
		const syncIndex = state.buffer.indexOf(SYNC);
		if (syncIndex < 0) {
			state.buffer = state.buffer.subarray(Math.max(0, state.buffer.length - SYNC.length + 1));
			break;
		}
		if (syncIndex > 0) state.buffer = state.buffer.subarray(syncIndex);
		if (state.buffer.length < HEADER_LENGTH) break;

		const contentLength = state.buffer.readUInt16BE(7);
		if (contentLength > MAX_CONTENT_LENGTH) {
			state.buffer = state.buffer.subarray(SYNC.length);
			continue;
		}
		const frameLength = HEADER_LENGTH + contentLength;
		if (state.buffer.length < frameLength) break;
		frames.push({
			source: state.buffer[4],
			destination: state.buffer[5],
			messageType: state.buffer[6],
			content: state.buffer.subarray(HEADER_LENGTH, frameLength)
		});
		state.buffer = state.buffer.subarray(frameLength);
	}

	return frames;
}

function isHandshake(frame) {
	return (
		frame.source === CLIENT_ADDRESS &&
		frame.destination === FRAME_CONTROLLER_ADDRESS &&
		frame.messageType === 0x4a &&
		frame.content.length === 8 &&
		frame.content[0] === 0 &&
		frame.content.readUInt16BE(1) === 0xff03 &&
		frame.content[3] === 4 &&
		(frame.content.readUInt16BE(4) === 0 || frame.content.readUInt16BE(4) === 1) &&
		frame.content.readUInt16BE(6) === 0
	);
}

function printFrame(cardAddress, dumpId, offset, registers) {
	const values = registers.subarray(offset, offset + 64).toString('hex');
	const record = Buffer.from(
		`regmon${dumpId.toString(16).padStart(2, '0')}${offset.toString(16).padStart(2, '0')}${values}\0`,
		'ascii'
	);
	return encodeFrame(cardAddress, PRINT_ADDRESS, 0x00, record);
}

const options = parseOptions(process.argv.slice(2));
const registers = loadRegisters();
const cardAddress = FRAME_CONTROLLER_ADDRESS + options.slot;
let nextDumpId = options.startId;
const clients = new Set();

const server = createServer((socket) => {
	const peer = `${socket.remoteAddress}:${socket.remotePort}`;
	const decoder = { buffer: Buffer.alloc(0) };
	clients.add(socket);
	console.log(`[connect] ${peer}`);

	socket.setNoDelay(true);
	socket.on('data', (bytes) => {
		for (const frame of takeFrames(decoder, bytes)) {
			if (isHandshake(frame)) {
				const force = frame.content.readUInt16BE(4) === 1;
				socket.write(
					encodeFrame(
						FRAME_CONTROLLER_ADDRESS,
						CLIENT_ADDRESS,
						0xca,
						Buffer.from([0, 0xff, 0x03, 2, 0, 1])
					)
				);
				console.log(`[handshake] accepted ${force ? 'force' : 'normal'} connection`);
				continue;
			}

			if (
				frame.source === CLIENT_ADDRESS &&
				frame.destination === cardAddress &&
				frame.messageType === 0x44 &&
				frame.content.equals(Buffer.from('regmon\0'))
			) {
				const dumpId = nextDumpId;
				nextDumpId = (nextDumpId + 1) & 0xff;
				let offsets = [0x00, 0x40, 0x80, 0xc0].filter((offset) => offset !== options.omitOffset);
				if (options.outOfOrder) offsets = offsets.reverse();
				const prints = offsets.map((offset) => printFrame(cardAddress, dumpId, offset, registers));
				const acknowledgment = encodeFrame(cardAddress, CLIENT_ADDRESS, 0xc4, Buffer.from([0]));
				const responses = options.printsBeforeAck
					? [...prints, acknowledgment]
					: [acknowledgment, ...prints];
				socket.write(Buffer.concat(responses));
				console.log(
					`[scan] dump ${dumpId.toString(16).padStart(2, '0')} sent ${offsets.length}/4 records`
				);
				continue;
			}

			console.log(
				`[ignore] src=0x${frame.source.toString(16).padStart(2, '0')} dst=0x${frame.destination.toString(16).padStart(2, '0')} type=0x${frame.messageType.toString(16).padStart(2, '0')} length=${frame.content.length}`
			);
		}
	});
	socket.on('close', () => {
		clients.delete(socket);
		console.log(`[disconnect] ${peer}`);
	});
	socket.on('error', (error) => console.error(`[client error] ${error.message}`));
});

server.on('error', (error) => fail(error.message));
server.listen(options.port, options.host, () => {
	console.log(
		`Mock OpenGear device listening on ${options.host}:${options.port}, slot ${options.slot}`
	);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
		for (const socket of clients) socket.destroy();
	});
}
