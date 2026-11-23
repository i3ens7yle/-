/**
 * เปิดหน้าเว็บจริงใน Chromium (Playwright) โดยต่อ google.script.run เข้ากับ Code.gs จำลอง
 * แล้วถ่ายภาพหน้าจอทุกขั้นตอน:  node attendance/dev/preview.js [โฟลเดอร์ผลลัพธ์]
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
env.setSetting('SHOP_NAME', 'ร้านเบียร์ริมทาง');

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

async function openPage(browser, ctxOpts, params) {
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.exposeFunction('__gas', (fn, args) => {
    env.clock.now = Date.now();
    return JSON.stringify(env.ctx[fn](...JSON.parse(args)));
  });
  await page.addInitScript(GAS_SHIM);
  env.clock.now = Date.now();
  const html = env.ctx.doGet({ parameter: params }).html;
  await page.route('https://script.google.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  // ถ้าเครื่องที่รันออกเน็ตไป cdnjs ไม่ได้ ให้ชี้ QRCODE_JS ไปที่ไฟล์ qrcode.min.js ในเครื่อง
  if (process.env.QRCODE_JS) {
    await context.route('https://cdnjs.cloudflare.com/**', (r) =>
      r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.QRCODE_JS, 'utf8') }));
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  }
  await page.goto('https://script.google.com/macros/s/TEST/exec');
  return { page, errors, context };
}

async function selfie(browser) {
  const p = await browser.newPage({ viewport: { width: 480, height: 480 } });
  await p.setContent('<body style="margin:0;display:grid;place-items:center;height:100vh;background:#d9c7a8;font-size:300px">🙂</body>');
  const buf = await p.screenshot({ type: 'jpeg' });
  await p.close();
  return buf;
}

(async () => {
  const browser = await chromium.launch();
  const photo = await selfie(browser);
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  const allErrors = [];

  // ── หน้าจอร้าน (แท็บเล็ตแนวนอน) ──
  const kiosk = await openPage(browser, { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 }, { page: 'kiosk' });
  allErrors.push(kiosk.errors);
  await kiosk.page.fill('input[name=pin]', '9999');
  await kiosk.page.click('button[type=submit]');
  await kiosk.page.waitForSelector('#qr img[src^="data:"]');
  await kiosk.page.waitForTimeout(400);
  await shot(kiosk.page, '1-kiosk');

  // ดึง URL จาก QR จริงที่แสดงบนจอ (ผ่าน API เดียวกัน) แล้วเปิดในมือถือ
  const qrUrl = env.run('apiKioskRefresh', '9999').qr.url;
  const t = new URL(qrUrl).searchParams.get('t');

  // ── มือถือพนักงาน ──
  const phone = await openPage(browser, { ...devices['iPhone 13'] }, { t });
  allErrors.push(phone.errors);
  await phone.page.waitForSelector('select[name=emp] option[value=E02]', { state: 'attached' });
  await phone.page.selectOption('select[name=emp]', 'E02');
  await phone.page.fill('input[name=pin]', '0042');
  await shot(phone.page, '2-phone-login');
  await phone.page.click('button[type=submit]');
  await phone.page.waitForSelector('[data-type=IN]');
  const [chooser] = await Promise.all([phone.page.waitForEvent('filechooser'), phone.page.click('[data-photo]')]);
  await chooser.setFiles({ name: 'selfie.jpg', mimeType: 'image/jpeg', buffer: photo });
  await phone.page.waitForSelector('.thumb.has');
  await shot(phone.page, '3-phone-action');
  await phone.page.click('[data-type=IN]');
  await phone.page.waitForSelector('.done');
  await shot(phone.page, '4-phone-done');

  // สแกนใหม่ครั้งต่อไป → จำชื่อไว้แล้ว เข้าหน้าปุ่มทันที และแนะนำ "ออกงาน"
  const t2 = new URL(env.run('apiKioskRefresh', '9999').qr.url).searchParams.get('t');
  const html2 = env.ctx.doGet({ parameter: { t: t2 } }).html;
  await phone.page.unroute('https://script.google.com/**');
  await phone.page.route('https://script.google.com/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html2 }));
  await phone.page.reload();
  await phone.page.waitForSelector('[data-type=OUT].suggest', { timeout: 5000 }).catch(async (e) => { await shot(phone.page, 'debug'); console.log(await phone.page.innerText('body')); throw e; });
  await shot(phone.page, '5-phone-remembered');

  // QR หมดอายุ
  const expired = await openPage(browser, { ...devices['iPhone 13'] }, { t: '1.0000000000000000' });
  allErrors.push(expired.errors);
  await expired.page.waitForSelector('.notice');
  await shot(expired.page, '6-phone-expired');

  // ── คนไม่มีมือถือ: ลงเวลาที่เครื่องร้าน ──
  await kiosk.page.click('[data-nophone]');
  await kiosk.page.selectOption('[data-flow] select[name=emp]', 'E03');
  await kiosk.page.fill('[data-flow] input[name=pin]', '5555');
  await kiosk.page.click('[data-flow] button[type=submit]');
  await kiosk.page.waitForSelector('[data-flow] [data-type=IN]');
  const [ch2] = await Promise.all([kiosk.page.waitForEvent('filechooser'), kiosk.page.click('[data-flow] [data-photo]')]);
  await ch2.setFiles({ name: 'selfie.jpg', mimeType: 'image/jpeg', buffer: photo });
  await kiosk.page.waitForSelector('[data-flow] .thumb.has');
  await shot(kiosk.page, '7-kiosk-nophone');
  await kiosk.page.click('[data-flow] [data-type=IN]');
  await kiosk.page.waitForSelector('[data-flow] .done');
  await kiosk.page.waitForTimeout(4500); // ปิดเอง + รีเฟรชรายชื่อ
  await shot(kiosk.page, '8-kiosk-after');

  // ── หน้าจอร้านแนวตั้ง (มือถือ/แท็บเล็ตตั้ง) ──
  const kioskPortrait = await openPage(browser, { ...devices['iPhone 13'] }, { page: 'kiosk' });
  allErrors.push(kioskPortrait.errors);
  await kioskPortrait.page.fill('input[name=pin]', '9999');
  await kioskPortrait.page.click('button[type=submit]');
  await kioskPortrait.page.waitForSelector('#qr img[src^="data:"]');
  await kioskPortrait.page.screenshot({ path: path.join(OUT, '9-kiosk-portrait.png'), fullPage: true });
  const overflow = await kioskPortrait.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  const log = env.sheets['บันทึกเวลา'].data.slice(1).map((r) => r.slice(1, 8).join(' | '));
  console.log('บันทึกในชีต:\n  ' + log.join('\n  '));
  console.log('horizontal overflow (portrait kiosk):', overflow);
  const errs = allErrors.flat();
  console.log('page errors:', errs.length ? errs : 'none');
  console.log('screenshots →', OUT);
  await browser.close();
  if (errs.length || overflow) process.exitCode = 1;
})();
