// Shared local JSONL writer for the Pi extension and command hooks.
import { appendFileSync, mkdirSync } from "node:fs";
import { DIR, FILE } from "./config.js";

export const short = (v, n = 200) => {
	const s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
	return s.length > n ? `${s.slice(0, n)}…` : s;
};
const CAP = 32000; // ponytail: cap strings at 32k characters; raise if full payloads matter
// Cap individual strings so argument objects remain valid JSON.
export function capDeep(value) {
	if (typeof value === "string") {
		return value.length > CAP
			? `${value.slice(0, CAP)}…[truncated ${value.length - CAP} chars]`
			: value;
	}
	if (Array.isArray(value)) return value.map(capDeep);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capDeep(item)]));
	}
	return value;
}
export const resText = (r) =>
	Array.isArray(r?.content)
		? r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
		: typeof r === "string"
			? r
			: (JSON.stringify(r) ?? "");

export function appendEvents(events) {
	if (!events.length) return;
	const t = Date.now();
	const lines = `${events.map((e) => JSON.stringify({ t, ...e })).join("\n")}\n`;
	mkdirSync(DIR, { recursive: true, mode: 0o700 });
	appendFileSync(FILE, lines, { mode: 0o600 });
}
