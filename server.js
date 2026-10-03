#!/usr/bin/env node
// Serve the local trace viewer and stream events.jsonl over SSE.
import { createServer } from "node:http";
import { readFileSync, statSync, openSync, readSync, closeSync, watch, existsSync, truncateSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DIR, FILE, PORT, URL } from "./config.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: agenttel

Start the local Pi telemetry viewer. Press Ctrl+C to stop.

Environment:
  AGENTTEL_DIR   Log directory (default: ~/.pi/agent/agenttel)
  AGENTTEL_PORT  Viewer port (default: 7777)
  PI_TRACE_PORT Legacy alias for AGENTTEL_PORT

Logs are local and may contain sensitive prompts, tool arguments, and results.`);
	process.exit(0);
}
if (process.argv.length > 2) {
	console.error("Unknown argument. Run agenttel --help for usage.");
	process.exit(1);
}

const HTML = fileURLToPath(new globalThis.URL("./index.html", import.meta.url));
const REPLAY_BYTES = 50 * 1024 * 1024; // ponytail: replay only the last 50MB; paginate if history matters
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const clients = new Set();

const readFrom = (from, to) => {
	const fd = openSync(FILE, "r");
	try {
		const buf = Buffer.alloc(to - from);
		const bytes = readSync(fd, buf, 0, buf.length, from);
		return buf.subarray(0, bytes);
	} finally {
		closeSync(fd);
	}
};

// Keep the offset on a newline boundary, including an incomplete line from a previous process.
const size = existsSync(FILE) ? statSync(FILE).size : 0;
const start = Math.max(0, size - REPLAY_BYTES);
let offset = size ? start + readFrom(start, size).lastIndexOf(10) + 1 : 0;
const broadcast = (text) => {
	const data = text.split("\n").filter(Boolean).map((line) => `data: ${line}\n\n`).join("");
	if (data) for (const res of clients) res.write(data);
};
const clearClients = () => {
	for (const res of clients) res.write("event: clear\ndata: 1\n\n");
};
const poll = () => {
	if (!existsSync(FILE)) return;
	const size = statSync(FILE).size;
	if (size < offset) { offset = 0; clearClients(); }
	if (size > offset) {
		const buf = readFrom(offset, size);
		const end = buf.lastIndexOf(10) + 1;
		if (end) {
			broadcast(buf.subarray(0, end).toString("utf8"));
			offset += end;
		}
	}
};

const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const server = createServer((req, res) => {
	// Block DNS rebinding and cross-origin requests to private traces.
	if (!hosts.has(req.headers.host) || (req.headers.origin && ![...hosts].some((host) => req.headers.origin === `http://${host}`))) {
		res.writeHead(403);
		return res.end("Forbidden");
	}
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cache-Control", "no-store");
	try {
		if (req.url === "/ping" && req.method === "GET") return res.end("agenttel");
		if (req.url === "/clear" && req.method === "POST") {
			if (existsSync(FILE)) truncateSync(FILE, 0);
			offset = 0;
			clearClients();
			return res.end("ok");
		}
		if (req.url === "/events" && req.method === "GET") {
			poll();
			res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
			if (offset) {
				const start = Math.max(0, offset - REPLAY_BYTES);
				let text = readFrom(start, offset).toString("utf8");
				if (start > 0) text = text.slice(text.indexOf("\n") + 1);
				for (const line of text.split("\n")) if (line) res.write(`data: ${line}\n\n`);
			}
			res.write("event: ready\ndata: 1\n\n");
			clients.add(res);
			res.on("close", () => clients.delete(res));
			return;
		}
		if (req.url === "/" && req.method === "GET") {
			const html = readFileSync(HTML);
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
			return res.end(html);
		}
		res.writeHead(404);
		res.end("Not found");
	} catch (error) {
		console.error(`agenttel: ${error.message}`);
		if (!res.headersSent) res.writeHead(500);
		res.end("Unable to read telemetry");
	}
});
server.on("error", (error) => {
	console.error(`agenttel: ${error.message}`);
	process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => console.log(`agenttel: ${URL}\nLogs: ${FILE}\nPress Ctrl+C to stop.`));
watch(DIR, poll);
setInterval(poll, 1000); // fs.watch is unreliable on some mounts
