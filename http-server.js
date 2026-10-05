// Serve only bundled viewer assets and stream the local JSONL file over SSE.
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	truncateSync,
	watch,
} from "node:fs";
import { createServer } from "node:http";
import { DIR, FILE, PORT, URL as VIEWER_URL } from "./config.js";

const ASSETS = new Map([
	["/", ["./index.html", "text/html"]],
	["/app.js", ["./web/app.js", "text/javascript"]],
	["/style.css", ["./web/style.css", "text/css"]],
	["/favicon.svg", ["./favicon.svg", "image/svg+xml"]],
]);
const CSP =
	"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const REPLAY_BYTES = 50 * 1024 * 1024; // ponytail: replay only the last 50MB; paginate if history matters

function readFrom(from, to) {
	const fd = openSync(FILE, "r");
	try {
		const buffer = Buffer.alloc(to - from);
		const bytes = readSync(fd, buffer, 0, buffer.length, from);
		return buffer.subarray(0, bytes);
	} finally {
		closeSync(fd);
	}
}

function eventData(text) {
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => `data: ${line}\n\n`)
		.join("");
}

export function startServer() {
	if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
		throw new Error("PANOPTICON_PORT must be an integer between 1 and 65535");
	}
	mkdirSync(DIR, { recursive: true, mode: 0o700 });
	const clients = new Set();
	const broadcast = (data) => {
		if (data) for (const res of clients) res.write(data);
	};
	const clearClients = () => broadcast("event: clear\ndata: 1\n\n");

	// Keep the offset on a newline boundary, including an incomplete line from a previous process.
	const size = existsSync(FILE) ? statSync(FILE).size : 0;
	const start = Math.max(0, size - REPLAY_BYTES);
	let offset = size ? start + readFrom(start, size).lastIndexOf(10) + 1 : 0;
	const poll = () => {
		if (!existsSync(FILE)) return;
		const size = statSync(FILE).size;
		if (size < offset) {
			offset = 0;
			clearClients();
		}
		if (size > offset) {
			const buffer = readFrom(offset, size);
			const end = buffer.lastIndexOf(10) + 1;
			if (end) {
				broadcast(eventData(buffer.subarray(0, end).toString("utf8")));
				offset += end;
			}
		}
	};

	const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
	const origins = new Set([...hosts].map((host) => `http://${host}`));
	const server = createServer((req, res) => {
		// Block DNS rebinding and cross-origin requests to private traces.
		if (!hosts.has(req.headers.host) || (req.headers.origin && !origins.has(req.headers.origin))) {
			res.writeHead(403);
			return res.end("Forbidden");
		}
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Cache-Control", "no-store");
		try {
			if (req.url === "/ping" && req.method === "GET") return res.end("panopticon");
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
					res.write(eventData(text));
				}
				res.write("event: ready\ndata: 1\n\n");
				clients.add(res);
				res.on("close", () => clients.delete(res));
				return;
			}
			const asset = ASSETS.get(req.url);
			if (asset && req.method === "GET") {
				const [path, type] = asset;
				const content = readFileSync(new URL(path, import.meta.url));
				if (req.url === "/") res.setHeader("Content-Security-Policy", CSP);
				res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
				return res.end(content);
			}
			res.writeHead(404);
			res.end("Not found");
		} catch (error) {
			console.error(`panopticon: ${error.message}`);
			if (!res.headersSent) res.writeHead(500);
			res.end("Unable to read telemetry");
		}
	});
	server.on("error", (error) => {
		console.error(`panopticon: ${error.message}`);
		process.exit(1);
	});
	server.listen(PORT, "127.0.0.1", () =>
		console.log(`panopticon: ${VIEWER_URL}\nLogs: ${FILE}\nPress Ctrl+C to stop.`),
	);
	const watcher = watch(DIR, poll);
	const timer = setInterval(poll, 1000); // fs.watch is unreliable on some mounts
	server.on("close", () => {
		watcher.close();
		clearInterval(timer);
	});
	return server;
}
