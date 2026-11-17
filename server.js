"use strict";
/* Back end GrandCodex — tanpa dependensi (Node ≥ 22.13: node:http + node:sqlite).
     GET    /api/seed.js    data bawaan + template .docx dari database/seed/{master,output,template}/ (SEED, TEMPLATE_DEFAULT, TEMPLATE_RB_DEFAULT, TUPREQ_TPL)
     GET    /api/state.js   isi basis data saat ini sebagai skrip (__GC_STATE: kunci → teks JSON)
     GET    /api/kv         semua kunci → nilai (JSON)
     GET    /api/kv/<kunci> satu nilai
     PUT    /api/kv/<kunci> simpan (isi: JSON)
     DELETE /api/kv/<kunci> hapus
     POST   /api/login      { username, password } → kuki sesi gc_sid        POST /api/logout        GET /api/me
     POST   /api/password   { lama, baru } ganti password sendiri
     GET/POST /api/users, PUT/DELETE /api/users/<username>   kelola user (khusus Admin)
     selain itu             berkas front end (login.html, index.html, css/, js/, vendor/)
   Semua data (/api/seed.js, /api/state.js, /api/kv) dan index.html hanya untuk yang sudah login; akun awal: admin / admin.
   Lingkungan: PORT (3000), HOST (127.0.0.1; pakai 0.0.0.0 agar bisa diakses dari jaringan), GC_DB (lokasi berkas .db) */
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, ".."), FRONT = path.join(ROOT, "frontend"), DBDIR = path.join(ROOT, "database");
const PORT = Number(process.env.PORT) || 3000, HOST = process.env.HOST || "127.0.0.1";
const DB_FILE = process.env.GC_DB || path.join(DBDIR, "grandcodex.db");
const MAX_BODY = 64 * 1024 * 1024;   // template .docx & POK disimpan sebagai JSON, bisa beberapa MB

/* ---------- basis data: tiga tabel menurut kategori ---------- */
const TABLES = ["master", "output", "pengaturan"];
const MASTER = /^st\.(pegawai|kampung|tarif|kode|pok\.[\w.\-]+|pokYears|template|templateRB|rekening|ptkp|suratFmt)$/;
const OUTPUT = /^st\.(records|rincian|massRows|massCommon|honor|surat|(rab|rpd|rpdKet|rpdSup|rpdFin|tup|up|revisi)(\.[\w.\-]+)?|tr\.[\w.\-]+)$/;
const tableOf = key => MASTER.test(key) ? "master" : OUTPUT.test(key) ? "output" : "pengaturan";

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
db.exec(fs.readFileSync(path.join(DBDIR, "schema.sql"), "utf8"));
/* migrasi: basis data lama memakai satu tabel `kv` → salin cadangan, lalu pindahkan tiap kunci ke tabel kategorinya */
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()){
  const bak = DB_FILE.replace(/\.db$/, "") + ".cadangan-sebelum-dibagi.db";
  if (!fs.existsSync(bak)) db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
  const rows = db.prepare("SELECT key, value, updated_at FROM kv").all();
  db.exec("BEGIN");
  try{
    for (const r of rows) db.prepare(`INSERT OR REPLACE INTO ${tableOf(r.key)} (key, value, updated_at) VALUES (?, ?, ?)`).run(r.key, r.value, r.updated_at);
    db.exec("DROP TABLE kv"); db.exec("COMMIT");
    console.log(`Basis data dibagi per kategori: ${rows.length} kunci dipindahkan dari tabel kv (cadangan: ${bak})`);
  }catch(e){ db.exec("ROLLBACK"); throw e; }
}
const q = Object.fromEntries(TABLES.map(t => [t, {
  get: db.prepare(`SELECT value FROM ${t} WHERE key = ?`),
  put: db.prepare(`INSERT INTO ${t} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')`),
  del: db.prepare(`DELETE FROM ${t} WHERE key = ?`)
}]));
const qAll = db.prepare(TABLES.map(t => `SELECT key, value FROM ${t}`).join(" UNION ALL ") + " ORDER BY key");
const state = () => Object.fromEntries(qAll.all().map(r => [r.key, r.value]));
const KEY = /^st\.[\w.\-]{1,150}$/;

/* ---------- user, password & sesi ---------- */
const SESSION_MS = 12 * 3600 * 1000 /* sesi berakhir setelah 12 jam tidak dipakai */, COOKIE_S = 7 * 86400, USERNAME = /^[A-Za-z0-9._-]{3,32}$/, FITUR = /^[a-z]{1,20}$/;
const hashPw = (pw, salt = crypto.randomBytes(16).toString("hex")) => `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 64).toString("hex")}`;
function checkPw(pw, stored){
  const [, salt, h] = String(stored).split("$"); if (!salt || !h) return false;
  const a = Buffer.from(h, "hex"), b = crypto.scryptSync(String(pw), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const U = {
  get: db.prepare("SELECT username, password, role, akses_fitur FROM users WHERE username = ?"),
  all: db.prepare("SELECT username, role, akses_fitur, created_at, updated_at FROM users ORDER BY role = 'Admin' DESC, username"),
  add: db.prepare("INSERT INTO users (username, password, role, akses_fitur) VALUES (?, ?, ?, ?)"),
  set: db.prepare("UPDATE users SET role = ?, akses_fitur = ?, updated_at = datetime('now', 'localtime') WHERE username = ?"),
  pw: db.prepare("UPDATE users SET password = ?, updated_at = datetime('now', 'localtime') WHERE username = ?"),
  del: db.prepare("DELETE FROM users WHERE username = ?"),
  admins: db.prepare("SELECT count(*) AS n FROM users WHERE role = 'Admin'"),
  count: db.prepare("SELECT count(*) AS n FROM users")
};
const S = {
  get: db.prepare("SELECT username, expires FROM sessions WHERE token = ?"),
  add: db.prepare("INSERT INTO sessions (token, username, expires) VALUES (?, ?, ?)"),
  del: db.prepare("DELETE FROM sessions WHERE token = ?"),
  delUser: db.prepare("DELETE FROM sessions WHERE username = ? AND token <> ?"),
  touch: db.prepare("UPDATE sessions SET expires = ? WHERE token = ?"),
  sweep: db.prepare("DELETE FROM sessions WHERE expires < ?")
};
if (!U.count.get().n){ U.add.run("admin", hashPw("admin"), "Admin", "[]"); console.log("Akun awal dibuat: admin / admin — segera ganti password-nya."); }
S.sweep.run(Date.now());
const pub = u => ({ username: u.username, role: u.role, fitur: JSON.parse(u.akses_fitur) });
const cookieSid = req => (/(?:^|;\s*)gc_sid=([a-f0-9]{64})/.exec(req.headers.cookie || "") || [])[1] || "";
/** user yang sedang login (dari kuki sesi), atau null */
function who(req){
  const sid = cookieSid(req); if (!sid) return null;
  const s = S.get.get(sha(sid)); if (!s) return null;
  if (s.expires < Date.now()){ S.del.run(sha(sid)); return null; }
  if (s.expires - Date.now() < SESSION_MS - 600000) S.touch.run(Date.now() + SESSION_MS, sha(sid));   // masih dipakai → perpanjang
  return U.get.get(s.username) || null;
}
const setSid = (sid, age) => ({ "Set-Cookie": `gc_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}` });
/* pembatas tebak password: 5 kali gagal per alamat + username → tunggu 5 menit */
const tries = new Map();
const tryKey = (req, name) => (req.socket.remoteAddress || "") + "|" + String(name).toLowerCase();
function cleanFitur(v){ return Array.isArray(v) ? [...new Set(v.filter(x => typeof x === "string" && FITUR.test(x)))].slice(0, 60) : []; }
async function jsonBody(req){
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw Object.assign(new Error("Content-Type harus application/json"), { status: 415 });
  try{ const o = JSON.parse(await readBody(req)); if (!o || typeof o !== "object") throw 0; return o; }catch(e){ if (e && e.status) throw e; throw Object.assign(new Error("Isi bukan JSON yang sah"), { status: 400 }); }
}
const pwOk = pw => typeof pw === "string" && pw.length >= 4 && pw.length <= 200;

/* ---------- data bawaan (tetap; dibaca sekali saat mulai) dari database/seed/ ----------
     master/    pegawai, kampung, tarif, kode-klasifikasi, pok-<tahun>
     output/    surat-tugas (data surat), rincian-biaya (rincian biaya tiap surat; dicocokkan lewat NO + TGL_TERBIT_ST)
     template/  surat_tugas.docx (ST, SPD, Lampiran SPPD, Lampiran ST), rincian_biaya.docx (kuitansi, pengeluaran riil, rincian, pernyataan), permintaan_tup.docx */
const js = v => JSON.stringify(v);
const seedDir = path.join(DBDIR, "seed"), seedJson = f => JSON.parse(fs.readFileSync(path.join(seedDir, f), "utf8")), b64 = f => fs.readFileSync(path.join(seedDir, "template", f)).toString("base64");
const pokY = Object.fromEntries(fs.readdirSync(path.join(seedDir, "master")).map(f => f.match(/^pok-(\d{4})\.json$/)).filter(Boolean).sort((a, b) => a[1] - b[1]).map(m => [m[1], seedJson("master/" + m[0])]));
const stKey = r => r.NO + "|" + r.TGL_TERBIT_ST, biaya = new Map(seedJson("output/rincian-biaya.json").map(b => [stKey(b), b]));
const seedRecords = seedJson("output/surat-tugas.json").map(r => ({ ...r, ...biaya.get(stKey(r)) }));
const SEED = { pegawai: seedJson("master/pegawai.json"), records: seedRecords, kampung: seedJson("master/kampung.json"), tarif: seedJson("master/tarif.json"),
  kode: seedJson("master/kode-klasifikasi.json"), pok: Object.values(pokY)[0], pokY };
const SEED_JS = "const SEED = " + js(SEED) + ";\n" +
  "const TEMPLATE_DEFAULT = " + js(b64("surat_tugas.docx")) + ";\n" +
  "const TEMPLATE_RB_DEFAULT = " + js(b64("rincian_biaya.docx")) + ";\n" +
  "const TUPREQ_TPL = " + js(b64("permintaan_tup.docx")) + ";\n";
const SEED_ETAG = '"' + crypto.createHash("sha1").update(SEED_JS).digest("hex") + '"';

/* ---------- bantuan HTTP ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function send(res, status, body, type = "application/json; charset=utf-8", extra = {}){
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra }); res.end(body);
}
const fail = (res, status, msg) => send(res, status, JSON.stringify({ error: msg }));
function readBody(req){
  return new Promise((ok, no) => { const parts = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > MAX_BODY){ no(Object.assign(new Error("Isi terlalu besar"), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8"))); req.on("error", no); });
}
/* Selain login: tolak permintaan yang berasal dari situs lain, agar halaman web asing tidak bisa membaca/mengubah data. */
function foreign(req){
  if (req.headers["sec-fetch-site"] === "cross-site") return true;
  const o = req.headers.origin; if (!o) return false;
  try{ return new URL(o).host !== req.headers.host; }catch(e){ return true; }
}

/* ---------- API ---------- */
async function api(req, res, p){
  if (foreign(req)) return fail(res, 403, "Permintaan lintas situs ditolak");
  const m = req.method;
  if (p === "/api/login" && m === "POST"){
    const b = await jsonBody(req), name = String(b.username || "").trim(), k = tryKey(req, name), t = tries.get(k);
    if (t && t.n >= 5 && t.until > Date.now()) return fail(res, 429, `Terlalu banyak percobaan. Coba lagi ${Math.ceil((t.until - Date.now()) / 60000)} menit lagi.`);
    const u = U.get.get(name);
    if (!u || !checkPw(b.password ?? "", u.password)){
      if (!u) hashPw(String(b.password ?? ""));   // samakan waktu jawab, agar username yang ada tidak bisa ditebak
      const n = (t && t.until > Date.now() ? t.n : 0) + 1; tries.set(k, { n, until: Date.now() + 5 * 60000 });
      return fail(res, 401, "Username atau password salah");
    }
    tries.delete(k);
    const sid = crypto.randomBytes(32).toString("hex"); S.sweep.run(Date.now()); S.add.run(sha(sid), u.username, Date.now() + SESSION_MS);
    return send(res, 200, js({ ok: true, user: pub(u) }), undefined, setSid(sid, COOKIE_S));
  }
  if (p === "/api/logout" && m === "POST"){ const sid = cookieSid(req); if (sid) S.del.run(sha(sid)); return send(res, 200, '{"ok":true}', undefined, setSid("", 0)); }
  const me = who(req);
  if (!me) return fail(res, 401, "Belum login");
  if (p === "/api/me" && m === "GET") return send(res, 200, js(pub(me)));
  if (p === "/api/password" && m === "POST"){
    const b = await jsonBody(req);
    if (!checkPw(b.lama ?? "", me.password)) return fail(res, 403, "Password lama salah");
    if (!pwOk(b.baru)) return fail(res, 400, "Password baru minimal 4 karakter");
    U.pw.run(hashPw(b.baru), me.username); S.delUser.run(me.username, sha(cookieSid(req)));
    return send(res, 200, '{"ok":true}');
  }
  if (p === "/api/users" || p.startsWith("/api/users/")){
    if (me.role !== "Admin") return fail(res, 403, "Khusus Admin");
    if (p === "/api/users" && m === "GET") return send(res, 200, js(U.all.all().map(u => ({ username: u.username, role: u.role, fitur: JSON.parse(u.akses_fitur), dibuat: u.created_at, diubah: u.updated_at }))));
    if (p === "/api/users" && m === "POST"){
      const b = await jsonBody(req), name = String(b.username || "").trim();
      if (!USERNAME.test(name)) return fail(res, 400, "Username 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung");
      if (!pwOk(b.password)) return fail(res, 400, "Password minimal 4 karakter");
      if (U.get.get(name)) return fail(res, 409, `Username "${name}" sudah dipakai`);
      U.add.run(name, hashPw(b.password), b.role === "Admin" ? "Admin" : "User", js(cleanFitur(b.fitur)));
      return send(res, 200, '{"ok":true}');
    }
    if (p.startsWith("/api/users/")){
      let name; try{ name = decodeURIComponent(p.slice(11)); }catch(e){ return fail(res, 400, "Username tidak sah"); }
      const u = U.get.get(name); if (!u) return fail(res, 404, "User tidak ditemukan");
      const self = u.username.toLowerCase() === me.username.toLowerCase(), lastAdmin = u.role === "Admin" && U.admins.get().n <= 1;
      if (m === "PUT"){
        const b = await jsonBody(req), role = b.role === undefined ? u.role : b.role === "Admin" ? "Admin" : "User";
        if (role !== "Admin" && lastAdmin) return fail(res, 400, "Harus ada minimal satu Admin");
        if (b.password !== undefined && b.password !== "" && !pwOk(b.password)) return fail(res, 400, "Password minimal 4 karakter");
        U.set.run(role, b.fitur === undefined ? u.akses_fitur : js(cleanFitur(b.fitur)), u.username);
        if (b.password){ U.pw.run(hashPw(b.password), u.username); S.delUser.run(u.username, self ? sha(cookieSid(req)) : ""); }
        return send(res, 200, '{"ok":true}');
      }
      if (m === "DELETE"){
        if (self) return fail(res, 400, "Tidak bisa menghapus akun yang sedang dipakai");
        if (lastAdmin) return fail(res, 400, "Harus ada minimal satu Admin");
        U.del.run(u.username); S.delUser.run(u.username, "");
        return send(res, 200, '{"ok":true}');
      }
    }
    return fail(res, 405, "Metode tidak didukung");
  }
  if (p === "/api/seed.js" && m === "GET"){
    if (req.headers["if-none-match"] === SEED_ETAG){ res.writeHead(304, { ETag: SEED_ETAG, "Cache-Control": "no-cache" }); return res.end(); }
    return send(res, 200, SEED_JS, MIME[".js"], { ETag: SEED_ETAG, "Cache-Control": "no-cache" });
  }
  if (p === "/api/state.js" && m === "GET") return send(res, 200, "const __GC_STATE = " + js(state()) + ";\nconst __GC_USER = " + js(pub(me)) + ";\n", MIME[".js"]);
  if (p === "/api/kv" && m === "GET") return send(res, 200, "{" + qAll.all().map(r => JSON.stringify(r.key) + ":" + r.value).join(",") + "}");
  if (p.startsWith("/api/kv/")){
    let key; try{ key = decodeURIComponent(p.slice(8)); }catch(e){ return fail(res, 400, "Kunci tidak sah"); }
    if (!KEY.test(key)) return fail(res, 400, "Kunci tidak sah");
    const t = q[tableOf(key)];
    if (m === "GET"){ const r = t.get.get(key); return r ? send(res, 200, r.value) : fail(res, 404, "Tidak ditemukan"); }
    if (m === "PUT"){
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return fail(res, 415, "Content-Type harus application/json");
      const body = await readBody(req);
      try{ JSON.parse(body); }catch(e){ return fail(res, 400, "Isi bukan JSON yang sah"); }
      t.put.run(key, body); return send(res, 200, '{"ok":true}');
    }
    if (m === "DELETE"){ t.del.run(key); return send(res, 200, '{"ok":true}'); }
    return fail(res, 405, "Metode tidak didukung");
  }
  return fail(res, 404, "Tidak ditemukan");
}

/* ---------- berkas front end (hanya yang memang untuk browser) ---------- */
const STATIC = /^\/((index|login)\.html|(css|js|vendor)\/[\w.\-]+)$/;
function file(req, res, p){
  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Metode tidak didukung");
  if (p === "/") p = "/index.html";
  if (!STATIC.test(p)) return fail(res, 404, "Tidak ditemukan");
  /* halaman utama hanya untuk yang sudah login; yang sudah login tidak perlu melihat halaman login lagi */
  if (p === "/index.html" && !who(req)){ res.writeHead(302, { Location: "/login.html", "Cache-Control": "no-store" }); return res.end(); }
  if (p === "/login.html" && who(req)){ res.writeHead(302, { Location: "/", "Cache-Control": "no-store" }); return res.end(); }
  const f = path.join(FRONT, p);
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, "Tidak ditemukan");
    const tag = `"${st.size}-${Math.round(st.mtimeMs)}"`, head = { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache", ETag: tag, "X-Content-Type-Options": "nosniff" };
    if (req.headers["if-none-match"] === tag){ res.writeHead(304, head); return res.end(); }
    res.writeHead(200, { ...head, "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(f).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let p; try{ p = new URL(req.url, "http://x").pathname; }catch(e){ return fail(res, 400, "URL tidak sah"); }
  if (p.startsWith("/api/")) api(req, res, p).catch(e => { if (!res.headersSent) fail(res, e.status || 500, e.message); else res.destroy(); if (!e.status) console.error(e); });
  else file(req, res, p);
});
server.listen(PORT, HOST, () => console.log(`GrandCodex: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  ·  basis data: ${DB_FILE}`));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { server.close(); server.closeAllConnections?.(); try{ db.close(); }catch(e){} process.exit(0); });
