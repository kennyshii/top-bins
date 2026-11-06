import { PROMPTS, byId, match, shotOf, BOOSTS } from "./game.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", ...CORS } });
const CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => CODE[b % CODE.length]).join("");
const clean = (s, n) => String(s || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, n);
const okCode = (s, n) => typeof s === "string" && s.length === n && [...s].every((c) => CODE.includes(c));
const okDay = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && Math.abs(parseDay(k) - Date.now()) < 2 * 86400000;
const RONDO = { normal: PROMPTS.filter((p) => p.answers.length >= 16 && !p.niche).map((p) => p.id), niche: PROMPTS.filter((p) => p.answers.length >= 16 && p.niche).map((p) => p.id) };
const TURN_MS = 25000, GRACE_MS = 4000, BOOST = 10;

const accept = (p, typed, i) => {
  if (!p || !Number.isInteger(i) || i < 0 || i >= p.answers.length) return false;
  const m = match(p, String(typed || "").slice(0, 80));
  return (m.kind === "ok" && m.i === i) || (m.kind === "suggest" && m.list.includes(i));
};
const shuffle = (list) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url), parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "room" && parts[1] === "new" && req.method === "POST") return json({ code: makeCode(4) });
    if (parts[0] === "room" && okCode(parts[1], 4) && parts[2] === "ws") return env.ROOM.get(env.ROOM.idFromName(parts[1])).fetch(req);
    if (parts[0] === "run" && req.method === "POST") {
      const body = await req.json().catch(() => ({})), pid = clean(body.pid, 40), day = String(body.date || "");
      if (!pid || !okDay(day)) return json({ error: "bad run" }, 400);
      const res = await env.RUN.get(env.RUN.idFromName(`${pid}:${day}`)).fetch(new Request(`https://run/${parts[1] || ""}`, { method: "POST", body: JSON.stringify(body) }));
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json", ...CORS } });
    }
    if (parts[0] === "league" && parts.length === 1 && req.method === "POST") {
      const body = await req.json().catch(() => ({})), id = makeCode(6);
      const res = await env.LEAGUE.get(env.LEAGUE.idFromName(id)).fetch(new Request(`https://league/${id}/create`, { method: "POST", body: JSON.stringify({ name: body.name }) }));
      return res.ok ? json({ id }) : json({ error: "could not create" }, 500);
    }
    if (parts[0] === "league" && okCode(parts[1], 6)) {
      const res = await env.LEAGUE.get(env.LEAGUE.idFromName(parts[1])).fetch(new Request(`https://league/${parts[1]}/${parts[2] || ""}${url.search}`, { method: req.method, body: req.method === "POST" ? await req.text() : undefined }));
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json", ...CORS } });
    }
    return json({ error: "not found" }, 404);
  },
};

const fresh = () => ({ phase: "lobby", level: "normal", host: null, players: [], queue: [], round: 0, prompt: null, used: [], log: [], holder: null, heat: 0, winner: null, out: null, ko: false, playAt: 0, ev: [] });
const LIVES = 3;

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    this.s = fresh();
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get("s")) || fresh(); });
  }
  idOf(ws) { const a = ws.deserializeAttachment(); return a && a.id; }
  socks(skip) { return this.ctx.getWebSockets().filter((ws) => ws !== skip && ws.readyState === 1); }
  online(skip) { return new Set(this.socks(skip).map((ws) => this.idOf(ws)).filter(Boolean)); }
  view(skip) {
    const s = this.s, on = this.online(skip);
    return { t: "state", phase: s.phase, level: s.level || "normal", host: s.host, round: s.round, prompt: s.prompt, used: s.used, log: s.log.slice(-40), holder: s.holder, heat: s.heat, winner: s.winner, out: s.out, ko: s.ko, since: s.phase === "playing" ? Date.now() - s.playAt : 0,
      players: s.players.map((p) => ({ id: p.id, name: p.name, pl: p.pl, alive: p.alive, lives: p.lives ?? LIVES, on: on.has(p.id) })) };
  }
  cast(skip) { const v = JSON.stringify(this.view(skip)); for (const ws of this.socks(skip)) { try { ws.send(v); } catch {} } }
  async commit(skip) {
    const s = this.s;
    s.ev.sort((a, b) => a.at - b.at);
    await this.ctx.storage.put("s", s);
    if (s.ev.length) await this.ctx.storage.setAlarm(s.ev[0].at); else await this.ctx.storage.deleteAlarm();
    this.cast(skip);
  }
  alive() { return this.s.players.filter((p) => p.alive); }
  nextAfter(id, skip = 0) {
    const ring = this.s.players.filter((p) => p.alive || p.id === id), i = ring.findIndex((p) => p.id === id), alive = ring.filter((p) => p.alive);
    if (!alive.length) return null;
    let j = i, left = skip + 1;
    while (left > 0) { j = (j + 1) % ring.length; if (ring[j].alive && ring[j].id !== id) left--; if (alive.length === 1) break; }
    return ring[j].id;
  }
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const s = this.s;
    if (m.t === "hello") {
      const id = clean(m.id, 40);
      if (!id) return;
      for (const other of this.ctx.getWebSockets()) if (other !== ws && this.idOf(other) === id) { try { other.close(1000, "replaced"); } catch {} }
      ws.serializeAttachment({ id });
      let p = s.players.find((x) => x.id === id);
      if (!p) {
        if (s.players.length >= 10) { try { ws.send(JSON.stringify({ t: "full" })); } catch {} return; }
        p = { id, alive: s.phase === "lobby", lives: s.phase === "lobby" ? LIVES : 0 };
        s.players.push(p);
      }
      p.name = clean(m.name, 16) || "Player";
      p.pl = BOOSTS[m.pl] ? m.pl : "messi";
      if (!s.host || !this.online().has(s.host)) s.host = id;
      return this.commit();
    }
    const me = this.idOf(ws);
    if (!me) return;
    if (m.t === "start" && me === s.host && s.phase === "lobby" && s.players.length >= 2) {
      s.queue = shuffle(RONDO[s.level === "niche" ? "niche" : "normal"]).slice(0, 40);
      for (const p of s.players) { p.alive = true; p.lives = LIVES; }
      s.round = 0;
      s.winner = null;
      this.startRound(s.players[Math.floor(Math.random() * s.players.length)].id);
      return this.commit();
    }
    if (m.t === "level" && me === s.host && s.phase === "lobby") {
      s.level = m.level === "niche" ? "niche" : "normal";
      return this.commit();
    }
    if (m.t === "answer" && s.phase === "playing" && me === s.holder) {
      const p = byId.get(s.prompt), i = m.i;
      if (!accept(p, m.typed, i)) { try { ws.send(JSON.stringify({ t: "nope", why: "invalid" })); } catch {} return; }
      if (s.used.includes(i)) { try { ws.send(JSON.stringify({ t: "nope", why: "used" })); } catch {} return; }
      s.used.push(i);
      const pts = p.answers[i].pts, skip = pts >= 70 && this.alive().length > 2 ? 1 : 0, to = this.nextAfter(me, skip);
      s.log.push({ by: me, i, name: p.answers[i].name, pts, to, skip });
      s.holder = to;
      return this.commit();
    }
    if (m.t === "again" && me === s.host && s.phase === "over") {
      const on = this.online();
      Object.assign(s, fresh(), { level: s.level, host: s.host, players: s.players.filter((p) => on.has(p.id)).map((p) => ({ ...p, alive: true, lives: LIVES })) });
      return this.commit();
    }
  }
  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }
  async gone(ws) {
    const me = this.idOf(ws), s = this.s;
    if (!me) return;
    const on = this.online(ws);
    if (on.has(me)) return;
    if (!on.size) { this.s = fresh(); await this.ctx.storage.deleteAll(); return; }
    if (s.phase === "lobby") s.players = s.players.filter((p) => p.id !== me);
    if (s.host === me) s.host = (s.players.find((p) => on.has(p.id)) || {}).id || null;
    await this.commit(ws);
  }
  startRound(first) {
    const s = this.s, now = Date.now(), fuse = 16000 + Math.random() * 20000;
    s.round += 1;
    s.prompt = s.queue[(s.round - 1) % s.queue.length];
    s.used = []; s.log = []; s.out = null; s.ko = false; s.heat = 0; s.holder = first; s.phase = "ready";
    s.ev = [{ at: now + 3200, t: "play" }, { at: now + 3200 + fuse - 8000, t: "heat1" }, { at: now + 3200 + fuse - 3500, t: "heat2" }, { at: now + 3200 + fuse, t: "pop" }];
  }
  async alarm() {
    const s = this.s, now = Date.now();
    while (s.ev.length && s.ev[0].at <= now + 50) {
      const e = s.ev.shift();
      if (e.t === "play") { s.phase = "playing"; s.playAt = now; }
      else if (e.t === "heat1") s.heat = 1;
      else if (e.t === "heat2") s.heat = 2;
      else if (e.t === "pop") {
        const victim = s.players.find((p) => p.id === s.holder);
        if (victim) { victim.lives = Math.max(0, (victim.lives ?? LIVES) - 1); if (!victim.lives) victim.alive = false; }
        s.out = s.holder; s.ko = !!victim && !victim.alive; s.phase = "pop"; s.heat = 0;
        s.ev = [{ at: now + 4200, t: "next" }];
      } else if (e.t === "next") {
        const left = this.alive();
        if (left.length <= 1) { s.phase = "over"; s.winner = left[0] ? left[0].id : null; s.holder = null; s.ev = []; }
        else this.startRound(this.nextAfter(s.out));
      }
    }
    await this.commit();
  }
}

export class Run {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const op = new URL(req.url).pathname.split("/").filter(Boolean)[0], st = this.ctx.storage, body = await req.json().catch(() => ({}));
    let r = await st.get("r");
    const now = Date.now(), total = (x) => x.items.reduce((s, it) => s + (it.pts || 0) + (it.bonus || 0), 0);
    const settle = (x) => { for (const it of x.items) if (it.open && it.pts === undefined && now - it.open > TURN_MS + GRACE_MS) { it.pts = 0; it.late = true; } x.done = x.items.every((it) => it.pts !== undefined); return x; };
    if (op === "start") {
      if (!r) {
        const set = Array.isArray(body.set) ? [...new Set(body.set.map(String))] : [];
        if (set.length !== 7 || !set.every((id) => byId.has(id))) return json({ error: "bad set" }, 400);
        r = { pl: BOOSTS[body.pl] ? body.pl : "messi", items: set.map((id) => ({ id })), started: now };
        await st.put("r", r);
      }
      return json({ ok: true, done: settle(r).done, total: total(r) });
    }
    if (!r) return json({ error: "no run" }, 404);
    settle(r);
    const k = Number(body.k), it = r.items[k];
    if (op === "open") {
      if (!it) return json({ error: "bad prompt" }, 400);
      if (!it.open) { it.open = now; await st.put("r", r); }
      return json({ ok: true, left: Math.max(0, TURN_MS - (now - it.open)) });
    }
    if (op === "answer") {
      if (!it) return json({ error: "bad prompt" }, 400);
      if (it.pts !== undefined) return json({ ok: true, pts: it.pts, bonus: it.bonus || 0, total: total(r), done: r.done });
      if (!it.open || r.items.slice(0, k).some((x) => x.pts === undefined)) return json({ error: "out of order" }, 400);
      const p = byId.get(it.id), i = body.i === null || body.i === undefined ? null : Number(body.i);
      if (i === null || now - it.open > TURN_MS + GRACE_MS) { it.pts = 0; it.late = i !== null; }
      else if (!accept(p, body.typed, i)) it.pts = 0;
      else { it.i = i; it.pts = p.answers[i].pts; it.bonus = shotOf(it.pts).kind === BOOSTS[r.pl] ? BOOST : 0; }
      settle(r);
      await st.put("r", r);
      return json({ ok: true, pts: it.pts, bonus: it.bonus || 0, total: total(r), done: r.done });
    }
    if (op === "total") return json({ done: r.done, total: total(r), pl: r.pl });
    return json({ error: "unknown" }, 404);
  }
}

const PTS = [15, 12, 10, 8, 7, 5, 4, 3, 2, 1];
const parseDay = (k) => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const keyOf = (t) => new Date(t).toISOString().slice(0, 10);
const mondayOf = (k) => { const t = parseDay(k), wd = (new Date(t).getUTCDay() + 6) % 7; return keyOf(t - wd * 86400000); };
const addDays = (k, n) => keyOf(parseDay(k) + n * 86400000);

export function dayTable(scores) {
  const rows = Object.entries(scores || {}).sort((a, b) => b[1] - a[1]);
  let place = 0;
  return rows.map(([pid, score], i) => { if (i === 0 || score < rows[i - 1][1]) place = i + 1; return { pid, score, place, pts: PTS[place - 1] || 0 }; });
}

const byBallon = (a, b) => {
  if (b.pts !== a.pts) return b.pts - a.pts;
  for (let i = 0; i < 10; i++) if ((b.places[i] || 0) !== (a.places[i] || 0)) return (b.places[i] || 0) - (a.places[i] || 0);
  return 0;
};

export function weekTable(scores, start) {
  const rows = new Map();
  for (let d = 0; d < 7; d++) {
    const day = addDays(start, d);
    for (const r of dayTable(scores[day])) {
      const w = rows.get(r.pid) || { pid: r.pid, pts: 0, places: Array(10).fill(0), days: 0, best: 0 };
      w.pts += r.pts; w.days += 1; w.best = Math.max(w.best, r.score);
      if (r.place <= 10) w.places[r.place - 1] += 1;
      rows.set(r.pid, w);
    }
  }
  const list = [...rows.values()].sort(byBallon);
  const winners = list.length && list[0].pts > 0 ? list.filter((r) => byBallon(r, list[0]) === 0).map((r) => r.pid) : [];
  return { start, end: addDays(start, 6), rows: list, winners };
}

export function standings(scores, today) {
  const thisWeek = mondayOf(today), days = Object.keys(scores).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const weekStarts = [...new Set(days.map(mondayOf))].sort();
  const past = weekStarts.filter((w) => w < thisWeek).map((w) => weekTable(scores, w));
  const months = new Map();
  for (const w of past) {
    const mk = w.end.slice(0, 7), m = months.get(mk) || new Map();
    for (const r of w.rows) {
      const e = m.get(r.pid) || { pid: r.pid, golds: 0, pts: 0 };
      e.pts += r.pts;
      if (w.winners.includes(r.pid)) e.golds += 1;
      m.set(r.pid, e);
    }
    months.set(mk, m);
  }
  const thisMonth = today.slice(0, 7), monthRows = (mk) => [...(months.get(mk) || new Map()).values()].sort((a, b) => b.golds - a.golds || b.pts - a.pts);
  const supers = [...months.keys()].filter((mk) => mk < thisMonth).sort().map((mk) => {
    const rows = monthRows(mk), top = rows[0];
    return { month: mk, winners: top && top.golds > 0 ? rows.filter((r) => r.golds === top.golds && r.pts === top.pts).map((r) => r.pid) : [], rows };
  });
  const trophies = {};
  const add = (pid, k) => { trophies[pid] = trophies[pid] || { ballon: 0, superBallon: 0 }; trophies[pid][k] += 1; };
  for (const w of past) for (const pid of w.winners) add(pid, "ballon");
  for (const m of supers) for (const pid of m.winners) add(pid, "superBallon");
  return { today: { day: today, rows: dayTable(scores[today]) }, week: weekTable(scores, thisWeek), month: { month: thisMonth, rows: monthRows(thisMonth) }, pastWeeks: past.reverse().slice(0, 12), supers: supers.reverse().slice(0, 12), trophies };
}

export class League {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(req) {
    const url = new URL(req.url), [, op] = url.pathname.split("/").filter(Boolean), st = this.ctx.storage;
    const meta = await st.get("meta");
    if (op === "create") {
      if (meta) return json({ error: "exists" }, 409);
      const body = await req.json().catch(() => ({}));
      await st.put("meta", { name: clean(body.name, 28) || "Our league", created: Date.now() });
      await st.put("members", {});
      await st.put("scores", {});
      return json({ ok: true });
    }
    if (!meta) return json({ error: "no such league" }, 404);
    const members = (await st.get("members")) || {}, scores = (await st.get("scores")) || {}, now = Date.now();
    let note = null;
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({})), pid = clean(body.pid, 40);
      if (!pid) return json({ error: "missing player" }, 400);
      if (op === "leave") { delete members[pid]; await st.put("members", members); return json({ ok: true }); }
      if (!members[pid] && Object.keys(members).length >= 60) return json({ error: "league is full" }, 403);
      const was = members[pid] || {};
      members[pid] = { name: clean(body.name, 16) || was.name || "Player", pl: BOOSTS[body.pl] ? body.pl : was.pl || "messi", joined: was.joined || now };
      await st.put("members", members);
      if (op === "score") {
        const day = String(body.date || "");
        if (!okDay(day)) return json({ error: "bad date" }, 400);
        if (!(scores[day] && scores[day][pid] !== undefined)) {
          const run = await this.env.RUN.get(this.env.RUN.idFromName(`${pid}:${day}`)).fetch(new Request("https://run/total", { method: "POST", body: "{}" })).then((r) => r.json()).catch(() => ({}));
          if (run.done) { scores[day] = scores[day] || {}; scores[day][pid] = run.total; await st.put("scores", scores); }
          else note = run.error === "no run" ? "unverified" : "unfinished";
        }
      }
    }
    const q = url.searchParams.get("d") || "", today = okDay(q) ? q : keyOf(now);
    return json({ name: meta.name, members, note, standings: standings(scores, today) });
  }
}
