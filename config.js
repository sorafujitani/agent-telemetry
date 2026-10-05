import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const piDirectory = join(homedir(), ".pi", "agent", "panopticon");
export const DIR = process.env.PANOPTICON_DIR
	? resolve(process.env.PANOPTICON_DIR)
	: existsSync(piDirectory)
		? piDirectory
		: join(homedir(), ".local", "share", "panopticon");
export const FILE = join(DIR, "events.jsonl");
export const PORT = Number(process.env.PANOPTICON_PORT ?? 7777);
export const URL = `http://127.0.0.1:${PORT}`;
