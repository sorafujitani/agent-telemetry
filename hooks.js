// Convert Codex and Claude Code command-hook input to the viewer's events.
import { fileURLToPath } from "node:url";
import { appendEvents, short, capDeep, resText } from "./recorder.js";

export function checkSource(source) {
	if (source !== "codex" && source !== "claude") throw new Error("Expected codex or claude");
}

export function hookEvents(source, input) {
	checkSource(source);
	if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("Expected a hook input object");
	for (const key of ["session_id", "hook_event_name"]) {
		if (typeof input[key] !== "string" || !input[key]) throw new Error(`Missing ${key}`);
	}
	const e = input;
	if (e.agent_id != null && typeof e.agent_id !== "string") throw new Error("Invalid agent_id");
	if (e.hook_event_name.startsWith("Subagent") && !e.agent_id) throw new Error("Missing agent_id");
	const base = {
		source, scope: "response",
		sid: `${source}:${e.session_id}${e.agent_id ? ":agent:" + e.agent_id : ""}`,
		cwd: typeof e.cwd === "string" ? e.cwd : undefined,
		model: typeof e.model === "string" ? e.model : undefined,
	};
	const event = (type, data = {}) => ({ ...base, type, ...data });
	const start = (prompt) => [event("run_start", { prompt: short(prompt, 400), promptChars: prompt.length }), event("turn_start", { turn: 0 })];
	const end = (stop, error) => [event("turn_end", { turn: 0, stop, error, text: short(e.last_assistant_message ?? "", 2000) }), event("run_end")];
	switch (e.hook_event_name) {
		case "SessionStart": return [event("session_start")];
		case "SessionEnd": return [event("session_end", { reason: e.reason })];
		case "UserPromptSubmit":
			if (typeof e.prompt !== "string") throw new Error("Missing prompt");
			return start(e.prompt);
		case "SubagentStart": return start(`[subagent: ${e.agent_type ?? "agent"}]`);
		case "Stop": case "SubagentStop": return end("stop");
		case "StopFailure": return end("error", short(e.error_details ?? e.error ?? "Response failed", 2000));
		case "Interrupt": return end("interrupted");
		case "PostCompact": return [event("compact", { reason: e.trigger })];
		case "PreToolUse": case "PostToolUse": case "PostToolUseFailure": {
			for (const key of ["tool_use_id", "tool_name"]) {
				if (typeof e[key] !== "string" || !e[key]) throw new Error(`Missing ${key}`);
			}
			const tool = { id: e.tool_use_id, tool: e.tool_name, args: JSON.stringify(capDeep(e.tool_input ?? {})) };
			if (e.hook_event_name === "PreToolUse") return [event("tool_start", tool)];
			const failed = e.hook_event_name === "PostToolUseFailure";
			const result = resText(failed ? e.error : e.tool_response);
			const r = e.tool_response;
			const code = r?.exit_code ?? r?.exitCode;
			// Codex does not consistently expose terminal status; do not infer it from output text.
			const isError = failed ? true : source === "claude" ? false
				: typeof r?.isError === "boolean" ? r.isError
				: Number.isInteger(code) ? code !== 0 : null;
			return [event("tool_end", { ...tool, isError, result: capDeep(result), out: result.length })];
		}
		default: return [];
	}
}

export async function recordHook(source) {
	try {
		let text = "", bytes = 0;
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) {
			bytes += Buffer.byteLength(chunk);
			if (bytes > 8 * 1024 * 1024) throw new Error("Hook input exceeds 8 MiB");
			text += chunk;
		}
		let input;
		try { input = JSON.parse(text); } catch { throw new Error("Hook input is not valid JSON"); }
		appendEvents(hookEvents(source, input));
	} catch (error) {
		// A recorder failure must never block tools or inject a continuation prompt.
		console.error(`agenttel: unable to record hook: ${error.message}`);
	}
	console.log("{}");
}

export function hookConfig(source) {
	checkSource(source);
	const quote = (s) => process.platform === "win32" ? `"${s}"` : "'" + s.replaceAll("'", "'\"'\"'") + "'";
	const cli = fileURLToPath(new URL("./server.js", import.meta.url));
	const command = `${quote(process.execPath)} ${quote(cli)} hook ${source}`;
	const names = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PostCompact", "SubagentStart", "SubagentStop"];
	names.push(...(source === "claude" ? ["PostToolUseFailure", "StopFailure"] : ["Interrupt"]));
	return { hooks: Object.fromEntries(names.map((name) => [name, [{ hooks: [{ type: "command", command, timeout: name === "Interrupt" ? 3 : 5 }] }]])) };
}
