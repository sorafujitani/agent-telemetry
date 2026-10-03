// Shared local JSONL writer for the Pi extension and command hooks.
import { appendFileSync, mkdirSync } from "node:fs";
import { DIR, FILE } from "./config.js";

export const short = (v, n = 200) => {
	const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
	return s.length > n ? s.slice(0, n) + "…" : s;
};
const CAP = 32000; // ponytail: cap strings at 32k characters; raise if full payloads matter
// Cap individual strings so argument objects remain valid JSON.
export const capDeep = (v) =>
	typeof v === "string" ? (v.length > CAP ? v.slice(0, CAP) + `…[truncated ${v.length - CAP} chars]` : v)
	: Array.isArray(v) ? v.map(capDeep)
	: v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capDeep(x)]))
	: v;
export const resText = (r) =>
	Array.isArray(r?.content)
		? r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
		: typeof r === "string" ? r : JSON.stringify(r) ?? "";

export function appendEvents(events) {
	if (!events.length) return;
	const t = Date.now();
	const lines = events.map((e) => JSON.stringify({ t, ...e })).join("\n") + "\n";
	mkdirSync(DIR, { recursive: true, mode: 0o700 });
	appendFileSync(FILE, lines, { mode: 0o600 });
}
