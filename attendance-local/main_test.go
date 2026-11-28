package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

var photo = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString([]byte("fake-jpeg"))

type tenv struct {
	t     *testing.T
	s     *Store
	srv   *httptest.Server
	admin *http.Client // มีคุกกี้เจ้าของร้าน
	phone *http.Client
	now   time.Time
}

func newEnv(t *testing.T) *tenv {
	t.Helper()
	e := &tenv{t: t, now: time.Date(2026, 11, 23, 16, 0, 0, 0, ict)}
	nowFunc = func() time.Time { return e.now }
	t.Cleanup(func() { nowFunc = time.Now })
	s, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e.s = s
	e.srv = httptest.NewServer(s.routes()) // 127.0.0.1 → นับเป็นคอมเครื่องแม่
	t.Cleanup(e.srv.Close)
	jar, _ := cookiejar.New(nil)
	e.admin = &http.Client{Jar: jar}
	e.phone = &http.Client{}
	return e
}

func (e *tenv) call(c *http.Client, method, path string, body any) map[string]any {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		e.t.Fatalf("%s %s: bad json: %v", method, path, err)
	}
	return out
}

func ok(t *testing.T, r map[string]any) map[string]any {
	t.Helper()
	if r["ok"] != true {
		t.Fatalf("expected ok, got %v", r)
	}
	return r
}

func fails(t *testing.T, r map[string]any, code string) {
	t.Helper()
	if r["ok"] != false || r["code"] != code {
		t.Fatalf("expected error code %q, got %v", code, r)
	}
}

func (e *tenv) setupShop() {
	ok(e.t, e.call(e.admin, "POST", "/api/admin/setup", map[string]string{"pin": "7788"}))
	ok(e.t, e.call(e.admin, "POST", "/api/admin/employees", map[string]any{"employees": []map[string]any{
		{"id": "E01", "name": "สมชาย", "pin": "1234", "start": "16:00", "rate": 500, "active": true},
		{"id": "E02", "name": "มานี", "pin": "0042", "start": "17:00", "rate": 450, "active": true},
		{"id": "E03", "name": "ปิติ", "pin": "9999", "start": "16:00", "active": false},
	}}))
}

var (
	somchaiPhone = map[string]string{"id": "S4F8-B2KQ", "name": "iPhone · Safari"}
	maneePhone   = map[string]string{"id": "M7Q2-K9XA", "name": "Android · Chrome"}
)

func (e *tenv) punch(id, pin, typ string, dev map[string]string) map[string]any {
	return e.call(e.phone, "POST", "/api/punch", map[string]any{"id": id, "pin": pin, "type": typ, "photo": photo, "thumb": photo, "device": dev})
}

func TestSetupAndAuth(t *testing.T) {
	e := newEnv(t)
	st := ok(t, e.call(e.admin, "GET", "/api/admin/status", nil))
	if st["needsSetup"] != true || st["local"] != true {
		t.Fatalf("status %v", st)
	}
	fails(t, e.call(e.admin, "GET", "/api/admin/employees", nil), "ADMIN")
	ok(t, e.call(e.admin, "POST", "/api/admin/setup", map[string]string{"pin": "7788"}))
	if list, isList := ok(t, e.call(e.admin, "GET", "/api/admin/employees", nil))["employees"].([]any); !isList || len(list) != 0 {
		t.Fatal("first run must return an empty list, not null")
	}
	e.s.set.AdminPIN = ""
	e.setupShop()
	fails(t, e.call(e.admin, "POST", "/api/admin/setup", map[string]string{"pin": "1111"}), "BAD") // ตั้งซ้ำไม่ได้
	fails(t, e.call(e.phone, "POST", "/api/admin/login", map[string]string{"pin": "0000"}), "ADMIN")
	fails(t, e.call(e.phone, "GET", "/api/admin/board", nil), "ADMIN")

	emps := ok(t, e.call(e.phone, "GET", "/api/employees", nil))["employees"].([]any)
	if len(emps) != 2 {
		t.Fatalf("inactive employee should be hidden: %v", emps)
	}
	if _, has := emps[0].(map[string]any)["pin"]; has {
		t.Fatal("PIN must not be sent to phones")
	}
}

func TestEmployeeValidation(t *testing.T) {
	e := newEnv(t)
	e.setupShop()
	bad := []map[string]any{
		{"id": "E01", "name": "ก", "pin": "12", "active": true},
	}
	r := e.call(e.admin, "POST", "/api/admin/employees", map[string]any{"employees": bad})
	fails(t, r, "BAD")
	if !strings.Contains(r["error"].(string), "PIN") {
		t.Fatal(r)
	}
	dup := []map[string]any{{"id": "E01", "name": "ก", "pin": "1234"}, {"id": "E01", "name": "ข", "pin": "5678"}}
	fails(t, e.call(e.admin, "POST", "/api/admin/employees", map[string]any{"employees": dup}), "BAD")
}

func TestPunchFlow(t *testing.T) {
	e := newEnv(t)
	e.setupShop()
	login := ok(t, e.call(e.phone, "POST", "/api/login", map[string]any{"id": "E02", "pin": "0042", "device": maneePhone}))
	if login["suggested"] != "IN" || login["last"] != nil {
		t.Fatal(login)
	}
	// ต้องมีรูป
	fails(t, e.call(e.phone, "POST", "/api/punch", map[string]any{"id": "E02", "pin": "0042", "type": "IN", "device": maneePhone}), "PHOTO")
	r := ok(t, e.punch("E02", "0042", "IN", maneePhone))
	if r["time"] != "16:00:00" || r["date"] != "23 พ.ย. 2569" {
		t.Fatal(r)
	}
	p := e.s.punches[0]
	if p.Photo != "2026-11/2026-11-23_160000_E02_IN.jpg" || p.DeviceID != "M7Q2-K9XA" || p.Flags != "" {
		t.Fatalf("%+v", p)
	}
	if b, _ := os.ReadFile(filepath.Join(e.s.photoDir(), "2026-11", "2026-11-23_160000_E02_IN.jpg")); string(b) != "fake-jpeg" {
		t.Fatal("photo not saved")
	}
	e.now = e.now.Add(30 * time.Second)
	fails(t, e.punch("E02", "0042", "IN", maneePhone), "DUP")
	login = ok(t, e.call(e.phone, "POST", "/api/login", map[string]any{"id": "E02", "pin": "0042", "device": maneePhone}))
	if login["suggested"] != "OUT" {
		t.Fatal(login)
	}
	// ข้อมูลยังอยู่หลังปิด-เปิดโปรแกรม
	s2, err := openStore(e.s.dir)
	if err != nil || len(s2.punches) != 1 || len(s2.emps) != 3 || s2.set.AdminPIN != "7788" {
		t.Fatalf("reload: %v %+v", err, s2)
	}
}

func TestPinLockout(t *testing.T) {
	e := newEnv(t)
	e.setupShop()
	for i := 0; i < 5; i++ {
		fails(t, e.call(e.phone, "POST", "/api/login", map[string]any{"id": "E01", "pin": "0000"}), "PIN")
	}
	r := e.call(e.phone, "POST", "/api/login", map[string]any{"id": "E01", "pin": "1234"})
	if !strings.Contains(r["error"].(string), "10 นาที") {
		t.Fatal(r)
	}
	e.now = e.now.Add(11 * time.Minute)
	ok(t, e.call(e.phone, "POST", "/api/login", map[string]any{"id": "E01", "pin": "1234"}))
	fails(t, e.call(e.phone, "POST", "/api/login", map[string]any{"id": "E03", "pin": "9999"}), "PIN") // ลาออก
}

func TestDeviceFlags(t *testing.T) {
	e := newEnv(t)
	e.setupShop()
	ok(t, e.punch("E02", "0042", "IN", maneePhone))
	ok(t, e.punch("E01", "1234", "IN", maneePhone)) // มานีกดแทนสมชาย
	if got := e.s.punches[1].Flags; got != "⚠️ เครื่องเดียวกับ มานี" {
		t.Fatalf("flag = %q", got)
	}
	e.now = e.now.Add(8 * time.Hour)
	ok(t, e.punch("E02", "0042", "OUT", maneePhone)) // เจ้าของเครื่องตัวจริงไม่โดนธง
	if e.s.punches[2].Flags != "" {
		t.Fatal(e.s.punches[2].Flags)
	}
	ok(t, e.punch("E01", "1234", "OUT", nil))
	if e.s.punches[3].Flags != "⚠️ ไม่มีรหัสเครื่อง" {
		t.Fatal(e.s.punches[3].Flags)
	}
	ok(t, e.call(e.admin, "POST", "/api/admin/login", map[string]string{"pin": "7788"}))
	day := ok(t, e.call(e.admin, "GET", "/api/admin/day?d=2026-11-23", nil))
	if n := len(day["pending"].([]any)); n != 1 {
		t.Fatalf("pending = %d", n)
	}
	ok(t, e.call(e.admin, "POST", "/api/admin/device", map[string]string{"empId": "E01", "deviceId": "M7Q2-K9XA", "decision": "OK"}))
	e.now = e.now.Add(10 * time.Hour)
	ok(t, e.punch("E01", "1234", "IN", maneePhone)) // ยืนยันแล้ว → ไม่ติดธง
	if e.s.punches[4].Flags != "" {
		t.Fatal(e.s.punches[4].Flags)
	}
	// สมชายเปลี่ยนมือถือใหม่
	ok(t, e.punch("E01", "1234", "OUT", somchaiPhone))
	if e.s.punches[5].Flags != "⚠️ เครื่องใหม่ (ปกติใช้ M7Q2-K9XA)" {
		t.Fatal(e.s.punches[5].Flags)
	}
}

func TestKioskNeedsOwner(t *testing.T) {
	e := newEnv(t)
	e.setupShop()
	fails(t, e.call(e.phone, "POST", "/api/punch", map[string]any{"id": "E01", "pin": "1234", "type": "IN", "kiosk": true}), "ADMIN")
	r := ok(t, e.call(e.admin, "POST", "/api/punch", map[string]any{"id": "E01", "pin": "1234", "type": "IN", "kiosk": true})) // ไม่มีรูปก็ได้
	if r["label"] != "เข้างาน" || e.s.punches[0].Channel != "kiosk" || len(e.s.devs) != 0 {
		t.Fatalf("%v %+v", r, e.s.punches[0])
	}
	board := ok(t, e.call(e.admin, "GET", "/api/admin/board", nil))
	if len(board["inside"].([]any)) != 1 {
		t.Fatal(board)
	}
	feed := ok(t, e.call(e.admin, "GET", "/api/admin/feed?since=0", nil))
	if len(feed["items"].([]any)) != 1 {
		t.Fatal(feed)
	}
}

func TestSummaryAndPay(t *testing.T) {
	e := newEnv(t)
	e.setupShop()
	at := func(s string) { e.now, _ = time.ParseInLocation("2006-01-02 15:04", s, ict) }
	at("2026-11-14 01:19") // สมชายลืมลงเวลาเข้า (กะวันที่ 13)
	ok(t, e.punch("E01", "1234", "OUT", somchaiPhone))
	at("2026-11-23 16:10") // สาย 10 นาที
	ok(t, e.punch("E01", "1234", "IN", somchaiPhone))
	at("2026-11-24 00:30")
	ok(t, e.punch("E01", "1234", "OUT", somchaiPhone))
	at("2026-11-23 16:55")
	e.now = e.now.Add(0)
	ok(t, e.punch("E02", "0042", "IN", maneePhone)) // ลืมออก
	at("2026-11-24 17:20")
	ok(t, e.punch("E02", "0042", "IN", maneePhone)) // สาย 20
	at("2026-11-24 23:00")
	ok(t, e.punch("E02", "0042", "OUT", maneePhone))
	// เรียงตามเวลาจริงเหมือนตอนโหลดไฟล์
	s2, _ := openStore(e.s.dir)
	e.s.punches = s2.punches
	at("2026-12-01 10:00")
	ok(t, e.call(e.admin, "POST", "/api/admin/login", map[string]string{"pin": "7788"}))
	r := ok(t, e.call(e.admin, "GET", "/api/admin/summary?m=2026-11", nil))
	b, _ := json.Marshal(r["totals"])
	var wantV any
	_ = json.Unmarshal([]byte(`[{"ID":"E01","Name":"สมชาย","Days":1,"Hours":8.33,"Late":10,"LateCount":1,"Missing":1,"Rate":500,"Pay":500},`+
		`{"ID":"E02","Name":"มานี","Days":2,"Hours":5.67,"Late":20,"LateCount":1,"Missing":1,"Rate":450,"Pay":900}]`), &wantV)
	want, _ := json.Marshal(wantV)
	if string(b) != string(want) {
		t.Fatalf("totals\n got %s\nwant %s", b, want)
	}
	rows := r["rows"].([]any)
	first := rows[0].(map[string]any)
	if first["Date"] != "2026-11-13" || first["Note"] != "ลืมลงเวลาเข้า" {
		t.Fatalf("forgot-in row: %v", first)
	}
	if r["totalPay"].(float64) != 1400 {
		t.Fatal(r["totalPay"])
	}

	// ไฟล์ Excel เปิดได้และมีครบทุกแท็บ
	res, err := e.admin.Get(e.srv.URL + "/api/admin/export.xlsx?m=2026-11")
	if err != nil || res.StatusCode != 200 {
		t.Fatal(err, res.Status)
	}
	f, err := excelize.OpenReader(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.GetSheetList(), ","); got != "สรุปเงินเดือน,รายละเอียดรายวัน,รายการน่าสงสัย,บันทึกทั้งหมด" {
		t.Fatal(got)
	}
	v, _ := f.GetCellValue("สรุปเงินเดือน", "I4")
	if v != "1,400.00" {
		t.Fatalf("total pay cell = %q", v)
	}
}

func TestPhotoAccessAndBackup(t *testing.T) {
	e := newEnv(t)
	e.setupShop()
	ok(t, e.punch("E01", "1234", "IN", somchaiPhone))
	res, _ := e.phone.Get(e.srv.URL + "/photo/2026-11/2026-11-23_160000_E01_IN.jpg")
	if res.StatusCode != 401 {
		t.Fatal("photos must need owner login", res.Status)
	}
	res, _ = e.admin.Get(e.srv.URL + "/photo/2026-11/2026-11-23_160000_E01_IN.jpg")
	if b, _ := io.ReadAll(res.Body); string(b) != "fake-jpeg" {
		t.Fatal("owner should see photo")
	}
	res, _ = e.admin.Get(e.srv.URL + "/photo/../settings.json")
	if res.StatusCode == 200 {
		if b, _ := io.ReadAll(res.Body); bytes.Contains(b, []byte("adminPin")) {
			t.Fatal("path traversal")
		}
	}
	res, _ = e.admin.Get(e.srv.URL + "/api/admin/backup.zip?photos=1")
	if b, _ := io.ReadAll(res.Body); res.StatusCode != 200 || !bytes.HasPrefix(b, []byte("PK")) {
		t.Fatal("backup zip")
	}

	// สำรองรายวัน + ลบของเก่า
	e.now = time.Date(2026, 11, 24, 7, 0, 0, 0, ict)
	e.s.maintenance()
	if _, err := os.Stat(filepath.Join(e.s.backupDir(), "2026-11-24", "punches.jsonl")); err != nil {
		t.Fatal("daily backup missing", err)
	}
	for _, d := range []string{"2026-08-01", "2026-08-02"} {
		_ = os.MkdirAll(filepath.Join(e.s.backupDir(), d), 0o755)
	}
	e.now = e.now.Add(24 * time.Hour)
	e.s.maintenance()
	if _, err := os.Stat(filepath.Join(e.s.backupDir(), "2026-08-02")); err == nil {
		t.Fatal("old backup should be removed")
	}
	if _, err := os.Stat(filepath.Join(e.s.backupDir(), "2026-08-01")); err != nil {
		t.Fatal("1st-of-month backup should be kept")
	}
	// รูปเก่ากว่า 180 วันถูกลบ
	old := filepath.Join(e.s.photoDir(), "2026-11", "2026-11-23_160000_E01_IN.jpg")
	_ = os.Chtimes(old, time.Now(), e.now.AddDate(0, 0, -200))
	e.now = e.now.Add(24 * time.Hour)
	e.s.maintenance()
	if _, err := os.Stat(old); err == nil {
		t.Fatal("old photo should be deleted")
	}
}
