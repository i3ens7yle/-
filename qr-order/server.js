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
const SALES_DIR = path.join(DATA_DIR, "sales"); // ประวัติการขาย 1 ไฟล์ต่อเดือน เก็บถาวร
const PORT = Number(process.env.PORT) || 3000;

fs.mkdirSync(SALES_DIR, { recursive: true });

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
    // เมนูที่ยังไม่ติ๊กว่า "ได้แล้ว" เกินกี่นาที ให้เด้งเตือนที่หน้าจอพนักงาน
    lateMinutes: Math.max(1, Number(c.lateMinutes) || 20),
    // VAT ที่บวกเพิ่มจากราคาในเมนู (ใส่ 0 ถ้าไม่เก็บ VAT)
    vatPercent: c.vatPercent == null ? 7 : Math.max(0, Number(c.vatPercent) || 0),
    // ร้านเปิดเลยเที่ยงคืน: ยอดก่อนกี่โมงเช้า นับเป็นของ "วันก่อนหน้า"
    dayStartHour: Math.max(0, Math.min(12, c.dayStartHour == null ? 6 : Number(c.dayStartHour) || 0)),
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
  { nextNo: 1, orders: [], calls: {}, soldOut: [], openTables: {}, moved: {} },
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
const money = (n) => Math.round(n * 100) / 100;
// ยอดที่ลูกค้าต้องจ่าย = ราคาอาหาร + VAT
function billFor(subtotal) {
  const p = config().vatPercent;
  const vat = money((subtotal * p) / 100);
  return { subtotal, vatPercent: p, vat, total: money(subtotal + vat) };
}
// "วันขาย" ของร้าน: ยอดหลังเที่ยงคืนก่อน dayStartHour นับเป็นวันก่อนหน้า
const businessDay = (ts) => bangkokDate(ts - config().dayStartHour * 3600e3);
const bangkokHour = (ts) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", hourCycle: "h23" }).format(new Date(ts)));

// ---------- ประวัติการขาย (data/sales/YYYY-MM.jsonl: 1 บรรทัด = 1 บิลที่ปิดแล้ว) ----------
const sales = [];
for (const f of fs.readdirSync(SALES_DIR).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()) {
  for (const line of fs.readFileSync(path.join(SALES_DIR, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { sales.push(JSON.parse(line)); } catch { console.warn("ข้ามบรรทัดเสียใน", f); }
  }
}
// ---------- รายจ่าย (data/expenses.json) ----------
const EXPENSE_FILE = path.join(DATA_DIR, "expenses.json");
const EXPENSE_CATEGORIES = ["วัตถุดิบอาหาร", "เบียร์ / เหล้า / เครื่องดื่ม", "น้ำแข็ง / แก๊ส", "ค่าแรงพนักงาน", "ค่าเช่าที่", "ค่าน้ำ / ค่าไฟ / เน็ต", "อุปกรณ์ / ซ่อมแซม", "อื่นๆ"];
const expenses = readJson(EXPENSE_FILE, []);
function saveExpenses() {
  const tmp = EXPENSE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(expenses, null, 1));
  fs.renameSync(tmp, EXPENSE_FILE);
}
const expensesIn = (from, to) => expenses.filter((e) => e.date >= from && e.date <= to);

function recordSale(rec) {
  sales.push(rec);
  fs.appendFileSync(path.join(SALES_DIR, rec.day.slice(0, 7) + ".jsonl"), JSON.stringify(rec) + "\n");
}
function isOpen(t) {
  return !config().requireOpenTable || !!state.openTables[t];
}
function today() {
  const d = businessDay(Date.now());
  const bills = sales.filter((b) => b.day === d);
  return { date: d, bills: bills.length, sales: money(bills.reduce((s, b) => s + b.total, 0)) };
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
    vatPercent: c.vatPercent,
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
  res.json({ table: t, open: isOpen(t), movedTo, orders: openOrders(t), total: tableTotal(t), bill: billFor(tableTotal(t)), call: state.calls[t] || null });
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
    lines.push({ id: m.id, name: m.name, price: Number(m.price) || 0, qty, done: false });
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
      total: billFor(tableTotal(t)).total, // ยอดที่ลูกค้าต้องจ่าย (รวม VAT)
      pending: os_.filter((o) => o.status === "new" || o.status === "cooking").length,
      since: opened ? opened.openedAt : os_.length ? os_[0].createdAt : null,
      call: state.calls[t] || null,
    });
  }
  res.json({ shopName: c.shopName, requireOpenTable: c.requireOpenTable, lateMinutes: c.lateMinutes, vatPercent: c.vatPercent, now: Date.now(), orders: openOrders(), tables, soldOut: state.soldOut, today: today() });
});

app.post("/api/staff/order/:id/status", staffOnly, (req, res) => {
  const o = state.orders.find((x) => x.id === req.params.id);
  const status = req.body && req.body.status;
  if (!o) return res.status(404).json({ error: "ไม่พบออร์เดอร์" });
  if (!["new", "cooking", "served", "cancelled"].includes(status)) return res.status(400).json({ error: "สถานะไม่ถูกต้อง" });
  o.status = status;
  o.updatedAt = Date.now();
  // กด "เสิร์ฟแล้ว" ทั้งออร์เดอร์ = ติ๊กทุกเมนู
  if (status === "served") for (const l of o.items) if (!l.done) (l.done = true), (l.doneAt = o.updatedAt);
  save();
  broadcast(o.table);
  res.json(o);
});

// ติ๊กทีละเมนูว่า "ได้แล้ว" ครบทุกเมนู = ออร์เดอร์เสิร์ฟแล้วอัตโนมัติ
app.post("/api/staff/order/:id/item/:idx", staffOnly, (req, res) => {
  const o = state.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "ไม่พบออร์เดอร์" });
  if (o.status === "cancelled") return res.status(400).json({ error: "ออร์เดอร์นี้ถูกยกเลิกแล้ว" });
  const l = o.items[Number(req.params.idx)];
  if (!l) return res.status(404).json({ error: "ไม่พบรายการ" });
  const done = !!(req.body && req.body.done);
  l.done = done;
  if (done) l.doneAt = Date.now();
  else delete l.doneAt;
  const all = o.items.every((x) => x.done);
  if (all) o.status = "served";
  else if (o.status === "served" || (o.status === "new" && done)) o.status = "cooking";
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
  const bill = billFor(tableTotal(t));
  const now = Date.now();
  for (const o of list) {
    o.billed = true;
    o.billedAt = now;
  }
  const live = list.filter((o) => o.status !== "cancelled");
  if (live.length) {
    recordSale({
      id: crypto.randomUUID(),
      day: businessDay(now),
      closedAt: now,
      table: t,
      ...bill,
      orders: live.map((o) => o.no),
      // แยกตามออร์เดอร์ เก็บเวลาที่สั่งไว้ด้วย (ใช้ดูช่วงเวลาขายดี)
      items: live.flatMap((o) => o.items.map((l) => ({ id: l.id, name: l.name, price: l.price, qty: l.qty, at: o.createdAt }))),
    });
  }
  delete state.calls[t];
  delete state.openTables[t];
  // เก็บประวัติออร์เดอร์ไว้ 7 วันพอ ไฟล์จะได้ไม่โตเรื่อยๆ
  const cutoff = now - 7 * 864e5;
  state.orders = state.orders.filter((o) => !o.billed || o.billedAt > cutoff);
  save();
  broadcast(t);
  res.json({ ok: true, ...bill, total: bill.total });
});

// ---------- รายงานยอดขาย ----------
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
function reportRange(q) {
  const t = businessDay(Date.now());
  const from = isDay(q.from) ? q.from : t.slice(0, 8) + "01";
  const to = isDay(q.to) ? q.to : t;
  return from <= to ? { from, to } : { from: to, to: from };
}
function buildReport(from, to) {
  const list = sales.filter((b) => b.day >= from && b.day <= to);
  const byDay = new Map(), byMonth = new Map(), items = new Map();
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, revenue: 0, qty: 0 }));
  for (const b of list) {
    const d = byDay.get(b.day) || { day: b.day, total: 0, subtotal: 0, vat: 0, bills: 0 };
    d.total += b.total; d.subtotal += b.subtotal; d.vat += b.vat; d.bills++;
    byDay.set(b.day, d);
    const mk = b.day.slice(0, 7);
    const m = byMonth.get(mk) || { month: mk, total: 0, subtotal: 0, vat: 0, bills: 0 };
    m.total += b.total; m.subtotal += b.subtotal; m.vat += b.vat; m.bills++;
    byMonth.set(mk, m);
    for (const l of b.items) {
      const it = items.get(l.id) || { id: l.id, name: l.name, qty: 0, revenue: 0, bills: new Set() };
      it.qty += l.qty; it.revenue += l.price * l.qty; it.name = l.name; it.bills.add(b.id);
      items.set(l.id, it);
      const h = byHour[bangkokHour(l.at || b.closedAt)];
      h.revenue += l.price * l.qty; h.qty += l.qty;
    }
  }
  // วันที่ไม่มียอดก็ใส่ 0 ไว้ กราฟจะได้ไม่ขาดช่วง
  const days = [];
  for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    days.push(byDay.get(k) || { day: k, total: 0, subtotal: 0, vat: 0, bills: 0 });
  }
  const months = [...new Set(days.map((d) => d.day.slice(0, 7)))].map((k) => byMonth.get(k) || { month: k, total: 0, subtotal: 0, vat: 0, bills: 0 });
  const sold = [...items.values()].map((i) => ({ id: i.id, name: i.name, qty: i.qty, revenue: money(i.revenue), bills: i.bills.size }));
  const soldIds = new Set(sold.map((i) => i.id));
  const unsold = menu().items.filter((i) => !soldIds.has(i.id)).map((i) => ({ id: i.id, name: i.name, price: i.price }));
  const sum = (k) => money(list.reduce((s, b) => s + b[k], 0));
  const r = (x) => ({ ...x, total: money(x.total), subtotal: money(x.subtotal), vat: money(x.vat) });
  const ex = expensesIn(from, to);
  const exTotal = money(ex.reduce((s, e) => s + e.amount, 0));
  const exByCat = new Map();
  for (const e of ex) exByCat.set(e.category, money((exByCat.get(e.category) || 0) + e.amount));
  const exByDay = new Map();
  for (const e of ex) exByDay.set(e.date, money((exByDay.get(e.date) || 0) + e.amount));
  for (const d of days) d.expense = exByDay.get(d.day) || 0;
  for (const m of months) m.expense = money(ex.filter((e) => e.date.startsWith(m.month)).reduce((s, e) => s + e.amount, 0));
  return {
    from, to,
    totals: { total: sum("total"), subtotal: sum("subtotal"), vat: sum("vat"), bills: list.length, qty: sold.reduce((s, i) => s + i.qty, 0),
      expense: exTotal, profit: money(sum("subtotal") - exTotal) },
    expenseByCategory: [...exByCat].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    days: days.map(r), months: months.map(r),
    hours: byHour.map((h) => ({ ...h, revenue: money(h.revenue) })),
    items: sold.sort((a, b) => b.qty - a.qty || b.revenue - a.revenue),
    unsold,
  };
}
app.get("/api/staff/report", staffOnly, (req, res) => {
  const { from, to } = reportRange(req.query);
  res.json({ shopName: config().shopName, vatPercent: config().vatPercent, today: businessDay(Date.now()), firstDay: sales.length ? sales[0].day : null, ...buildReport(from, to) });
});

// ดาวน์โหลดเป็น CSV เปิดด้วย Excel / Google Sheets ได้
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
app.get("/api/staff/report.csv", staffOnly, (req, res) => {
  const { from, to } = reportRange(req.query);
  let rows;
  if (req.query.type === "ledger") {
    // บัญชีรายรับรายจ่าย (เงินเข้า-ออกจริง) มียอดยกมาและคงเหลือสะสม
    const before = (k) => k < from;
    const opening = money(sales.filter((b) => before(b.day)).reduce((s, b) => s + b.total, 0) - expenses.filter((e) => before(e.date)).reduce((s, e) => s + e.amount, 0));
    rows = [["วันที่", "ประเภท", "หมวด", "รายการ", "รายรับ", "รายจ่าย", "คงเหลือ", "VAT ขาย (อยู่ในรายรับ)", "VAT ซื้อ (อยู่ในรายจ่าย)", "หมายเหตุ"]];
    let bal = opening;
    rows.push([from, "ยอดยกมา", "", "ยอดคงเหลือก่อนวันที่ " + from, "", "", bal, "", "", ""]);
    const byDay = new Map();
    for (const b of sales.filter((b) => b.day >= from && b.day <= to)) {
      const d = byDay.get(b.day) || { total: 0, vat: 0, bills: 0 };
      d.total += b.total; d.vat += b.vat; d.bills++; byDay.set(b.day, d);
    }
    const ex = expensesIn(from, to).slice().sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
    const dates = [...new Set([...byDay.keys(), ...ex.map((e) => e.date)])].sort();
    let inSum = 0, outSum = 0, vatIn = 0, vatOut = 0;
    for (const day of dates) {
      const d = byDay.get(day);
      if (d) {
        bal = money(bal + d.total); inSum += d.total; vatOut += d.vat;
        rows.push([day, "รายรับ", "ขายหน้าร้าน", `ยอดขาย ${d.bills} บิล`, money(d.total), "", bal, money(d.vat), "", ""]);
      }
      for (const e of ex.filter((e) => e.date === day)) {
        bal = money(bal - e.amount); outSum += e.amount; vatIn += e.vat || 0;
        rows.push([day, "รายจ่าย", e.category, e.desc, "", e.amount, bal, "", e.vat || "", e.note || ""]);
      }
    }
    rows.push([], ["", "สรุป", "", "รวมรายรับ", money(inSum), "", "", money(vatOut), "", ""],
      ["", "สรุป", "", "รวมรายจ่าย", "", money(outSum), "", "", money(vatIn), ""],
      ["", "สรุป", "", "รายรับ − รายจ่าย ในช่วงนี้", money(inSum - outSum), "", bal, "", "", ""]);
  } else if (req.query.type === "expenses") {
    rows = [["วันที่", "หมวด", "รายการ", "จำนวนเงิน", "VAT ซื้อ", "หมายเหตุ"],
      ...expensesIn(from, to).sort((a, b) => a.date.localeCompare(b.date)).map((e) => [e.date, e.category, e.desc, e.amount, e.vat || "", e.note || ""])];
  } else if (req.query.type === "lines") {
    rows = [["วันขาย", "เวลาปิดบิล", "โต๊ะ", "เลขบิล", "เมนู", "ราคา", "จำนวน", "รวม (ก่อน VAT)"]];
    for (const b of sales.filter((b) => b.day >= from && b.day <= to)) {
      const closed = new Date(b.closedAt).toLocaleTimeString("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
      for (const l of b.items) rows.push([b.day, closed, b.table, b.id.slice(0, 8), l.name, l.price, l.qty, money(l.price * l.qty)]);
    }
  } else if (req.query.type === "days") {
    const rep = buildReport(from, to);
    rows = [["วันขาย", "จำนวนบิล", "ยอดก่อน VAT", "VAT", "ยอดรวม"], ...rep.days.map((d) => [d.day, d.bills, d.subtotal, d.vat, d.total])];
  } else {
    const rep = buildReport(from, to);
    rows = [["อันดับ", "เมนู", "จำนวนที่ขายได้", "ยอดขาย (ก่อน VAT)", "จำนวนบิลที่สั่ง"],
      ...rep.items.map((i, n) => [n + 1, i.name, i.qty, i.revenue, i.bills]),
      ...rep.unsold.map((i) => ["-", i.name, 0, 0, 0])];
  }
  const name = `sales-${req.query.type || "items"}-${from}_${to}.csv`;
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` });
  res.send("\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n"));
});

// ----- บันทึกรายจ่าย -----
app.get("/api/staff/expenses", staffOnly, (req, res) => {
  const { from, to } = reportRange(req.query);
  res.json({ from, to, today: businessDay(Date.now()), categories: EXPENSE_CATEGORIES,
    expenses: expensesIn(from, to).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt) });
});
app.post("/api/staff/expenses", staffOnly, (req, res) => {
  const b = req.body || {};
  const amount = money(Number(b.amount));
  const vat = money(Number(b.vat) || 0);
  if (!isDay(b.date)) return res.status(400).json({ error: "วันที่ไม่ถูกต้อง" });
  if (!(amount > 0) || amount > 10000000) return res.status(400).json({ error: "ใส่จำนวนเงินให้ถูกต้อง" });
  if (vat < 0 || vat > amount) return res.status(400).json({ error: "VAT ต้องไม่เกินจำนวนเงิน" });
  const desc = String(b.desc || "").trim().slice(0, 120);
  if (!desc) return res.status(400).json({ error: "ใส่รายการด้วย เช่น ซื้อเบียร์ 10 ลัง" });
  const e = { id: crypto.randomUUID(), date: b.date, category: EXPENSE_CATEGORIES.includes(b.category) ? b.category : "อื่นๆ",
    desc, amount, vat, note: String(b.note || "").trim().slice(0, 120), createdAt: Date.now() };
  expenses.push(e);
  saveExpenses();
  res.json(e);
});
app.delete("/api/staff/expenses/:id", staffOnly, (req, res) => {
  const i = expenses.findIndex((e) => e.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "ไม่พบรายการ" });
  expenses.splice(i, 1);
  saveExpenses();
  res.json({ ok: true });
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
