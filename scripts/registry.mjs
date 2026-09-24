// Реестр плагинов hostpink: plugins/*.json → hostpink-registry.json
//
//   node scripts/registry.mjs                 проверить все плагины и собрать hostpink-registry.json
//   node scripts/registry.mjs --pin           закрепить новые плагины (без ref) на свежем коммите и посчитать хэши
//   node scripts/registry.mjs --pin --update  перезакрепить все плагины на свежих коммитах
//   node scripts/registry.mjs --check         только проверка, файл не пишется (для CI)
//
// Каждый файл плагина скачивается клиентом по неизменяемому адресу
// raw.githubusercontent.com/<repo>/<commit>/<path> и сверяется по SHA-256 из реестра.
//
// Copyright (c) 2026 Rxflex (https://host.pink). PolyForm Noncommercial License 1.0.0.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "plugins");
const OUT = join(ROOT, "hostpink-registry.json");
const PIN = process.argv.includes("--pin");
const UPDATE = process.argv.includes("--update");
const CHECK = process.argv.includes("--check");

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SHA = /^[0-9a-f]{40}$/;
const PLATFORMS = new Set(["linux", "darwin", "windows", "freebsd"]);
const FIELDS = ["id", "title", "author", "repo", "ref", "category", "description", "platforms", "needs_root", "fetches_latest", "files", "actions", "source", "featured"];

async function gh(path) {
  const headers = { "user-agent": "hostpink-registry", accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`GitHub ${path}: ${r.status}`);
  return r.json();
}

async function pin(p) {
  if (!p.ref || UPDATE) {
    const repo = await gh(`/repos/${p.repo}`);
    const c = await gh(`/repos/${p.repo}/commits/${repo.default_branch}`);
    p.ref = c.sha;
  }
  let text = "";
  for (const f of p.files) {
    const r = await fetch(`https://raw.githubusercontent.com/${p.repo}/${p.ref}/${f.path}`);
    if (!r.ok) throw new Error(`${p.id}: ${f.path} → ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    f.sha256 = createHash("sha256").update(buf).digest("hex");
    f.size = buf.length;
    text += buf.toString("utf8");
  }
  // подсказки, которые клиент показывает перед запуском
  if (p.needs_root === undefined) p.needs_root = /\$EUID|id -u|must be run as root|от имени root/i.test(text);
  p.fetches_latest = /raw\.githubusercontent\.com|github\.com\/[^\s"']+\/(archive|raw|releases)|git clone|cdn\.jsdelivr\.net\/gh/i.test(text);
  return p;
}

function check(p, file) {
  const err = (m) => { throw new Error(`${file}: ${m}`); };
  for (const k of Object.keys(p)) if (!FIELDS.includes(k)) err(`лишнее поле ${k}`);
  if (!ID.test(p.id ?? "")) err("id: только a-z, 0-9 и дефис");
  if (`${p.id}.json` !== file) err("имя файла должно совпадать с id");
  for (const k of ["title", "author", "repo", "category", "description"]) if (!p[k]) err(`нет ${k}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo)) err("repo вида owner/name");
  if (!SHA.test(p.ref ?? "")) err("ref не закреплён: запусти --pin");
  if (!p.platforms?.length || p.platforms.some((x) => !PLATFORMS.has(x))) err("platforms: linux, darwin, windows, freebsd");
  if (!p.files?.length) err("нет files");
  for (const f of p.files) {
    if (!f.path || f.path.includes("..") || f.path.startsWith("/")) err(`плохой путь ${f.path}`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) err(`нет sha256 у ${f.path}: запусти --pin`);
  }
  if (p.featured !== undefined && typeof p.featured !== "boolean") err("featured: true или false");
  if (!p.actions?.length) err("нет actions");
  const ids = new Set();
  for (const a of p.actions) {
    if (!a.id || !a.title || !a.run) err("у action нужны id, title и run");
    if (ids.has(a.id)) err(`повтор action ${a.id}`);
    ids.add(a.id);
  }
}

const list = [];
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(DIR, file);
  let p = JSON.parse(readFileSync(path, "utf8"));
  if (PIN && (!p.ref || UPDATE || p.files?.some((f) => !f.sha256))) {
    p = await pin(p);
    writeFileSync(path, JSON.stringify(p, null, 2) + "\n");
    console.log(`pin ${p.id} @ ${p.ref.slice(0, 7)}${p.needs_root ? " root" : ""}${p.fetches_latest ? " fetches-latest" : ""}`);
  }
  check(p, file);
  list.push(p);
}

// Реестры, на которые ссылается этот. Клиенты обходят их сами (до трёх уровней вложенности),
// поэтому чужой реестр подключается без пересборки hostpink и без деплоя сайта.
const REGS = join(ROOT, "registries.json");
const registries = existsSync(REGS) ? JSON.parse(readFileSync(REGS, "utf8")) : [];
const regIds = new Set();
for (const r of registries) {
  const err = (m) => { throw new Error(`registries.json, ${r.id ?? "?"}: ${m}`); };
  for (const k of Object.keys(r)) if (!["id", "name", "repo", "url", "description"].includes(k)) err(`лишнее поле ${k}`);
  if (!ID.test(r.id ?? "")) err("id: только a-z, 0-9 и дефис");
  if (regIds.has(r.id)) err("повтор id");
  regIds.add(r.id);
  if (!r.name) err("нет name");
  if (!!r.repo === !!r.url) err("нужен ровно один из repo (owner/name) или url (https://…json)");
  if (r.repo && !/^[\w.-]+\/[\w.-]+$/.test(r.repo)) err("repo вида owner/name");
  if (r.url && !/^https:\/\/\S+\.json$/.test(r.url)) err("url: https и .json");
}

if (!CHECK) {
  const out = { version: 1, name: "host.pink", plugins: list };
  if (registries.length) out.registries = registries;
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
}
console.log(`registry: ${list.length} плагинов, ${registries.length} реестров по ссылке${CHECK ? ", всё в порядке" : ` → ${OUT}`}`);
