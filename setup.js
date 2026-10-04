// Install skills and merge recording Hooks without overwriting other agent settings.
import { accessSync, constants, readFileSync, writeFileSync, mkdirSync, lstatSync, statSync, realpathSync, symlinkSync, openSync, closeSync, unlinkSync, renameSync, chmodSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hookConfig, checkSource } from "./hooks.js";

function skillPlan(source) {
	if (source != null) checkSource(source);
	const roots = { codex: ".agents", claude: ".claude" };
	const skill = realpathSync(fileURLToPath(new URL("./skills/panopticon", import.meta.url)));
	const destinations = (source ? [roots[source]] : Object.values(roots)).map(root => join(homedir(), root, "skills", "panopticon"));
	for (const dest of destinations) {
		const stat = lstatSync(dest, { throwIfNoEntry: false });
		if (stat && (!stat.isSymbolicLink() || realpathSync(dest) !== skill)) throw new Error(`Skill already exists: ${dest}. Review it before removing or relinking it.`);
	}
	return { skill, destinations };
}

function applySkills({ skill, destinations }) {
	for (const dest of destinations) if (!lstatSync(dest, { throwIfNoEntry: false })) {
		mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
		symlinkSync(skill, dest, "junction");
	}
	return destinations;
}

export function installSkill() {
	return applySkills(skillPlan());
}

const isObject = value => value != null && typeof value === "object" && !Array.isArray(value);
function mergeHooks(config, source) {
	if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks))) throw new Error("Settings and hooks must be JSON objects");
	const hooks = { ...config.hooks };
	const stale = new RegExp(String.raw`[\\/](?:panopticon|agent(?:tel|-telemetry))[\\/]server\.js["']?\s+hook\s+${source}$`);
	for (const [event, entries] of Object.entries(hookConfig(source).hooks)) {
		const command = entries[0].hooks[0].command;
		const previous = hooks[event] === undefined ? [] : hooks[event];
		if (!Array.isArray(previous)) throw new Error(`hooks.${event} must be an array`);
		hooks[event] = previous.flatMap(entry => {
			if (!isObject(entry) || !Array.isArray(entry.hooks) || !entry.hooks.every(isObject)) throw new Error(`Invalid hook entry in ${event}`);
			const other = entry.hooks.filter(handler => {
				if (handler.type !== "command") return true;
				if (handler.command === command) return false;
				if (typeof handler.command === "string" && stale.test(handler.command.trim())) throw new Error("A stale recording Hook command exists. Review and remove it before setup; settings were not changed.");
				return true;
			});
			return other.length || !entry.hooks.length ? [{ ...entry, hooks: other }] : [];
		});
		hooks[event].push(...entries);
	}
	return { ...config, hooks };
}

function readSettings(file) {
	return lstatSync(file, { throwIfNoEntry: false }) ? readFileSync(file, "utf8") : null;
}

function saveSettings(file, original, config) {
	if (readSettings(file) !== original) throw new Error("Settings changed during setup; retry without editing them concurrently");
	const target = original == null ? file : realpathSync(file);
	if (original != null) accessSync(target, constants.W_OK);
	const mode = original == null ? 0o600 : statSync(target).mode & 0o777;
	const backup = original == null ? null : `${file}.panopticon-backup-${randomUUID()}`;
	if (backup) writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
	const temporary = join(dirname(target), `.panopticon-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		chmodSync(temporary, mode);
		if (readSettings(file) !== original) throw new Error("Settings changed during setup; retry without editing them concurrently");
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
	return backup;
}

export function setupAgent(source) {
	checkSource(source);
	const plan = skillPlan(source);
	const file = source === "codex" ? join(homedir(), ".codex", "hooks.json") : join(homedir(), ".claude", "settings.json");
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const lock = `${file}.panopticon.lock`;
	let fd;
	try { fd = openSync(lock, "wx", 0o600); }
	catch (error) {
		if (error.code === "EEXIST") throw new Error(`Setup lock exists: ${lock}. Check for a running setup before removing a stale lock.`);
		throw error;
	}
	try {
		writeFileSync(fd, `${process.pid}\n`);
		const original = readSettings(file);
		let config;
		try { config = original == null ? {} : JSON.parse(original); }
		catch { throw new Error(`Invalid JSON in ${file}; settings were not changed`); }
		if (source === "claude" && config?.disableAllHooks === true) throw new Error("Hooks are disabled by disableAllHooks; review that setting before setup");
		const merged = mergeHooks(config, source);
		const changed = JSON.stringify(config) !== JSON.stringify(merged);
		const destinations = applySkills(plan);
		const backup = changed ? saveSettings(file, original, merged) : null;
		return { file, destinations, backup, changed };
	} finally {
		closeSync(fd);
		unlinkSync(lock);
	}
}
