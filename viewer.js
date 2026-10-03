// Shared viewer launcher for /agenttel in Pi and agenttel open in other agents.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { URL } from "./config.js";

export async function openViewer(notify) {
	const alive = () => fetch(`${URL}/ping`, { signal: AbortSignal.timeout(500) })
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
			notify(`agenttel: could not start the viewer at ${URL}. Check the port or run agenttel in a terminal.`, "error");
			return false;
		}
	}
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
	const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", URL] : [URL];
	const browser = spawn(command, args, { detached: true, stdio: "ignore" });
	const fallback = () => notify(`agenttel: open ${URL} in your browser`, "warning");
	browser.on("error", fallback);
	browser.on("exit", (code) => { if (code) fallback(); });
	browser.unref();
	try { await once(browser, "spawn"); } catch { /* The error handler already reported the fallback URL. */ }
	notify(`agenttel: ${URL}`, "info");
	return true;
}
