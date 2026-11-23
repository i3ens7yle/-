/**
 * ตัวจำลอง Google Apps Script สำหรับทดสอบบนเครื่อง (ไม่ต้องอัปโหลดขึ้น Apps Script)
 * โหลด Code.gs เข้า Node vm พร้อม mock ของ SpreadsheetApp, DriveApp, CacheService ฯลฯ
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function createEnv(opts = {}) {
  const clock = { now: opts.now || Date.parse('2026-11-23T09:00:00Z') }; // 16:00 เวลาไทย
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }

  // ── Spreadsheet ──
  class Range {
    constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.sheet.data[this.r - 1 + i] || [];
        const o = [];
        for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o.push(v === undefined || v === null ? '' : v); }
        out.push(o);
      }
      return out;
    }
    setValues(vals) {
      if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error('setValues size mismatch');
      vals.forEach((row, i) => {
        const tgt = (this.sheet.data[this.r - 1 + i] = this.sheet.data[this.r - 1 + i] || []);
        row.forEach((v, j) => { tgt[this.c - 1 + j] = v; });
      });
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setDataValidation() { return this; }
  }
  class Sheet {
    constructor(name) { this.name = name; this.data = []; }
    getName() { return this.name; }
    getLastRow() {
      for (let i = this.data.length - 1; i >= 0; i--) {
        if ((this.data[i] || []).some((v) => v !== '' && v !== undefined && v !== null)) return i + 1;
      }
      return 0;
    }
    getRange(a, b, c, d) {
      if (typeof a === 'string') return new Range(this, 1, 1, 1, 1); // A1 notation: ใช้แค่ format → ไม่ต้องสนใจ
      return new Range(this, a, b, c || 1, d || 1);
    }
    appendRow(row) { this.data[this.getLastRow()] = Array.from(row); }
    setFrozenRows() {}
    autoResizeColumns() {}
    clear() { this.data = []; }
    activate() {}
  }
  const sheets = {};
  let ssTz = 'America/New_York';
  const spreadsheet = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new Sheet(n)),
    setSpreadsheetTimeZone: (tz) => { ssTz = tz; },
    getSpreadsheetTimeZone: () => ssTz,
  };

  // ── Utilities ──
  function formatDate(date, tz, fmt) {
    const parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
    return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (t) => ({
      yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second,
    })[t]);
  }

  const props = {};
  const cache = {};
  const drive = { folders: {}, files: [] };
  const uiCalls = [];

  const context = {
    console: { log() {}, error() {} },
    Date: FakeDate,
    Math, JSON, Number, String, Object, Array, Error, RegExp, isNaN, isFinite, parseInt,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      flush() {},
      newDataValidation() {
        const b = { requireValueInList: () => b, setAllowInvalid: () => b, build: () => ({}) };
        return b;
      },
      getUi() {
        if (!opts.ui) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
        return opts.ui(uiCalls);
      },
    },
    Utilities: {
      formatDate,
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (value, key) =>
        [...crypto.createHmac('sha256', key).update(value).digest()].map((b) => (b > 127 ? b - 256 : b)),
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64'),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache[k] && cache[k].exp > clock.now ? cache[k].v : null),
        put: (k, v, ttl) => { cache[k] = { v: String(v), exp: clock.now + (ttl || 600) * 1000 }; },
        remove: (k) => { delete cache[k]; },
        getAll: (keys) => {
          const out = {};
          keys.forEach((k) => { if (cache[k] && cache[k].exp > clock.now) out[k] = cache[k].v; });
          return out;
        },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    DriveApp: {
      createFolder(name) {
        const id = 'folder' + Object.keys(drive.folders).length;
        const f = {
          getId: () => id,
          createFile: (blob) => {
            drive.files.push(blob);
            const fid = 'FILE' + String(drive.files.length).padStart(8, '0');
            return { getUrl: () => 'https://drive.google.com/file/d/' + fid + '/view?usp=drivesdk' };
          },
        };
        drive.folders[id] = { name, f };
        return f;
      },
      getFileById(id) {
        const blob = drive.files[Number(String(id).replace('FILE', '')) - 1];
        if (!blob) throw new Error('file not found');
        return { getBlob: () => ({ getContentType: () => blob.type, getBytes: () => blob.bytes }) };
      },
      getFolderById(id) {
        if (!drive.folders[id]) throw new Error('not found');
        return drive.folders[id].f;
      },
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
    HtmlService: {
      createTemplateFromFile(name) {
        const src = fs.readFileSync(path.join(ROOT, name + '.html'), 'utf8');
        const t = {
          evaluate() {
            const html = src.replace(/<\?!=\s*(\w+)\s*\?>/g, (_, k) => t[k]);
            const out = { html, title: '', setTitle(x) { out.title = x; return out; }, addMetaTag() { return out; }, getContent: () => html };
            return out;
          },
        };
        return t;
      },
      createHtmlOutput: (h) => ({ setWidth() { return this; }, setHeight() { return this; }, h }),
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8'), context, { filename: 'Code.gs' });

  /** ตั้งค่าเริ่มต้นแบบเดียวกับเมนู setup (ไม่ผ่าน UI) */
  function seed(employees) {
    const fakeUi = () => ({ alert() {}, ButtonSet: {}, Button: {} });
    const prev = opts.ui;
    opts.ui = fakeUi;
    context.setup();
    opts.ui = prev;
    if (employees) {
      const emp = sheets['พนักงาน'];
      emp.data = [emp.data[0], ...employees];
    }
  }

  return {
    ctx: context, clock, sheets, props, cache, drive, seed,
    setSetting(key, value) {
      const s = sheets['ตั้งค่า'];
      const row = s.data.find((r) => r && r[0] === key);
      if (row) row[1] = value; else s.appendRow([key, value, '']);
    },
    advance(ms) { clock.now += ms; },
    // google.script.run ส่งข้อมูลผ่าน JSON เสมอ → จำลองให้เหมือนกัน
    run(fn, ...args) { return JSON.parse(JSON.stringify(context[fn](...JSON.parse(JSON.stringify(args))))); },
  };
}

module.exports = { createEnv };
