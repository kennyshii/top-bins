const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", ...CORS } });
const CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => CODE[b % CODE.length]).join("");
const clean = (s, n) => String(s || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, n);
const okCode = (s, n) => typeof s === "string" && s.length === n && [...s].every((c) => CODE.includes(c));
const PLAYER_IDS = new Set(["messi", "ronaldo", "mbappe", "yamal", "haaland", "bellingham", "neymar", "palmer", "vini", "son"]);

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url), parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "room" && parts[1] === "new" && req.method === "POST") return json({ code: makeCode(4) });
    if (parts[0] === "room" && okCode(parts[1], 4) && parts[2] === "ws") return env.ROOM.get(env.ROOM.idFromName(parts[1])).fetch(req);
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

export class Room {
  constructor(state) {
    this.state = state;
    this.socks = new Map();
    this.reset();
  }
  reset() {
    this.phase = "lobby";
    this.players = this.players ? this.players.filter((p) => this.socks.has(p.id)).map((p) => ({ ...p, alive: true })) : [];
    this.queue = [];
    this.round = 0;
    this.prompt = null;
    this.used = [];
    this.log = [];
    this.holder = null;
    this.heat = 0;
    this.winner = null;
    this.out = null;
    this.timers = [];
  }
  clear() { for (const t of this.timers) clearTimeout(t); this.timers = []; }
  later(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
  view() {
    return { t: "state", phase: this.phase, host: this.host, round: this.round, prompt: this.prompt, used: this.used, log: this.log.slice(-40), holder: this.holder, heat: this.heat, winner: this.winner, out: this.out,
      players: this.players.map((p) => ({ id: p.id, name: p.name, pl: p.pl, alive: p.alive, on: this.socks.has(p.id) })) };
  }
  send(ws, v) { try { ws.send(JSON.stringify(v)); } catch {} }
  cast(v = this.view()) { const s = JSON.stringify(v); for (const ws of this.socks.values()) { try { ws.send(s); } catch {} } }
  alive() { return this.players.filter((p) => p.alive); }
  nextAfter(id, skip = 0) {
    const ring = this.players.filter((p) => p.alive || p.id === id), i = ring.findIndex((p) => p.id === id);
    const alive = ring.filter((p) => p.alive);
    if (!alive.length) return null;
    let j = i, left = skip + 1;
    while (left > 0) { j = (j + 1) % ring.length; if (ring[j].alive && ring[j].id !== id) left--; if (alive.length === 1) break; }
    return ring[j].id;
  }
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair(), [client, ws] = Object.values(pair);
    ws.accept();
    let me = null;
    ws.addEventListener("message", (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "hello") {
        const id = clean(m.id, 40);
        if (!id) return;
        me = id;
        const old = this.socks.get(id);
        if (old && old !== ws) { try { old.close(1000, "replaced"); } catch {} }
        this.socks.set(id, ws);
        let p = this.players.find((x) => x.id === id);
        if (!p) {
          if (this.players.length >= 10) { this.send(ws, { t: "full" }); return; }
          p = { id, alive: this.phase === "lobby" };
          this.players.push(p);
        }
        p.name = clean(m.name, 16) || "Player";
        p.pl = PLAYER_IDS.has(m.pl) ? m.pl : "messi";
        if (!this.host || !this.socks.has(this.host)) this.host = id;
        this.cast();
        return;
      }
      if (!me) return;
      if (m.t === "start" && me === this.host && this.phase === "lobby" && this.players.length >= 2 && Array.isArray(m.prompts) && m.prompts.length) {
        this.queue = m.prompts.slice(0, 60).map((x) => clean(x, 16));
        for (const p of this.players) p.alive = true;
        this.round = 0;
        this.winner = null;
        this.startRound(this.players[Math.floor(Math.random() * this.players.length)].id);
        return;
      }
      if (m.t === "answer" && this.phase === "playing" && me === this.holder && Number.isInteger(m.i) && m.i >= 0 && m.i < 200 && !this.used.includes(m.i)) {
        this.used.push(m.i);
        const pts = Math.max(0, Math.min(100, Number(m.pts) || 0)), skip = pts >= 70 && this.alive().length > 2 ? 1 : 0;
        const to = this.nextAfter(me, skip);
        this.log.push({ by: me, i: m.i, name: clean(m.name, 48), pts, to, skip });
        this.holder = to;
        this.cast();
        return;
      }
      if (m.t === "again" && me === this.host && this.phase === "over") { this.clear(); this.reset(); this.cast(); }
    });
    const gone = () => {
      if (!me || this.socks.get(me) !== ws) return;
      this.socks.delete(me);
      if (this.phase === "lobby") this.players = this.players.filter((p) => p.id !== me);
      if (this.host === me) this.host = (this.players.find((p) => this.socks.has(p.id)) || {}).id || null;
      if (!this.socks.size) { this.clear(); this.players = []; this.reset(); return; }
      this.cast();
    };
    ws.addEventListener("close", gone);
    ws.addEventListener("error", gone);
    return new Response(null, { status: 101, webSocket: client });
  }
  startRound(first) {
    this.clear();
    this.round += 1;
    this.prompt = this.queue[(this.round - 1) % this.queue.length];
    this.used = [];
    this.log = [];
    this.out = null;
    this.heat = 0;
    this.holder = first;
    this.phase = "ready";
    this.cast();
    const fuse = 16000 + Math.random() * 20000;
    this.later(3200, () => {
      this.phase = "playing";
      this.cast();
      this.later(fuse - 8000, () => { this.heat = 1; this.cast(); });
      this.later(fuse - 3500, () => { this.heat = 2; this.cast(); });
      this.later(fuse, () => this.pop());
    });
  }
  pop() {
    this.clear();
    const victim = this.players.find((p) => p.id === this.holder);
    if (victim) victim.alive = false;
    this.out = this.holder;
    this.phase = "pop";
    this.heat = 0;
    this.cast();
    this.later(4200, () => {
      const left = this.alive();
      if (left.length <= 1) {
        this.phase = "over";
        this.winner = left[0] ? left[0].id : null;
        this.holder = null;
        this.cast();
        return;
      }
      this.startRound(this.nextAfter(this.out));
    });
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
  constructor(state) { this.state = state; }
  async fetch(req) {
    const url = new URL(req.url), [, op] = url.pathname.split("/").filter(Boolean), st = this.state.storage;
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
    const members = (await st.get("members")) || {}, scores = (await st.get("scores")) || {};
    const now = Date.now(), near = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && Math.abs(parseDay(k) - now) < 2 * 86400000;
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({})), pid = clean(body.pid, 40);
      if (!pid) return json({ error: "missing player" }, 400);
      if (op === "leave") { delete members[pid]; await st.put("members", members); return json({ ok: true }); }
      if (!members[pid] && Object.keys(members).length >= 60) return json({ error: "league is full" }, 403);
      members[pid] = { name: clean(body.name, 16) || (members[pid] && members[pid].name) || "Player", pl: PLAYER_IDS.has(body.pl) ? body.pl : (members[pid] && members[pid].pl) || "messi", joined: (members[pid] && members[pid].joined) || now };
      await st.put("members", members);
      if (op === "score") {
        const day = String(body.date || ""), score = Math.round(Number(body.score));
        if (!near(day) || !Number.isFinite(score) || score < 0 || score > 1000) return json({ error: "bad score" }, 400);
        scores[day] = scores[day] || {};
        if (scores[day][pid] === undefined) { scores[day][pid] = score; await st.put("scores", scores); }
      }
    }
    const today = near(url.searchParams.get("d") || "") ? url.searchParams.get("d") : keyOf(now);
    return json({ name: meta.name, members, standings: standings(scores, today) });
  }
}
