/**
 * ระบบลงเวลาพนักงานด้วย QR Code (แบบ B)
 *
 *  - หน้าจอร้าน (Kiosk) แสดง QR ที่เปลี่ยนทุก 30 วินาที → ถ่ายรูปเก็บไว้สแกนทีหลังไม่ได้
 *  - พนักงานสแกนด้วยมือถือตัวเอง → เลือกชื่อ → ใส่ PIN → ถ่ายเซลฟี่ → กดเข้า/ออกงาน
 *  - คนที่ไม่มีมือถือ กดปุ่ม "ลงเวลาที่เครื่องนี้" บนหน้าจอร้านได้เลย
 *  - กันลงเวลาแทนกัน: รหัสประจำเครื่อง + เตือนอัตโนมัติ, ผูกเครื่อง (เลือกเปิด),
 *    รูปเซลฟี่ขึ้นบนหน้าจอร้าน, หน้า "ตรวจรูป" สำหรับเจ้าของร้าน
 *  - ข้อมูลทั้งหมดเก็บใน Google Sheet นี้ รูปเซลฟี่เก็บใน Google Drive
 *
 * วิธีติดตั้งดูใน README.md
 */

const TZ = 'Asia/Bangkok';
const SHEETS = { EMP: 'พนักงาน', LOG: 'บันทึกเวลา', DEV: 'อุปกรณ์', SET: 'ตั้งค่า' };
const EMP_HEADERS = ['รหัส', 'ชื่อ', 'PIN', 'เวลาเริ่มงาน', 'สถานะ'];
const LOG_HEADERS = ['เวลาบันทึก', 'วันที่', 'เวลา', 'รหัส', 'ชื่อ', 'ประเภท', 'ช่องทาง', 'รูป', 'อุปกรณ์', 'รหัสเครื่อง', 'ตรวจสอบ'];
const DEV_HEADERS = ['รหัสพนักงาน', 'ชื่อ', 'รหัสเครื่อง', 'รุ่นเครื่อง', 'เห็นครั้งแรก', 'ใช้ล่าสุด', 'สถานะ', 'หมายเหตุ'];
const DEV_STATUS = { OK: 'อนุมัติ', PENDING: 'รออนุมัติ', NO: 'ไม่อนุมัติ' };
const DEVICE_RE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const TYPE_LABEL = { IN: 'เข้างาน', OUT: 'ออกงาน' };
const CHANNEL = { PHONE: 'มือถือพนักงาน', KIOSK: 'เครื่องของร้าน' };
const SETTING_DEFAULTS = [
  ['SHOP_NAME', 'อาม่า แคมป์', 'ชื่อร้านที่แสดงบนหน้าจอ'],
  ['ADMIN_PIN', '9999', 'รหัสเปิดหน้าจอร้านและหน้าตรวจรูป — เปลี่ยนทันทีหลังติดตั้ง!'],
  ['QR_SECONDS', 30, 'QR บนหน้าจอร้านเปลี่ยนทุกกี่วินาที (10–300)'],
  ['REQUIRE_PHOTO', 'TRUE', 'บังคับถ่ายเซลฟี่ตอนลงเวลา (TRUE/FALSE)'],
  ['MIN_GAP_MINUTES', 2, 'กันกดซ้ำ: ลงเวลาประเภทเดิมซ้ำได้หลังผ่านไปกี่นาที'],
  ['MAX_SHIFT_HOURS', 16, 'ถ้าเข้า–ออกห่างกันเกินกี่ชั่วโมง ถือว่าลืมลงเวลาออก'],
  ['DEVICE_LOCK', 'FALSE', 'ผูกเครื่อง: TRUE = ลงเวลาได้เฉพาะมือถือที่อนุมัติแล้ว (แนะนำเปิดหลังใช้ไป 1 สัปดาห์)'],
  ['KIOSK_PHOTO', 'TRUE', 'แสดงรูปเซลฟี่บนหน้าจอร้าน 5 วินาทีหลังมีคนลงเวลา (TRUE/FALSE)'],
];
const PASS_MINUTES = 5;      // หลังสแกน QR มีเวลากรอก PIN/ถ่ายรูปกี่นาที
const MAX_PIN_FAILS = 5;     // ใส่ PIN ผิดเกินนี้ ล็อก 10 นาที
const MAX_ADMIN_FAILS = 10;
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

// ───────────────────────── เมนูใน Google Sheet ─────────────────────────
// ทุกฟังก์ชันในส่วนนี้เรียก SpreadsheetApp.getUi() เป็นบรรทัดแรก
// ซึ่งจะ error ถ้ามีคนพยายามเรียกผ่านเว็บ จึงเรียกได้จากเมนูเท่านั้น

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⏱ ระบบลงเวลา')
    .addItem('1) ตั้งค่าเริ่มต้น (ทำครั้งแรก / หลังอัปเดตโค้ด)', 'setup')
    .addItem('2) ดูลิงก์หน้าจอร้าน และหน้าตรวจรูป', 'showLinks')
    .addSeparator()
    .addItem('สร้างสรุปรายเดือน', 'promptMonthlySummary')
    .addItem('อนุมัติเครื่องที่รออยู่ทั้งหมด', 'approveAllPending')
    .addItem('เปลี่ยนรหัสลับของ QR', 'rotateSecret')
    .addToUi();
}

function setup() {
  const ui = SpreadsheetApp.getUi();
  const ss = ss_();
  ss.setSpreadsheetTimeZone(TZ);

  const emp = ensureSheet_(SHEETS.EMP, EMP_HEADERS);
  emp.getRange('C:D').setNumberFormat('@'); // PIN/เวลาเริ่มงานเป็นข้อความ (ไม่ให้ 0 นำหน้าหาย)
  if (emp.getLastRow() < 2) {
    emp.getRange(2, 1, 2, 5).setValues([
      ['E01', 'ตัวอย่าง ก', '1234', '16:00', 'ทำงาน'],
      ['E02', 'ตัวอย่าง ข', '5678', '17:00', 'ทำงาน'],
    ]);
  }

  const log = ensureSheet_(SHEETS.LOG, LOG_HEADERS);
  log.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  log.getRange('B:C').setNumberFormat('@');

  devValidation_(ensureSheet_(SHEETS.DEV, DEV_HEADERS));

  const set = ensureSheet_(SHEETS.SET, ['ชื่อค่า', 'ค่า', 'คำอธิบาย']);
  const have = {};
  if (set.getLastRow() > 1) {
    set.getRange(2, 1, set.getLastRow() - 1, 1).getValues().forEach(function (r) { have[String(r[0]).trim()] = true; });
  }
  SETTING_DEFAULTS.forEach(function (row) { if (!have[row[0]]) set.appendRow(row); });

  getSecret_();
  photoFolder_();

  ui.alert('ตั้งค่าเสร็จแล้ว ✅',
    'ขั้นต่อไป:\n' +
    '1. แท็บ "ตั้งค่า" → เปลี่ยน ADMIN_PIN (ชื่อร้านตั้งเป็น อาม่า แคมป์ ไว้แล้ว)\n' +
    '2. แท็บ "พนักงาน" → ใส่รายชื่อ รหัส และ PIN ของแต่ละคน (ลบแถวตัวอย่างออก)\n' +
    '3. Deploy เป็นเว็บแอป (ดู README) แล้วกดเมนู "ดูลิงก์หน้าจอร้าน"',
    ui.ButtonSet.OK);
}

function showLinks() {
  const ui = SpreadsheetApp.getUi();
  const url = ScriptApp.getService().getUrl();
  if (!url) {
    ui.alert('ยังไม่ได้ Deploy เป็นเว็บแอป — ทำตามขั้นตอนใน README ก่อน');
    return;
  }
  const link = function (u) { return '<a href="' + u + '" target="_blank" style="word-break:break-all">' + u + '</a>'; };
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.6">' +
    '<p><b>หน้าจอร้าน</b> — เปิดบนแท็บเล็ตของร้าน แล้วใส่ ADMIN_PIN:<br>' + link(url + '?page=kiosk') + '</p>' +
    '<p><b>ตรวจรูป / อนุมัติเครื่อง</b> — สำหรับเจ้าของร้าน เปิดบนมือถือตัวเองได้:<br>' + link(url + '?page=review') + '</p>' +
    '<p style="color:#666">ไม่ต้องส่งลิงก์เหล่านี้ให้พนักงาน — พนักงานแค่สแกน QR ที่ขึ้นบนหน้าจอร้าน</p></div>'
  ).setWidth(580).setHeight(300);
  ui.showModalDialog(html, 'ลิงก์ของระบบ');
}

function promptMonthlySummary() {
  const ui = SpreadsheetApp.getUi();
  const def = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const res = ui.prompt('สรุปรายเดือน', 'ใส่เดือนที่ต้องการ เช่น ' + def + ' (ปี พ.ศ. ก็ได้)', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const month = normalizeMonth_(res.getResponseText() || def);
  if (!month) { ui.alert('รูปแบบเดือนไม่ถูกต้อง ใช้แบบ ' + def); return; }
  const name = buildMonthlySummary_(month);
  ss_().getSheetByName(name).activate();
  ui.alert('สร้างแท็บ "' + name + '" แล้ว');
}

function approveAllPending() {
  const ui = SpreadsheetApp.getUi();
  const pending = readDevices_().filter(function (d) { return d.status === DEV_STATUS.PENDING; });
  if (!pending.length) { ui.alert('ไม่มีเครื่องที่รออนุมัติ'); return; }
  const list = pending.map(function (d) { return '• ' + d.empName + ' — ' + d.deviceId + ' (' + d.deviceName + ')' + (d.note ? ' ' + d.note : ''); }).join('\n');
  const ok = ui.alert('อนุมัติทั้งหมด ' + pending.length + ' เครื่อง?', list, ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  pending.forEach(function (d) { setDeviceStatus_(d, DEV_STATUS.OK); });
  ui.alert('อนุมัติแล้ว ' + pending.length + ' เครื่อง');
}

function rotateSecret() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('เปลี่ยนรหัสลับของ QR?',
    'QR และลิงก์ที่เปิดค้างไว้ทั้งหมดจะใช้ไม่ได้ทันที (หน้าจอร้านจะสร้าง QR ใหม่ให้เอง)',
    ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty('QR_SECRET', newSecret_());
  ui.alert('เปลี่ยนรหัสลับแล้ว');
}

// ───────────────────────── หน้าเว็บ ─────────────────────────

function doGet(e) {
  const p = (e && e.parameter) || {};
  const cfg = getSettings_();
  const mode = p.page === 'kiosk' || p.page === 'review' ? p.page : 'punch';
  const boot = { mode: mode, shopName: cfg.SHOP_NAME, requirePhoto: cfg.REQUIRE_PHOTO };
  if (mode === 'punch') {
    try {
      if (!p.t) throw userError_('กรุณาสแกน QR Code ที่หน้าจอของร้านเพื่อลงเวลา');
      verifyQrToken_(p.t, cfg);
      boot.pass = makePass_(nowSec_());
    } catch (err) {
      boot.error = err.message;
    }
  }
  const titles = { kiosk: 'หน้าจอลงเวลา · ', review: 'ตรวจรูปลงเวลา · ', punch: 'ลงเวลา · ' };
  const t = HtmlService.createTemplateFromFile('Index');
  t.bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle(titles[mode] + boot.shopName)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

// ── API สำหรับมือถือพนักงาน (ต้องมี pass ที่ได้จากการสแกน QR) ──

function apiEmployees(pass) {
  return api_(function () {
    verifyPass_(pass);
    return { employees: publicEmployees_() };
  });
}

function apiLogin(pass, empId, pin, device) {
  return api_(function () {
    const cfg = getSettings_();
    verifyPass_(pass);
    const emp = authEmployee_(empId, pin);
    deviceGate_(emp, device, cfg, false);
    return loginResult_(emp, cfg);
  });
}

function apiPunch(req) {
  return api_(function () {
    req = req || {};
    const cfg = getSettings_();
    verifyPass_(req.pass);
    const emp = authEmployee_(req.empId, req.pin);
    const dev = deviceGate_(emp, req.device, cfg, true);
    const res = recordPunch_(emp, req, CHANNEL.PHONE, cfg, dev);
    CacheService.getScriptCache().put('used_' + req.pass, '1', 21600);
    return res;
  });
}

// ── API สำหรับหน้าจอร้าน (ต้องมี ADMIN_PIN) ──

function apiKioskInit(adminPin) {
  return api_(function () {
    const cfg = getSettings_();
    checkAdmin_(adminPin, cfg);
    return {
      shopName: cfg.SHOP_NAME,
      requirePhoto: cfg.REQUIRE_PHOTO,
      kioskPhoto: cfg.KIOSK_PHOTO,
      qr: qrPayload_(cfg),
      board: board_(cfg),
      employees: publicEmployees_(),
      feedTs: Date.now(),
    };
  });
}

function apiKioskRefresh(adminPin) {
  return api_(function () {
    const cfg = getSettings_();
    checkAdmin_(adminPin, cfg);
    return { qr: qrPayload_(cfg), board: board_(cfg) };
  });
}

/** รายการลงเวลาใหม่ตั้งแต่ since (ms) พร้อมรูปย่อ — หน้าจอร้านเรียกทุก ~5 วินาที (อ่านจาก cache ไม่แตะชีต) */
function apiKioskFeed(adminPin, since) {
  return api_(function () {
    const cfg = getSettings_();
    checkAdmin_(adminPin, cfg);
    const cache = CacheService.getScriptCache();
    const items = readFeed_(cache).filter(function (i) { return i.ts > Number(since || 0); });
    const keys = cfg.KIOSK_PHOTO ? items.map(function (i) { return i.tk; }).filter(String) : [];
    const thumbs = keys.length ? cache.getAll(keys) : {};
    return {
      items: items.map(function (i) {
        return { ts: i.ts, name: i.name, type: i.type, label: i.label, time: i.time, kiosk: i.kiosk, thumb: thumbs[i.tk] || '' };
      }),
    };
  });
}

function apiKioskLogin(adminPin, empId, pin) {
  return api_(function () {
    const cfg = getSettings_();
    checkAdmin_(adminPin, cfg);
    return loginResult_(authEmployee_(empId, pin), cfg);
  });
}

function apiKioskPunch(req) {
  return api_(function () {
    req = req || {};
    const cfg = getSettings_();
    checkAdmin_(req.adminPin, cfg);
    const emp = authEmployee_(req.empId, req.pin);
    return recordPunch_(emp, req, CHANNEL.KIOSK, cfg, { id: '', name: 'แท็บเล็ตร้าน', flags: [] });
  });
}

// ── API หน้าตรวจรูป สำหรับเจ้าของร้าน (ต้องมี ADMIN_PIN) ──

function apiReviewDay(adminPin, day) {
  return api_(function () {
    const cfg = getSettings_();
    checkAdmin_(adminPin, cfg);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : dayOf_(Date.now());
    const entries = readLogs_(0)
      .filter(function (l) { return dayOf_(l.ts) === d; })
      .sort(function (a, b) { return a.ts - b.ts; })
      .map(function (l) {
        return {
          row: l.rowNum, ts: l.ts, id: l.id, name: l.name, type: l.type, label: TYPE_LABEL[l.type],
          time: Utilities.formatDate(new Date(l.ts), TZ, 'HH:mm:ss'),
          kiosk: l.channel === CHANNEL.KIOSK, deviceId: l.deviceId, deviceName: l.deviceName,
          flags: l.flags, hasPhoto: !!driveId_(l.photo), url: l.photo,
        };
      });
    return {
      day: d,
      label: thaiDate_(Date.parse(d + 'T12:00:00+07:00')),
      today: dayOf_(Date.now()),
      deviceLock: cfg.DEVICE_LOCK,
      entries: entries,
      pending: pendingDevices_(),
    };
  });
}

/** รูปเซลฟี่ของแถวที่ขอ (สูงสุด 8 รูป/ครั้ง) — ต้องส่ง row + ts ให้ตรงกับชีต จึงขอรูปอื่นใน Drive ไม่ได้ */
function apiReviewPhotos(adminPin, items) {
  return api_(function () {
    const cfg = getSettings_();
    checkAdmin_(adminPin, cfg);
    const sh = sheet_(SHEETS.LOG);
    const last = sh.getLastRow();
    const photos = {};
    (items || []).slice(0, 8).forEach(function (it) {
      const row = Number(it && it.row);
      if (!(row >= 2 && row <= last)) return;
      const v = sh.getRange(row, 1, 1, 8).getValues()[0];
      const ts = v[0] instanceof Date ? v[0].getTime() : NaN;
      const id = driveId_(v[7]);
      if (ts !== Number(it.ts) || !id) return;
      try {
        const blob = DriveApp.getFileById(id).getBlob();
        photos[row] = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
      } catch (e) { /* ไฟล์ถูกลบ */ }
    });
    return { photos: photos };
  });
}

function apiReviewDevice(adminPin, row, deviceId, empId, decision) {
  return api_(function () {
    const cfg = getSettings_();
    checkAdmin_(adminPin, cfg);
    const d = readDevices_().filter(function (x) {
      return x.rowNum === Number(row) && x.deviceId === deviceId && x.empId === empId;
    })[0];
    if (!d) throw userError_('ไม่พบรายการนี้ (อาจถูกแก้ในชีตไปแล้ว) กรุณารีเฟรชหน้า');
    setDeviceStatus_(d, decision === 'OK' ? DEV_STATUS.OK : DEV_STATUS.NO);
    return { pending: pendingDevices_() };
  });
}

// ───────────────────────── ภายใน ─────────────────────────

function api_(fn) {
  try {
    const r = fn() || {};
    r.ok = true;
    return r;
  } catch (err) {
    console.error(err);
    return { ok: false, error: (err && err.message) || String(err), code: (err && err.code) || '' };
  }
}

function userError_(msg, code) {
  const e = new Error(msg);
  e.code = code || '';
  return e;
}

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw userError_('ไม่พบแท็บ "' + name + '" — เจ้าของร้านต้องกดเมนู ระบบลงเวลา → ตั้งค่าเริ่มต้น ก่อน');
  return sh;
}

/** สร้างแท็บถ้ายังไม่มี และเขียนหัวตารางให้ตรงกับเวอร์ชันล่าสุด (เพิ่มคอลัมน์ใหม่ต่อท้ายได้โดยข้อมูลเดิมไม่เสีย) */
function ensureSheet_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const cur = sh.getLastRow() ? sh.getRange(1, 1, 1, headers.length).getValues()[0] : [];
  if (cur.join('|') !== headers.join('|')) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#efeae0');
    sh.setFrozenRows(1);
  }
  return sh;
}

function nowSec_() { return Math.floor(Date.now() / 1000); }

function clampNum_(v, min, max, def) {
  const n = Number(v);
  if (!isFinite(n) || v === '') return def;
  return Math.min(max, Math.max(min, n));
}

function bool_(v) { return v === true || String(v).trim().toUpperCase() === 'TRUE'; }

function getSettings_() {
  const s = {};
  SETTING_DEFAULTS.forEach(function (row) { s[row[0]] = row[1]; });
  const sh = ss_().getSheetByName(SHEETS.SET);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      const k = String(r[0]).trim();
      if (k && r[1] !== '' && r[1] !== null) s[k] = r[1];
    });
  }
  s.SHOP_NAME = String(s.SHOP_NAME).trim() || 'อาม่า แคมป์';
  s.ADMIN_PIN = String(s.ADMIN_PIN).trim();
  s.QR_SECONDS = Math.round(clampNum_(s.QR_SECONDS, 10, 300, 30));
  s.REQUIRE_PHOTO = bool_(s.REQUIRE_PHOTO);
  s.MIN_GAP_MINUTES = clampNum_(s.MIN_GAP_MINUTES, 0, 120, 2);
  s.MAX_SHIFT_HOURS = clampNum_(s.MAX_SHIFT_HOURS, 4, 24, 16);
  s.DEVICE_LOCK = bool_(s.DEVICE_LOCK);
  s.KIOSK_PHOTO = bool_(s.KIOSK_PHOTO);
  return s;
}

// ── QR token & pass ──

function newSecret_() { return Utilities.getUuid() + Utilities.getUuid(); }

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('QR_SECRET');
  if (!s) {
    s = newSecret_();
    props.setProperty('QR_SECRET', s);
  }
  return s;
}

function sign_(msg) {
  const bytes = Utilities.computeHmacSha256Signature(msg, getSecret_());
  return bytes.slice(0, 8).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function makeQrToken_(win) { return win.toString(36) + '.' + sign_('qr:' + win); }

function verifyQrToken_(tok, cfg) {
  const m = /^([0-9a-z]+)\.([0-9a-f]{16})$/.exec(String(tok || ''));
  const win = m ? parseInt(m[1], 36) : NaN;
  if (!m || sign_('qr:' + win) !== m[2]) throw userError_('QR Code ไม่ถูกต้อง กรุณาสแกนจากหน้าจอของร้าน');
  const age = Math.floor(nowSec_() / cfg.QR_SECONDS) - win;
  if (age < 0 || age > 1) throw userError_('QR Code หมดอายุแล้ว กรุณาสแกนใหม่จากหน้าจอของร้าน');
}

/** pass = สิทธิ์ลงเวลา 1 ครั้งหลังสแกน (มี nonce สุ่ม เพื่อให้คนที่สแกนพร้อมกันได้ pass คนละใบ) */
function makePass_(sec) {
  const nonce = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  return 'p' + sec.toString(36) + '.' + nonce + '.' + sign_('pass:' + sec + ':' + nonce);
}

function verifyPass_(pass) {
  const m = /^p([0-9a-z]+)\.([0-9a-f]{12})\.([0-9a-f]{16})$/.exec(String(pass || ''));
  const sec = m ? parseInt(m[1], 36) : NaN;
  if (!m || sign_('pass:' + sec + ':' + m[2]) !== m[3]) throw userError_('ลิงก์ไม่ถูกต้อง กรุณาสแกน QR Code ใหม่', 'PASS');
  if (nowSec_() - sec > PASS_MINUTES * 60) throw userError_('หมดเวลาแล้ว กรุณาสแกน QR Code ที่หน้าจอร้านใหม่', 'PASS');
  if (CacheService.getScriptCache().get('used_' + pass)) {
    throw userError_('QR ที่สแกนนี้ใช้ลงเวลาไปแล้ว ถ้าจะลงเวลาอีกครั้งกรุณาสแกนใหม่', 'PASS');
  }
}

function qrPayload_(cfg) {
  const secs = cfg.QR_SECONDS;
  const now = nowSec_();
  const win = Math.floor(now / secs);
  return {
    url: ScriptApp.getService().getUrl() + '?t=' + makeQrToken_(win),
    secondsLeft: (win + 1) * secs - now,
    period: secs,
  };
}

// ── พนักงาน & PIN ──

function timeStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, ss_().getSpreadsheetTimeZone(), 'HH:mm');
  const m = /^(\d{1,2})[:.](\d{2})/.exec(String(v).trim());
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}

function readEmployees_() {
  const sh = sheet_(SHEETS.EMP);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 5).getValues().map(function (r) {
    return {
      id: String(r[0]).trim(),
      name: String(r[1]).trim(),
      pin: String(r[2]).trim(),
      start: timeStr_(r[3]),
      active: !/^(ระงับ|ลาออก|พัก|ไม่ใช้งาน|inactive|no|false)$/i.test(String(r[4]).trim()),
    };
  }).filter(function (e) { return e.id && e.name; });
}

function publicEmployees_() {
  return readEmployees_()
    .filter(function (e) { return e.active; })
    .map(function (e) { return { id: e.id, name: e.name }; });
}

function authEmployee_(empId, pin) {
  const id = String(empId || '').trim();
  const cache = CacheService.getScriptCache();
  const key = 'fail_' + id;
  const fails = Number(cache.get(key)) || 0;
  if (fails >= MAX_PIN_FAILS) throw userError_('ใส่ PIN ผิดหลายครั้งเกินไป กรุณารอ 10 นาทีแล้วลองใหม่', 'PIN');
  const emp = readEmployees_().filter(function (e) { return e.id === id && e.active; })[0];
  if (!emp) throw userError_('ไม่พบชื่อพนักงานนี้ กรุณาแจ้งเจ้าของร้าน', 'PIN');
  if (!emp.pin || emp.pin !== String(pin || '').trim()) {
    cache.put(key, String(fails + 1), 600);
    const left = MAX_PIN_FAILS - fails - 1;
    throw userError_('PIN ไม่ถูกต้อง' + (left > 0 ? ' (ลองได้อีก ' + left + ' ครั้ง)' : ' — ถูกล็อก 10 นาที'), 'PIN');
  }
  cache.remove(key);
  return emp;
}

function checkAdmin_(pin, cfg) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fail_admin')) || 0;
  if (fails >= MAX_ADMIN_FAILS) throw userError_('ใส่รหัสผิดหลายครั้งเกินไป กรุณารอ 10 นาที', 'ADMIN');
  if (!cfg.ADMIN_PIN || String(pin || '').trim() !== cfg.ADMIN_PIN) {
    cache.put('fail_admin', String(fails + 1), 600);
    throw userError_('รหัส ADMIN_PIN ไม่ถูกต้อง', 'ADMIN');
  }
  if (fails) cache.remove('fail_admin');
}

// ── อุปกรณ์ (รหัสประจำเครื่อง + ผูกเครื่อง) ──

function devValidation_(sh) {
  sh.getRange('G2:G').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([DEV_STATUS.OK, DEV_STATUS.PENDING, DEV_STATUS.NO], true)
    .setAllowInvalid(false)
    .build());
  sh.getRange('E2:F').setNumberFormat('yyyy-mm-dd hh:mm');
}

function devSheet_() {
  let sh = ss_().getSheetByName(SHEETS.DEV);
  if (!sh) {
    sh = ensureSheet_(SHEETS.DEV, DEV_HEADERS);
    devValidation_(sh);
  }
  return sh;
}

function readDevices_() {
  const sh = ss_().getSheetByName(SHEETS.DEV);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().map(function (r, i) {
    const st = String(r[6]).trim();
    return {
      rowNum: i + 2,
      empId: String(r[0]).trim(),
      empName: String(r[1]).trim(),
      deviceId: String(r[2]).trim().toUpperCase(),
      deviceName: String(r[3]).trim(),
      firstSeen: r[4] instanceof Date ? r[4].getTime() : NaN,
      status: st === DEV_STATUS.OK || st === DEV_STATUS.NO ? st : DEV_STATUS.PENDING,
      note: String(r[7]).trim(),
    };
  }).filter(function (d) { return d.empId && d.deviceId; });
}

function pendingDevices_() {
  return readDevices_()
    .filter(function (d) { return d.status === DEV_STATUS.PENDING; })
    .map(function (d) {
      return {
        row: d.rowNum, empId: d.empId, empName: d.empName, deviceId: d.deviceId, deviceName: d.deviceName,
        firstSeen: isNaN(d.firstSeen) ? '' : describeWhen_(d.firstSeen), note: d.note,
      };
    });
}

function setDeviceStatus_(d, status) {
  const by = (status === DEV_STATUS.OK ? 'อนุมัติ' : 'ไม่อนุมัติ') + 'โดยเจ้าของร้าน ' +
    Utilities.formatDate(new Date(), TZ, 'dd/MM HH:mm');
  devSheet_().getRange(d.rowNum, 7, 1, 2).setValues([[status, d.note ? d.note + ' · ' + by : by]]);
}

function cleanDevice_(device) {
  const id = String((device && device.id) || '').trim().toUpperCase();
  if (!DEVICE_RE.test(id)) return null;
  return { id: id, name: String((device && device.name) || '').slice(0, 60) };
}

/**
 * ตรวจเครื่องที่ใช้ลงเวลา + ลงทะเบียนเครื่องใหม่ในแท็บ "อุปกรณ์"
 * - เครื่องแรกของพนักงาน (และไม่มีคนอื่นเคยใช้) → อนุมัติอัตโนมัติ
 * - เครื่องที่คนอื่นเคยใช้ / เครื่องที่สองขึ้นไป → "รออนุมัติ" + ติดธงเตือน
 * - ถ้าเปิด DEVICE_LOCK เครื่องที่ยังไม่อนุมัติจะลงเวลาไม่ได้
 */
function deviceGate_(emp, device, cfg, touch) {
  const dev = cleanDevice_(device);
  if (!dev) {
    if (cfg.DEVICE_LOCK) {
      throw userError_('เบราว์เซอร์นี้จำรหัสเครื่องไม่ได้ (อาจเปิดโหมดไม่ระบุตัวตนอยู่) กรุณาสแกนด้วยกล้องมือถือแล้วเปิดในเบราว์เซอร์ปกติ', 'DEVICE');
    }
    return { id: '', name: '', flags: ['⚠️ ไม่มีรหัสเครื่อง'] };
  }

  const flags = [];
  let status;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = devSheet_();
    const rows = readDevices_();
    const mine = rows.filter(function (r) { return r.empId === emp.id; });
    const others = rows.filter(function (r) { return r.deviceId === dev.id && r.empId !== emp.id; });
    const otherNames = others.map(function (r) { return r.empName; })
      .filter(function (n, i, a) { return a.indexOf(n) === i; });
    const approvedMine = mine.filter(function (r) { return r.status === DEV_STATUS.OK; });
    const row = mine.filter(function (r) { return r.deviceId === dev.id; })[0];
    const now = new Date();

    if (!row) {
      const auto = !approvedMine.length && !others.length;
      status = auto ? DEV_STATUS.OK : DEV_STATUS.PENDING;
      const note = auto ? 'เครื่องแรก (อนุมัติอัตโนมัติ)'
        : others.length ? 'ใช้ร่วมกับ ' + otherNames.join(', ') : 'เครื่องใหม่';
      sh.appendRow([emp.id, emp.name, dev.id, dev.name, now, now, status, note]);
    } else {
      status = row.status;
      if (touch) sh.getRange(row.rowNum, 6).setValue(now);
    }

    if (others.length) flags.push('⚠️ เครื่องเดียวกับ ' + otherNames.join(', '));
    if (status === DEV_STATUS.NO) flags.push('⚠️ เครื่องที่เจ้าของร้านไม่อนุมัติ');
    else if (status === DEV_STATUS.PENDING && !others.length) {
      const usual = approvedMine.map(function (r) { return r.deviceId; });
      flags.push('⚠️ เครื่องใหม่' + (usual.length ? ' (ปกติใช้ ' + usual.join(', ') + ')' : ''));
    }
  } finally {
    lock.releaseLock();
  }

  if (cfg.DEVICE_LOCK && status !== DEV_STATUS.OK) {
    throw userError_(status === DEV_STATUS.NO
      ? 'มือถือเครื่องนี้ไม่ได้รับอนุญาตให้ลงเวลาของ ' + emp.name
      : 'มือถือเครื่องนี้ยังไม่ได้รับอนุมัติสำหรับ ' + emp.name + ' — แจ้งเจ้าของร้านให้อนุมัติรหัสเครื่อง ' + dev.id + ' แล้วสแกนใหม่',
      'DEVICE');
  }
  return { id: dev.id, name: dev.name, flags: flags };
}

// ── บันทึกเวลา ──

function dayOf_(ts) { return Utilities.formatDate(new Date(ts), TZ, 'yyyy-MM-dd'); }
function hm_(ts) { return Utilities.formatDate(new Date(ts), TZ, 'HH:mm'); }

function thaiDate_(ts) {
  const p = dayOf_(ts).split('-');
  return Number(p[2]) + ' ' + THAI_MONTHS[Number(p[1]) - 1] + ' ' + (Number(p[0]) + 543);
}

function describeWhen_(ts) {
  const now = Date.now();
  if (dayOf_(ts) === dayOf_(now)) return 'วันนี้ ' + hm_(ts);
  if (dayOf_(ts) === dayOf_(now - 86400000)) return 'เมื่อวาน ' + hm_(ts);
  return Utilities.formatDate(new Date(ts), TZ, 'dd/MM') + ' ' + hm_(ts);
}

function driveId_(url) {
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(String(url || ''));
  return m ? m[1] : '';
}

/** อ่านบันทึกเวลา (maxRows = อ่านเฉพาะแถวท้ายสุด, 0 = ทั้งหมด) เรียงตามลำดับที่บันทึก */
function readLogs_(maxRows) {
  const sh = sheet_(SHEETS.LOG);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const start = maxRows ? Math.max(2, last - maxRows + 1) : 2;
  return sh.getRange(start, 1, last - start + 1, LOG_HEADERS.length).getValues().map(function (r, i) {
    const ts = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
    const type = r[5] === TYPE_LABEL.IN ? 'IN' : r[5] === TYPE_LABEL.OUT ? 'OUT' : '';
    return {
      rowNum: start + i, ts: ts, id: String(r[3]).trim(), name: String(r[4]).trim(), type: type,
      channel: String(r[6]), photo: String(r[7]), deviceName: String(r[8]),
      deviceId: String(r[9]).trim(), flags: String(r[10]).trim(),
    };
  }).filter(function (l) { return l.id && l.type && !isNaN(l.ts); });
}

function lastPunchOf_(logs, id) {
  for (let i = logs.length - 1; i >= 0; i--) if (logs[i].id === id) return logs[i];
  return null;
}

function suggestType_(last, cfg) {
  return last && last.type === 'IN' && Date.now() - last.ts < cfg.MAX_SHIFT_HOURS * 3600000 ? 'OUT' : 'IN';
}

function loginResult_(emp, cfg) {
  const last = lastPunchOf_(readLogs_(3000), emp.id);
  return {
    employee: { id: emp.id, name: emp.name },
    last: last ? { type: last.type, label: TYPE_LABEL[last.type], when: describeWhen_(last.ts) } : null,
    suggested: suggestType_(last, cfg),
  };
}

function checkDuplicate_(emp, type, cfg) {
  const last = lastPunchOf_(readLogs_(500), emp.id);
  if (last && last.type === type && Date.now() - last.ts < cfg.MIN_GAP_MINUTES * 60000) {
    throw userError_('คุณลง' + TYPE_LABEL[type] + 'ไปแล้วเมื่อ ' + hm_(last.ts) + ' น.', 'DUP');
  }
}

function cleanThumb_(t) {
  const s = String(t || '');
  return s.length < 90000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';
}

function readFeed_(cache) {
  try { return JSON.parse(cache.get('feed') || '[]'); } catch (e) { return []; }
}

function recordPunch_(emp, req, channel, cfg, dev) {
  const type = req.type === 'IN' || req.type === 'OUT' ? req.type : null;
  if (!type) throw userError_('กรุณาเลือก เข้างาน หรือ ออกงาน');
  if (cfg.REQUIRE_PHOTO && !req.photo) throw userError_('กรุณาถ่ายเซลฟี่ก่อนลงเวลา', 'PHOTO');
  checkDuplicate_(emp, type, cfg);

  const now = new Date();
  const photoUrl = req.photo ? savePhoto_(req.photo, emp, type, now) : '';
  const thumb = cleanThumb_(req.thumb);
  const time = Utilities.formatDate(now, TZ, 'HH:mm:ss');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    checkDuplicate_(emp, type, cfg);
    sheet_(SHEETS.LOG).appendRow([
      now, dayOf_(now), time, emp.id, emp.name, TYPE_LABEL[type], channel, photoUrl,
      dev.name, dev.id, dev.flags.join(' / '),
    ]);
    SpreadsheetApp.flush();

    // ส่งให้หน้าจอร้านโชว์รูป (เก็บใน cache ชั่วคราว 15 นาที ไม่ลงชีต)
    const cache = CacheService.getScriptCache();
    const tk = thumb ? 'thumb_' + now.getTime() + '_' + emp.id : '';
    if (tk) cache.put(tk, thumb, 900);
    const feed = readFeed_(cache);
    feed.push({ ts: now.getTime(), name: emp.name, type: type, label: TYPE_LABEL[type], time: hm_(now.getTime()), kiosk: channel === CHANNEL.KIOSK, tk: tk });
    cache.put('feed', JSON.stringify(feed.slice(-15)), 3600);
  } finally {
    lock.releaseLock();
  }
  return { name: emp.name, type: type, label: TYPE_LABEL[type], time: time, date: thaiDate_(now.getTime()) };
}

function savePhoto_(dataUrl, emp, type, now) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw userError_('ไฟล์รูปไม่ถูกต้อง กรุณาถ่ายใหม่', 'PHOTO');
  if (m[2].length > 2800000) throw userError_('รูปใหญ่เกินไป กรุณาถ่ายใหม่', 'PHOTO');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = Utilities.formatDate(now, TZ, 'yyyy-MM-dd_HHmmss') + '_' + emp.id + '_' + type + '.' + ext;
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1], name);
  return photoFolder_().createFile(blob).getUrl();
}

function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* โฟลเดอร์ถูกลบ → สร้างใหม่ */ }
  }
  const folder = DriveApp.createFolder('รูปลงเวลาพนักงาน');
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

/** ข้อมูลบนหน้าจอร้าน: ใครอยู่ในร้านตอนนี้ + ลงเวลาล่าสุด */
function board_(cfg) {
  const logs = readLogs_(800);
  const now = Date.now();
  const maxMs = cfg.MAX_SHIFT_HOURS * 3600000;
  const lastBy = {};
  logs.forEach(function (l) { lastBy[l.id] = l; });
  const inside = Object.keys(lastBy)
    .map(function (k) { return lastBy[k]; })
    .filter(function (l) { return l.type === 'IN' && now - l.ts < maxMs; })
    .sort(function (a, b) { return a.ts - b.ts; })
    .map(function (l) { return { name: l.name, since: hm_(l.ts) }; });
  const recent = logs.slice(-10).reverse().map(function (l) {
    return { name: l.name, type: l.type, label: TYPE_LABEL[l.type], when: describeWhen_(l.ts) };
  });
  return { inside: inside, recent: recent };
}

// ── สรุปรายเดือน ──

function normalizeMonth_(text) {
  const m = /^\s*(\d{4})\s*[-/.]\s*(\d{1,2})\s*$/.exec(String(text));
  if (!m) return null;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  if (y > 2400) y -= 543; // ปี พ.ศ.
  if (mo < 1 || mo > 12) return null;
  return y + '-' + ('0' + mo).slice(-2);
}

function minutesOf_(hhmm) {
  const p = String(hhmm).split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}

/** จับคู่ เข้า→ออก ของแต่ละคน (รองรับกะดึกข้ามเที่ยงคืน: นับเป็นวันของเวลาเข้า) */
function pairShifts_(logs, employees, cfg) {
  const maxMs = cfg.MAX_SHIFT_HOURS * 3600000;
  const startOf = {};
  employees.forEach(function (e) { startOf[e.id] = e.start; });
  const byEmp = {};
  logs.slice().sort(function (a, b) { return a.ts - b.ts; }).forEach(function (l) {
    (byEmp[l.id] = byEmp[l.id] || []).push(l);
  });

  const rows = [];
  function push(inL, outL) {
    const base = inL || outL;
    const row = {
      date: dayOf_(base.ts), id: base.id, name: base.name,
      in: inL ? hm_(inL.ts) : '', out: outL ? hm_(outL.ts) : '',
      hours: '', late: '', note: '',
    };
    if (inL && outL) row.hours = Math.round((outL.ts - inL.ts) / 36000) / 100;
    if (inL && startOf[base.id]) {
      let diff = minutesOf_(row.in) - minutesOf_(startOf[base.id]);
      if (diff > 720) diff -= 1440;
      if (diff < -720) diff += 1440;
      row.late = Math.max(0, diff);
    }
    if (!outL) row.note = Date.now() - inL.ts < maxMs ? 'ยังทำงานอยู่' : 'ลืมลงเวลาออก';
    if (!inL) row.note = 'ลืมลงเวลาเข้า';
    rows.push(row);
  }

  Object.keys(byEmp).forEach(function (id) {
    let pending = null;
    byEmp[id].forEach(function (l) {
      if (l.type === 'IN') {
        if (pending) push(pending, null);
        pending = l;
      } else if (pending && l.ts - pending.ts <= maxMs) {
        push(pending, l);
        pending = null;
      } else {
        if (pending) push(pending, null);
        pending = null;
        push(null, l);
      }
    });
    if (pending) push(pending, null);
  });
  return rows;
}

function buildMonthlySummary_(month) {
  const cfg = getSettings_();
  const employees = readEmployees_();
  const logs = readLogs_(0);
  const rows = pairShifts_(logs, employees, cfg)
    .filter(function (r) { return r.date.indexOf(month) === 0; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1; });

  const totals = {};
  rows.forEach(function (r) {
    const t = totals[r.id] = totals[r.id] || { id: r.id, name: r.name, days: {}, hours: 0, late: 0, lateCount: 0, missing: 0 };
    if (r.in) t.days[r.date] = true;
    if (r.hours !== '') t.hours += r.hours;
    if (r.late) { t.late += r.late; t.lateCount++; }
    if (r.note === 'ลืมลงเวลาออก' || r.note === 'ลืมลงเวลาเข้า') t.missing++;
  });

  const ss = ss_();
  const name = 'สรุป ' + month;
  let sh = ss.getSheetByName(name);
  if (sh) sh.clear(); else sh = ss.insertSheet(name);

  const y = Number(month.slice(0, 4)), mo = Number(month.slice(5, 7));
  sh.getRange(1, 1).setValue('สรุปเวลาทำงาน เดือน ' + THAI_MONTHS[mo - 1] + ' ' + (y + 543) +
    '  (สร้างเมื่อ ' + thaiDate_(Date.now()) + ' ' + hm_(Date.now()) + ')').setFontWeight('bold');

  function table(r, title, head, body, textCols) {
    if (title) { sh.getRange(r, 1).setValue(title).setFontWeight('bold'); r++; }
    sh.getRange(r, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#efeae0');
    if (body.length) {
      (textCols || []).forEach(function (c) { sh.getRange(r + 1, c, body.length, 1).setNumberFormat('@'); });
      sh.getRange(r + 1, 1, body.length, head.length).setValues(body);
    }
    return r + 1 + Math.max(body.length, 1) + 1;
  }

  // 1) รวมรายคน
  const body1 = Object.keys(totals).sort().map(function (k) {
    const t = totals[k];
    return [t.id, t.name, Object.keys(t.days).length, Math.round(t.hours * 100) / 100, t.late, t.lateCount, t.missing];
  });
  let r = table(3, '', ['รหัส', 'ชื่อ', 'วันที่มาทำงาน', 'ชั่วโมงรวม', 'มาสายรวม (นาที)', 'มาสาย (ครั้ง)', 'ลงเวลาไม่ครบ (ครั้ง)'], body1);

  // 2) รายการน่าสงสัย (ธงจากระบบตรวจเครื่อง)
  const flagged = logs
    .filter(function (l) { return l.flags && dayOf_(l.ts).indexOf(month) === 0; })
    .map(function (l) { return [dayOf_(l.ts), hm_(l.ts), l.id, l.name, TYPE_LABEL[l.type], l.deviceId, l.flags]; });
  r = table(r, '⚠️ รายการน่าสงสัย (' + flagged.length + ')',
    ['วันที่', 'เวลา', 'รหัส', 'ชื่อ', 'ประเภท', 'รหัสเครื่อง', 'เรื่อง'], flagged, [1, 2]);

  // 3) รายละเอียดรายวัน (วันที่/เวลาเป็นข้อความ ไม่ให้ Sheets แปลงเอง; ชั่วโมง/นาทีสายเป็นตัวเลขไว้รวมต่อได้)
  const body2 = rows.map(function (x) { return [x.date, x.id, x.name, x.in, x.out, x.hours, x.late, x.note]; });
  table(r, 'รายละเอียดรายวัน', ['วันที่', 'รหัส', 'ชื่อ', 'เข้างาน', 'ออกงาน', 'ชั่วโมง', 'สาย (นาที)', 'หมายเหตุ'], body2, [1, 4, 5]);

  sh.autoResizeColumns(1, 8);
  return name;
}
