import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DIR = process.env.AGENTTEL_DIR
	? resolve(process.env.AGENTTEL_DIR)
	: join(homedir(), ".pi", "agent", "agenttel");
export const FILE = join(DIR, "events.jsonl");
export const PORT = Number(process.env.AGENTTEL_PORT ?? process.env.PI_TRACE_PORT ?? 7777);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	throw new Error("AGENTTEL_PORT must be an integer between 1 and 65535");
}
export const URL = `http://127.0.0.1:${PORT}`;
