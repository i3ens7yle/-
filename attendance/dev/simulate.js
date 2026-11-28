/**
 * จำลองร้าน "อาม่า แคมป์" ใช้ระบบลงเวลาทั้งเดือน พ.ย. 2569 (1–22 พ.ย.)
 * ทุกการลงเวลาเรียก API จริงของ Code.gs (ผ่านตัวจำลอง Apps Script) เหมือนมือถือ/แท็บเล็ตจริง
 * มีเหตุการณ์ปัญหาแทรก: มาสาย, ลืมลงเวลา, เปลี่ยนมือถือ, ลงเวลาแทนเพื่อน, กดซ้ำ, PIN ผิด
 *
 *   node attendance/dev/simulate.js [โฟลเดอร์ผลลัพธ์]
 *
 * ผลลัพธ์: ภาพหน้าจอ + sheets.json (ข้อมูลทุกแท็บของ Google Sheet ณ วันที่ 24 พ.ย.)
 */
const path = require('path');
const fs = require('fs');
const { chromium, devices } = require('playwright');
const { createEnv } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'simulation'));
fs.mkdirSync(OUT, { recursive: true });

// ───────── พนักงานสมมติ ─────────
const STAFF = [
  { id: 'E01', name: 'สมชาย', role: 'กุ๊ก', pin: '4821', start: '15:30', emoji: '👨🏻‍🍳', bg: '#c9d6c3',
    device: { id: 'SMCH-A2K7', name: 'iPhone · Safari' }, cleanup: true },
  { id: 'E02', name: 'มานี', role: 'เสิร์ฟ', pin: '0193', start: '16:00', emoji: '👩🏻', bg: '#e6cfc0',
    device: { id: 'MANE-4R8Q', name: 'Android SM-A155F · Chrome' }, off: [3] },
  { id: 'E03', name: 'ป้าแดง', role: 'ล้างจาน (ไม่มีมือถือ)', pin: '7350', start: '15:30', emoji: '👵🏻', bg: '#d9c7a8',
    kiosk: true, cleanup: true },
  { id: 'E04', name: 'เอก', role: 'บาร์', pin: '2468', start: '17:00', emoji: '🧔🏻', bg: '#c3cfdc',
    device: { id: 'EKKA-9P3W', name: 'Android Redmi Note 12 · Chrome' }, off: [4],
    newDevice: { from: '2026-11-15', id: 'EKNW-5T6Y', name: 'iPhone · Safari' } },
  { id: 'E05', name: 'นุ่น', role: 'แคชเชียร์', pin: '5902', start: '16:00', emoji: '👩🏻‍🦱', bg: '#e3d3e6',
    device: { id: 'NUNN-7X2D', name: 'iPhone · Safari' }, off: [2] },
  { id: 'E06', name: 'บอย', role: 'เสิร์ฟพาร์ทไทม์ (ศ–อา)', pin: '3317', start: '17:00', emoji: '👦🏻', bg: '#d6e3c9',
    device: { id: 'BXYY-3H8L', name: 'Android CPH2591 · Chrome' }, onlyDays: [5, 6, 0] },
];
const byId = Object.fromEntries(STAFF.map((s) => [s.id, s]));
const ADMIN = '7788';

const env = createEnv({ now: Date.parse('2026-10-31T12:00:00+07:00') });
env.seed(STAFF.map((s) => [s.id, s.name, s.pin, s.start, 'ทำงาน']));
env.setSetting('ADMIN_PIN', ADMIN);

// ───────── สุ่มแบบกำหนดผลได้ (รันกี่ครั้งก็ได้ผลเดิม) ─────────
let seed = 20261124;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const MIN = 60000;
const at = (day, hhmm) => Date.parse(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00+07:00`);
const fmt = (ts) => env.ctx.Utilities.formatDate(new Date(ts), 'Asia/Bangkok', 'dd/MM HH:mm');
const dow = (day) => new Date(Date.UTC(2026, 10, day)).getUTCDay(); // 0=อา … 6=ส

// ───────── สร้างตารางเหตุการณ์ ─────────
const events = [];
const add = (ts, fn, label) => events.push({ ts, fn, label });
const DAYS = 22; // 1–22 พ.ย. (23 พ.ย. วันจันทร์ร้านปิด, 24 พ.ย. = วันนี้)

for (let d = 1; d <= DAYS; d++) {
  const w = dow(d);
  if (w === 1) continue; // ร้านปิดทุกวันจันทร์
  const lateClose = w === 5 || w === 6; // ศ/ส ปิดตี 1
  const dd = `2026-11-${String(d).padStart(2, '0')}`;
  for (const s of STAFF) {
    if (s.off && s.off.includes(w)) continue;
    if (s.onlyDays && !s.onlyDays.includes(w)) continue;
    const key = `${dd}|${s.id}`;

    // เวลาเข้า: ปกติมาก่อน 3–15 นาที, 12% มาสาย 5–25 นาที
    const startTs = at(d, s.start);
    let inTs = startTs - between(3, 15) * MIN;
    if (rand() < 0.12) inTs = startTs + between(5, 25) * MIN;
    // เวลาออก: หลังร้านปิด (คนเก็บร้าน/ล้างจานออกช้ากว่า)
    const closeTs = at(d, '23:59') + MIN + (lateClose ? 60 * MIN : 0);
    const outTs = closeTs + (s.cleanup ? between(10, 40) : between(-10, 15)) * MIN + between(0, 59) * 1000;
    inTs += between(0, 59) * 1000;

    const dev = s.newDevice && dd >= s.newDevice.from ? s.newDevice : s.device;

    // ── เหตุการณ์พิเศษ ──
    if (key === '2026-11-14|E01') { add(outTs, () => punch(s, 'OUT', dev), `${s.name} ลืมลงเวลาเข้า (ลงแค่ออก)`); continue; }
    if (key === '2026-11-20|E06') {
      // บอยมาสาย นุ่นใช้มือถือตัวเอง + PIN ของบอย กดเข้างานให้ (เซลฟี่เป็นหน้านุ่น)
      add(at(d, '16:58'), () => punch(s, 'IN', byId.E05.device, byId.E05), 'นุ่นลงเวลาเข้างานแทนบอย ด้วยมือถือนุ่น');
      add(outTs, () => punch(s, 'OUT', dev), null);
      continue;
    }
    if (key === '2026-11-22|E06') {
      add(at(d, '17:01'), () => punch(s, 'IN', byId.E05.device, byId.E05, 'blocked'), 'นุ่นพยายามลงเวลาแทนบอยอีกรอบ (ผูกเครื่องเปิดแล้ว)');
      add(at(d, '17:22'), () => punch(s, 'IN', dev), 'บอยมาถึงแล้วลงเวลาเอง (สาย 22 นาที)');
      add(outTs, () => punch(s, 'OUT', dev), null);
      continue;
    }
    if (key === '2026-11-18|E03') {
      add(inTs, () => kioskPunch(s, 'IN', '7305'), 'ป้าแดงใส่ PIN ผิด 1 ครั้งที่เครื่องร้าน แล้วใส่ใหม่');
      add(outTs, () => kioskPunch(s, 'OUT'), null);
      continue;
    }

    add(inTs, () => (s.kiosk ? kioskPunch(s, 'IN') : punch(s, 'IN', dev)),
      key === '2026-11-15|E04' ? 'เอกเปลี่ยนมือถือใหม่ (เครื่องแรกที่ใช้)' : null);
    if (key === '2026-11-19|E02') add(inTs + 50 * 1000, () => punch(s, 'IN', dev), 'มานีกดเข้างานซ้ำ (เผลอกดสองรอบ)');
    if (key === '2026-11-08|E02') continue; // มานีลืมลงเวลาออก
    add(outTs, () => (s.kiosk ? kioskPunch(s, 'OUT') : punch(s, 'OUT', dev)), null);
  }
}

// เจ้าของร้าน
add(at(17, '10:00'), () => {
  const p = env.run('apiReviewDay', ADMIN, '').pending.find((x) => x.deviceId === 'EKNW-5T6Y');
  const r = env.run('apiReviewDevice', ADMIN, p.row, p.deviceId, p.empId, 'OK');
  return { ok: r.ok, msg: 'อนุมัติมือถือใหม่ของเอก' };
}, 'เจ้าของร้านเปิดหน้าตรวจรูป → อนุมัติมือถือใหม่ของเอก');
add(at(21, '09:00'), 'OWNER_REVIEW', 'เจ้าของร้านเปิดหน้าตรวจรูปของวันที่ 20 → เห็นธง → กด "ไม่อนุมัติ" มือถือนุ่นสำหรับบอย');
add(at(21, '09:05'), () => { env.setSetting('DEVICE_LOCK', 'TRUE'); return { ok: true, msg: 'DEVICE_LOCK = TRUE' }; },
  'เจ้าของร้านเปิด "ผูกเครื่อง" (DEVICE_LOCK = TRUE)');
add(at(22, '17:01') - 1000, 'PHONE_BLOCKED_SHOT', null);
add(at(22, '18:30'), 'KIOSK_SHOT', null);

events.sort((a, b) => a.ts - b.ts);

// ───────── รูปเซลฟี่จำลอง ─────────
const faces = {};
async function makeFaces(browser) {
  for (const s of STAFF) {
    const p = await browser.newPage({ viewport: { width: 480, height: 480 } });
    await p.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${s.bg};font-size:280px">${s.emoji}</body>`);
    const full = 'data:image/jpeg;base64,' + (await p.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
    await p.setViewportSize({ width: 240, height: 240 });
    await p.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${s.bg};font-size:140px">${s.emoji}</body>`);
    const thumb = 'data:image/jpeg;base64,' + (await p.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
    faces[s.id] = { full, thumb };
    await p.close();
  }
}

// ───────── การลงเวลา (เรียก API เหมือนหน้าเว็บจริง) ─────────
function punch(emp, type, device, faceOf, expect) {
  const k = env.run('apiKioskRefresh', ADMIN);                        // QR บนจอร้านตอนนั้น
  const t = new URL(k.qr.url).searchParams.get('t');
  const boot = JSON.parse(/var BOOT = (.*?);<\/script>/.exec(env.ctx.doGet({ parameter: { t } }).html)[1]);
  if (!boot.pass) return { ok: false, msg: boot.error };
  const login = env.run('apiLogin', boot.pass, emp.id, emp.pin, device);
  if (!login.ok) return { ok: false, msg: login.error, expect };
  env.advance(20 * 1000);                                              // ถ่ายเซลฟี่
  const face = faces[(faceOf || emp).id];
  const r = env.run('apiPunch', { pass: boot.pass, empId: emp.id, pin: emp.pin, type, photo: face.full, thumb: face.thumb, device });
  return r.ok ? { ok: true, msg: `${r.label} ${r.time}` } : { ok: false, msg: r.error, expect };
}

function kioskPunch(emp, type, wrongPin) {
  let note = '';
  if (wrongPin) note = 'PIN ผิด: ' + env.run('apiKioskLogin', ADMIN, emp.id, wrongPin).error + ' → ';
  const login = env.run('apiKioskLogin', ADMIN, emp.id, emp.pin);
  if (!login.ok) return { ok: false, msg: note + login.error };
  env.advance(20 * 1000);
  const r = env.run('apiKioskPunch', { adminPin: ADMIN, empId: emp.id, pin: emp.pin, type, photo: faces[emp.id].full, thumb: faces[emp.id].thumb });
  return r.ok ? { ok: true, msg: note + `${r.label} ${r.time} (เครื่องร้าน)` } : { ok: false, msg: note + r.error };
}

// ───────── เบราว์เซอร์ (สำหรับภาพหน้าจอ) ─────────
const GAS_SHIM = `
  (function () {
    function runner(ok, fail) {
      return new Proxy({}, { get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (h) { return runner(h, fail); };
        if (prop === 'withFailureHandler') return function (h) { return runner(ok, h); };
        return function () {
          var args = JSON.stringify(Array.prototype.slice.call(arguments));
          window.__gas(prop, args).then(function (r) { ok && ok(JSON.parse(r)); }, function (e) { fail && fail(e); });
        };
      } });
    }
    window.google = { script: { run: runner() } };
  })();`;
const pageErrors = [];

async function openApp(browser, ctxOpts, params, initScript) {
  const context = await browser.newContext({ timezoneId: 'Asia/Bangkok', locale: 'th-TH', ...ctxOpts });
  if (process.env.QRCODE_JS) {
    await context.route('https://cdnjs.cloudflare.com/**', (r) =>
      r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.QRCODE_JS, 'utf8') }));
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.clock.setFixedTime(new Date(env.clock.now));
  await page.exposeFunction('__gas', (fn, args) => JSON.stringify(env.ctx[fn](...JSON.parse(args))));
  await page.addInitScript(GAS_SHIM);
  if (initScript) await page.addInitScript(initScript);
  const html = env.ctx.doGet({ parameter: params }).html;
  await page.route('https://script.google.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://script.google.com/macros/s/TEST/exec');
  return page;
}

async function reviewDay(browser, dayLabel, file, opts = {}) {
  const page = await openApp(browser, opts.mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 900 } }, { page: 'review' });
  await page.fill('input[name=pin]', ADMIN);
  await page.click('button[type=submit]');
  await page.waitForSelector('.daybar');
  while (!(await page.textContent('.daybar .day b')).startsWith(dayLabel)) {
    await page.click('[data-prev]');
    await page.waitForTimeout(150);
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.pcard img')].every((i) => i.src.startsWith('data:')));
  await page.screenshot({ path: path.join(OUT, file), fullPage: true });
  return page;
}

// ───────── รัน ─────────
(async () => {
  const browser = await chromium.launch();
  await makeFaces(browser);
  const timeline = [];

  for (const ev of events) {
    env.clock.now = ev.ts;
    if (ev.fn === 'OWNER_REVIEW') {
      const page = await reviewDay(browser, '20 พ.ย.', 'sim-1-review-20nov.png');
      await page.click('[data-dev][data-dec=NO]');
      await page.waitForFunction(() => !document.querySelector('[data-dev]'));
      timeline.push({ ts: ev.ts, label: ev.label, ok: true, msg: 'ไม่อนุมัติ NUNN-7X2D สำหรับบอย' });
      await page.context().close();
      continue;
    }
    if (ev.fn === 'PHONE_BLOCKED_SHOT') {
      // มือถือของนุ่น (เบราว์เซอร์จำรหัสเครื่อง NUNN-7X2D) → เลือกชื่อบอย
      const k = env.run('apiKioskRefresh', ADMIN);
      const t = new URL(k.qr.url).searchParams.get('t');
      const page = await openApp(browser, { ...devices['iPhone 13'] },
        { t }, `try { localStorage.setItem('att_dev', '"NUNN-7X2D"'); } catch (e) {}`);
      await page.waitForSelector('select[name=emp] option[value=E06]', { state: 'attached' });
      await page.selectOption('select[name=emp]', 'E06');
      await page.fill('input[name=pin]', byId.E06.pin);
      await page.click('button[type=submit]');
      await page.waitForSelector('.devbox');
      await page.screenshot({ path: path.join(OUT, 'sim-2-phone-blocked-22nov.png') });
      await page.context().close();
      continue;
    }
    if (ev.fn === 'KIOSK_SHOT') {
      const page = await openApp(browser, { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 }, { page: 'kiosk' });
      await page.fill('input[name=pin]', ADMIN);
      await page.click('button[type=submit]');
      await page.waitForSelector('#qr img[src^="data:"]');
      await page.screenshot({ path: path.join(OUT, 'sim-3-kiosk-22nov-1830.png') });
      await page.context().close();
      continue;
    }
    const res = ev.fn();
    if (ev.label || !res.ok) timeline.push({ ts: ev.ts, label: ev.label || '(ไม่คาดคิด)', ...res });
  }

  // ── วันที่ 24 พ.ย. เช้า: เจ้าของร้านสร้างสรุปรายเดือน + ดูหน้าตรวจรูป ──
  env.clock.now = Date.parse('2026-11-24T10:00:00+07:00');
  const sumName = env.ctx.buildMonthlySummary_('2026-11');
  const pageNov22 = await reviewDay(browser, '22 พ.ย.', 'sim-4-review-22nov-phone.png', { mobile: true });
  await pageNov22.context().close();
  await browser.close();

  // ── รายงาน ──
  const unexpected = timeline.filter((t) => !t.ok && !t.expect && !/ซ้ำ/.test(t.label));
  console.log('เหตุการณ์สำคัญ:');
  timeline.forEach((t) => console.log(`  ${fmt(t.ts)}  ${t.ok ? '✅' : '⛔'} ${t.label}\n                 → ${t.msg}`));

  const log = env.sheets['บันทึกเวลา'].data.slice(1).filter(Boolean);
  console.log(`\nบันทึกเวลาทั้งหมด ${log.length} แถว, ติดธง ${log.filter((r) => r[10]).length} แถว`);
  console.log('\nแท็บอุปกรณ์:');
  env.sheets['อุปกรณ์'].data.slice(1).filter(Boolean).forEach((r) => console.log(`  ${r[1]} | ${r[2]} | ${r[3]} | ${r[6]} | ${r[7]}`));
  console.log(`\n${sumName}:`);
  env.sheets[sumName].data.forEach((r, i) => { if (r && r.some((v) => v !== '' && v != null)) console.log(`  ${String(i + 1).padStart(3)}: ${r.join(' | ')}`); });

  const dump = {};
  for (const [name, sh] of Object.entries(env.sheets)) {
    dump[name] = sh.data.map((r) => (r || []).map((v) => (v instanceof Date ? { date: v.toISOString() } : v)));
  }
  fs.writeFileSync(path.join(OUT, 'sheets.json'), JSON.stringify({ order: ['พนักงาน', 'บันทึกเวลา', 'อุปกรณ์', 'ตั้งค่า', sumName], sheets: dump }));
  console.log('\npage errors:', pageErrors.length ? pageErrors : 'none');
  console.log('unexpected failures:', unexpected.length ? unexpected : 'none');
  console.log('output →', OUT);
  if (pageErrors.length || unexpected.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
