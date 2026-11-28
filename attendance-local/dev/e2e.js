/**
 * ทดสอบโปรแกรมจริงในเบราว์เซอร์: เจ้าของร้าน (คอม) + มือถือพนักงาน (ผ่าน Wi-Fi) + หน้าจอร้าน (เว็บแคม)
 * ต้องรันโปรแกรมไว้ก่อน:  AMACAMP_NO_BROWSER=1 AMACAMP_DATA=/tmp/x AMACAMP_PORT=18080 ./amacamp
 *   node dev/e2e.js <LOCAL_URL> <LAN_URL> <โฟลเดอร์ภาพ>
 */
const path = require('path');
const fs = require('fs');
const { chromium, devices } = require('playwright');

const LOCAL = process.argv[2] || 'http://localhost:18080';
const LAN = process.argv[3] || LOCAL;
const OUT = path.resolve(process.argv[4] || 'shots');
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
const shot = (p, n, full) => p.screenshot({ path: path.join(OUT, n + '.png'), fullPage: !!full });

async function selfie(browser, emoji, bg) {
  const p = await browser.newPage({ viewport: { width: 480, height: 480 } });
  await p.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${bg};font-size:280px">${emoji}</body>`);
  const b = await p.screenshot({ type: 'jpeg' });
  await p.close();
  return b;
}

async function ctx(browser, opts) {
  const c = await browser.newContext({ timezoneId: 'Asia/Bangkok', locale: 'th-TH', ...opts });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text()); });
  p.on('dialog', (d) => d.accept());
  return p;
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const faceA = await selfie(browser, '👨🏻‍🍳', '#c9d6c3');
  const faceB = await selfie(browser, '👩🏻', '#e6cfc0');

  // ── 1) เจ้าของร้านเปิดโปรแกรมครั้งแรกที่คอม ──
  const owner = await ctx(browser, { viewport: { width: 1280, height: 860 } });
  await owner.goto(LOCAL + '/admin');
  await owner.waitForSelector('input[name=a]');
  await shot(owner, '01-owner-first-run');
  await owner.fill('input[name=a]', '7788');
  await owner.fill('input[name=b]', '7788');
  await owner.click('button.primary');
  await owner.waitForSelector('[data-add]');
  for (const [name, rate, start] of [['สมชาย', '650', '16:00'], ['มานี', '450', '16:30'], ['ป้าแดง', '420', '16:30']]) {
    await owner.click('[data-add]');
    const rows = await owner.$$('tbody tr');
    const last = rows[rows.length - 1];
    await (await last.$('[name=name]')).fill(name);
    await (await last.$('[name=start]')).fill(start);
    await (await last.$('[name=rate]')).fill(rate);
  }
  const pins = await owner.$$eval('tbody [name=pin]', (els) => els.map((e) => e.value));
  await owner.click('[data-save]');
  await owner.waitForSelector('.okmsg:not(:empty)');
  await shot(owner, '02-owner-employees');
  await owner.click('[data-tab=set]');
  await owner.waitForSelector('#qr img[src^="data:"]');
  await owner.waitForTimeout(300);
  await shot(owner, '03-owner-qr');

  // ── 2) หน้าจอร้านบนคอม (มีเว็บแคม) ──
  const kiosk = await ctx(browser, { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
  await kiosk.goto(LOCAL + '/kiosk');
  await kiosk.waitForSelector('input[name=pin]');
  await kiosk.fill('input[name=pin]', '7788');
  await kiosk.click('button.primary');
  await kiosk.waitForSelector('#qr img[src^="data:"]');
  await shot(kiosk, '04-kiosk');

  // ── 3) มือถือพนักงานผ่าน Wi-Fi (ไม่ใช่ localhost) ──
  const phone = await ctx(browser, devices['iPhone 13']);
  await phone.goto(LAN);
  await phone.waitForSelector('select[name=emp] option[value=E01]', { state: 'attached' });
  await phone.selectOption('select[name=emp]', 'E01');
  await phone.fill('input[name=pin]', pins[0]);
  await shot(phone, '05-phone-login');
  await phone.click('button[type=submit]');
  await phone.waitForSelector('[data-type=IN].suggest');
  const [fc] = await Promise.all([phone.waitForEvent('filechooser'), phone.click('[data-photo]')]);
  await fc.setFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: faceA });
  await phone.waitForSelector('.thumb.has');
  await shot(phone, '06-phone-action');
  await phone.click('[data-type=IN]');
  await phone.waitForSelector('.done');
  await shot(phone, '07-phone-done');
  const devcode = await phone.textContent('.devcode');

  await kiosk.waitForSelector('.flash:not(.hidden)', { timeout: 10000 });
  await kiosk.waitForTimeout(300);
  await shot(kiosk, '08-kiosk-flash');

  // สแกนอีกครั้ง → จำชื่อไว้ แนะนำ "ออกงาน"
  await phone.goto(LAN);
  await phone.waitForSelector('[data-type=OUT].suggest');

  // มานีใช้มือถือตัวเอง แล้วมากดแทนสมชาย (ติดธง)
  const phone2 = await ctx(browser, devices['Pixel 7']);
  await phone2.goto(LAN);
  await phone2.waitForSelector('select[name=emp] option[value=E02]', { state: 'attached' });
  await phone2.selectOption('select[name=emp]', 'E02');
  await phone2.fill('input[name=pin]', pins[1]);
  await phone2.click('button[type=submit]');
  await phone2.waitForSelector('[data-type=IN]');
  let [fc2] = await Promise.all([phone2.waitForEvent('filechooser'), phone2.click('[data-photo]')]);
  await fc2.setFiles({ name: 'b.jpg', mimeType: 'image/jpeg', buffer: faceB });
  await phone2.click('[data-type=IN]');
  await phone2.waitForSelector('.done');
  await phone2.goto(LAN);
  await phone2.waitForSelector('[data-switch]');
  await phone2.click('[data-switch]');
  await phone2.selectOption('select[name=emp]', 'E01');
  await phone2.fill('input[name=pin]', pins[0]);
  await phone2.click('button[type=submit]');
  await phone2.waitForSelector('[data-type=OUT]');
  [fc2] = await Promise.all([phone2.waitForEvent('filechooser'), phone2.click('[data-photo]')]);
  await fc2.setFiles({ name: 'b.jpg', mimeType: 'image/jpeg', buffer: faceB });
  await phone2.waitForTimeout(200);
  await phone2.click('[data-type=OUT]');
  await phone2.waitForSelector('.done');

  // ── 4) ป้าแดงไม่มีมือถือ: ลงเวลาที่หน้าจอร้านด้วยเว็บแคม ──
  await kiosk.waitForTimeout(5600);
  await kiosk.click('[data-nophone]');
  await kiosk.selectOption('[data-flow] select[name=emp]', 'E03');
  await kiosk.fill('[data-flow] input[name=pin]', pins[2]);
  await kiosk.click('[data-flow] button[type=submit]');
  await kiosk.waitForSelector('[data-flow] [data-type=IN]');
  await kiosk.click('[data-flow] [data-photo]');
  await kiosk.waitForSelector('.cam video');
  await kiosk.waitForFunction(() => document.querySelector('.cam video').videoWidth > 0);
  await shot(kiosk, '09-kiosk-webcam');
  await kiosk.click('.cam [data-snap]');
  await kiosk.waitForSelector('[data-flow] .thumb.has');
  await kiosk.click('[data-flow] [data-type=IN]');
  await kiosk.waitForSelector('[data-flow] .done');
  await kiosk.waitForTimeout(4500);
  await shot(kiosk, '10-kiosk-after');

  // ── 5) เจ้าของร้านดูรูป / ยืนยันเครื่อง / สรุปเงินเดือน / Excel ──
  await owner.click('[data-tab=day]');
  await owner.waitForSelector('.pcard');
  await owner.waitForFunction(() => [...document.querySelectorAll('.pcard a.ph')].length >= 3);
  await owner.waitForTimeout(500);
  await shot(owner, '11-owner-day', true);
  await owner.click('[data-tab=pay]');
  await owner.waitForSelector('table');
  await shot(owner, '12-owner-pay', true);
  const [dl] = await Promise.all([owner.waitForEvent('download'), owner.click('a[href*="export.xlsx"]')]);
  const xlsx = path.join(OUT, 'export.xlsx');
  await dl.saveAs(xlsx);

  // มือถือพนักงานพยายามเปิดหน้าเจ้าของร้าน / รูป → ต้องเข้าไม่ได้
  const sneaky = await (await ctx(browser, devices['iPhone 13'])).goto(LAN + 'photo/x.jpg');
  const ownerPage = await ctx(browser, devices['iPhone 13']);
  await ownerPage.goto(LAN + 'admin');
  await ownerPage.waitForSelector('input[name=pin], .notice');
  const ownerGate = await ownerPage.textContent('main');

  const narrow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(JSON.stringify({ pins, devcode, xlsx: fs.statSync(xlsx).size, sneakyPhotoStatus: sneaky.status(),
    ownerGateFromPhone: ownerGate.includes('รหัสเจ้าของร้าน'), phoneOverflow: narrow, errors }, null, 1));
  await browser.close();
  if (errors.length || narrow || sneaky.status() !== 401) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
