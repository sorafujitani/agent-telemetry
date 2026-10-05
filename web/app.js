// Localhost-only viewer of the user's own trace file; every interpolated value passes through esc().
// Rendering policy: data ticks re-render #stats/#body only for the selected session and only when it changed;
// user clicks never re-render #body (class toggles only) so the viewport never jumps.
const side = document.getElementById("side");
const sq = document.getElementById("sq");
const clear = document.getElementById("clear");
const head = document.getElementById("head");
const tq = document.getElementById("tq");
const body = document.getElementById("body");
const jump = document.getElementById("jump");
const detail = document.getElementById("detail");
const mainEl = document.getElementById("mainEl");
const stats = document.getElementById("stats");

const sessions = new Map();
let selected = null,
	tab = "timeline",
	ready = false;
const filt = { q: "", err: false, slow: false, notify: false };
const open = new Set(); // expanded prompt/text/think keys and open runs
let sel = null; // selected tool call id (right pane)
let bodyKey = "",
	bodyVer = -1,
	dirtySide = false;

const fmt = (n) =>
	n == null
		? "–"
		: n >= 1e6
			? `${(n / 1e6).toFixed(2)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}k`
				: String(n);
const ms = (n) =>
	n == null
		? "…"
		: n >= 60e3
			? `${(n / 60e3).toFixed(1)}m`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}s`
				: `${n}ms`;
const usd = (n) =>
	n == null
		? null
		: n >= 1
			? `$${n.toFixed(2)}`
			: n >= 0.01
				? `$${n.toFixed(3)}`
				: `$${n.toFixed(4)}`;
const pc = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const setHTML = (el, html) =>
	el.replaceChildren(document.createRange().createContextualFragment(html)); // all interpolations pass through esc()
const esc = (s) =>
	String(s ?? "").replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	);
const base = (p) => (p || "").split("/").slice(-2).join("/");
const sumKnown = (values) =>
	values.length && values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null;
const hit = (u) =>
	u && Number.isFinite(u.input) && Number.isFinite(u.cacheRead) && u.input + u.cacheRead
		? u.cacheRead / (u.input + u.cacheRead)
		: null;
// Parse JSON that may have been cut mid-way (legacy 200-char cap): close open string/brackets, drop a dangling key.
function lenient(s) {
	if (typeof s !== "string") return null;
	try {
		return { value: JSON.parse(s), truncated: false };
	} catch {}
	let str = false,
		escp = false;
	const stack = [];
	for (const ch of s) {
		if (str) {
			if (escp) escp = false;
			else if (ch === "\\") escp = true;
			else if (ch === '"') str = false;
			continue;
		}
		if (ch === '"') str = true;
		else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
		else if (ch === "}" || ch === "]") stack.pop();
	}
	let t = s.replace(/\u2026$/, "");
	if (escp) t = t.slice(0, -1);
	if (str) t += '"';
	else t = t.replace(/,\s*("[^"]*"?\s*:?\s*)?$/, "").replace(/:\s*$/, ":null");
	try {
		return { value: JSON.parse(t + stack.reverse().join("")), truncated: true };
	} catch {
		return null;
	}
}
const pretty = (s) => {
	const p = lenient(s);
	return p ? JSON.stringify(p.value, null, 2) : s;
};
const TRUNC = `<span class="tag warn" title="recorded with an older 200-char cap; showing what was captured">truncated</span>`;
// overlap of tool-call time windows inside one turn = what ran in parallel
const endOf = (c) => (c.ms == null ? Date.now() : c.t + c.ms);
const overlaps = (a, b) => a !== b && a.t < endOf(b) && b.t < endOf(a);
const isPeer = (a, b) =>
	!!a &&
	!!b &&
	a.run === b.run &&
	a.turn === b.turn &&
	overlaps(a, b) &&
	a.parent !== b.id &&
	b.parent !== a.id;
const peers = (c, t) => (t?.tools ?? []).filter((o) => isPeer(c, o));
const turnOf = (c) => c?.run?.turns.find((t) => t.turn === c.turn);
const MAIN = {
	bash: "command",
	Bash: "command",
	read: "path",
	Read: "file_path",
	write: "path",
	Write: "file_path",
	edit: "path",
	Edit: "file_path",
	apply_patch: "command",
	codemode: "code",
	web_search: "query",
	fetch_content: "url",
};
function summ(tool, args) {
	const p = lenient(args);
	if (!p) return esc(args);
	const o = p.value;
	if (!o || typeof o !== "object") return esc(args);
	const main = MAIN[tool] ?? Object.keys(o)[0];
	const v = o[main];
	let head = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
	if (tool === "codemode")
		head = head.replace(/\s+/g, " ").replace(/^const \w+ ?= ?await Promise\.allSettled\(\[/, "∥ ");
	const rest = Object.entries(o)
		.filter(([k, x]) => k !== main && x != null && x !== "")
		.map(
			([k, x]) =>
				`<span class="k">${esc(k)}=</span>${esc(typeof x === "string" ? x : JSON.stringify(x)).slice(0, 40)}`,
		);
	return (
		esc(head.slice(0, 300)) + (rest.length ? `  <span class="k">·</span> ${rest.join(" ")}` : "")
	);
}
const chip = (k, v, cls = "") =>
	v == null || v === "" ? "" : `<span class="chip ${cls}">${k} <b>${v}</b></span>`;
const hitChip = (h) =>
	h == null ? "" : chip("hit", `${Math.round(h * 100)}%`, `hit${h < 0.5 ? " low" : ""}`);
const lowHit = (h) => (h != null && h < 0.5 ? hitChip(h) : ""); // cache hit is ~100% normally; only surface misses
const costChip = (c) => chip("cost", usd(c) ?? "–", "cost");

function ingest(e) {
	let s = sessions.get(e.sid);
	if (!s) {
		s = {
			sid: e.sid,
			source: e.source ?? "pi",
			scope: e.scope,
			cwd: e.cwd,
			pid: e.pid,
			runs: [],
			tools: new Map(),
			compacts: 0,
			cost: null,
			ver: 0,
		};
		sessions.set(e.sid, s);
	}
	Object.assign(s, {
		model: e.model ?? s.model,
		ctx: e.ctx ?? s.ctx,
		win: e.win ?? s.win,
		last: Math.max(s.last ?? e.t, e.t),
	});
	s.ver++;
	dirtySide = true;
	// Recording, clearing, or a bounded replay can miss the run/turn start events.
	const activity = ["turn_start", "turn_end", "tool_start", "tool_end"].includes(e.type);
	const start = { ...e, t: e.ms == null ? e.t : e.t - e.ms };
	if (activity && !s.busy && (e.scope !== "response" || e.type === "tool_start")) {
		ingest({
			...start,
			type: "run_start",
			prompt: `[recording started during ${e.scope === "response" ? "response" : "run"}]`,
		});
	}
	const run = s.runs[s.runs.length - 1];
	if (activity && run && !run.turns.length && e.type !== "turn_start") {
		ingest({ ...start, type: "turn_start", turn: e.turn ?? 0 });
	}
	const turn = run?.turns[run.turns.length - 1];
	if (e.type === "tool_end" && !s.tools.has(e.id) && e.ms != null) {
		ingest({ ...start, type: "tool_start", args: e.args ?? "" });
	}
	switch (e.type) {
		case "run_start":
			s.runs.push({
				n: s.runs.length + 1,
				scope: e.scope,
				t: e.t,
				prompt: e.prompt,
				promptChars: e.promptChars,
				sysChars: e.sysChars,
				ntools: e.tools,
				turns: [],
				ms: null,
				in: null,
				out: null,
				cache: null,
				cost: null,
			});
			s.busy = true;
			s.title ??= e.prompt;
			open.add(`${e.sid}run${s.runs.length}`);
			break;
		case "turn_start":
			if (run) run.turns.push({ run, t: e.t, turn: e.turn, tools: [], ms: null });
			break;
		case "turn_end":
			if (turn) {
				Object.assign(turn, {
					ms: e.ms ?? Math.max(0, e.t - turn.t),
					usage: e.usage,
					stop: e.stop,
					error: e.error,
					text: e.text,
					thinking: typeof e.thinking === "string" ? e.thinking : undefined,
					model: e.model,
					ctx: e.ctx,
				});
				turn.toolMs = turn.tools.filter((c) => !c.parent).reduce((a, c) => a + (c.ms || 0), 0);
				turn.modelMs = run.scope === "response" ? null : Math.max(0, turn.ms - turn.toolMs);
				run.in = sumKnown(run.turns.map((t) => t.usage?.input));
				run.out = sumKnown(run.turns.map((t) => t.usage?.output));
				run.cache = sumKnown(run.turns.map((t) => t.usage?.cacheRead));
				run.cost = sumKnown(run.turns.map((t) => t.usage?.cost?.total));
				s.cost = sumKnown(s.runs.map((r) => r.cost));
			}
			break;
		case "tool_start": {
			const tc = {
				id: e.id,
				parent: e.parent,
				tool: e.tool,
				args: e.args,
				t: e.t,
				ms: null,
				run,
				turn: turn?.turn,
			};
			s.tools.set(e.id, tc);
			turn?.tools.push(tc);
			break;
		}
		case "tool_end": {
			const tc = s.tools.get(e.id);
			if (tc)
				Object.assign(tc, {
					ms: e.ms ?? Math.max(0, e.t - tc.t),
					args: e.args ?? tc.args,
					isError: e.isError,
					out: e.out,
					result: e.result ?? e.err,
				});
			break;
		}
		case "run_end":
			if (run) run.ms = e.ms ?? Math.max(0, e.t - run.t);
			s.busy = false;
			if (ready && filt.notify && document.hidden)
				new Notification(`${s.source} done · ${base(s.cwd)}`, {
					body: `${ms(run?.ms)} · ${run?.turns.length ?? 0} ${run?.scope === "response" ? "responses" : "turns"} · ${(run?.prompt || "").slice(0, 80)}`,
				});
			break;
		case "session_end":
			if (s.busy) {
				ingest({ ...e, type: "turn_end", stop: "interrupted" });
				ingest({ ...e, type: "run_end" });
			}
			break;
		case "compact":
			s.compacts++;
			if (run) run.compact = e.reason;
			break;
	}
}

const allTools = (s) => s.runs.flatMap((r) => r.turns.flatMap((t) => t.tools));
const allTurns = (s) => s.runs.flatMap((r) => r.turns);
const match = (c) =>
	(!filt.err || c.isError) &&
	(!filt.slow || c.ms > 10e3) &&
	(!filt.q || `${c.tool} ${c.args}`.toLowerCase().includes(filt.q));

function flags(run) {
	const f = [],
		tools = run.turns.flatMap((t) => t.tools);
	if (run.turns.length >= 10) f.push(`<span class="warn">⟳ ${run.turns.length} turns</span>`);
	const seen = new Map();
	let dup = 0;
	for (const c of tools) {
		const k = c.tool + c.args;
		seen.set(k, (seen.get(k) || 0) + 1);
		if (seen.get(k) === 2) dup++;
	}
	if (dup) f.push(`<span class="warn">↻ ${dup} repeated calls</span>`);
	const errs =
		tools.filter((c) => c.isError).length +
		run.turns.filter((t) => t.error || t.stop === "error").length;
	if (errs) f.push(`<span class="err">✗ ${errs} errors</span>`);
	const slow = tools.filter((c) => c.ms > 10e3).length;
	if (slow) f.push(`<span class="warn">⏱ ${slow} slow tools</span>`);
	if (run.compact) f.push(`<span class="acc">⇣ compact(${esc(run.compact)})</span>`);
	return f.join("");
}

const pct = (s) =>
	s.ctx != null && s.win ? Math.min(100, Math.round((100 * s.ctx) / s.win)) : null;
const ctxBar = (s) =>
	pct(s) == null
		? ""
		: `<div class="bar"><i class="${pct(s) > 80 ? "err" : pct(s) > 60 ? "warn" : ""}" style="width:${pct(s)}%"></i></div>`;

// Sessions whose prompt fired before recording was enabled have no runs to show.
const listed = () =>
	[...sessions.values()].filter((s) => s.runs.length).sort((a, b) => b.last - a.last);

function renderSide() {
	dirtySide = false;
	const q = sq.value.toLowerCase();
	const list = listed().filter(
		(s) => !q || `${s.source} ${s.cwd} ${s.title} ${s.model}`.toLowerCase().includes(q),
	);
	const top = side.scrollTop;
	setHTML(
		side,
		list
			.map(
				(s) => `<div class="s ${s.sid === selected ? "on" : ""}" data-sid="${esc(s.sid)}">
    <div>${s.busy ? '<span class="live">●</span>' : '<span class="dim">○</span>'} ${esc(base(s.cwd))} <span class="dim">${esc(s.source)}${s.pid != null ? ` #${esc(s.pid)}` : ""}</span></div>
    <div class="ttl">${esc(s.title ?? "")}</div>
    <div class="cwd">${esc(s.model)} · ${s.runs.length} runs${s.cost ? ` · ${usd(s.cost)}` : ""} · ${new Date(s.last).toLocaleTimeString()}</div>${ctxBar(s)}</div>`,
			)
			.join(""),
	);
	side.scrollTop = top;
}

function renderStats(s) {
	const tot = {
		in: sumKnown(s.runs.map((r) => r.in)),
		out: sumKnown(s.runs.map((r) => r.out)),
		cache: sumKnown(s.runs.map((r) => r.cache)),
	};
	setHTML(
		stats,
		`<h2>${esc(s.cwd)}</h2>
  <div class="kv"><span>agent <b>${esc(s.source)}</b></span><span>model <b>${esc(s.model ?? "–")}</b></span><span>ctx <b>${fmt(s.ctx)} / ${fmt(s.win)} (${pct(s) == null ? "–" : `${pct(s)}%`})</b></span>
    <span>Σ in <b>${fmt(tot.in)}</b></span><span>Σ out <b>${fmt(tot.out)}</b></span>${hitChip(hit({ input: tot.in, cacheRead: tot.cache }))}${costChip(s.cost)}${s.compacts ? `<span>compacts <b>${s.compacts}</b></span>` : ""}
    ${((r) => (r ? `<span title="system prompt ≈tokens / active tools (latest run)">sys ≈<b>${fmt(r.sysChars == null ? null : Math.round(r.sysChars / 4))}</b> · tools <b>${r.ntools ?? "–"}</b></span>` : ""))(s.runs.at(-1))}<span class="ttl" title="${esc(s.sid)}">${esc(s.sid.slice(0, 8))}</span></div>
  ${ctxBar(s)}`,
	);
}

const nearBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 60;
function renderBody(force) {
	const s = sessions.get(selected);
	if (!s) return;
	const key = `${selected}|${tab}|${filt.q}${filt.err}${filt.slow}`;
	if (!force && key === bodyKey && bodyVer === s.ver) return;
	const fresh = key !== bodyKey,
		stick = fresh || nearBottom();
	const top = body.scrollTop;
	setHTML(body, tab === "exec" ? renderExec(s) : s.runs.map(renderRun).join(""));
	body.scrollTop = tab === "exec" && fresh ? 0 : stick ? body.scrollHeight : top;
	bodyKey = key;
	bodyVer = s.ver;
	jump.classList.toggle("show", tab === "timeline" && !nearBottom());
}

function renderRun(r) {
	const h = hit({ input: r.in, cacheRead: r.cache });
	return `<details class="run" ${open.has(`${selected}run${r.n}`) ? "open" : ""} data-run="${r.n}"><summary>
    <div class="th"><span class="n">#${r.n}</span><span class="dim">${new Date(r.t).toLocaleTimeString()}</span><span>${r.ms == null ? '<span class="live">running…</span>' : ms(r.ms)}</span>
      ${chip(r.scope === "response" ? "responses" : "turns", r.turns.length)}${chip("in", fmt(r.in))}${chip("out", fmt(r.out))}${lowHit(h)}${costChip(r.cost)}</div>
    <div class="prompt ${open.has(`p${r.n}`) ? "x" : ""}" data-x="p${r.n}">${esc(r.prompt)}</div><div class="flags">${flags(r)}</div>${waterfall(r)}</summary>
    ${r.turns.map(renderTurn).join("")}</details>`;
}

function waterfall(r) {
	if (r.scope === "response") return ""; // Hooks do not expose individual model-call timing.
	const total = r.ms ?? r.turns.reduce((a, t) => a + (t.ms || 0), 0);
	if (!total) return "";
	return `<div class="wf">${r.turns
		.map((t) =>
			t.ms == null
				? ""
				: `<i class="m" style="width:${(100 * t.modelMs) / total}%" title="turn ${t.turn} model ${ms(t.modelMs)}"></i>` +
					t.tools
						.filter((c) => !c.parent && c.ms != null)
						.map(
							(c) =>
								`<i class="${c.isError ? "e" : "t"}" style="width:${(100 * c.ms) / total}%" title="turn ${t.turn} ${esc(c.tool)} ${ms(c.ms)}"></i>`,
						)
						.join(""),
		)
		.join("")}</div>`;
}

function renderTurn(t) {
	const u = t.usage || {},
		h = hit(u);
	const bad = t.error || t.stop === "error",
		slow = t.ms > 60e3;
	const k = `t${t.run.n}_${t.turn}`;
	return `<div class="turn ${bad ? "bad" : slow ? "slow" : ""}">
    <div class="th"><span class="n">${t.run.scope === "response" ? "response" : `turn ${t.turn}`}</span>
      ${t.ms == null ? '<span class="live">running…</span>' : `<span>${ms(t.ms)}</span>${t.run.scope === "response" ? "" : `<span class="tbar" title="model ${ms(t.modelMs)} / tools ${ms(t.toolMs)}"><i style="width:${pc(t.modelMs, t.ms)}"></i><i style="width:${pc(t.toolMs, t.ms)}"></i></span>`}`}
      <span title="in ${fmt(u.input)} · cacheRead ${fmt(u.cacheRead)} · hit ${h != null ? `${Math.round(h * 100)}%` : "–"} · cost ${usd(u.cost?.total) ?? "–"}">${chip("out", fmt(u.output))}${u.reasoning ? chip("think", fmt(u.reasoning)) : ""}${lowHit(h)}${chip("ctx", fmt(t.ctx))}</span>
      ${t.stop && t.stop !== "toolUse" && t.stop !== "stop" ? `<span class="${bad ? "err" : "dim"}">${esc(t.stop)}</span>` : ""}</div>
    ${t.error ? `<div class="errmsg">${esc(t.error)}</div>` : ""}
    ${t.thinking ? `<div class="think ${open.has(`${k}k`) ? "x" : ""}" data-x="${k}k" title="thinking">💭 ${esc(t.thinking)}</div>` : ""}
    ${t.tools.some((c) => peers(c, t).length) ? gantt(t) : ""}
    ${t.tools.map((c) => renderTool(c, t)).join("")}
    ${t.text ? `<div class="text ${open.has(k) ? "x" : ""}" data-x="${k}">${esc(t.text)}</div>` : ""}</div>`;
}

const mark = (c) =>
	c.ms == null
		? '<span class="live">●</span>'
		: c.isError == null
			? '<span class="dim" title="terminal status unavailable">?</span>'
			: c.isError
				? '<span class="err">✗</span>'
				: '<span class="ok">✓</span>';
function renderTool(c, t = turnOf(c)) {
	const n = t ? peers(c, t).length : 0;
	const parallel = isPeer(c, sessions.get(selected)?.tools.get(sel));
	return `<div class="tool ${c.parent ? "nested" : ""} ${sel === c.id ? "sel" : ""} ${parallel ? "parallel" : ""} ${match(c) ? "" : "hide"}" data-id="${esc(c.id)}">
    <span>${mark(c)}</span><span class="name">${esc(c.tool)}${n ? `<span class="par" title="${n} concurrent">∥${n}</span>` : ""}</span><span class="ms ${c.ms > 10e3 ? "slow" : ""}">${ms(c.ms)}</span><span class="sz">${c.out != null ? `${fmt(c.out)}c` : ""}</span>
    <span class="args">${summ(c.tool, c.args)}</span></div>`;
}

// per-turn gantt: x = time since the turn started; bars on the same x range ran in parallel
function gantt(t, focus = sessions.get(selected)?.tools.get(sel)) {
	const t0 = t.t,
		end = Math.max(t.t + (t.ms ?? 0), ...t.tools.map(endOf)),
		span = Math.max(1, end - t0);
	const x = (v) => `${((100 * (v - t0)) / span).toFixed(2)}%`;
	return `<div class="gantt ${t.tools.includes(focus) ? "has-focus" : ""}" style="--rows:${t.tools.length}">${t.tools.map((c, i) => `<i class="${c.isError ? "e" : c.ms == null ? "r" : ""} ${c.parent ? "nested" : ""} ${focus === c ? "focus" : ""} ${isPeer(c, focus) ? "parallel" : ""}" data-id="${esc(c.id)}" style="top:${i * 8}px;left:${x(c.t)};width:max(2px,${((100 * (endOf(c) - c.t)) / span).toFixed(2)}%)" title="${esc(c.tool)} ${ms(c.ms)} · +${ms(c.t - t0)}"></i>`).join("")}
    <b style="left:${x(t0)}">0</b><b style="left:${x(end)};transform:translateX(-100%)">${ms(span)}</b></div>`;
}

// what the harness actually did, reconstructed per tool from the final (post-hook) arguments
const diff = (o, n) =>
	(o ?? "")
		.split("\n")
		.map((l) => `<i class="d">- ${esc(l)}</i>`)
		.join("") +
	(n ?? "")
		.split("\n")
		.map((l) => `<i class="a">+ ${esc(l)}</i>`)
		.join("");
function executed(c, s) {
	const p = lenient(c.args);
	if (!p) return `<pre>${esc(c.args)}</pre>`;
	const a = p.value;
	if (!a || typeof a !== "object") return "";
	return executedBody(c, s, a);
}
function executedBody(c, s, a) {
	switch (c.tool.toLowerCase()) {
		case "bash":
			return `<div class="kvs"><span>cwd</span><span>${esc(s.cwd)}</span>${a.timeout ? `<span>timeout</span><span>${esc(a.timeout)}s</span>` : ""}</div><pre class="sh">$ ${esc(a.command)}</pre>`;
		case "read": {
			const from = a.offset ?? 1;
			return `<div class="kvs"><span>file</span><span>${esc(a.path ?? a.file_path)}</span><span>lines</span><span>${esc(from)} – ${a.limit ? esc(from + a.limit - 1) : "end"}</span></div>`;
		}
		case "write":
			return `<div class="kvs"><span>file</span><span>${esc(a.path ?? a.file_path)}</span><span>size</span><span>${fmt((a.content || "").length)} chars</span></div><pre>${esc(a.content)}</pre>`;
		case "edit": {
			const edits = a.edits ?? [{ oldText: a.old_string, newText: a.new_string }];
			return (
				`<div class="kvs"><span>file</span><span>${esc(a.path ?? a.file_path)}</span><span>edits</span><span>${edits.length}</span>${a.replace_all ? "<span>replace all</span><span>yes</span>" : ""}</div>` +
				edits
					.map(
						(e, i) => `<h5>edit ${i + 1}</h5><pre class="diff">${diff(e.oldText, e.newText)}</pre>`,
					)
					.join("")
			);
		}
		case "codemode": {
			const kids = [...s.tools.values()].filter((k) => k.parent === c.id);
			return `<pre class="sh">${esc(a.code)}</pre>${kids.length ? `<h5>nested calls (${kids.length})</h5>${kids.map((k) => renderTool(k)).join("")}` : ""}`;
		}
		default:
			return `<div class="kvs">${Object.entries(a)
				.map(
					([k, v]) =>
						`<span>${esc(k)}</span><span>${esc(typeof v === "string" ? v : JSON.stringify(v))}</span>`,
				)
				.join("")}</div>`;
	}
}

function renderDetail() {
	const s = sessions.get(selected),
		c = s?.tools.get(sel);
	mainEl.classList.toggle("has-detail", !!c);
	if (!c) return setHTML(detail, "");
	const parent = c.parent ? s.tools.get(c.parent) : null;
	const status =
		c.ms == null
			? '<span class="live">● running</span>'
			: c.isError == null
				? '<span class="dim">? status unknown</span>'
				: c.isError
					? '<span class="err">✗ error</span>'
					: '<span class="ok">✓ ok</span>';
	setHTML(
		detail,
		`<div class="dh"><span class="name">${esc(c.tool)}</span>${status}<span class="dim">run #${c.run?.n} · turn ${c.turn}</span><button id="dclose" title="Esc">✕ close</button></div>
  <div class="kvs"><span>started</span><span>${new Date(c.t).toLocaleTimeString()}</span><span>duration</span><span class="${c.ms > 10e3 ? "warn" : ""}">${ms(c.ms)}</span><span>output size</span><span>${c.out != null ? `${fmt(c.out)} chars` : "–"}</span>${parent ? `<span>called by</span><span class="tool-link" data-id="${esc(parent.id)}" style="cursor:pointer;color:var(--acc)">${esc(parent.tool)} ↗</span>` : ""}<span>id</span><span class="dim">${esc(c.id)}</span></div>
  ${(() => {
		const t = turnOf(c),
			ps = peers(c, t);
		return ps.length
			? `<h4>Parallel <small>${ps.length} overlapping</small></h4>${gantt(t, c)}${ps.map((p) => renderTool(p, t)).join("")}`
			: "";
	})()}
  <h4>Executed ${lenient(c.args)?.truncated ? TRUNC : ""}</h4>${executed(c, s)}
  <h4>Result${c.ms == null ? ` <span class="tag live">running</span>` : c.isError ? ` <span class="tag err">error</span>` : ""}${c.out > 32000 ? ` <span class="tag">first 32k characters</span>` : ""}</h4><pre class="${c.isError ? "err" : ""}">${c.result != null ? esc(c.result) : c.ms == null ? "" : c.out ? `<span class="dim">not recorded</span>` : "(empty)"}</pre>
  <h4>Arguments ${lenient(c.args)?.truncated ? TRUNC : ""}</h4><pre>${esc(pretty(c.args))}</pre>`,
	);
}

function spark(turns) {
	const pts = turns.filter((t) => t.ctx != null);
	if (pts.length < 2) return "";
	const max = Math.max(...pts.map((t) => t.ctx)),
		w = 1000,
		h = 60;
	const xy = pts
		.map((t, i) => `${(i / (pts.length - 1)) * w},${h - (t.ctx / (max || 1)) * (h - 6) - 3}`)
		.join(" ");
	return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="var(--acc)" stroke-width="2" points="${xy}"/></svg>
  <div class="kv"><span>ctx growth over ${pts.length} turns</span><span>max <b>${fmt(max)}</b></span><span>avg Δ/turn <b>${fmt(Math.round((pts.at(-1).ctx - pts[0].ctx) / (pts.length - 1)))}</b></span></div>`;
}

function renderExec(s) {
	const turns = allTurns(s).filter((t) => t.ms != null),
		tools = allTools(s).filter((c) => c.ms != null && match(c));
	const wall = s.runs.reduce((a, r) => a + (r.ms || 0), 0);
	const modelMs = sumKnown(turns.map((t) => t.modelMs)),
		toolMs = turns.reduce((a, t) => a + t.toolMs, 0);
	const byTool = new Map();
	for (const c of tools) {
		const b = byTool.get(c.tool) ?? { tool: c.tool, n: 0, err: 0, ms: 0, max: 0, out: 0 };
		b.n++;
		b.err = c.isError == null || b.err == null ? null : b.err + (c.isError ? 1 : 0);
		b.ms += c.ms;
		b.max = Math.max(b.max, c.ms);
		b.out += c.out || 0;
		byTool.set(c.tool, b);
	}
	const rows = [...byTool.values()].sort((a, b) => b.ms - a.ms);
	const top = rows[0]?.ms || 1,
		sumRows = rows.reduce((a, b) => a + b.ms, 0); // nested calls (codemode→bash) count in both rows
	const slowTools = [...tools].sort((a, b) => b.ms - a.ms).slice(0, 20);
	const slowTurns = [...turns]
		.sort((a, b) => (s.scope === "response" ? b.ms - a.ms : b.modelMs - a.modelMs))
		.slice(0, 10);
	const bar = (v, max, cls) =>
		`<span class="bar"><i class="${cls}" style="width:${Math.round((100 * v) / max)}%"></i></span>`;
	return `
  <h3>time breakdown</h3>
  ${s.scope === "response" ? "" : `<div class="bar" style="height:14px"><i class="model" style="width:${pc(modelMs, modelMs + toolMs)}"></i><i class="tool" style="width:${pc(toolMs, modelMs + toolMs)}"></i></div>`}
  <div class="kv"><span>wall <b>${ms(wall)}</b></span><span><span style="color:var(--model)">■</span> model <b>${modelMs == null ? "–" : ms(modelMs)}</b> ${modelMs == null ? "" : pc(modelMs, modelMs + toolMs)}</span><span><span class="acc">■</span> tools <b>${ms(toolMs)}</b> ${modelMs == null ? "(sum)" : pc(toolMs, modelMs + toolMs)}</span><span>turns <b>${turns.length}</b></span><span>tool calls <b>${tools.length}</b></span>${costChip(s.cost)}</div>
  <h3>context</h3>${spark(turns)}
  <h3>by tool</h3>
  <table><tr><th>tool</th><th class="n">calls</th><th class="n">errors</th><th class="n">total</th><th class="n">avg</th><th class="n">max</th><th class="n">output</th><th>share</th></tr>
  ${rows.map((b) => `<tr><td>${esc(b.tool)}</td><td class="n">${b.n}</td><td class="n ${b.err ? "err" : ""}">${fmt(b.err)}</td><td class="n">${ms(b.ms)}</td><td class="n">${ms(Math.round(b.ms / b.n))}</td><td class="n">${ms(b.max)}</td><td class="n">${fmt(b.out)}c</td><td>${bar(b.ms, top, "tool")}${pc(b.ms, sumRows)}</td></tr>`).join("")}</table>
  <h3>slowest tool calls</h3>
  <table><tr><th>ms</th><th>tool</th><th>run/turn</th><th>args</th></tr>
  ${slowTools.map((c) => `<tr class="tool ${sel === c.id ? "sel" : ""} ${isPeer(c, s.tools.get(sel)) ? "parallel" : ""}" data-id="${esc(c.id)}"><td class="${c.ms > 10e3 ? "warn" : ""}">${ms(c.ms)}</td><td>${c.isError ? '<span class="err">✗</span> ' : ""}${esc(c.tool)}</td><td class="dim">#${c.run?.n}/${c.turn}</td><td class="w">${summ(c.tool, c.args)}</td></tr>`).join("")}</table>
  <h3>slowest ${s.scope === "response" ? "responses" : "model turns"}</h3>
  <table><tr><th>${s.scope === "response" ? "response ms" : "model ms"}</th><th>run/turn</th><th class="n">in</th><th class="n">out</th><th class="n">think</th><th class="n">cache hit</th><th class="n">cost</th><th>ctx</th><th>stop</th><th>text</th></tr>
  ${slowTurns
		.map((t) => {
			const u = t.usage || {},
				h = hit(u);
			return `<tr><td class="${t.modelMs > 60e3 ? "warn" : ""}">${ms(t.run.scope === "response" ? t.ms : t.modelMs)}</td><td class="dim">#${t.run.n}/${t.turn}</td><td class="n">${fmt(u.input)}</td><td class="n">${fmt(u.output)}</td><td class="n">${fmt(u.reasoning)}</td><td class="n">${h != null ? `${Math.round(h * 100)}%` : "–"}</td><td class="n">${usd(u.cost?.total) ?? "–"}</td><td>${fmt(t.ctx)}</td><td>${esc(t.stop)}</td><td class="w">${esc(t.text)}</td></tr>`;
		})
		.join("")}</table>
  <h3>runs</h3>
  <table><tr><th>#</th><th>wall</th><th>model / tools</th><th class="n">turns</th><th class="n">calls</th><th class="n">in</th><th class="n">out</th><th class="n">cache hit</th><th class="n">cost</th><th>prompt</th></tr>
  ${s.runs
		.map((r) => {
			const tm = r.turns.reduce((a, t) => a + (t.modelMs || 0), 0),
				tt = r.turns.reduce((a, t) => a + (t.toolMs || 0), 0),
				h = hit({ input: r.in, cacheRead: r.cache });
			return `<tr><td>#${r.n}</td><td>${ms(r.ms)}</td><td><span class="bar"><i class="model" style="width:${pc(tm, tm + tt)}"></i><i class="tool" style="width:${pc(tt, tm + tt)}"></i></span>${r.scope === "response" ? "–" : ms(tm)} / ${ms(tt)}</td><td class="n">${r.turns.length}</td><td class="n">${r.turns.reduce((a, t) => a + t.tools.length, 0)}</td><td class="n">${fmt(r.in)}</td><td class="n">${fmt(r.out)}</td><td class="n">${h != null ? `${Math.round(h * 100)}%` : "–"}</td><td class="n">${usd(r.cost) ?? "–"}</td><td class="w">${esc(r.prompt)}</td></tr>`;
		})
		.join("")}</table>`;
}

// ---- interaction: never re-render #body on click; mutate classes in place and keep the clicked element where it is
function keepAnchored(el, fn) {
	const before = el?.getBoundingClientRect().top;
	fn();
	if (el && before != null) body.scrollTop += el.getBoundingClientRect().top - before;
}
function selectTool(id, anchor) {
	sel = sel === id ? null : id;
	const s = sessions.get(selected),
		focus = s?.tools.get(sel);
	for (const chart of body.querySelectorAll(".gantt")) chart.classList.remove("has-focus");
	for (const el of body.querySelectorAll(".tool, .gantt i")) {
		const c = s?.tools.get(el.dataset.id),
			row = el.classList.contains("tool");
		const focused = !!c && c === focus;
		el.classList.toggle(row ? "sel" : "focus", focused);
		el.classList.toggle("parallel", isPeer(c, focus));
		if (!row && focused) el.parentElement.classList.add("has-focus");
	}
	keepAnchored(anchor, renderDetail);
}
function selectSession(sid) {
	selected = sid;
	sel = null;
	renderSide();
	renderStats(sessions.get(sid));
	renderBody(true);
	renderDetail();
}

side.onclick = (e) => {
	const el = e.target.closest(".s");
	if (el) selectSession(el.dataset.sid);
};
sq.oninput = renderSide;
clear.onclick = () => {
	if (confirm("Clear all events?")) fetch("/clear", { method: "POST" });
};
head.onclick = (e) => {
	const t = e.target.closest("[data-tab]");
	if (t) {
		tab = t.dataset.tab;
		for (const el of head.querySelectorAll("[data-tab]")) el.classList.toggle("on", el === t);
		return renderBody();
	}
	const f = e.target.closest("[data-f]");
	if (f) {
		const k = f.dataset.f;
		filt[k] = !filt[k];
		f.classList.toggle("on", filt[k]);
		if (k === "notify" && filt.notify) Notification.requestPermission();
		if (k !== "notify") renderBody();
	}
};
tq.oninput = () => {
	filt.q = tq.value.toLowerCase();
	renderBody();
};
body.onclick = (e) => {
	if (e.target.closest("pre")) return;
	const x = e.target.closest("[data-x]");
	if (x) {
		e.preventDefault();
		x.classList.toggle("x");
		open.has(x.dataset.x) ? open.delete(x.dataset.x) : open.add(x.dataset.x);
		return;
	}
	const c = e.target.closest(".tool, .gantt i");
	if (c) return selectTool(c.dataset.id, c);
};
body.addEventListener(
	"toggle",
	(e) => {
		const r = e.target.dataset?.run;
		if (r) e.target.open ? open.add(`${selected}run${r}`) : open.delete(`${selected}run${r}`);
	},
	true,
);
body.onscroll = () => jump.classList.toggle("show", tab === "timeline" && !nearBottom());
jump.onclick = () => {
	body.scrollTop = body.scrollHeight;
};
detail.onclick = (e) => {
	if (e.target.id === "dclose") return selectTool(sel, body.querySelector(".tool.sel"));
	const c = e.target.closest("[data-id]");
	if (c && c.dataset.id !== sel) {
		selectTool(c.dataset.id, null);
		const row = body.querySelector(`.tool[data-id="${CSS.escape(c.dataset.id)}"]`);
		row?.scrollIntoView({ block: "center" });
	}
};
document.onkeydown = (e) => {
	if (e.key === "Escape" && sel) selectTool(sel, body.querySelector(".tool.sel"));
};

// ---- data ticks
setInterval(() => {
	if (!ready) return;
	if (dirtySide) renderSide();
	const s = sessions.get(selected);
	if (s && bodyVer !== s.ver) {
		renderStats(s);
		renderBody();
		if (sel) renderDetail();
	}
}, 300);

const es = new EventSource("/events");
es.onmessage = (e) => {
	try {
		ingest(JSON.parse(e.data));
	} catch {}
};
es.addEventListener("ready", () => {
	ready = true;
	const first = listed()[0];
	if (first) selectSession(first.sid);
	else renderSide();
});
es.addEventListener("clear", () => {
	sessions.clear();
	selected = null;
	sel = null;
	open.clear();
	bodyKey = "";
	setHTML(stats, '<p class="dim">cleared</p>');
	setHTML(body, "");
	renderDetail();
	renderSide();
});
