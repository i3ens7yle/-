// ระบบสั่งอาหารผ่าน QR Code
// รัน: npm install แล้ว npm start  → เปิด http://localhost:3000/staff
const express = require("express");
const QRCode = require("qrcode");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SECRET_FILE = path.join(DATA_DIR, "secret.txt");
const PORT = Number(process.env.PORT) || 3000;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- config & menu (อ่านใหม่ทุกครั้ง แก้ไฟล์แล้วมีผลทันที ไม่ต้องรีสตาร์ท) ----------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`อ่านไฟล์ ${path.basename(file)} ไม่ได้: ${e.message}`);
  }
}
function config() {
  const c = readJson(path.join(ROOT, "config.json"));
  return {
    shopName: c.shopName || "ร้านอาหาร",
    tagline: c.tagline || "",
    logo: c.logo || "",
    tables: Math.max(1, Math.min(200, Number(c.tables) || 20)),
    // true = ลูกค้าสั่งได้เฉพาะโต๊ะที่พนักงานกด "เปิดโต๊ะ" แล้ว (กันคนถ่ายรูป QR ไปสั่งเล่นจากนอกร้าน)
    requireOpenTable: c.requireOpenTable !== false,
    staffPin: String(process.env.STAFF_PIN || c.staffPin || "1234"),
    publicUrl: (process.env.PUBLIC_URL || c.publicUrl || "").replace(/\/+$/, ""),
  };
}
function menu() {
  return readJson(path.join(ROOT, "menu.json"));
}

// ---------- รหัสลับของแต่ละโต๊ะ (กันคนนอกร้านเดาลิงก์มาสั่งเล่น) ----------
// บนคลาวด์ที่ดิสก์ถูกล้างได้ ให้ตั้ง TABLE_SECRET ไว้ QR ที่พิมพ์แล้วจะได้ใช้ได้ตลอด
let SECRET = process.env.TABLE_SECRET;
if (!SECRET) try {
  SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();
} catch {
  SECRET = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(SECRET_FILE, SECRET);
}
const tableKey = (t) =>
  crypto.createHmac("sha256", SECRET).update("table:" + t).digest("hex").slice(0, 8);
function tableOk(table, key) {
  const t = Number(table);
  if (!Number.isInteger(t) || t < 1 || t > config().tables) return false;
  const k = String(key || "");
  const expected = tableKey(t);
  return k.length === expected.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(expected));
}

// ---------- ข้อมูลออร์เดอร์ (เก็บลงไฟล์ data/state.json) ----------
const state = Object.assign(
  { nextNo: 1, orders: [], calls: {}, soldOut: [], bills: [], openTables: {}, moved: {} },
  readJson(STATE_FILE, {})
);
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}
const bangkokDate = (ts) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });

function openOrders(table) {
  return state.orders.filter((o) => !o.billed && (table == null || o.table === table));
}
function tableTotal(table) {
  return openOrders(table)
    .filter((o) => o.status !== "cancelled")
    .reduce((s, o) => s + o.total, 0);
}
function isOpen(t) {
  return !config().requireOpenTable || !!state.openTables[t];
}
function today() {
  const d = bangkokDate(Date.now());
  const bills = state.bills.filter((b) => bangkokDate(b.closedAt) === d);
  return { date: d, bills: bills.length, sales: bills.reduce((s, b) => s + b.total, 0) };
}

// ---------- realtime (Server-Sent Events) ----------
const clients = new Set(); // { res, table|null(staff) }
function broadcast(table) {
  for (const c of clients) {
    if (c.table == null || table == null || c.table === table) c.res.write("data: changed\n\n");
  }
}
setInterval(() => {
  for (const c of clients) c.res.write(": ping\n\n");
}, 25000);

// ---------- app ----------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

function staffOnly(req, res, next) {
  const pin = req.get("x-staff-pin") || req.query.pin;
  if (String(pin || "") !== config().staffPin) return res.status(401).json({ error: "PIN ไม่ถูกต้อง" });
  next();
}

// เมนู (ลูกค้าและพนักงานใช้ร่วมกัน)
app.get("/api/menu", (req, res) => {
  const c = config();
  const m = menu();
  const sold = new Set(state.soldOut);
  res.json({
    shopName: c.shopName,
    tagline: c.tagline,
    logo: c.logo,
    tables: c.tables,
    categories: m.categories,
    items: m.items.map((i) => ({ ...i, soldOut: sold.has(i.id) })),
  });
});

// ----- ฝั่งลูกค้า -----
app.get("/api/table/:t", (req, res) => {
  const t = Number(req.params.t);
  if (!tableOk(t, req.query.k)) return res.status(403).json({ error: "QR Code ไม่ถูกต้อง กรุณาสแกนใหม่ที่โต๊ะ" });
  const mv = state.moved[t];
  const movedTo = !openOrders(t).length && mv && Date.now() - mv.at < 3 * 3600e3 ? mv.to : null;
  res.json({ table: t, open: isOpen(t), movedTo, orders: openOrders(t), total: tableTotal(t), call: state.calls[t] || null });
});

const lastOrderAt = new Map();
app.post("/api/order", (req, res) => {
  const { table, k, items, note } = req.body || {};
  const t = Number(table);
  if (!tableOk(t, k)) return res.status(403).json({ error: "QR Code ไม่ถูกต้อง กรุณาสแกนใหม่ที่โต๊ะ" });
  if (!isOpen(t)) return res.status(403).json({ error: "โต๊ะนี้ยังไม่เปิด กรุณาเรียกพนักงานเพื่อเปิดโต๊ะก่อน" });
  if (Date.now() - (lastOrderAt.get(t) || 0) < 3000)
    return res.status(429).json({ error: "สั่งถี่เกินไป รอสักครู่แล้วลองใหม่" });

  const byId = new Map(menu().items.map((i) => [i.id, i]));
  const sold = new Set(state.soldOut);
  const lines = [];
  for (const it of Array.isArray(items) ? items : []) {
    const m = byId.get(it && it.id);
    const qty = Math.floor(Number(it && it.qty));
    if (!m || !(qty >= 1 && qty <= 99)) continue;
    if (sold.has(m.id)) return res.status(409).json({ error: `ขออภัย "${m.name}" หมดแล้ว` });
    // ราคาใช้จากเมนูฝั่งร้านเสมอ ไม่เชื่อราคาที่มาจากมือถือลูกค้า
    lines.push({ id: m.id, name: m.name, price: Number(m.price) || 0, qty });
  }
  if (!lines.length) return res.status(400).json({ error: "ยังไม่ได้เลือกรายการ" });
  if (lines.length > 50) return res.status(400).json({ error: "รายการเยอะเกินไป" });

  const order = {
    id: crypto.randomUUID(),
    no: state.nextNo++,
    table: t,
    items: lines,
    note: String(note || "").slice(0, 200),
    total: lines.reduce((s, l) => s + l.price * l.qty, 0),
    status: "new",
    createdAt: Date.now(),
    billed: false,
  };
  state.orders.push(order);
  lastOrderAt.set(t, Date.now());
  save();
  broadcast(t);
  res.json(order);
});

app.post("/api/call", (req, res) => {
  const { table, k, type } = req.body || {};
  const t = Number(table);
  if (!tableOk(t, k)) return res.status(403).json({ error: "QR Code ไม่ถูกต้อง" });
  if (!["staff", "bill"].includes(type)) return res.status(400).json({ error: "type ไม่ถูกต้อง" });
  if (type === "bill" && !isOpen(t)) return res.status(403).json({ error: "โต๊ะนี้ยังไม่เปิด" });
  const prev = state.calls[t];
  if (prev && Date.now() - prev.at < 10000) return res.json({ ok: true }); // กันกดรัว
  state.calls[t] = { type, at: Date.now() };
  save();
  broadcast(t);
  res.json({ ok: true });
});

app.get("/api/stream", (req, res) => {
  let table = null;
  if (req.query.table != null) {
    table = Number(req.query.table);
    if (!tableOk(table, req.query.k)) return res.status(403).end();
  } else if (String(req.query.pin || "") !== config().staffPin) {
    return res.status(401).end();
  }
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  const c = { res, table };
  clients.add(c);
  req.on("close", () => clients.delete(c));
});

// ----- ฝั่งพนักงาน -----
app.get("/api/staff/state", staffOnly, (req, res) => {
  const c = config();
  const tables = [];
  for (let t = 1; t <= c.tables; t++) {
    const os_ = openOrders(t);
    const opened = state.openTables[t];
    tables.push({
      table: t,
      open: isOpen(t),
      openedAt: opened ? opened.openedAt : null,
      orders: os_.length,
      total: tableTotal(t),
      pending: os_.filter((o) => o.status === "new" || o.status === "cooking").length,
      since: opened ? opened.openedAt : os_.length ? os_[0].createdAt : null,
      call: state.calls[t] || null,
    });
  }
  res.json({ shopName: c.shopName, requireOpenTable: c.requireOpenTable, orders: openOrders(), tables, soldOut: state.soldOut, today: today() });
});

app.post("/api/staff/order/:id/status", staffOnly, (req, res) => {
  const o = state.orders.find((x) => x.id === req.params.id);
  const status = req.body && req.body.status;
  if (!o) return res.status(404).json({ error: "ไม่พบออร์เดอร์" });
  if (!["new", "cooking", "served", "cancelled"].includes(status)) return res.status(400).json({ error: "สถานะไม่ถูกต้อง" });
  o.status = status;
  o.updatedAt = Date.now();
  save();
  broadcast(o.table);
  res.json(o);
});

app.post("/api/staff/table/:t/open", staffOnly, (req, res) => {
  const t = Number(req.params.t);
  if (!Number.isInteger(t) || t < 1 || t > config().tables) return res.status(404).json({ error: "ไม่พบโต๊ะ" });
  if (!state.openTables[t]) state.openTables[t] = { openedAt: Date.now() };
  delete state.moved[t];
  if (state.calls[t] && state.calls[t].type === "staff") delete state.calls[t];
  save();
  broadcast(t);
  res.json({ ok: true });
});

// ย้ายโต๊ะ: ถ้าโต๊ะปลายทางว่าง = ย้าย, ถ้ามีลูกค้าอยู่แล้ว = รวมบิลเป็นโต๊ะเดียว
app.post("/api/staff/table/:t/move", staffOnly, (req, res) => {
  const from = Number(req.params.t);
  const to = Number(req.body && req.body.to);
  const max = config().tables;
  if (![from, to].every((x) => Number.isInteger(x) && x >= 1 && x <= max) || from === to)
    return res.status(400).json({ error: "เลขโต๊ะไม่ถูกต้อง" });
  const list = openOrders(from);
  if (!list.length && !state.openTables[from]) return res.status(400).json({ error: `โต๊ะ ${from} ไม่มีลูกค้า` });
  const merged = openOrders(to).length > 0 || !!state.openTables[to];
  for (const o of list) {
    if (o.movedFrom == null) o.movedFrom = from;
    o.table = to;
  }
  const a = state.openTables[from], b = state.openTables[to];
  if (a || b) state.openTables[to] = { openedAt: Math.min(a ? a.openedAt : Infinity, b ? b.openedAt : Infinity) };
  delete state.openTables[from];
  if (state.calls[from] && !state.calls[to]) state.calls[to] = state.calls[from];
  delete state.calls[from];
  delete state.moved[to];
  state.moved[from] = { to, at: Date.now() };
  save();
  broadcast(from);
  broadcast(to);
  res.json({ ok: true, merged });
});

app.post("/api/staff/table/:t/close", staffOnly, (req, res) => {
  const t = Number(req.params.t);
  const list = openOrders(t);
  if (!list.length && !state.calls[t] && !state.openTables[t]) return res.status(400).json({ error: "โต๊ะนี้ไม่มีบิลค้าง" });
  const total = tableTotal(t);
  const now = Date.now();
  for (const o of list) {
    o.billed = true;
    o.billedAt = now;
  }
  if (list.length) state.bills.push({ table: t, total, orders: list.map((o) => o.no), closedAt: now });
  delete state.calls[t];
  delete state.openTables[t];
  // เก็บประวัติออร์เดอร์ไว้ 7 วันพอ ไฟล์จะได้ไม่โตเรื่อยๆ
  const cutoff = now - 7 * 864e5;
  state.orders = state.orders.filter((o) => !o.billed || o.billedAt > cutoff);
  save();
  broadcast(t);
  res.json({ ok: true, total });
});

app.post("/api/staff/call/:t/clear", staffOnly, (req, res) => {
  const t = Number(req.params.t);
  delete state.calls[t];
  save();
  broadcast(t);
  res.json({ ok: true });
});

app.post("/api/staff/soldout", staffOnly, (req, res) => {
  const { id, soldOut } = req.body || {};
  if (!menu().items.some((i) => i.id === id)) return res.status(404).json({ error: "ไม่พบเมนู" });
  state.soldOut = state.soldOut.filter((x) => x !== id);
  if (soldOut) state.soldOut.push(id);
  save();
  broadcast(null);
  res.json({ ok: true });
});

// ----- QR Code -----
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "localhost";
}
function baseUrl(req) {
  const c = config();
  if (req.query.base) return String(req.query.base).replace(/\/+$/, "");
  if (c.publicUrl) return c.publicUrl;
  const host = req.get("host") || `localhost:${PORT}`;
  // ถ้าเปิดจาก localhost ให้ใช้ IP ในวง Wi-Fi แทน มือถือลูกค้าจะได้เข้าถึงได้
  if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) return `http://${lanAddress()}:${PORT}`;
  return `${req.protocol}://${host}`;
}
const tableUrl = (base, t) => `${base}/?table=${t}&k=${tableKey(t)}`;

app.get("/api/staff/qr-links", staffOnly, (req, res) => {
  const base = baseUrl(req);
  const out = [];
  for (let t = 1; t <= config().tables; t++) out.push({ table: t, url: tableUrl(base, t) });
  res.json({ base, links: out });
});

app.get("/api/staff/qr/:t.svg", staffOnly, async (req, res) => {
  const t = Number(req.params.t);
  if (!Number.isInteger(t) || t < 1 || t > config().tables) return res.status(404).end();
  const svg = await QRCode.toString(tableUrl(baseUrl(req), t), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  res.type("image/svg+xml").send(svg);
});

app.listen(PORT, () => {
  console.log(`\n  ระบบสั่งอาหาร QR พร้อมแล้ว`);
  console.log(`  หน้าพนักงาน:   http://localhost:${PORT}/staff   (PIN ใน config.json)`);
  console.log(`  พิมพ์ QR โต๊ะ: http://localhost:${PORT}/qr`);
  console.log(`  ในวง Wi-Fi ร้าน: http://${lanAddress()}:${PORT}\n`);
});
