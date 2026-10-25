#!/usr/bin/env node
// Local transcription server for the daemon's voice notes.
// Loads the Parakeet TDT model once, then reads one JSON request per line
// from stdin and answers one JSON result per line on stdout.
//
// Request:  {"file": "/abs/path/to/audio.(ogg|webm|wav|mp4)"}
// Response: {"text": "transcribed text"} | {"error": "reason"}
//
// Audio in any ffmpeg-readable format is converted to 16 kHz mono WAV
// before decoding. The model path defaults to the desktop app's voice
// model and can be overridden with GENTLE_DOT_VOICE_MODEL.
//
// The daemon spawns this script lazily and keeps it alive so the model
// stays warm (~1-3s per note instead of ~15s cold load).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_MODEL = path.join(
	os.homedir(),
	".local/share/dev.gentleman.gentle-dot/models/parakeet-tdt-0.6b-v3-int8",
);
const MODEL_DIR = process.env.GENTLE_DOT_VOICE_MODEL || DEFAULT_MODEL;

const SHERPA = (() => {
	try {
		return require("sherpa-onnx-node");
	} catch (error) {
		console.error(`transcriber: sherpa-onnx-node is not installed in ${__dirname}`);
		throw error;
	}
})();

const RECOGNIZER = new SHERPA.OfflineRecognizer({
	modelConfig: {
		transducer: {
			encoder: path.join(MODEL_DIR, "encoder.int8.onnx"),
			decoder: path.join(MODEL_DIR, "decoder.int8.onnx"),
			joiner: path.join(MODEL_DIR, "joiner.int8.onnx"),
		},
		tokens: path.join(MODEL_DIR, "tokens.txt"),
		numThreads: 2,
		debug: false,
	},
});

const ffmpegToWav = (input) =>
	new Promise((resolve, reject) => {
		const out = path.join(os.tmpdir(), `dot-transcribe-${process.pid}-${Date.now()}.wav`);
		const ffmpeg = spawn("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			input,
			"-ar",
			"16000",
			"-ac",
			"1",
			"-f",
			"wav",
			out,
		]);
		let stderr = "";
		ffmpeg.stderr.on("data", (chunk) => (stderr += chunk));
		ffmpeg.on("error", reject);
		ffmpeg.on("close", (code) => {
			if (code === 0) resolve(out);
			else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
		});
	});

const transcribeFile = async (file) => {
	if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) {
		throw new Error("request file is missing");
	}
	const wav = await ffmpegToWav(file);
	try {
		const wave = SHERPA.readWave(wav);
		const stream = RECOGNIZER.createStream();
		stream.acceptWaveform({
			samples: wave.samples,
			sampleRate: wave.sampleRate,
		});
		RECOGNIZER.decode(stream);
		const result = RECOGNIZER.getResult(stream);
		const text = (result?.text ? String(result.text) : "").trim();
		return text;
	} finally {
		fs.rm(wav, { force: true }, () => {});
	}
};

console.error(`transcriber: ready (model=${path.basename(MODEL_DIR)}, pid=${process.pid})`);

let buffer = "";
let pending = 0;
let stdinEnded = false;

const maybeExit = () => {
	if (stdinEnded && pending === 0) process.exit(0);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(0, index + 1);
		if (!line) continue;
		let request;
		try {
			request = JSON.parse(line);
		} catch {
			process.stdout.write(`${JSON.stringify({ error: "malformed request" })}\n`);
			continue;
		}
		pending += 1;
		transcribeFile(request.file)
			.then((text) => {
				process.stdout.write(`${JSON.stringify({ text })}\n`);
			})
			.catch((error) => {
				process.stdout.write(`${JSON.stringify({ error: String(error.message || error) })}\n`);
			})
			.finally(() => {
				pending -= 1;
				maybeExit();
			});
	}
});
process.stdin.on("end", () => {
	stdinEnded = true;
	// Drain: finish any in-flight transcription before exiting, so a
	// caller that writes a request and closes stdin still gets its answer.
	maybeExit();
});
