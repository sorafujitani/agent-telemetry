import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const legacy = join(homedir(), ".pi", "agent", "agenttel");
export const DIR = process.env.AGENTTEL_DIR
	? resolve(process.env.AGENTTEL_DIR)
	: existsSync(legacy) ? legacy : join(homedir(), ".local", "share", "agenttel");
export const FILE = join(DIR, "events.jsonl");
export const PORT = Number(process.env.AGENTTEL_PORT ?? process.env.PI_TRACE_PORT ?? 7777);
export const URL = `http://127.0.0.1:${PORT}`;
