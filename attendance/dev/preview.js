/**
 * เปิดหน้าเว็บจริงใน Chromium (Playwright) โดยต่อ google.script.run เข้ากับ Code.gs จำลอง
 * แล้วเดินทุกขั้นตอน + ถ่ายภาพหน้าจอ:  node attendance/dev/preview.js [โฟลเดอร์ผลลัพธ์]
 *
 * ถ้าเครื่องที่รันออกเน็ตไป cdnjs ไม่ได้ ให้ตั้ง QRCODE_JS=/path/to/qrcode.min.js (ไลบรารี qrcodejs)
 */
const path = require('path');
const fs = require('fs');
const { chromium, devices } = require('playwright');
const { createEnv } = require('./harness');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'screenshots'));
fs.mkdirSync(OUT, { recursive: true });

const env = createEnv({ now: Date.now() });
env.seed([
  ['E01', 'สมชาย', '1234', '16:00', 'ทำงาน'],
  ['E02', 'มานี', '0042', '17:00', 'ทำงาน'],
  ['E03', 'ป้าแดง', '5555', '16:00', 'ทำงาน'],
]);
// ใช้ชื่อร้านค่าเริ่มต้นจาก Code.gs

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

const allErrors = [];

async function newPage(browser, ctxOpts) {
  const context = await browser.newContext(ctxOpts);
  if (process.env.QRCODE_JS) {
    await context.route('https://cdnjs.cloudflare.com/**', (r) =>
      r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.QRCODE_JS, 'utf8') }));
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => allErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') allErrors.push(m.text()); });
  await page.exposeFunction('__gas', (fn, args) => {
    env.clock.now = Date.now();
    return JSON.stringify(env.ctx[fn](...JSON.parse(args)));
  });
  await page.addInitScript(GAS_SHIM);
  return page;
}

/** เปิด URL ของเว็บแอป (จำลอง doGet ด้วยพารามิเตอร์ที่ให้) */
async function go(page, params) {
  env.clock.now = Date.now();
  const html = env.ctx.doGet({ parameter: params }).html;
  await page.unroute('https://script.google.com/**').catch(() => {});
  await page.route('https://script.google.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://script.google.com/macros/s/TEST/exec?' + new URLSearchParams(params));
}

/** สแกน QR ปัจจุบันบนหน้าจอร้าน */
async function scan(page) {
  const t = new URL(env.run('apiKioskRefresh', '9999').qr.url).searchParams.get('t');
  await go(page, { t });
}

async function selfieJpeg(browser, emoji, bg) {
  const p = await browser.newPage({ viewport: { width: 480, height: 480 } });
  await p.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${bg};font-size:300px">${emoji}</body>`);
  const buf = await p.screenshot({ type: 'jpeg' });
  await p.close();
  return buf;
}

async function takeSelfie(page, buffer, scope = '') {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(scope + ' [data-photo]')]);
  await chooser.setFiles({ name: 'selfie.jpg', mimeType: 'image/jpeg', buffer });
  await page.waitForSelector(scope + ' .thumb.has');
}

async function login(page, empId, pin) {
  await page.waitForSelector(`select[name=emp] option[value=${empId}]`, { state: 'attached' });
  await page.selectOption('select[name=emp]', empId);
  await page.fill('input[name=pin]', pin);
  await page.click('button[type=submit]');
}

(async () => {
  const browser = await chromium.launch();
  const face = {
    somchai: await selfieJpeg(browser, '👨🏻', '#c9d6c3'),
    manee: await selfieJpeg(browser, '👩🏻', '#e6cfc0'),
    daeng: await selfieJpeg(browser, '👵🏻', '#d9c7a8'),
  };
  const shot = (page, name, full) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full });
  const iphone = devices['iPhone 13'];

  // ── หน้าจอร้าน (แท็บเล็ตแนวนอน) ──
  const kiosk = await newPage(browser, { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  await go(kiosk, { page: 'kiosk' });
  await kiosk.fill('input[name=pin]', '9999');
  await kiosk.click('button[type=submit]');
  await kiosk.waitForSelector('#qr img[src^="data:"]');
  await shot(kiosk, '01-kiosk');

  // ── มือถือของสมชาย: ลงเวลาเข้างาน (เครื่องแรก → อนุมัติอัตโนมัติ) ──
  const somchaiPhone = await newPage(browser, iphone);
  await scan(somchaiPhone);
  await login(somchaiPhone, 'E01', '1234');
  await somchaiPhone.waitForSelector('[data-type=IN]');
  await takeSelfie(somchaiPhone, face.somchai);
  await shot(somchaiPhone, '02-phone-action');
  await somchaiPhone.click('[data-type=IN]');
  await somchaiPhone.waitForSelector('.done');
  await shot(somchaiPhone, '03-phone-done');

  // ── ข้อ 3: รูปเด้งบนหน้าจอร้าน ──
  await kiosk.waitForSelector('.flash:not(.hidden)', { timeout: 9000 });
  await kiosk.waitForTimeout(300);
  await shot(kiosk, '04-kiosk-flash');

  // ── มือถือของมานี: มานีเข้างานด้วยเครื่องตัวเอง ──
  const maneePhone = await newPage(browser, { ...devices['Pixel 7'] });
  await scan(maneePhone);
  await login(maneePhone, 'E02', '0042');
  await maneePhone.waitForSelector('[data-type=IN]');
  await takeSelfie(maneePhone, face.manee);
  await maneePhone.click('[data-type=IN]');
  await maneePhone.waitForSelector('.done');

  // ── กรณี A: มานีใช้ PIN ของสมชาย กด "ออกงาน" ให้สมชายจากมือถือตัวเอง ──
  await scan(maneePhone);
  await maneePhone.waitForSelector('[data-switch]');
  await maneePhone.click('[data-switch]');
  await login(maneePhone, 'E01', '1234');
  await maneePhone.waitForSelector('[data-type=OUT]');
  await takeSelfie(maneePhone, face.manee);
  await maneePhone.click('[data-type=OUT]');
  await maneePhone.waitForSelector('.done'); // ผูกเครื่องยังปิด → ลงได้ แต่ติดธง

  // ── ข้อ 2: เปิดผูกเครื่อง แล้วลองอีกครั้ง → ถูกบล็อก ──
  env.setSetting('DEVICE_LOCK', 'TRUE');
  await scan(maneePhone);
  await maneePhone.waitForSelector('.notice .devbox');
  await shot(maneePhone, '05-phone-device-blocked');

  // ── คนไม่มีมือถือ: ป้าแดงลงเวลาที่เครื่องร้าน ──
  await kiosk.click('[data-nophone]');
  await kiosk.selectOption('[data-flow] select[name=emp]', 'E03');
  await kiosk.fill('[data-flow] input[name=pin]', '5555');
  await kiosk.click('[data-flow] button[type=submit]');
  await kiosk.waitForSelector('[data-flow] [data-type=IN]');
  await takeSelfie(kiosk, face.daeng, '[data-flow]');
  await kiosk.click('[data-flow] [data-type=IN]');
  await kiosk.waitForSelector('[data-flow] .done');
  await kiosk.waitForTimeout(4500);
  await shot(kiosk, '06-kiosk-after');

  // ── ข้อ 4: หน้าตรวจรูปของเจ้าของร้าน (มือถือ) ──
  const owner = await newPage(browser, iphone);
  await go(owner, { page: 'review' });
  await owner.fill('input[name=pin]', '9999');
  await owner.click('button[type=submit]');
  await owner.waitForSelector('.pcard');
  await owner.waitForFunction(() => document.querySelectorAll('.pcard img[src^="data:"]').length >= 5);
  await shot(owner, '07-review-phone', true);
  const reviewOverflow = await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  // หน้าตรวจรูปบนคอม
  const ownerPc = await newPage(browser, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await go(ownerPc, { page: 'review' });
  await ownerPc.fill('input[name=pin]', '9999');
  await ownerPc.click('button[type=submit]');
  await ownerPc.waitForFunction(() => document.querySelectorAll('.pcard img[src^="data:"]').length >= 5);
  await shot(ownerPc, '08-review-desktop', true);

  // อนุมัติเครื่อง → มือถือมานีลงเวลาให้สมชายได้แล้ว (ในชีวิตจริงเจ้าของร้านคงกด "ไม่อนุมัติ")
  await ownerPc.click('[data-dec=OK]');
  await ownerPc.waitForFunction(() => !document.querySelector('[data-dev]'));
  await scan(maneePhone);
  await maneePhone.waitForSelector('[data-type]');

  // QR หมดอายุ
  const expired = await newPage(browser, iphone);
  await go(expired, { t: '1.0000000000000000' });
  await expired.waitForSelector('.notice');
  await shot(expired, '09-phone-expired');

  const tab = (name, cols) => env.sheets[name].data.slice(1).filter(Boolean).map((r) => cols.map((c) => r[c]).join(' | '));
  console.log('บันทึกเวลา (ชื่อ | ประเภท | ช่องทาง | รหัสเครื่อง | ตรวจสอบ):\n  ' + tab('บันทึกเวลา', [4, 5, 6, 9, 10]).join('\n  '));
  console.log('อุปกรณ์ (ชื่อ | รหัสเครื่อง | รุ่น | สถานะ | หมายเหตุ):\n  ' + tab('อุปกรณ์', [1, 2, 3, 6, 7]).join('\n  '));
  console.log('horizontal overflow (review on phone):', reviewOverflow);
  console.log('page errors:', allErrors.length ? allErrors : 'none');
  console.log('screenshots →', OUT);
  await browser.close();
  if (allErrors.length || reviewOverflow) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
