/**
 * ทดสอบ logic ของ Code.gs บนเครื่อง:  node attendance/dev/test.js
 */
const assert = require('assert/strict');
const { createEnv } = require('./harness');

const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');
const EMPLOYEES = [
  ['E01', 'สมชาย', '1234', '16:00', 'ทำงาน'],
  ['E02', 'มานี', '0042', '17:00', 'ทำงาน'],
  ['E03', 'ปิติ', '9999', '16:00', 'ลาออก'],
];
const MIN = 60000, HOUR = 60 * MIN;

let passed = 0;
function test(name, fn) {
  const env = createEnv();
  env.seed(EMPLOYEES);
  try { fn(env); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; }
}

/** จำลองการสแกน QR บนหน้าจอร้าน → ได้ pass จากหน้าเว็บ */
function scan(env) {
  const k = env.run('apiKioskRefresh', '9999');
  assert.equal(k.ok, true, k.error);
  const t = new URL(k.qr.url).searchParams.get('t');
  const page = env.ctx.doGet({ parameter: { t } });
  const boot = JSON.parse(/var BOOT = (.*?);<\/script>/.exec(page.html)[1]);
  return { boot, token: t };
}

function punch(env, empId, pin, type, extra) {
  const { boot } = scan(env);
  assert.ok(boot.pass, boot.error);
  return env.run('apiPunch', Object.assign({ pass: boot.pass, empId, pin, type, photo: PHOTO, device: 'test' }, extra));
}

console.log('ระบบลงเวลา — tests');

test('setup สร้างแท็บและค่าตั้งต้นครบ', (env) => {
  assert.ok(env.sheets['พนักงาน'] && env.sheets['บันทึกเวลา'] && env.sheets['ตั้งค่า']);
  assert.ok(env.props.QR_SECRET && env.props.PHOTO_FOLDER_ID);
  assert.equal(env.ctx.getSettings_().QR_SECONDS, 30);
});

test('ฟังก์ชันเมนูเรียกผ่านเว็บไม่ได้ (getUi โยน error)', (env) => {
  for (const fn of ['setup', 'rotateSecret', 'promptMonthlySummary', 'showLinks', 'onOpen']) {
    assert.throws(() => env.ctx[fn](), /getUi/);
  }
});

test('หน้าจอร้าน: ต้องมี ADMIN_PIN ถูกต้อง', (env) => {
  assert.equal(env.run('apiKioskInit', '0000').ok, false);
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
  const login = env.run('apiLogin', boot.pass, 'E02', '0042');
  assert.equal(login.ok, true, login.error);
  assert.equal(login.suggested, 'IN');
  assert.equal(login.last, null);

  const r = env.run('apiPunch', { pass: boot.pass, empId: 'E02', pin: '0042', type: 'IN', photo: PHOTO });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.time, '16:00:00');
  assert.equal(r.date, '23 พ.ย. 2569');
  const row = env.sheets['บันทึกเวลา'].data[1];
  assert.deepEqual(row.slice(1, 7), ['2026-11-23', '16:00:00', 'E02', 'มานี', 'เข้างาน', 'มือถือพนักงาน']);
  assert.match(row[7], /drive\.google\.com/);
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
  const r = env.run('apiPunch', { pass: boot.pass, empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PASS');

  ({ boot } = scan(env));
  assert.equal(env.run('apiPunch', { pass: boot.pass, empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO }).ok, true);
  const again = env.run('apiPunch', { pass: boot.pass, empId: 'E02', pin: '0042', type: 'IN', photo: PHOTO });
  assert.equal(again.ok, false);
  assert.match(again.error, /ใช้ลงเวลาไปแล้ว/);
});

test('สองคนสแกน QR เดียวกันในวินาทีเดียวกัน ลงเวลาได้ทั้งคู่', (env) => {
  const { token } = scan(env);
  const boot = (t) => JSON.parse(/var BOOT = (.*?);<\/script>/.exec(env.ctx.doGet({ parameter: { t } }).html)[1]);
  const a = boot(token), b = boot(token);
  assert.notEqual(a.pass, b.pass);
  assert.equal(env.run('apiPunch', { pass: a.pass, empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO }).ok, true);
  const rb = env.run('apiPunch', { pass: b.pass, empId: 'E02', pin: '0042', type: 'IN', photo: PHOTO });
  assert.equal(rb.ok, true, rb.error);
});

test('PIN ผิด 5 ครั้ง → ล็อก 10 นาที', (env) => {
  const { boot } = scan(env);
  for (let i = 0; i < 5; i++) assert.equal(env.run('apiLogin', boot.pass, 'E01', '0000').code, 'PIN');
  assert.match(env.run('apiLogin', boot.pass, 'E01', '1234').error, /รอ 10 นาที/);
  env.advance(4 * MIN); // pass ยังไม่หมด (รวม 4 นาที)
  assert.match(env.run('apiLogin', boot.pass, 'E01', '1234').error, /รอ 10 นาที/);
  env.advance(7 * MIN);
  const b2 = scan(env).boot;
  assert.equal(env.run('apiLogin', b2.pass, 'E01', '1234').ok, true);
});

test('พนักงานลาออก login ไม่ได้', (env) => {
  const { boot } = scan(env);
  assert.match(env.run('apiLogin', boot.pass, 'E03', '9999').error, /ไม่พบ/);
});

test('บังคับเซลฟี่ตามค่า REQUIRE_PHOTO', (env) => {
  let r = punch(env, 'E01', '1234', 'IN', { photo: null });
  assert.equal(r.code, 'PHOTO');
  env.setSetting('REQUIRE_PHOTO', 'FALSE');
  r = punch(env, 'E01', '1234', 'IN', { photo: null });
  assert.equal(r.ok, true, r.error);
  assert.equal(env.sheets['บันทึกเวลา'].data[1][7], '');
});

test('กันกดซ้ำภายใน MIN_GAP_MINUTES และแนะนำปุ่มถัดไปถูก', (env) => {
  assert.equal(punch(env, 'E01', '1234', 'IN').ok, true);
  env.advance(30 * 1000);
  const dup = punch(env, 'E01', '1234', 'IN');
  assert.equal(dup.code, 'DUP');
  const { boot } = scan(env);
  const login = env.run('apiLogin', boot.pass, 'E01', '1234');
  assert.equal(login.suggested, 'OUT');
  assert.equal(login.last.when, 'วันนี้ 16:00');
});

test('ลงเวลาที่เครื่องร้าน (คนไม่มีมือถือ)', (env) => {
  assert.equal(env.run('apiKioskLogin', '9999', 'E01', '1234').ok, true);
  assert.equal(env.run('apiKioskPunch', { adminPin: '1111', empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO }).code, 'ADMIN');
  const r = env.run('apiKioskPunch', { adminPin: '9999', empId: 'E01', pin: '1234', type: 'IN', photo: PHOTO });
  assert.equal(r.ok, true, r.error);
  assert.equal(env.sheets['บันทึกเวลา'].data[1][6], 'เครื่องของร้าน');
  const board = env.run('apiKioskRefresh', '9999').board;
  assert.deepEqual(board.inside, [{ name: 'สมชาย', since: '16:00' }]);
  assert.equal(board.recent[0].label, 'เข้างาน');
});

test('สรุปรายเดือน: กะดึกข้ามเที่ยงคืน, มาสาย, ลืมลงเวลาออก', (env) => {
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
  assert.equal(punch(env, 'E01', '1234', 'OUT').ok, true);

  env.clock.now = Date.parse('2026-12-01T03:00:00Z');
  const name = env.ctx.buildMonthlySummary_('2026-11');
  assert.equal(name, 'สรุป 2026-11');
  const data = env.sheets[name].data;
  const totals = data.slice(3, 5);
  assert.deepEqual(totals[0], ['E01', 'สมชาย', 2, 16.33, 10, 1, 0]);
  assert.deepEqual(totals[1], ['E02', 'มานี', 2, 5.67, 20, 1, 1]);

  const detailStart = data.findIndex((r) => r && r[0] === 'วันที่');
  const detail = data.slice(detailStart + 1).filter(Boolean);
  assert.deepEqual(detail, [
    ['2026-11-23', 'E01', 'สมชาย', '16:10', '00:30', 8.33, 10, ''],
    ['2026-11-23', 'E02', 'มานี', '16:55', '', '', 0, 'ลืมลงเวลาออก'],
    ['2026-11-24', 'E01', 'สมชาย', '15:50', '23:50', 8, 0, ''],
    ['2026-11-24', 'E02', 'มานี', '17:20', '23:00', 5.67, 20, ''],
  ]);
});

test('รับเดือนแบบ พ.ศ. ได้', (env) => {
  assert.equal(env.ctx.normalizeMonth_('2569-11'), '2026-11');
  assert.equal(env.ctx.normalizeMonth_('2026/3'), '2026-03');
  assert.equal(env.ctx.normalizeMonth_('2026-13'), null);
});

console.log(`\n${passed} passed`);
