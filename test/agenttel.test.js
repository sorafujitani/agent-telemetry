import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { once } from "node:events";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "agenttel-test-"));
after(() => rmSync(temp, { recursive: true, force: true }));
process.env.AGENTTEL_DIR = join(temp, "recording");
process.env.AGENTTEL_PORT = "7777";

// Pack and install the actual distributable, not a symlink to the checkout.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = JSON.parse(execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }))[0];
const prefix = join(temp, "consumer");
execFileSync(npm, ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(temp, packed.filename)], { encoding: "utf8" });
const installed = join(prefix, "node_modules", "agenttel");

test("npm package contains all runtime assets and exposes the CLI and Pi extension", () => {
	assert.deepEqual(packed.files.map((f) => f.path).sort(), ["LICENSE", "README.md", "config.js", "index.html", "index.js", "package.json", "server.js"]);
	const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
	assert.deepEqual(pkg.pi.extensions, ["./index.js"]);
	assert.equal(pkg.bin.agenttel, "./server.js");
	const cli = join(prefix, "node_modules", ".bin", process.platform === "win32" ? "agenttel.cmd" : "agenttel");
	assert.match(execFileSync(cli, ["--help"], { encoding: "utf8" }), /Usage: agenttel/);
	const invalid = spawn(process.execPath, [join(installed, "server.js")], { env: { ...process.env, AGENTTEL_PORT: "not-a-port" }, stdio: "ignore" });
	return once(invalid, "exit").then(([code]) => assert.equal(code, 1));
});

test("installed extension records lifecycle events, caps payloads, and preserves nested calls", async () => {
	const extension = (await import(pathToFileURL(join(installed, "index.js")))).default;
	const handlers = new Map(), commands = new Map(), notices = [];
	extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command), getActiveTools: () => ["bash", "read"] });
	assert.equal(typeof commands.get("agenttel").handler, "function");
	const ctx = { cwd: "/example", sessionManager: { getSessionId: () => "session" }, model: { provider: "example", id: "model" }, getContextUsage: () => ({ tokens: 42, contextWindow: 100 }), ui: { notify: (...args) => notices.push(args) } };
	const emit = (name, data) => handlers.get(name)(data, ctx);
	emit("before_agent_start", { prompt: "hello", systemPrompt: "system" });
	emit("turn_start", { turnIndex: 0 });
	emit("tool_execution_start", { toolCallId: "parent", toolName: "codemode", args: { code: "x".repeat(32001), nested: ["keep"] } });
	emit("tool_execution_start", { toolCallId: "child", parentToolCallId: "parent", toolName: "bash", args: { command: "echo hello" } });
	emit("tool_execution_end", { toolCallId: "child", parentToolCallId: "parent", toolName: "bash", result: { content: [{ type: "text", text: "hello" }] }, isError: false });
	emit("tool_execution_end", { toolCallId: "parent", toolName: "codemode", result: "y".repeat(32001), isError: true });
	emit("turn_end", { turnIndex: 0, message: { usage: { input: 1, output: 2 }, stopReason: "stop", content: [{ type: "text", text: "done" }, { type: "thinking", thinking: "reason" }] } });
	emit("agent_end", {});
	emit("session_compact", { reason: "manual" });
	emit("model_select", { model: { provider: "example", id: "new" }, previousModel: { id: "model" } });
	const file = join(process.env.AGENTTEL_DIR, "events.jsonl");
	const events = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(events.map((e) => e.type), ["run_start", "turn_start", "tool_start", "tool_start", "tool_end", "tool_end", "turn_end", "run_end", "compact", "model_select"]);
	assert.equal(events[0].sid, "session");
	assert.equal(events[0].ctx, 42);
	assert.equal(events[0].tools, 2);
	assert.deepEqual(JSON.parse(events[2].args).nested, ["keep"]);
	assert.match(JSON.parse(events[2].args).code, /truncated 1 chars/);
	assert.equal(events[4].parent, "parent");
	assert.equal(events[4].result, "hello");
	assert.equal(events[5].isError, true);
	assert.match(events[5].result, /truncated 1 chars/);
	assert.equal(events[6].thinking, "reason");
	assert.deepEqual(events[6].usage, { input: 1, output: 2 });
	if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(notices, []);

	// A recording failure must warn once without stopping the agent.
	rmSync(process.env.AGENTTEL_DIR, { recursive: true });
	writeFileSync(process.env.AGENTTEL_DIR, "not a directory");
	emit("agent_end", {});
	emit("agent_end", {});
	assert.equal(notices.length, 1);
	assert.match(notices[0][0], /unable to write telemetry/);
});

test("installed viewer replays and streams complete UTF-8 events and protects local data", { timeout: 15000 }, async (t) => {
	const socket = createServer().listen(0, "127.0.0.1");
	await once(socket, "listening");
	const port = socket.address().port;
	await new Promise((resolve) => socket.close(resolve));
	const dir = join(temp, "viewer");
	mkdirSync(dir);
	const file = join(dir, "events.jsonl");
	writeFileSync(file, '{"sid":"first","type":"run_start"}\n{"text":"');
	const child = spawn(process.execPath, [join(installed, "server.js")], { env: { ...process.env, AGENTTEL_DIR: dir, AGENTTEL_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
	const exited = once(child, "exit");
	t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
	await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error("Viewer exited before startup"); })]);
	const url = `http://127.0.0.1:${port}`;
	assert.equal(await (await fetch(url + "/ping")).text(), "agenttel");
	const page = await fetch(url);
	assert.match(await page.text(), /<html lang="en">/);
	assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
	assert.equal((await fetch(url + "/missing")).status, 404);
	const blockedHost = await new Promise((resolve, reject) => {
		const req = request(url + "/ping", { headers: { Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
		req.on("error", reject);
		req.end();
	});
	assert.equal(blockedHost, 403);
	assert.equal((await fetch(url + "/clear", { method: "POST", headers: { Origin: "https://attacker.example" } })).status, 403);
	assert.match(readFileSync(file, "utf8"), /first/);

	const abort = new AbortController();
	t.after(() => abort.abort());
	const stream = await fetch(url + "/events", { signal: abort.signal });
	assert.equal(stream.headers.get("content-type"), "text/event-stream");
	const reader = stream.body.getReader();
	let data = "";
	const until = async (needle) => {
		while (!data.includes(needle)) {
			const chunk = await reader.read();
			assert.equal(chunk.done, false);
			data += new TextDecoder().decode(chunk.value);
		}
	};
	await until("event: ready");
	assert.match(data, /data: {"sid":"first"/);
	assert.doesNotMatch(data, /data: {"text"/);
	const unicode = Buffer.from("🌍");
	appendFileSync(file, unicode.subarray(0, 2));
	await new Promise((resolve) => setTimeout(resolve, 100));
	appendFileSync(file, Buffer.concat([unicode.subarray(2), Buffer.from('"}\n')]));
	await until('data: {"text":"🌍"}');
	assert.equal((await fetch(url + "/clear", { method: "POST", headers: { Origin: url } })).status, 200);
	await until("event: clear");
	assert.equal(readFileSync(file, "utf8"), "");
	appendFileSync(file, '{"sid":"after-clear"}\n');
	await until('data: {"sid":"after-clear"}');
	abort.abort();
});
