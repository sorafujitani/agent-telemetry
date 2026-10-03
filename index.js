/** Record Pi lifecycle events locally; /agenttel opens the live viewer. */
import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DIR, FILE, URL } from "./config.js";

const short = (v, n = 200) => {
	const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
	return s.length > n ? s.slice(0, n) + "…" : s;
};
const CAP = 32000; // ponytail: cap strings at 32k characters; raise if full payloads matter
// Cap individual strings so argument objects remain valid JSON.
const capDeep = (v) =>
	typeof v === "string" ? (v.length > CAP ? v.slice(0, CAP) + `…[truncated ${v.length - CAP} chars]` : v)
	: Array.isArray(v) ? v.map(capDeep)
	: v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capDeep(x)]))
	: v;
const resText = (r) =>
	Array.isArray(r?.content)
		? r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
		: typeof r === "string"
			? r
			: JSON.stringify(r) ?? "";
const partsOf = (m, type, key) =>
	(m?.content ?? [])
		.filter((c) => c.type === type)
		.map((c) => c[key])
		.join("\n");

export default function (pi) {
	const toolStart = new Map();
	let turnStart = 0;
	let runStart = 0;
	let warned = false;

	const emit = (ctx, type, data = {}) => {
		try {
			const u = ctx.getContextUsage?.();
			const line = {
				t: Date.now(),
				sid: ctx.sessionManager?.getSessionId?.(),
				cwd: ctx.cwd,
				pid: process.pid,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				ctx: u?.tokens ?? null,
				win: u?.contextWindow ?? null,
				type,
				...data,
			};
			mkdirSync(DIR, { recursive: true, mode: 0o700 });
			appendFileSync(FILE, JSON.stringify(line) + "\n", { mode: 0o600 });
		} catch (error) {
			if (!warned) {
				warned = true;
				ctx.ui?.notify(`agenttel: unable to write telemetry: ${error.message}`, "warning");
			}
		}
	};

	pi.on("before_agent_start", (e, ctx) => {
		runStart = Date.now();
		emit(ctx, "run_start", {
			prompt: short(e.prompt, 400),
			promptChars: e.prompt.length,
			sysChars: e.systemPrompt.length,
			tools: pi.getActiveTools?.()?.length,
		});
	});
	pi.on("turn_start", (e, ctx) => {
		turnStart = Date.now();
		emit(ctx, "turn_start", { turn: e.turnIndex });
	});
	pi.on("turn_end", (e, ctx) => {
		const m = e.message ?? {};
		emit(ctx, "turn_end", {
			turn: e.turnIndex,
			ms: Date.now() - turnStart,
			usage: m.usage,
			stop: m.stopReason,
			error: m.errorMessage,
			text: short(partsOf(m, "text", "text"), 2000),
			thinking: short(partsOf(m, "thinking", "thinking"), 2000) || undefined,
		});
	});
	pi.on("tool_execution_start", (e, ctx) => {
		toolStart.set(e.toolCallId, Date.now());
		emit(ctx, "tool_start", { id: e.toolCallId, parent: e.parentToolCallId, tool: e.toolName, args: JSON.stringify(capDeep(e.args)) });
	});
	pi.on("tool_execution_end", (e, ctx) => {
		const s = toolStart.get(e.toolCallId);
		toolStart.delete(e.toolCallId);
		const text = resText(e.result);
		emit(ctx, "tool_end", {
			id: e.toolCallId,
			parent: e.parentToolCallId,
			tool: e.toolName,
			ms: s ? Date.now() - s : null,
			isError: !!e.isError,
			out: text.length,
			result: capDeep(text),
		});
	});
	pi.on("agent_end", (_e, ctx) => emit(ctx, "run_end", { ms: Date.now() - runStart }));
	pi.on("session_compact", (e, ctx) => emit(ctx, "compact", { reason: e.reason }));
	pi.on("model_select", (e, ctx) =>
		emit(ctx, "model_select", { to: `${e.model.provider}/${e.model.id}`, from: e.previousModel?.id }),
	);

	pi.registerCommand("agenttel", {
		description: `Open the agenttel viewer (${URL})`,
		handler: async (_args, ctx) => {
			const alive = () => fetch(URL + "/ping", { signal: AbortSignal.timeout(500) })
				.then(async (r) => r.ok && await r.text() === "agenttel").catch(() => false);
			if (!await alive()) {
				const server = fileURLToPath(new globalThis.URL("./server.js", import.meta.url));
				const child = spawn(process.execPath, [server], { detached: true, stdio: "ignore" });
				let failed = false;
				child.on("error", () => { failed = true; });
				child.on("exit", () => { failed = true; });
				child.unref();
				for (let i = 0; i < 30 && !failed; i++) {
					if (await alive()) break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				if (!await alive()) {
					ctx.ui.notify(`agenttel: could not start the viewer at ${URL}. Check the port or run agenttel in a terminal.`, "error");
					return;
				}
			}
			const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
			const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", URL] : [URL];
			const browser = spawn(command, args, { detached: true, stdio: "ignore" });
			const fallback = () => ctx.ui.notify(`agenttel: open ${URL} in your browser`, "warning");
			browser.on("error", fallback);
			browser.on("exit", (code) => { if (code) fallback(); });
			browser.unref();
			ctx.ui.notify(`agenttel: ${URL}`, "info");
		},
	});
}
