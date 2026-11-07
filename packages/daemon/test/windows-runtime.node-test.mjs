import assert from "node:assert/strict";
import test from "node:test";
import { resolveWindowsEngram } from "../src/windows-runtime.ts";

const runtime = "C:\\Program Files\\Gentle Dot\\runtime";
const home = "C:\\Users\\Example";
const go = `${home}\\go\\bin\\engram.exe`;
const appData = `${home}\\AppData\\Local\\engram\\bin\\engram.exe`;
const local = `${home}\\.local\\bin\\engram.exe`;
const packaged = `${runtime}\\bin\\engram.exe`;
const resolve = (env, files) => resolveWindowsEngram(env, runtime, {
	isFile: (path) => files.includes(path),
});

test("Windows Engram discovers the AppData install between Go and .local", () => {
	const env = { USERPROFILE: home };
	assert.equal(resolve(env, [appData, local, packaged]), appData);
	assert.equal(resolve(env, [go, appData, local, packaged]), go);
	assert.equal(resolve(env, [local, packaged]), local);
	assert.equal(resolve(env, [packaged]), packaged);
});

test("Windows Engram retains inherited PATH and case-insensitive explicit override precedence", () => {
	const inherited = "D:\\Tools\\engram.exe";
	const explicit = "E:\\Memory\\ENGRAM.EXE";
	const env = { userprofile: home, Path: 'relative;"D:\\Tools"', engram_bin: explicit };
	assert.equal(resolve(env, [explicit, inherited, appData]), explicit);
	assert.equal(resolve({ ...env, engram_bin: undefined }, [inherited, appData]), inherited);
	for (const invalid of ["/tmp/engram.exe", "C:engram.exe", "C:\\Tools\\engram.cmd", explicit]) {
		assert.throws(() => resolve({ ENGRAM_BIN: invalid }, [packaged]), /readable absolute Windows .exe/);
	}
	assert.throws(() => resolve({ USERPROFILE: "relative" }, []), /Engram is missing/);
});
