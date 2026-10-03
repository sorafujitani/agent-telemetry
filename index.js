/** Record Pi lifecycle events locally; /agenttel opens the live viewer. */
import { openViewer } from "./viewer.js";
import { URL } from "./config.js";
import { appendEvents, short, capDeep, resText } from "./recorder.js";
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
				source: "pi",
				sid: ctx.sessionManager?.getSessionId?.(),
				cwd: ctx.cwd,
				pid: process.pid,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				ctx: u?.tokens ?? null,
				win: u?.contextWindow ?? null,
				type,
				...data,
			};
			appendEvents([line]);
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
		handler: (_args, ctx) => openViewer((message, level) => ctx.ui.notify(message, level)),
	});
}
