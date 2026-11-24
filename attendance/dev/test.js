/**
 * ทดสอบ logic ของ Code.gs บนเครื่อง:  node attendance/dev/test.js
 */
const assert = require('assert/strict');
const { createEnv } = require('./harness');

const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');
const THUMB = 'data:image/jpeg;base64,' + Buffer.from('fake-thumb').toString('base64');
const EMPLOYEES = [
  ['E01', 'สมชาย', '1234', '16:00', 'ทำงาน'],
  ['E02', 'มานี', '0042', '17:00', 'ทำงาน'],
  ['E03', 'ปิติ', '9999', '16:00', 'ลาออก'],
];
// มือถือแต่ละเครื่อง (รหัสสุ่มจากหน้าเว็บ)
const PHONE = {
  somchai: { id: 'S4F8-B2KQ', name: 'iPhone · Safari' },
  manee: { id: 'M7Q2-K9XA', name: 'Android · Chrome' },
  somchaiNew: { id: 'X9PD-A3RT', name: 'Android · Chrome' },
};
const MIN = 60000;

let passed = 0;
function test(name, fn) {
  const env = createEnv();
  env.seed(EMPLOYEES);
  try { fn(env); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; }
}

const bootOf = (html) => JSON.parse(/var BOOT = (.*?);<\/script>/.exec(html)[1]);

/** จำลองการสแกน QR บนหน้าจอร้าน → ได้ pass จากหน้าเว็บ */
function scan(env) {
  const k = env.run('apiKioskRefresh', '9999');
  assert.equal(k.ok, true, k.error);
  const t = new URL(k.qr.url).searchParams.get('t');
  return { boot: bootOf(env.ctx.doGet({ parameter: { t } }).html), token: t };
}

function punch(env, empId, pin, type, extra) {
  const { boot } = scan(env);
  assert.ok(boot.pass, boot.error);
  const device = empId === 'E01' ? PHONE.somchai : PHONE.manee;
  return env.run('apiPunch', Object.assign({ pass: boot.pass, empId, pin, type, photo: PHOTO, device }, extra));
}

const logRows = (env) => env.sheets['บันทึกเวลา'].data.slice(1).filter(Boolean);
const devRows = (env) => (env.sheets['อุปกรณ์'] ? env.sheets['อุปกรณ์'].data.slice(1).filter(Boolean) : []);

console.log('ระบบลงเวลา — tests');

// ───────── พื้นฐาน ─────────

test('setup สร้างแท็บและค่าตั้งต้นครบ', (env) => {
  for (const s of ['พนักงาน', 'บันทึกเวลา', 'อุปกรณ์', 'ตั้งค่า']) assert.ok(env.sheets[s], s);
  assert.ok(env.props.QR_SECRET && env.props.PHOTO_FOLDER_ID);
  const cfg = env.ctx.getSettings_();
  assert.equal(cfg.QR_SECONDS, 30);
  assert.equal(cfg.DEVICE_LOCK, false);
  assert.equal(cfg.KIOSK_PHOTO, true);
});

test('setup ซ้ำ (หลังอัปเดตโค้ด) อัปเดตหัวตารางโดยข้อมูลเดิมไม่หาย', (env) => {
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.sheets['บันทึกเวลา'].data[0] = env.sheets['บันทึกเวลา'].data[0].slice(0, 9); // หัวตารางเวอร์ชันเก่า
  env.seed();
  assert.equal(env.sheets['บันทึกเวลา'].data[0][10], 'ตรวจสอบ');
  assert.equal(logRows(env).length, 1);
  assert.equal(env.sheets['พนักงาน'].data.length, 4);
});

test('ฟังก์ชันเมนูเรียกผ่านเว็บไม่ได้ (getUi โยน error)', (env) => {
  for (const fn of ['setup', 'rotateSecret', 'promptMonthlySummary', 'showLinks', 'onOpen', 'approveAllPending']) {
    assert.throws(() => env.ctx[fn](), /getUi/);
  }
});

test('หน้าจอร้าน: ต้องมี ADMIN_PIN ถูกต้อง', (env) => {
  assert.equal(env.run('apiKioskInit', '0000').code, 'ADMIN');
  const r = env.run('apiKioskInit', '9999');
  assert.equal(r.ok, true);
  assert.deepEqual(r.employees.map((e) => e.id), ['E01', 'E02']); // คนลาออกไม่แสดง
  assert.ok(!('pin' in r.employees[0]), 'ห้ามส่ง PIN ไปหน้าเว็บ');
  assert.match(r.qr.url, /\?t=[0-9a-z]+\.[0-9a-f]{16}$/);
});

test('สแกน → login → ลงเวลาเข้า แล้วบันทึกลงชีต', (env) => {
  const { boot } = scan(env);
  assert.equal(boot.mode, 'punch');
  assert.equal(env.run('apiEmployees', boot.pass).employees.length, 2);
  const login = env.run('apiLogin', boot.pass, 'E02', '0042', PHONE.manee);
  assert.equal(login.ok, true, login.error);
  assert.equal(login.suggested, 'IN');
  assert.equal(login.last, null);

  const r = env.run('apiPunch', { pass: boot.pass, empId: 'E02', pin: '0042', type: 'IN', photo: PHOTO, device: PHONE.manee });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.time, '16:00:00');
  assert.equal(r.date, '23 พ.ย. 2569');
  const row = logRows(env)[0];
  assert.deepEqual(row.slice(1, 7), ['2026-11-23', '16:00:00', 'E02', 'มานี', 'เข้างาน', 'มือถือพนักงาน']);
  assert.match(row[7], /drive\.google\.com/);
  assert.deepEqual(row.slice(8), ['Android · Chrome', 'M7Q2-K9XA', '']);
  assert.equal(env.drive.files[0].name, '2026-11-23_160000_E02_IN.jpg');
});

test('QR ใช้ได้แค่ช่วงสั้น ๆ (รอบปัจจุบัน + 1 รอบ)', (env) => {
  const { token } = scan(env);
  env.advance(30 * 1000);
  assert.ok(env.ctx.doGet({ parameter: { t: token } }).html.includes('"pass"'));
  env.advance(31 * 1000);
  const html = env.ctx.doGet({ parameter: { t: token } }).html;
  assert.ok(html.includes('หมดอายุ'));
  assert.ok(!html.includes('"pass"'));
});

test('QR ปลอม/แก้ไข ใช้ไม่ได้', (env) => {
  const { token } = scan(env);
  const fake = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
  assert.ok(env.ctx.doGet({ parameter: { t: fake } }).html.includes('ไม่ถูกต้อง'));
  assert.ok(env.ctx.doGet({ parameter: {} }).html.includes('กรุณาสแกน'));
});

test('pass หมดอายุหลัง 5 นาที และใช้ซ้ำไม่ได้', (env) => {
  let { boot } = scan(env);
  env.advance(6 * MIN);
  const r = env.run('apiPunch', { pass: boot.pass, empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO, device: PHONE.somchai });
  assert.equal(r.code, 'PASS');

  ({ boot } = scan(env));
  assert.equal(env.run('apiPunch', { pass: boot.pass, empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO, device: PHONE.somchai }).ok, true);
  const again = env.run('apiPunch', { pass: boot.pass, empId: 'E02', pin: '0042', type: 'IN', photo: PHOTO, device: PHONE.manee });
  assert.equal(again.ok, false);
  assert.match(again.error, /ใช้ลงเวลาไปแล้ว/);
});

test('สองคนสแกน QR เดียวกันในวินาทีเดียวกัน ลงเวลาได้ทั้งคู่', (env) => {
  const { token } = scan(env);
  const a = bootOf(env.ctx.doGet({ parameter: { t: token } }).html);
  const b = bootOf(env.ctx.doGet({ parameter: { t: token } }).html);
  assert.notEqual(a.pass, b.pass);
  assert.equal(env.run('apiPunch', { pass: a.pass, empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO, device: PHONE.somchai }).ok, true);
  const rb = env.run('apiPunch', { pass: b.pass, empId: 'E02', pin: '0042', type: 'IN', photo: PHOTO, device: PHONE.manee });
  assert.equal(rb.ok, true, rb.error);
});

test('PIN ผิด 5 ครั้ง → ล็อก 10 นาที', (env) => {
  const { boot } = scan(env);
  for (let i = 0; i < 5; i++) assert.equal(env.run('apiLogin', boot.pass, 'E01', '0000', PHONE.somchai).code, 'PIN');
  assert.match(env.run('apiLogin', boot.pass, 'E01', '1234', PHONE.somchai).error, /รอ 10 นาที/);
  env.advance(11 * MIN);
  const b2 = scan(env).boot;
  assert.equal(env.run('apiLogin', b2.pass, 'E01', '1234', PHONE.somchai).ok, true);
});

test('PIN ผิดไม่ลงทะเบียนเครื่อง', (env) => {
  const { boot } = scan(env);
  env.run('apiLogin', boot.pass, 'E01', '0000', PHONE.manee);
  assert.equal(devRows(env).length, 0);
});

test('พนักงานลาออก login ไม่ได้', (env) => {
  const { boot } = scan(env);
  assert.match(env.run('apiLogin', boot.pass, 'E03', '9999', PHONE.manee).error, /ไม่พบ/);
});

test('บังคับเซลฟี่ตามค่า REQUIRE_PHOTO', (env) => {
  assert.equal(punch(env, 'E01', '1234', 'IN', { photo: null }).code, 'PHOTO');
  env.setSetting('REQUIRE_PHOTO', 'FALSE');
  const r = punch(env, 'E01', '1234', 'IN', { photo: null });
  assert.equal(r.ok, true, r.error);
  assert.equal(logRows(env)[0][7], '');
});

test('กันกดซ้ำภายใน MIN_GAP_MINUTES และแนะนำปุ่มถัดไปถูก', (env) => {
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.advance(30 * 1000);
  assert.equal(punch(env, 'E01', '1234', 'IN').code, 'DUP');
  const { boot } = scan(env);
  const login = env.run('apiLogin', boot.pass, 'E01', '1234', PHONE.somchai);
  assert.equal(login.suggested, 'OUT');
  assert.equal(login.last.when, 'วันนี้ 16:00');
});

test('ลงเวลาที่เครื่องร้าน (คนไม่มีมือถือ) ไม่ต้องมีรหัสเครื่อง และไม่ติดธง', (env) => {
  env.setSetting('DEVICE_LOCK', 'TRUE');
  assert.equal(env.run('apiKioskLogin', '9999', 'E01', '1234').ok, true);
  assert.equal(env.run('apiKioskPunch', { adminPin: '1111', empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO }).code, 'ADMIN');
  const r = env.run('apiKioskPunch', { adminPin: '9999', empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(logRows(env)[0].slice(6, 11).filter((_, i) => i !== 1), ['เครื่องของร้าน', 'แท็บเล็ตร้าน', '', '']);
  assert.equal(devRows(env).length, 0);
  const board = env.run('apiKioskRefresh', '9999').board;
  assert.deepEqual(board.inside, [{ name: 'สมชาย', since: '16:00' }]);
});

// ───────── ข้อ 1: รหัสประจำเครื่อง + เตือนอัตโนมัติ ─────────

test('[1] เครื่องแรกของแต่ละคนอนุมัติอัตโนมัติ ไม่มีธง', (env) => {
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);
  assert.deepEqual(devRows(env).map((r) => [r[0], r[2], r[6], r[7]]), [
    ['E01', 'S4F8-B2KQ', 'อนุมัติ', 'เครื่องแรก (อนุมัติอัตโนมัติ)'],
    ['E02', 'M7Q2-K9XA', 'อนุมัติ', 'เครื่องแรก (อนุมัติอัตโนมัติ)'],
  ]);
  assert.deepEqual(logRows(env).map((r) => r[10]), ['', '']);
});

test('[1] กรณี A: มานีใช้ PIN ของสมชายกดแทนจากมือถือตัวเอง → ติดธง "เครื่องเดียวกับ มานี"', (env) => {
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);            // สมชายใช้เครื่องตัวเองตามปกติ
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);            // มานีใช้เครื่องตัวเอง
  env.advance(24 * 3600000);
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);
  const r = punch(env, 'E01', '1234', 'IN', { device: PHONE.manee }); // มานีกดแทนสมชาย
  assert.equal(r.ok, true, r.error); // ผูกเครื่องปิดอยู่ → ยังลงเวลาได้ แต่ติดธง
  assert.equal(logRows(env).at(-1)[10], '⚠️ เครื่องเดียวกับ มานี');
  const dev = devRows(env).at(-1);
  assert.deepEqual([dev[0], dev[2], dev[6], dev[7]], ['E01', 'M7Q2-K9XA', 'รออนุมัติ', 'ใช้ร่วมกับ มานี']);
});

test('[1] พนักงานใช้มือถือเครื่องใหม่ → ติดธง "เครื่องใหม่ (ปกติใช้ …)"', (env) => {
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.advance(10 * MIN);
  assert.equal(punch(env, 'E01', '1234', 'OUT', { device: PHONE.somchaiNew }).ok, true);
  assert.equal(logRows(env).at(-1)[10], '⚠️ เครื่องใหม่ (ปกติใช้ S4F8-B2KQ)');
  env.advance(10 * MIN);
  assert.equal(punch(env, 'E01', '1234', 'IN', { device: PHONE.somchaiNew }).ok, true); // ยังไม่อนุมัติ → ยังติดธง
  assert.match(logRows(env).at(-1)[10], /เครื่องใหม่/);
  assert.equal(devRows(env).length, 2); // ไม่ลงทะเบียนซ้ำ
});

test('[1] ไม่มีรหัสเครื่อง (เช่นโหมดไม่ระบุตัวตน) → ติดธง', (env) => {
  const r = punch(env, 'E01', '1234', 'IN', { device: { id: 'bad' } });
  assert.equal(r.ok, true);
  assert.equal(logRows(env)[0][10], '⚠️ ไม่มีรหัสเครื่อง');
});

// ───────── ข้อ 2: ผูกเครื่อง ─────────

test('[2] เปิดผูกเครื่อง: เครื่องแรกใช้ได้เลย เครื่องของคนอื่นถูกบล็อกตั้งแต่ login', (env) => {
  env.setSetting('DEVICE_LOCK', 'TRUE');
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);
  const { boot } = scan(env);
  const r = env.run('apiLogin', boot.pass, 'E01', '1234', PHONE.manee);
  assert.equal(r.code, 'DEVICE');
  assert.match(r.error, /ยังไม่ได้รับอนุมัติสำหรับ สมชาย.*M7Q2-K9XA/);
  const p = env.run('apiPunch', { pass: boot.pass, empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO, device: PHONE.manee });
  assert.equal(p.code, 'DEVICE');
  // ไม่ได้ลงเวลา แต่จดความพยายามไว้ 1 แถว (login + punch ภายใน 10 นาที นับครั้งเดียว)
  const rows = logRows(env);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1][4], rows[1][5], rows[1][9], rows[1][10]],
    ['สมชาย', 'ถูกบล็อก', 'M7Q2-K9XA', '⛔ เครื่องรออนุมัติ · เครื่องของ มานี']);
  // แถวถูกบล็อกไม่กระทบการคำนวณ: สมชายยังไม่ได้เข้างาน
  assert.deepEqual(env.run('apiKioskRefresh', '9999').board.inside.map((x) => x.name), ['มานี']);
  const review = env.run('apiReviewDay', '9999', '');
  assert.deepEqual(review.entries.map((e) => e.label), ['เข้างาน', 'ถูกบล็อก']);
  env.advance(11 * MIN);
  punch(env, 'E01', '1234', 'IN', { device: PHONE.manee });
  assert.equal(logRows(env).length, 3); // เกิน 10 นาที → จดใหม่
});

test('[1] เจ้าของเครื่องตัวจริงไม่โดนธงไปด้วย หลังมีคนอื่นมาใช้เครื่องตัวเอง', (env) => {
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);
  assert.equal(punch(env, 'E01', '1234', 'IN', { device: PHONE.manee }).ok, true); // สมชายใช้มือถือมานี
  env.advance(9 * 3600000);
  assert.equal(punch(env, 'E02', '0042', 'OUT').ok, true);                            // มานีใช้มือถือตัวเอง
  assert.deepEqual(logRows(env).map((r) => r[10]), ['', '⚠️ เครื่องเดียวกับ มานี', '']);
});

test('[2] เปิดผูกเครื่อง: เปลี่ยนมือถือ → รออนุมัติ → เจ้าของร้านอนุมัติ → ใช้ได้', (env) => {
  env.setSetting('DEVICE_LOCK', 'TRUE');
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.advance(10 * MIN);
  assert.equal(punch(env, 'E01', '1234', 'OUT', { device: PHONE.somchaiNew }).code, 'DEVICE');

  const day = env.run('apiReviewDay', '9999', '');
  assert.equal(day.pending.length, 1);
  const d = day.pending[0];
  assert.deepEqual([d.empName, d.deviceId, d.note], ['สมชาย', 'X9PD-A3RT', 'เครื่องใหม่']);
  assert.equal(env.run('apiReviewDevice', '9999', d.row, 'WRONG-ID', d.empId, 'OK').ok, false);
  assert.deepEqual(env.run('apiReviewDevice', '9999', d.row, d.deviceId, d.empId, 'OK').pending, []);

  const r = punch(env, 'E01', '1234', 'OUT', { device: PHONE.somchaiNew });
  assert.equal(r.ok, true, r.error);
  assert.equal(logRows(env).at(-1)[10], ''); // อนุมัติแล้ว → ไม่ติดธง
});

test('[2] เจ้าของร้านกด "ไม่อนุมัติ" → เครื่องนั้นใช้ไม่ได้ และไม่ถามซ้ำ', (env) => {
  env.setSetting('DEVICE_LOCK', 'TRUE');
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);
  punch(env, 'E01', '1234', 'IN', { device: PHONE.manee });
  const d = env.run('apiReviewDay', '9999', '').pending[0];
  env.run('apiReviewDevice', '9999', d.row, d.deviceId, d.empId, 'NO');
  assert.equal(env.run('apiReviewDay', '9999', '').pending.length, 0);
  const r = punch(env, 'E01', '1234', 'IN', { device: PHONE.manee });
  assert.match(r.error, /ไม่ได้รับอนุญาต/);
});

test('[2] เปิดผูกเครื่อง + ไม่มีรหัสเครื่อง → ลงเวลาไม่ได้', (env) => {
  env.setSetting('DEVICE_LOCK', 'TRUE');
  assert.equal(punch(env, 'E01', '1234', 'IN', { device: null }).code, 'DEVICE');
});

// ───────── ข้อ 3: รูปเซลฟี่บนหน้าจอร้าน ─────────

test('[3] หน้าจอร้านได้รายการใหม่พร้อมรูปย่อ เฉพาะที่ใหม่กว่า since', (env) => {
  const init = env.run('apiKioskInit', '9999');
  assert.equal(init.kioskPhoto, true);
  assert.deepEqual(env.run('apiKioskFeed', '9999', init.feedTs).items, []);
  env.advance(1000);
  assert.equal(punch(env, 'E02', '0042', 'IN', { thumb: THUMB }).ok, true);
  const f = env.run('apiKioskFeed', '9999', init.feedTs);
  assert.equal(f.items.length, 1);
  assert.deepEqual([f.items[0].name, f.items[0].label, f.items[0].kiosk, f.items[0].thumb], ['มานี', 'เข้างาน', false, THUMB]);
  assert.deepEqual(env.run('apiKioskFeed', '9999', f.items[0].ts).items, []);
  assert.equal(env.run('apiKioskFeed', '0000', 0).code, 'ADMIN');
});

test('[3] ปิด KIOSK_PHOTO → ไม่ส่งรูป, รูปย่อผิดรูปแบบไม่ถูกเก็บ', (env) => {
  env.setSetting('KIOSK_PHOTO', 'FALSE');
  punch(env, 'E02', '0042', 'IN', { thumb: THUMB });
  assert.equal(env.run('apiKioskFeed', '9999', 0).items[0].thumb, '');
  env.setSetting('KIOSK_PHOTO', 'TRUE');
  env.advance(5 * MIN);
  punch(env, 'E01', '1234', 'IN', { thumb: 'javascript:alert(1)' });
  const items = env.run('apiKioskFeed', '9999', 0).items;
  assert.equal(items.at(-1).thumb, '');
});

// ───────── ข้อ 4: หน้าตรวจรูป ─────────

test('[4] หน้าตรวจรูป: รายการของวัน + ธง + โหลดรูปได้เฉพาะแถวที่ตรงกับชีต', (env) => {
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);
  assert.equal(punch(env, 'E01', '1234', 'IN', { device: PHONE.manee }).ok, true);
  assert.equal(env.run('apiReviewDay', '1111', '').code, 'ADMIN');

  const r = env.run('apiReviewDay', '9999', '');
  assert.equal(r.day, '2026-11-23');
  assert.equal(r.label, '23 พ.ย. 2569');
  assert.deepEqual(r.entries.map((e) => [e.name, e.label, e.flags, e.hasPhoto]), [
    ['มานี', 'เข้างาน', '', true],
    ['สมชาย', 'เข้างาน', '⚠️ เครื่องเดียวกับ มานี', true],
  ]);
  assert.equal(r.pending.length, 1);

  const e = r.entries[1];
  const ph = env.run('apiReviewPhotos', '9999', [{ row: e.row, ts: e.ts }, { row: e.row, ts: e.ts + 1 }, { row: 999, ts: 0 }]);
  assert.deepEqual(Object.keys(ph.photos), [String(e.row)]);
  assert.equal(ph.photos[e.row], PHOTO);

  assert.deepEqual(env.run('apiReviewDay', '9999', '2026-11-22').entries, []);
});

// ───────── สำรองข้อมูล ─────────

const backups = (env) => env.drive.files.filter((f) => f.folder === 'สำรองข้อมูลระบบลงเวลา');

test('setup ตั้งงานสำรองอัตโนมัติทุกเช้า 6 โมง (กดซ้ำไม่ซ้อนกัน)', (env) => {
  env.seed();
  env.seed();
  assert.equal(env.triggers.length, 1);
  assert.deepEqual(env.triggers[0], { fn: 'dailyMaintenance', everyDays: 1, atHour: 6, tz: 'Asia/Bangkok' });
  assert.ok(env.props.BACKUP_FOLDER_ID);
});

test('สำรองข้อมูลทุกเช้าเป็น .xlsx ทั้งไฟล์ และเรียกซ้ำถี่ ๆ ไม่ได้', (env) => {
  env.clock.now = Date.parse('2026-11-24T06:00:00+07:00');
  env.ctx.dailyMaintenance();
  assert.deepEqual(backups(env).map((f) => f.name), ['สำรอง อาม่า แคมป์ 2026-11-24 0600.xlsx']);
  assert.match(env.fetches[0].url, /spreadsheets\/d\/SHEET123\/export\?format=xlsx/);
  assert.equal(env.fetches[0].o.headers.Authorization, 'Bearer TOKEN');
  env.advance(3600000);
  env.ctx.dailyMaintenance(); // มีคนเรียกผ่านเว็บ → ไม่ทำซ้ำ
  assert.equal(backups(env).length, 1);
  env.advance(23 * 3600000);
  env.ctx.dailyMaintenance();
  assert.equal(backups(env).length, 2);
});

test('เมนู "สำรองข้อมูลตอนนี้" เรียกผ่านเว็บไม่ได้ และสำรองไม่สำเร็จต้องแจ้ง error', (env) => {
  assert.throws(() => env.ctx.backupNow(), /getUi/);
  const bad = createEnv({ fetchFails: true });
  bad.seed();
  assert.throws(() => bad.ctx.backup_(bad.ctx.getSettings_()), /HTTP 500/);
});

test('ลบไฟล์สำรองเก่ากว่า 60 วัน แต่เก็บของวันที่ 1 ทุกเดือนไว้ตลอด', (env) => {
  for (let d = 0; d < 75; d++) {
    env.clock.now = Date.parse('2026-09-01T06:00:00+07:00') + d * 86400000;
    env.ctx.dailyMaintenance();
  }
  const kept = backups(env).filter((f) => !f.trashed).map((f) => /\d{4}-\d{2}-\d{2}/.exec(f.name)[0]);
  assert.equal(kept.length, 61 + 1);                    // 15 ก.ย.–14 พ.ย. (60 วันย้อนหลัง) + 1 ก.ย.
  assert.ok(kept.includes('2026-09-01'));               // วันที่ 1 → เก็บ
  assert.ok(!kept.includes('2026-09-14'));              // เก่ากว่า 60 วัน → ลบ
  assert.ok(kept.includes('2026-09-15'));
  assert.equal(kept.at(-1), '2026-11-14');
});

test('ลบรูปเซลฟี่ที่เก่ากว่า PHOTO_KEEP_DAYS (0 = เก็บตลอด)', (env) => {
  env.clock.now = Date.parse('2026-01-01T16:00:00+07:00');
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.clock.now = Date.parse('2026-07-01T16:00:00+07:00');
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  const photos = () => env.drive.files.filter((f) => f.folder === 'รูปลงเวลาพนักงาน');

  env.setSetting('PHOTO_KEEP_DAYS', 0);
  env.ctx.dailyMaintenance();
  assert.deepEqual(photos().map((f) => f.trashed), [false, false]);

  env.setSetting('PHOTO_KEEP_DAYS', 180);
  env.advance(13 * 3600000);
  env.ctx.dailyMaintenance();
  assert.deepEqual(photos().map((f) => f.trashed), [true, false]); // ม.ค. เกิน 180 วัน → ถังขยะ
  assert.equal(logRows(env).length, 2);                            // บันทึกเวลายังอยู่ครบ
});

// ───────── สรุปรายเดือน ─────────

test('สรุปรายเดือน: กะดึกข้ามเที่ยงคืน, มาสาย, ลืมลงเวลาออก, รายการน่าสงสัย', (env) => {
  // 23 พ.ย. สมชายเข้า 16:10 (สาย 10 นาที) ออก 00:30 ของวันถัดไป
  env.clock.now = Date.parse('2026-11-23T09:10:00Z');
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.clock.now = Date.parse('2026-11-23T17:30:00Z');
  assert.equal(punch(env, 'E01', '1234', 'OUT').ok, true);
  // มานีเข้า 16:55 (ไม่สาย) แต่ลืมลงเวลาออก
  env.clock.now = Date.parse('2026-11-23T09:55:00Z');
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);
  // 24 พ.ย. สมชายเข้า 15:50 ออก 23:50 / มานีเข้า 17:20 (สาย 20) ออก 23:00
  env.clock.now = Date.parse('2026-11-24T08:50:00Z');
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.clock.now = Date.parse('2026-11-24T10:20:00Z');
  assert.equal(punch(env, 'E02', '0042', 'IN').ok, true);
  env.clock.now = Date.parse('2026-11-24T16:00:00Z');
  assert.equal(punch(env, 'E02', '0042', 'OUT').ok, true);
  env.clock.now = Date.parse('2026-11-24T16:50:00Z');
  assert.equal(punch(env, 'E01', '1234', 'OUT', { device: PHONE.manee }).ok, true); // มานีกดออกงานแทน

  env.clock.now = Date.parse('2026-12-01T03:00:00Z');
  const name = env.ctx.buildMonthlySummary_('2026-11');
  assert.equal(name, 'สรุป 2026-11');
  const data = env.sheets[name].data;
  const after = (title) => data.findIndex((r) => r && r[0] === title);

  assert.deepEqual(data.slice(3, 5), [
    ['E01', 'สมชาย', 2, 16.33, 10, 1, 0],
    ['E02', 'มานี', 2, 5.67, 20, 1, 1],
  ]);

  const s = after('⚠️ รายการน่าสงสัย (1)');
  assert.ok(s > 0, 'มีหัวข้อรายการน่าสงสัย');
  assert.deepEqual(data[s + 2], ['2026-11-24', '23:50', 'E01', 'สมชาย', 'ออกงาน', 'M7Q2-K9XA', '⚠️ เครื่องเดียวกับ มานี']);

  const d = after('รายละเอียดรายวัน');
  assert.deepEqual(data.slice(d + 2).filter(Boolean), [
    ['2026-11-23', 'E01', 'สมชาย', '16:10', '00:30', 8.33, 10, ''],
    ['2026-11-23', 'E02', 'มานี', '16:55', '', '', 0, 'ลืมลงเวลาออก'],
    ['2026-11-24', 'E01', 'สมชาย', '15:50', '23:50', 8, 0, ''],
    ['2026-11-24', 'E02', 'มานี', '17:20', '23:00', 5.67, 20, ''],
  ]);
});

test('สรุปรายเดือน: ลืมลงเวลาเข้า แล้วออกหลังเที่ยงคืน → นับเป็นกะของวันก่อน', (env) => {
  env.clock.now = Date.parse('2026-11-15T01:19:00+07:00');
  assert.equal(punch(env, 'E01', '1234', 'OUT').ok, true);
  env.clock.now = Date.parse('2026-11-15T15:20:00+07:00');
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.clock.now = Date.parse('2026-11-16T00:10:00+07:00');
  assert.equal(punch(env, 'E01', '1234', 'OUT').ok, true);
  env.clock.now = Date.parse('2026-12-01T10:00:00+07:00');
  const data = env.sheets[env.ctx.buildMonthlySummary_('2026-11')].data;
  const d = data.findIndex((r) => r && r[0] === 'รายละเอียดรายวัน');
  assert.deepEqual(data.slice(d + 2).filter(Boolean).map((r) => [r[0], r[3], r[4], r[7]]), [
    ['2026-11-14', '', '01:19', 'ลืมลงเวลาเข้า'],
    ['2026-11-15', '15:20', '00:10', ''],
  ]);
});

test('[4] หน้าตรวจรูปจัดกลุ่มตามกะ: ออกงานหลังเที่ยงคืนอยู่ในวันเดียวกับเข้างาน', (env) => {
  env.clock.now = Date.parse('2026-11-21T16:00:00+07:00');
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.clock.now = Date.parse('2026-11-22T00:45:00+07:00');
  assert.equal(punch(env, 'E01', '1234', 'OUT').ok, true);
  assert.equal(env.run('apiReviewDay', '9999', '').day, '2026-11-21'); // ตี 1 ยังนับเป็นกะของวันที่ 21
  assert.deepEqual(env.run('apiReviewDay', '9999', '2026-11-21').entries.map((e) => e.time), ['16:00:00', '00:45:00']);
  env.clock.now = Date.parse('2026-11-22T10:00:00+07:00');
  assert.deepEqual(env.run('apiReviewDay', '9999', '').entries, []);
});

test('รับเดือนแบบ พ.ศ. ได้', (env) => {
  assert.equal(env.ctx.normalizeMonth_('2569-11'), '2026-11');
  assert.equal(env.ctx.normalizeMonth_('2026/3'), '2026-03');
  assert.equal(env.ctx.normalizeMonth_('2026-13'), null);
});

console.log(`\n${passed} passed`);
