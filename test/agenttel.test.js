import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync, existsSync, realpathSync, readdirSync, symlinkSync, lstatSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { runInNewContext, Script } from "node:vm";
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
const prefix = join(temp, "consumer's copy");
execFileSync(npm, ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(temp, packed.filename)], { encoding: "utf8" });
const installed = join(prefix, "node_modules", "agenttel");

test("npm package contains all runtime assets and exposes the CLI and Pi extension", () => {
	assert.deepEqual(packed.files.map((f) => f.path).sort(), ["LICENSE", "README.md", "config.js", "favicon.svg", "hooks.js", "index.html", "index.js", "package.json", "recorder.js", "server.js", "setup.js", "skills/agenttel/SKILL.md", "viewer.js"]);
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
	assert.equal(events[0].source, "pi");
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
	assert.equal(await (await fetch(`${url}/ping`)).text(), "agenttel");
	const page = await fetch(url);
	const html = await page.text();
	assert.match(html, /<html lang="en">/);
	assert.match(html, /<link rel="icon" href="\/favicon\.svg"/);
	assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
	assert.match(page.headers.get("content-security-policy"), /img-src 'self'/);
	const favicon = await fetch(`${url}/favicon.svg`);
	assert.equal(favicon.status, 200);
	assert.match(favicon.headers.get("content-type"), /image\/svg\+xml/);
	assert.equal(favicon.headers.get("cache-control"), "no-store");
	assert.match(await favicon.text(), /viewBox="0 0 32 32"/);
	if (process.platform !== "win32") {
		const bin = join(temp, "fake-browser"), opened = join(temp, "opened-url");
		mkdirSync(bin);
		writeFileSync(join(bin, process.platform === "darwin" ? "open" : "xdg-open"), '#!/bin/sh\nprintf "%s" "$1" > "$AGENTTEL_TEST_BROWSER"\n', { mode: 0o700 });
		const output = execFileSync(process.execPath, [join(installed, "server.js"), "open"], { env: { ...process.env, AGENTTEL_PORT: String(port), AGENTTEL_DIR: dir, PATH: `${bin}:${process.env.PATH}`, AGENTTEL_TEST_BROWSER: opened }, encoding: "utf8", timeout: 5000 });
		assert.match(output, new RegExp(url));
		for (let i = 0; i < 100 && !existsSync(opened); i++) await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(readFileSync(opened, "utf8"), url);
		assert.equal(child.exitCode, null); // The existing viewer is reused, not replaced.
	}
	assert.equal((await fetch(`${url}/missing`)).status, 404);
	const blockedHost = await new Promise((resolve, reject) => {
		const req = request(`${url}/ping`, { headers: { Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
		req.on("error", reject);
		req.end();
	});
	assert.equal(blockedHost, 403);
	assert.equal((await fetch(`${url}/clear`, { method: "POST", headers: { Origin: "https://attacker.example" } })).status, 403);
	assert.match(readFileSync(file, "utf8"), /first/);

	const abort = new AbortController();
	t.after(() => abort.abort());
	const stream = await fetch(`${url}/events`, { signal: abort.signal });
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
	assert.equal((await fetch(`${url}/clear`, { method: "POST", headers: { Origin: url } })).status, 200);
	await until("event: clear");
	assert.equal(readFileSync(file, "utf8"), "");
	appendFileSync(file, '{"sid":"after-clear"}\n');
	await until('data: {"sid":"after-clear"}');
	abort.abort();
});

test("installed command hooks record both agents, cap valid JSON, and leave agent decisions unchanged", { timeout: 15000 }, async () => {
	const dir = join(temp, "hooks");
	const env = { ...process.env, AGENTTEL_DIR: dir, AGENTTEL_PORT: "not-a-port" };
	const cli = join(installed, "server.js");
	const record = (source, input) => {
		const result = spawnSync(process.execPath, [cli, "hook", source], { env, input: JSON.stringify(input), encoding: "utf8", timeout: 3000 });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.deepEqual(JSON.parse(result.stdout), {});
	};
	for (const source of ["codex", "claude"]) {
		const config = JSON.parse(execFileSync(process.execPath, [cli, "hooks", source], { env, encoding: "utf8" }));
		assert.equal(!!config.hooks.Interrupt, source === "codex");
		assert.equal(!!config.hooks.PostToolUseFailure, source === "claude");
		const base = { session_id: "shared", cwd: "/example", model: "example-model" };
		const command = config.hooks.UserPromptSubmit[0].hooks[0];
		assert.equal(command.type, "command");
		assert.equal(command.async, undefined);
		// Exercise the generated shell command, including installation paths with spaces and quotes.
		const started = spawnSync(command.command, { shell: true, env, input: JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hello" }), encoding: "utf8", timeout: 3000 });
		assert.equal(started.status, 0, started.stderr);
		assert.deepEqual(JSON.parse(started.stdout), {});
		const tool = { ...base, tool_use_id: "tool", tool_name: "Bash", tool_input: { command: "x".repeat(32001), nested: ["keep"] } };
		record(source, { ...tool, hook_event_name: "PreToolUse" });
		record(source, { ...tool, hook_event_name: "PostToolUse", tool_input: { command: "actual command" }, tool_response: "y".repeat(32001) });
		record(source, { ...base, hook_event_name: "Stop", last_assistant_message: "done" });
		record(source, { ...base, hook_event_name: "SessionEnd", reason: "other" });
		record(source, { ...base, hook_event_name: "PostCompact", trigger: "manual" });
		record(source, { ...base, hook_event_name: "SubagentStart", agent_id: "child", agent_type: "Explore" });
		record(source, { ...base, hook_event_name: "SubagentStop", agent_id: "child", last_assistant_message: "child done" });
	}
	const file = join(dir, "events.jsonl");
	const events = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
	for (const source of ["codex", "claude"]) {
		const main = events.filter(e => e.sid === `${source}:shared`);
		assert.deepEqual(main.map(e => e.type), ["run_start", "turn_start", "tool_start", "tool_end", "turn_end", "run_end", "session_end", "compact"]);
		assert.equal(main[0].source, source);
		assert.equal(main[0].scope, "response");
		assert.equal(main[0].prompt, "hello");
		assert.deepEqual(JSON.parse(main[2].args).nested, ["keep"]);
		assert.match(JSON.parse(main[2].args).command, /truncated 1 chars/);
		assert.equal(JSON.parse(main[3].args).command, "actual command");
		assert.equal(main[3].isError, source === "claude" ? false : null);
		assert.equal(main[3].out, 32001);
		assert.match(main[3].result, /truncated 1 chars/);
		assert.equal(main[4].text, "done");
		assert.equal(main[4].usage, undefined);
		assert.equal(main[4].ms, undefined);
		assert.equal(main[7].reason, "manual");
		assert.equal(events.filter(e => e.sid === `${source}:shared:agent:child`).length, 4);
	}
	record("claude", { session_id: "failure", hook_event_name: "PostToolUseFailure", tool_use_id: "bad", tool_name: "Bash", error: "failed" });
	record("claude", { session_id: "failure", hook_event_name: "StopFailure", error: "rate_limit", error_details: "try later" });
	record("codex", { session_id: "failure", hook_event_name: "PostToolUse", tool_use_id: "bad", tool_name: "Bash", tool_response: { exit_code: 1 } });
	record("codex", { session_id: "failure", hook_event_name: "Interrupt" });
	const failures = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).slice(events.length);
	assert.equal(failures[0].isError, true);
	assert.equal(failures[1].error, "try later");
	assert.equal(failures[3].isError, true);
	assert.equal(failures[4].stop, "interrupted");
	// Separate processes append concurrently without shared mutable timestamp state.
	await Promise.all(Array.from({ length: 8 }, (_, n) => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, "hook", "codex"], { env, stdio: ["pipe", "ignore", "pipe"] });
		child.on("error", reject);
		child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Hook exited ${code}`)));
		child.stdin.end(JSON.stringify({ session_id: `parallel-${n}`, hook_event_name: "UserPromptSubmit", prompt: "hi" }));
	})));
	assert.equal(readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).length, events.length + failures.length + 16);
	if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("hook input and storage failures are non-blocking and invalid CLI sources fail clearly", () => {
	const cli = join(installed, "server.js");
	const dir = join(temp, "broken-hooks");
	writeFileSync(dir, "not a directory");
	for (const input of ["not JSON", "[]", '{}', JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "hello" })]) {
		const result = spawnSync(process.execPath, [cli, "hook", "claude"], { env: { ...process.env, AGENTTEL_DIR: dir }, input, encoding: "utf8", timeout: 3000 });
		assert.equal(result.status, 0);
		assert.deepEqual(JSON.parse(result.stdout), {});
		assert.match(result.stderr, /unable to record hook/);
		assert.equal(readFileSync(dir, "utf8"), "not a directory");
	}
	for (const args of [["hook", "other"], ["hooks"], ["hooks", "codex", "extra"], ["setup"], ["setup", "pi"], ["setup", "codex", "extra"]]) {
		const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 3000 });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /codex or claude/);
	}
});

test("viewer derives hook durations, isolates sessions, and keeps unavailable values unknown", () => {
	const script = readFileSync(join(installed, "index.html"), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
	new Script(script); // Check the interaction and SSE code too, not just the functions below.
	const stats = { replaceChildren: html => { stats.html = html; } };
	const side = { scrollTop: 0, replaceChildren: html => { side.html = html; } };
	const viewer = runInNewContext(`${script.split("// ---- interaction:")[0]}\n({ ingest, sessions, renderStats, renderSide, renderExec, renderRun, executed, mark, sumKnown })`, {
		stats, side, sq: { value: "" }, document: { createRange: () => ({ createContextualFragment: html => html }) },
	});
	const base = { sid: "codex:shared", source: "codex", scope: "response", cwd: "/example" };
	for (const e of [
		{ type: "run_start", t: 1000, prompt: "hello" }, { type: "turn_start", t: 1000, turn: 0 },
		{ type: "tool_start", t: 1100, id: "tool", tool: "Bash", args: '{"command":"before"}' },
		{ type: "tool_end", t: 1300, id: "tool", args: '{"command":"after"}', result: "done", isError: null },
		{ type: "turn_end", t: 1500, text: "answer" }, { type: "run_end", t: 1500 }, { type: "session_end", t: 1600 },
	]) viewer.ingest({ ...base, ...e });
	const s = viewer.sessions.get(base.sid), run = s.runs[0];
	assert.equal(run.ms, 500);
	assert.equal(run.turns[0].ms, 500);
	assert.equal(run.turns[0].modelMs, null);
	assert.equal(s.tools.get("tool").ms, 200);
	assert.equal(s.tools.get("tool").args, '{"command":"after"}');
	assert.equal(run.turns[0].text, "answer");
	assert.equal(s.busy, false);
	assert.equal(run.in, null);
	assert.equal(run.cost, null);
	viewer.renderStats(s); viewer.renderSide();
	assert.match(stats.html, /Σ in <b>–<\/b>/);
	assert.match(stats.html, /cost <b>–<\/b>/);
	assert.doesNotMatch(stats.html, /NaN|0%|undefined/);
	assert.match(side.html, /codex/);
	assert.match(viewer.renderRun(run), /responses/);
	assert.match(viewer.renderExec(s), /slowest responses/);
	assert.doesNotMatch(viewer.renderExec(s), /NaN|Infinity|\$0\.0000/);
	assert.match(viewer.mark(s.tools.get("tool")), /terminal status unavailable/);
	assert.match(viewer.executed({ tool: "Read", args: '{"file_path":"/example/file"}' }, s), /\/example\/file/);
	assert.match(viewer.executed({ tool: "Edit", args: '{"file_path":"/example/file","old_string":"old","new_string":"new","replace_all":true}' }, s), /replace all/);
	viewer.ingest({ ...base, sid: "claude:shared", source: "claude", type: "tool_start", id: "tool", tool: "Bash", args: "{}", t: 2000 });
	viewer.ingest({ ...base, sid: "claude:shared", source: "claude", type: "session_end", t: 2500 });
	assert.equal(viewer.sessions.get("claude:shared").runs[0].ms, 500);
	assert.equal(viewer.sessions.get("claude:shared").busy, false);
	// Old Pi logs have no source field, retain explicit timing, and keep measured zero costs.
	for (const e of [{ type: "run_start", t: 0 }, { type: "turn_start", t: 0, turn: 0 }, { type: "turn_end", t: 50, ms: 40, usage: { input: 1, output: 2, cacheRead: 0, cost: { total: 0 } } }, { type: "run_end", t: 60, ms: 45 }]) viewer.ingest({ sid: "shared", ...e });
	const pi = viewer.sessions.get("shared");
	assert.equal(pi.source, "pi");
	assert.equal(pi.runs[0].ms, 45);
	assert.equal(pi.runs[0].in, 1);
	assert.equal(pi.cost, 0);
	assert.equal(viewer.sumKnown([1, null]), null);
	assert.equal(viewer.sumKnown([0, 0]), 0);
	assert.equal(viewer.sessions.size, 3);
});

test("bundled skill registration is idempotent and preserves existing skills", () => {
	const cli = join(installed, "server.js"), home = join(temp, "skill-home");
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	const source = realpathSync(join(installed, "skills", "agenttel"));
	assert.match(readFileSync(join(source, "SKILL.md"), "utf8"), /name: agenttel/);
	assert.match(readFileSync(join(source, "SKILL.md"), "utf8"), /agenttel open/);
	for (let n = 0; n < 2; n++) {
		const result = spawnSync(process.execPath, [cli, "install-skill"], { env, encoding: "utf8", timeout: 3000 });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /skill registered/);
		for (const root of [".agents", ".claude"]) assert.equal(realpathSync(join(home, root, "skills", "agenttel")), source);
	}
	const conflictHome = join(temp, "skill-conflict");
	const conflict = join(conflictHome, ".claude", "skills", "agenttel");
	mkdirSync(conflict, { recursive: true });
	writeFileSync(join(conflict, "SKILL.md"), "existing skill");
	const result = spawnSync(process.execPath, [cli, "install-skill"], { env: { ...env, HOME: conflictHome, USERPROFILE: conflictHome }, encoding: "utf8", timeout: 3000 });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Skill already exists/);
	assert.equal(readFileSync(join(conflict, "SKILL.md"), "utf8"), "existing skill");
	assert.equal(existsSync(join(conflictHome, ".agents", "skills", "agenttel")), false);
});

test("setup merges only the selected agent, backs up settings, and is idempotent", () => {
	const cli = join(installed, "server.js");
	for (const source of ["codex", "claude"]) {
		const home = join(temp, `setup-${source}`), logs = join(home, "traces");
		const env = { ...process.env, HOME: home, USERPROFILE: home, AGENTTEL_DIR: logs };
		const file = join(home, source === "codex" ? ".codex" : ".claude", source === "codex" ? "hooks.json" : "settings.json");
		mkdirSync(dirname(file), { recursive: true });
		const generated = JSON.parse(execFileSync(process.execPath, [cli, "hooks", source], { env, encoding: "utf8" }));
		const other = { type: "command", command: "echo keep", timeout: 10 };
		const original = { env: { KEEP: "value" }, permissions: { allow: ["Read"] }, hooks: {
			PermissionRequest: [{ matcher: "Bash", hooks: [other] }],
			UserPromptSubmit: [{ matcher: "", hooks: [other, generated.hooks.UserPromptSubmit[0].hooks[0], generated.hooks.UserPromptSubmit[0].hooks[0]] }],
		} };
		const raw = JSON.stringify(original, null, 4) + "\n";
		const linked = source === "claude" && process.platform !== "win32";
		const target = linked ? join(home, "dotfiles-settings.json") : file;
		writeFileSync(target, raw);
		if (linked) symlinkSync(target, file);
		if (process.platform !== "win32") chmodSync(target, 0o640);
		const first = spawnSync(process.execPath, [cli, "setup", source], { env, encoding: "utf8", timeout: 3000 });
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stdout, /setup complete/);
		assert.ok(first.stdout.includes(`Hooks: ${file}`));
		assert.ok(first.stdout.includes(`Logs: ${join(logs, "events.jsonl")}`));
		const config = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(config.env, original.env);
		assert.deepEqual(config.permissions, original.permissions);
		assert.deepEqual(config.hooks.PermissionRequest, original.hooks.PermissionRequest);
		assert.deepEqual(config.hooks.UserPromptSubmit[0], { matcher: "", hooks: [other] });
		for (const [event, entries] of Object.entries(generated.hooks)) {
			const command = entries[0].hooks[0].command;
			assert.equal(config.hooks[event].flatMap(entry => entry.hooks).filter(handler => handler.command === command).length, 1);
		}
		const skillRoot = source === "codex" ? ".agents" : ".claude";
		assert.equal(realpathSync(join(home, skillRoot, "skills", "agenttel")), realpathSync(join(installed, "skills", "agenttel")));
		assert.equal(existsSync(join(home, source === "codex" ? ".claude" : ".codex")), false);
		const backups = () => readdirSync(dirname(file)).filter(name => name.startsWith(`${file.split(/[\\/]/).at(-1)}.agenttel-backup-`));
		assert.equal(backups().length, 1);
		const backup = join(dirname(file), backups()[0]);
		assert.equal(readFileSync(backup, "utf8"), raw);
		if (process.platform !== "win32") {
			assert.equal(statSync(backup).mode & 0o777, 0o600);
			assert.equal(statSync(file).mode & 0o777, 0o640);
		}
		if (linked) assert.equal(lstatSync(file).isSymbolicLink(), true);
		const saved = readFileSync(file, "utf8"), mtime = statSync(file).mtimeMs;
		const second = spawnSync(process.execPath, [cli, "setup", source], { env, encoding: "utf8", timeout: 3000 });
		assert.equal(second.status, 0, second.stderr);
		assert.match(second.stdout, /already configured/);
		assert.equal(readFileSync(file, "utf8"), saved);
		assert.equal(statSync(file).mtimeMs, mtime);
		assert.equal(backups().length, 1);
		assert.equal(existsSync(`${file}.agenttel.lock`), false);
		const recorded = spawnSync(config.hooks.UserPromptSubmit.at(-1).hooks[0].command, { shell: true, env, input: JSON.stringify({ session_id: "setup-check", hook_event_name: "UserPromptSubmit", prompt: "hello" }), encoding: "utf8", timeout: 3000 });
		assert.equal(recorded.status, 0, recorded.stderr);
		assert.deepEqual(JSON.parse(recorded.stdout), {});
		assert.equal(JSON.parse(readFileSync(join(logs, "events.jsonl"), "utf8").split("\n")[0]).sid, `${source}:setup-check`);
		const freshHome = join(temp, `setup-fresh-${source}`);
		const fresh = spawnSync(process.execPath, [cli, "setup", source], { env: { ...env, HOME: freshHome, USERPROFILE: freshHome }, encoding: "utf8", timeout: 3000 });
		assert.equal(fresh.status, 0, fresh.stderr);
		const freshFile = join(freshHome, source === "codex" ? ".codex" : ".claude", source === "codex" ? "hooks.json" : "settings.json");
		assert.deepEqual(JSON.parse(readFileSync(freshFile, "utf8")), generated);
		assert.doesNotMatch(fresh.stdout, /Backup:/);
		assert.equal(existsSync(join(freshHome, ".pi")), false);
		if (process.platform !== "win32") assert.equal(statSync(freshFile).mode & 0o777, 0o600);
	}
});

test("setup refuses invalid, disabled, stale, or busy settings without changing them", () => {
	const cli = join(installed, "server.js");
	const cases = ["not JSON", "[]", '{"hooks":[]}', '{"hooks":{"Stop":null}}', '{"hooks":{"Stop":[{}]}}', '{"hooks":{"Stop":[{"hooks":[null]}]}}', '{"disableAllHooks":true}', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "'node' '/old/agenttel/server.js' hook claude" }] }] } })];
	for (const [n, raw] of cases.entries()) {
		const home = join(temp, `setup-invalid-${n}`), file = join(home, ".claude", "settings.json");
		mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, raw);
		const result = spawnSync(process.execPath, [cli, "setup", "claude"], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 3000 });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /agenttel:/);
		assert.equal(readFileSync(file, "utf8"), raw);
		assert.equal(existsSync(join(home, ".claude", "skills", "agenttel")), false);
		assert.deepEqual(readdirSync(dirname(file)), ["settings.json"]);
	}
	const home = join(temp, "setup-busy"), file = join(home, ".codex", "hooks.json");
	mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "{}"); writeFileSync(`${file}.agenttel.lock`, "busy");
	const busy = spawnSync(process.execPath, [cli, "setup", "codex"], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 3000 });
	assert.equal(busy.status, 1);
	assert.match(busy.stderr, /Setup lock exists/);
	assert.equal(readFileSync(file, "utf8"), "{}");
	assert.equal(readFileSync(`${file}.agenttel.lock`, "utf8"), "busy");
	assert.equal(existsSync(join(home, ".agents", "skills", "agenttel")), false);
});

test("documented local npm installation works without pnpm or a published package", { skip: process.platform === "win32", timeout: 15000 }, () => {
	const bin = join(temp, "no-pnpm"), prefix = join(temp, "global-install");
	mkdirSync(bin); writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
	execFileSync(npm, ["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", root], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 10000 });
	const help = execFileSync(join(prefix, "bin", "agenttel"), ["--help"], { encoding: "utf8", timeout: 3000 });
	assert.match(help, /agenttel setup <codex\|claude>/);
});

test("new installations use a shared directory and existing Pi directories are reused", { skip: process.platform === "win32" }, () => {
	const home = join(temp, "home");
	mkdirSync(home);
	const env = { ...process.env, HOME: home };
	delete env.AGENTTEL_DIR;
	const script = `import { DIR } from ${JSON.stringify(pathToFileURL(join(installed, "config.js")).href)}; console.log(DIR);`;
	const dir = () => execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }).trim();
	assert.equal(dir(), join(home, ".local", "share", "agenttel"));
	const legacy = join(home, ".pi", "agent", "agenttel");
	mkdirSync(legacy, { recursive: true });
	assert.equal(dir(), legacy);
});
