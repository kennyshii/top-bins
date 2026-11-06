import { readFileSync, writeFileSync } from "fs";
const src = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error("missing " + from); return src.slice(a, b + to.length); };
const data = cut("const PROMPTS = [", "const byId = new Map(PROMPTS.map((p) => [p.id, p]));");
const shots = cut("const SHOTS = [", "const shotOf = (pts) => SHOTS.find((s) => pts >= s.min);");
const boosts = Object.fromEntries([...src.matchAll(/\{ id: "(\w+)",[^\n]*?boost: "(\w+)"/g)].map((m) => [m[1], m[2]]));
writeFileSync(new URL("./game.js", import.meta.url), `${data}\n${shots}\nconst BOOSTS = ${JSON.stringify(boosts)};\nexport { PROMPTS, byId, match, shotOf, BOOSTS, dailySet, dayNo };\n`);
console.log("game.js:", Object.keys(boosts).length, "players");
