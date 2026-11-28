// โปรแกรมลงเวลาพนักงาน อาม่า แคมป์ — ทำงานบนคอมเครื่องแม่ เก็บข้อมูลในเครื่อง
// พนักงานต่อ Wi-Fi ร้านแล้วสแกน QR เพื่อลงเวลาด้วยมือถือตัวเอง
package main

import (
	"archive/zip"
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

const (
	appTitle    = "ระบบลงเวลา อาม่า แคมป์"
	cookieName  = "amacamp_admin"
	shiftCutoff = 6 * time.Hour // ลงเวลาหลังเที่ยงคืนถึงตี 6 นับเป็นกะของวันก่อน
	maxPinFails = 5
)

var (
	ict         = time.FixedZone("ICT", 7*3600)
	deviceRe    = regexp.MustCompile(`^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$`)
	dataURLRe   = regexp.MustCompile(`^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$`)
	thumbRe     = regexp.MustCompile(`^data:image/jpeg;base64,[A-Za-z0-9+/=]+$`)
	pinRe       = regexp.MustCompile(`^[0-9]{4,8}$`)
	hhmmRe      = regexp.MustCompile(`^([01]?[0-9]|2[0-3])[:.]([0-5][0-9])$`)
	thaiMonths  = []string{"ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."}
	typeLabel   = map[string]string{"IN": "เข้างาน", "OUT": "ออกงาน"}
	statusLabel = map[string]string{"ok": "อนุมัติ", "pending": "รออนุมัติ", "no": "ไม่อนุมัติ"}
	nowFunc     = time.Now // เปลี่ยนได้ในการทดสอบ
)

// ───────────────────────── ข้อมูล ─────────────────────────

type Settings struct {
	ShopName       string `json:"shopName"`
	AdminPIN       string `json:"adminPin"`
	RequirePhoto   bool   `json:"requirePhoto"`
	KioskPhoto     bool   `json:"kioskPhoto"`
	MinGapMinutes  int    `json:"minGapMinutes"`
	MaxShiftHours  int    `json:"maxShiftHours"`
	PhotoKeepDays  int    `json:"photoKeepDays"`
	BackupKeepDays int    `json:"backupKeepDays"`
	Port           int    `json:"port"`
	Secret         string `json:"secret"`
}

type Employee struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	PIN    string  `json:"pin"`
	Start  string  `json:"start"`
	Rate   float64 `json:"rate"`
	Active bool    `json:"active"`
}

type Punch struct {
	TS         int64  `json:"ts"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`    // IN / OUT
	Channel    string `json:"channel"` // phone / kiosk
	Photo      string `json:"photo,omitempty"`
	DeviceID   string `json:"deviceId,omitempty"`
	DeviceName string `json:"deviceName,omitempty"`
	Flags      string `json:"flags,omitempty"`
}

type Device struct {
	EmpID      string `json:"empId"`
	EmpName    string `json:"empName"`
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	FirstSeen  int64  `json:"firstSeen"`
	LastUsed   int64  `json:"lastUsed"`
	Status     string `json:"status"` // ok / pending / no
	Note       string `json:"note"`
}

type feedItem struct {
	TS    int64  `json:"ts"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Label string `json:"label"`
	Time  string `json:"time"`
	Kiosk bool   `json:"kiosk"`
	Thumb string `json:"thumb,omitempty"`
}

type failInfo struct {
	n     int
	until time.Time
}

type Store struct {
	mu       sync.Mutex
	dir      string
	set      Settings
	emps     []Employee
	punches  []Punch
	devs     []Device
	fails    map[string]*failInfo
	feed     []feedItem
	lastMain string
}

type apiErr struct{ msg, code string }

func (e *apiErr) Error() string   { return e.msg }
func uerr(msg, code string) error { return &apiErr{msg, code} }

func defaultSettings() Settings {
	return Settings{
		ShopName: "อาม่า แคมป์", RequirePhoto: true, KioskPhoto: true, MinGapMinutes: 2, MaxShiftHours: 16,
		PhotoKeepDays: 180, BackupKeepDays: 60, Port: 8080, Secret: randHex(32),
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (s *Store) path(name string) string { return filepath.Join(s.dir, name) }
func (s *Store) photoDir() string        { return s.path("รูป") }
func (s *Store) backupDir() string       { return s.path("สำรอง") }

func openStore(dir string) (*Store, error) {
	s := &Store{dir: dir, fails: map[string]*failInfo{}}
	for _, d := range []string{dir, s.photoDir(), s.backupDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	s.set = defaultSettings()
	if err := readJSON(s.path("settings.json"), &s.set); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("อ่าน settings.json ไม่ได้: %w", err)
	}
	if s.set.Secret == "" {
		s.set.Secret = randHex(32)
	}
	if err := readJSON(s.path("employees.json"), &s.emps); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("อ่าน employees.json ไม่ได้: %w", err)
	}
	if err := readJSON(s.path("devices.json"), &s.devs); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("อ่าน devices.json ไม่ได้: %w", err)
	}
	if err := s.loadPunches(); err != nil {
		return nil, err
	}
	if s.emps == nil { // ไฟล์ยังไม่มี → ส่งเป็นรายการว่าง [] ไม่ใช่ null
		s.emps = []Employee{}
	}
	if s.devs == nil {
		s.devs = []Device{}
	}
	return s, s.saveSettings()
}

func readJSON(p string, v any) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// เขียนไฟล์แบบปลอดภัย: เขียนไฟล์ชั่วคราวก่อนแล้วค่อยแทนที่ (ไฟดับกลางคันไฟล์เดิมไม่เสีย)
func writeJSON(p string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) saveSettings() error  { return writeJSON(s.path("settings.json"), s.set) }
func (s *Store) saveEmployees() error { return writeJSON(s.path("employees.json"), s.emps) }
func (s *Store) saveDevices() error   { return writeJSON(s.path("devices.json"), s.devs) }

func (s *Store) loadPunches() error {
	b, err := os.ReadFile(s.path("punches.jsonl"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for i, line := range bytes.Split(b, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var p Punch
		if err := json.Unmarshal(line, &p); err != nil {
			log.Printf("ข้ามบรรทัด %d ใน punches.jsonl ที่อ่านไม่ได้: %v", i+1, err)
			continue
		}
		s.punches = append(s.punches, p)
	}
	sort.SliceStable(s.punches, func(a, b int) bool { return s.punches[a].TS < s.punches[b].TS })
	return nil
}

func (s *Store) appendPunch(p Punch) error {
	b, _ := json.Marshal(p)
	f, err := os.OpenFile(s.path("punches.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	s.punches = append(s.punches, p)
	return nil
}

// ───────────────────────── เวลา ─────────────────────────

func tOf(ms int64) time.Time   { return time.UnixMilli(ms).In(ict) }
func dayOf(ms int64) string    { return tOf(ms).Format("2006-01-02") }
func shiftDay(ms int64) string { return tOf(ms).Add(-shiftCutoff).Format("2006-01-02") }
func hm(ms int64) string       { return tOf(ms).Format("15:04") }
func nowMS() int64             { return nowFunc().UnixMilli() }
func thaiDateT(t time.Time) string {
	return fmt.Sprintf("%d %s %d", t.Day(), thaiMonths[t.Month()-1], t.Year()+543)
}

func describeWhen(ms int64) string {
	now := nowMS()
	switch dayOf(ms) {
	case dayOf(now):
		return "วันนี้ " + hm(ms)
	case dayOf(now - 86400000):
		return "เมื่อวาน " + hm(ms)
	}
	return tOf(ms).Format("02/01") + " " + hm(ms)
}

func minutesOf(hhmm string) int {
	m := hhmmRe.FindStringSubmatch(hhmm)
	if m == nil {
		return -1
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	return h*60 + mi
}

// ───────────────────────── พนักงาน / PIN / เครื่อง ─────────────────────────

func (s *Store) emp(id string) *Employee {
	for i := range s.emps {
		if s.emps[i].ID == id {
			return &s.emps[i]
		}
	}
	return nil
}

func (s *Store) checkFails(key string, max int) error {
	f := s.fails[key]
	if f != nil && f.n >= max && nowFunc().Before(f.until) {
		return uerr("ใส่รหัสผิดหลายครั้งเกินไป กรุณารอ 10 นาทีแล้วลองใหม่", "PIN")
	}
	if f != nil && !nowFunc().Before(f.until) {
		delete(s.fails, key)
	}
	return nil
}

func (s *Store) addFail(key string) int {
	f := s.fails[key]
	if f == nil {
		f = &failInfo{}
		s.fails[key] = f
	}
	f.n++
	f.until = nowFunc().Add(10 * time.Minute)
	return f.n
}

func (s *Store) auth(id, pin string) (*Employee, error) {
	id = strings.TrimSpace(id)
	key := "emp:" + id
	if err := s.checkFails(key, maxPinFails); err != nil {
		return nil, err
	}
	e := s.emp(id)
	if e == nil || !e.Active {
		return nil, uerr("ไม่พบชื่อพนักงานนี้ กรุณาแจ้งเจ้าของร้าน", "PIN")
	}
	if e.PIN == "" || e.PIN != strings.TrimSpace(pin) {
		n := s.addFail(key)
		if left := maxPinFails - n; left > 0 {
			return nil, uerr(fmt.Sprintf("PIN ไม่ถูกต้อง (ลองได้อีก %d ครั้ง)", left), "PIN")
		}
		return nil, uerr("PIN ไม่ถูกต้อง — ถูกล็อก 10 นาที", "PIN")
	}
	delete(s.fails, key)
	return e, nil
}

type devIn struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ลงทะเบียนเครื่อง + คืนธงเตือน (เครื่องแรกของแต่ละคนอนุมัติอัตโนมัติ)
func (s *Store) deviceCheck(e *Employee, d *devIn, touch bool) (string, string, []string) {
	if d == nil || !deviceRe.MatchString(strings.ToUpper(strings.TrimSpace(d.ID))) {
		return "", "", []string{"⚠️ ไม่มีรหัสเครื่อง"}
	}
	id := strings.ToUpper(strings.TrimSpace(d.ID))
	name := d.Name
	if len([]rune(name)) > 60 {
		name = string([]rune(name)[:60])
	}
	var mine *Device
	approvedMine := []string{}
	others := []string{}
	for i := range s.devs {
		dv := &s.devs[i]
		if dv.EmpID == e.ID {
			if dv.DeviceID == id {
				mine = dv
			}
			if dv.Status == "ok" {
				approvedMine = append(approvedMine, dv.DeviceID)
			}
		} else if dv.DeviceID == id && !contains(others, dv.EmpName) {
			others = append(others, dv.EmpName)
		}
	}
	now := nowMS()
	if mine == nil {
		status, note := "pending", "เครื่องใหม่"
		if len(approvedMine) == 0 && len(others) == 0 {
			status, note = "ok", "เครื่องแรก (อนุมัติอัตโนมัติ)"
		} else if len(others) > 0 {
			note = "ใช้ร่วมกับ " + strings.Join(others, ", ")
		}
		s.devs = append(s.devs, Device{EmpID: e.ID, EmpName: e.Name, DeviceID: id, DeviceName: name, FirstSeen: now, LastUsed: now, Status: status, Note: note})
		mine = &s.devs[len(s.devs)-1]
		_ = s.saveDevices()
	} else if touch {
		mine.LastUsed = now
		_ = s.saveDevices()
	}
	flags := []string{}
	if mine.Status != "ok" {
		if len(others) > 0 {
			flags = append(flags, "⚠️ เครื่องเดียวกับ "+strings.Join(others, ", "))
		}
		if mine.Status == "no" {
			flags = append(flags, "⚠️ เครื่องที่เจ้าของร้านไม่อนุมัติ")
		} else if len(others) == 0 {
			f := "⚠️ เครื่องใหม่"
			if len(approvedMine) > 0 {
				f += " (ปกติใช้ " + strings.Join(approvedMine, ", ") + ")"
			}
			flags = append(flags, f)
		}
	}
	return id, name, flags
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func (s *Store) lastPunch(id string) *Punch {
	for i := len(s.punches) - 1; i >= 0; i-- {
		if s.punches[i].ID == id {
			return &s.punches[i]
		}
	}
	return nil
}

func (s *Store) suggest(last *Punch) string {
	if last != nil && last.Type == "IN" && nowMS()-last.TS < int64(s.set.MaxShiftHours)*3600000 {
		return "OUT"
	}
	return "IN"
}

func (s *Store) savePhoto(dataURL string, e *Employee, typ string, t time.Time) (string, error) {
	m := dataURLRe.FindStringSubmatch(dataURL)
	if m == nil {
		return "", uerr("ไฟล์รูปไม่ถูกต้อง กรุณาถ่ายใหม่", "PHOTO")
	}
	if len(m[2]) > 4_000_000 {
		return "", uerr("รูปใหญ่เกินไป กรุณาถ่ายใหม่", "PHOTO")
	}
	b, err := base64.StdEncoding.DecodeString(m[2])
	if err != nil {
		return "", uerr("ไฟล์รูปไม่ถูกต้อง กรุณาถ่ายใหม่", "PHOTO")
	}
	ext := m[1]
	if ext == "jpeg" {
		ext = "jpg"
	}
	month := t.Format("2006-01")
	safeID := regexp.MustCompile(`[^A-Za-z0-9_-]`).ReplaceAllString(e.ID, "_")
	rel := month + "/" + t.Format("2006-01-02_150405") + "_" + safeID + "_" + typ + "." + ext
	full := filepath.Join(s.photoDir(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "", err
	}
	return rel, os.WriteFile(full, b, 0o644)
}

// ───────────────────────── HTTP ─────────────────────────

func (s *Store) adminToken() string {
	mac := hmac.New(sha256.New, []byte(s.set.Secret))
	mac.Write([]byte("admin:" + s.set.AdminPIN))
	return hex.EncodeToString(mac.Sum(nil))[:40]
}

func (s *Store) isAdmin(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	return err == nil && s.set.AdminPIN != "" && hmac.Equal([]byte(c.Value), []byte(s.adminToken()))
}

func (s *Store) setAdminCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: s.adminToken(), Path: "/", MaxAge: 400 * 86400, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type handlerFn func(w http.ResponseWriter, r *http.Request) (map[string]any, error)

// ทุก API ตอบ JSON {ok:true,...} หรือ {ok:false,error,code}; ล็อก Store ให้ทั้งคำขอ
func (s *Store) api(admin bool, fn handlerFn) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		var out map[string]any
		var err error
		if admin && !s.isAdmin(r) {
			err = uerr("กรุณาเข้าสู่ระบบเจ้าของร้าน", "ADMIN")
		} else {
			out, err = fn(w, r)
		}
		if out == nil {
			out = map[string]any{}
		}
		if err != nil {
			code := ""
			var ae *apiErr
			if errors.As(err, &ae) {
				code = ae.code
			} else {
				log.Printf("ข้อผิดพลาด %s: %v", r.URL.Path, err)
			}
			out = map[string]any{"ok": false, "error": err.Error(), "code": code}
		} else {
			out["ok"] = true
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(out)
	}
}

func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(v); err != nil {
		return uerr("ข้อมูลที่ส่งมาไม่ถูกต้อง", "BAD")
	}
	return nil
}

func (s *Store) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	page := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b, _ := fs.ReadFile(sub, name)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(b)
		}
	}
	mux.HandleFunc("GET /{$}", page("index.html"))
	mux.HandleFunc("GET /kiosk", page("kiosk.html"))
	mux.HandleFunc("GET /admin", page("admin.html"))
	mux.Handle("GET /static/", http.StripPrefix("/static/", static))

	mux.HandleFunc("GET /api/ping", s.api(false, func(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
		return map[string]any{"app": "amacamp-attendance"}, nil
	}))
	mux.HandleFunc("GET /api/info", s.api(false, s.apiInfo))
	mux.HandleFunc("GET /api/employees", s.api(false, s.apiEmployees))
	mux.HandleFunc("POST /api/login", s.api(false, s.apiLogin))
	mux.HandleFunc("POST /api/punch", s.api(false, s.apiPunch))

	mux.HandleFunc("GET /api/admin/status", s.api(false, s.apiAdminStatus))
	mux.HandleFunc("POST /api/admin/setup", s.api(false, s.apiAdminSetup))
	mux.HandleFunc("POST /api/admin/login", s.api(false, s.apiAdminLogin))
	mux.HandleFunc("POST /api/admin/logout", s.api(false, func(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
		http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1})
		return nil, nil
	}))
	mux.HandleFunc("GET /api/admin/board", s.api(true, s.apiBoard))
	mux.HandleFunc("GET /api/admin/feed", s.api(true, s.apiFeed))
	mux.HandleFunc("GET /api/admin/day", s.api(true, s.apiDay))
	mux.HandleFunc("GET /api/admin/employees", s.api(true, s.apiAdminEmployees))
	mux.HandleFunc("POST /api/admin/employees", s.api(true, s.apiSaveEmployees))
	mux.HandleFunc("POST /api/admin/device", s.api(true, s.apiDevice))
	mux.HandleFunc("GET /api/admin/summary", s.api(true, s.apiSummary))
	mux.HandleFunc("GET /api/admin/settings", s.api(true, s.apiGetSettings))
	mux.HandleFunc("POST /api/admin/settings", s.api(true, s.apiSaveSettings))
	mux.HandleFunc("POST /api/admin/startup", s.api(true, s.apiStartup))
	mux.HandleFunc("GET /api/admin/export.xlsx", s.withAdmin(s.exportXLSX))
	mux.HandleFunc("GET /api/admin/backup.zip", s.withAdmin(s.backupZip))
	mux.HandleFunc("GET /photo/", s.withAdmin(s.servePhoto))
	return mux
}

func (s *Store) withAdmin(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		ok := s.isAdmin(r)
		s.mu.Unlock()
		if !ok {
			http.Error(w, "กรุณาเข้าสู่ระบบเจ้าของร้าน", http.StatusUnauthorized)
			return
		}
		fn(w, r)
	}
}

// ── พนักงาน (มือถือ) ──

func (s *Store) apiInfo(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	return map[string]any{"shopName": s.set.ShopName, "requirePhoto": s.set.RequirePhoto}, nil
}

func (s *Store) apiEmployees(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	list := []map[string]string{}
	for _, e := range s.emps {
		if e.Active {
			list = append(list, map[string]string{"id": e.ID, "name": e.Name})
		}
	}
	return map[string]any{"employees": list}, nil
}

type punchIn struct {
	ID     string `json:"id"`
	PIN    string `json:"pin"`
	Type   string `json:"type"`
	Photo  string `json:"photo"`
	Thumb  string `json:"thumb"`
	Device *devIn `json:"device"`
	Kiosk  bool   `json:"kiosk"`
}

func (s *Store) apiLogin(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	var in punchIn
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if in.Kiosk && !s.isAdmin(r) {
		return nil, uerr("หน้าจอร้านยังไม่ได้เข้าสู่ระบบ", "ADMIN")
	}
	e, err := s.auth(in.ID, in.PIN)
	if err != nil {
		return nil, err
	}
	if !in.Kiosk {
		s.deviceCheck(e, in.Device, false)
	}
	out := map[string]any{"employee": map[string]string{"id": e.ID, "name": e.Name}, "last": nil}
	last := s.lastPunch(e.ID)
	if last != nil {
		out["last"] = map[string]string{"type": last.Type, "label": typeLabel[last.Type], "when": describeWhen(last.TS)}
	}
	out["suggested"] = s.suggest(last)
	return out, nil
}

func (s *Store) apiPunch(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	var in punchIn
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if in.Kiosk && !s.isAdmin(r) {
		return nil, uerr("หน้าจอร้านยังไม่ได้เข้าสู่ระบบ", "ADMIN")
	}
	e, err := s.auth(in.ID, in.PIN)
	if err != nil {
		return nil, err
	}
	if in.Type != "IN" && in.Type != "OUT" {
		return nil, uerr("กรุณาเลือก เข้างาน หรือ ออกงาน", "BAD")
	}
	if !in.Kiosk && s.set.RequirePhoto && in.Photo == "" {
		return nil, uerr("กรุณาถ่ายเซลฟี่ก่อนลงเวลา", "PHOTO")
	}
	now := nowFunc().In(ict)
	if last := s.lastPunch(e.ID); last != nil && last.Type == in.Type &&
		now.UnixMilli()-last.TS < int64(s.set.MinGapMinutes)*60000 {
		return nil, uerr("คุณลง"+typeLabel[in.Type]+"ไปแล้วเมื่อ "+hm(last.TS)+" น.", "DUP")
	}
	p := Punch{TS: now.UnixMilli(), ID: e.ID, Name: e.Name, Type: in.Type, Channel: "phone"}
	if in.Kiosk {
		p.Channel, p.DeviceName = "kiosk", "เครื่องของร้าน"
	} else {
		var flags []string
		p.DeviceID, p.DeviceName, flags = s.deviceCheck(e, in.Device, true)
		p.Flags = strings.Join(flags, " / ")
	}
	if in.Photo != "" {
		rel, err := s.savePhoto(in.Photo, e, in.Type, now)
		if err != nil {
			return nil, err
		}
		p.Photo = rel
	}
	if err := s.appendPunch(p); err != nil {
		return nil, fmt.Errorf("บันทึกไม่สำเร็จ: %w", err)
	}
	thumb := ""
	if len(in.Thumb) < 120000 && thumbRe.MatchString(in.Thumb) {
		thumb = in.Thumb
	}
	s.feed = append(s.feed, feedItem{TS: p.TS, Name: e.Name, Type: p.Type, Label: typeLabel[p.Type], Time: hm(p.TS), Kiosk: in.Kiosk, Thumb: thumb})
	if len(s.feed) > 15 {
		s.feed = s.feed[len(s.feed)-15:]
	}
	return map[string]any{"name": e.Name, "type": p.Type, "label": typeLabel[p.Type], "time": now.Format("15:04:05"), "date": thaiDateT(now)}, nil
}

// ── เจ้าของร้าน ──

func (s *Store) apiAdminStatus(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	return map[string]any{
		"needsSetup": s.set.AdminPIN == "", "loggedIn": s.isAdmin(r), "local": isLoopback(r),
		"shopName": s.set.ShopName,
	}, nil
}

func (s *Store) apiAdminSetup(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	if s.set.AdminPIN != "" {
		return nil, uerr("ตั้งรหัสไปแล้ว", "BAD")
	}
	if !isLoopback(r) {
		return nil, uerr("ตั้งรหัสครั้งแรกได้เฉพาะที่คอมเครื่องแม่", "BAD")
	}
	var in struct {
		PIN string `json:"pin"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if !pinRe.MatchString(in.PIN) {
		return nil, uerr("รหัสต้องเป็นตัวเลข 4–8 หลัก", "BAD")
	}
	s.set.AdminPIN = in.PIN
	if err := s.saveSettings(); err != nil {
		return nil, err
	}
	s.setAdminCookie(w)
	return nil, nil
}

func (s *Store) apiAdminLogin(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	var in struct {
		PIN string `json:"pin"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if err := s.checkFails("admin", 10); err != nil {
		return nil, err
	}
	if s.set.AdminPIN == "" || in.PIN != s.set.AdminPIN {
		s.addFail("admin")
		return nil, uerr("รหัสเจ้าของร้านไม่ถูกต้อง", "ADMIN")
	}
	delete(s.fails, "admin")
	s.setAdminCookie(w)
	return nil, nil
}

func (s *Store) apiBoard(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	now := nowMS()
	maxMs := int64(s.set.MaxShiftHours) * 3600000
	lastBy := map[string]Punch{}
	order := []string{}
	for _, p := range s.punches {
		if now-p.TS > 48*3600000 {
			continue
		}
		if _, ok := lastBy[p.ID]; !ok {
			order = append(order, p.ID)
		}
		lastBy[p.ID] = p
	}
	inside := []map[string]string{}
	for _, id := range order {
		p := lastBy[id]
		if p.Type == "IN" && now-p.TS < maxMs {
			inside = append(inside, map[string]string{"name": p.Name, "since": hm(p.TS)})
		}
	}
	recent := []map[string]string{}
	for i := len(s.punches) - 1; i >= 0 && len(recent) < 10; i-- {
		p := s.punches[i]
		recent = append(recent, map[string]string{"name": p.Name, "type": p.Type, "label": typeLabel[p.Type], "when": describeWhen(p.TS)})
	}
	return map[string]any{"inside": inside, "recent": recent, "employees": s.activeList(), "kioskPhoto": s.set.KioskPhoto, "shopName": s.set.ShopName, "now": now}, nil
}

func (s *Store) activeList() []map[string]string {
	list := []map[string]string{}
	for _, e := range s.emps {
		if e.Active {
			list = append(list, map[string]string{"id": e.ID, "name": e.Name})
		}
	}
	return list
}

func (s *Store) apiFeed(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	items := []feedItem{}
	for _, f := range s.feed {
		if f.TS > since {
			if !s.set.KioskPhoto {
				f.Thumb = ""
			}
			items = append(items, f)
		}
	}
	return map[string]any{"items": items, "now": nowMS()}, nil
}

func (s *Store) pendingDevices() []map[string]any {
	out := []map[string]any{}
	for _, d := range s.devs {
		if d.Status == "pending" {
			out = append(out, map[string]any{"empId": d.EmpID, "empName": d.EmpName, "deviceId": d.DeviceID, "deviceName": d.DeviceName, "firstSeen": describeWhen(d.FirstSeen), "note": d.Note})
		}
	}
	return out
}

func (s *Store) apiDay(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	d := r.URL.Query().Get("d")
	today := shiftDay(nowMS())
	if _, err := time.Parse("2006-01-02", d); err != nil {
		d = today
	}
	entries := []map[string]any{}
	for _, p := range s.punches {
		if shiftDay(p.TS) != d {
			continue
		}
		photo := ""
		if p.Photo != "" {
			photo = "/photo/" + p.Photo
		}
		entries = append(entries, map[string]any{
			"ts": p.TS, "name": p.Name, "id": p.ID, "type": p.Type, "label": typeLabel[p.Type],
			"time": tOf(p.TS).Format("15:04:05"), "kiosk": p.Channel == "kiosk", "deviceId": p.DeviceID,
			"deviceName": p.DeviceName, "flags": p.Flags, "photo": photo,
		})
	}
	t, _ := time.ParseInLocation("2006-01-02", d, ict)
	return map[string]any{"day": d, "label": thaiDateT(t), "today": today, "entries": entries, "pending": s.pendingDevices()}, nil
}

func (s *Store) apiDevice(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	var in struct {
		EmpID    string `json:"empId"`
		DeviceID string `json:"deviceId"`
		Decision string `json:"decision"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	for i := range s.devs {
		d := &s.devs[i]
		if d.EmpID == in.EmpID && d.DeviceID == in.DeviceID {
			d.Status = "no"
			if in.Decision == "OK" {
				d.Status = "ok"
			}
			d.Note = strings.TrimPrefix(d.Note+" · "+statusLabel[d.Status]+"โดยเจ้าของร้าน "+nowFunc().In(ict).Format("02/01 15:04"), " · ")
			return map[string]any{"pending": s.pendingDevices()}, s.saveDevices()
		}
	}
	return nil, uerr("ไม่พบรายการนี้ กรุณารีเฟรชหน้า", "BAD")
}

func (s *Store) apiAdminEmployees(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	return map[string]any{"employees": s.emps}, nil
}

func (s *Store) apiSaveEmployees(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	var in struct {
		Employees []Employee `json:"employees"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	clean := []Employee{}
	for i, e := range in.Employees {
		e.ID, e.Name, e.PIN = strings.TrimSpace(e.ID), strings.TrimSpace(e.Name), strings.TrimSpace(e.PIN)
		e.Start = strings.ReplaceAll(strings.TrimSpace(e.Start), ".", ":")
		if e.ID == "" && e.Name == "" && e.PIN == "" {
			continue
		}
		row := fmt.Sprintf("แถวที่ %d", i+1)
		if e.ID == "" || e.Name == "" {
			return nil, uerr(row+": ต้องมีรหัสและชื่อ", "BAD")
		}
		if seen[e.ID] {
			return nil, uerr(row+": รหัส "+e.ID+" ซ้ำกับแถวอื่น", "BAD")
		}
		seen[e.ID] = true
		if !pinRe.MatchString(e.PIN) {
			return nil, uerr(row+" ("+e.Name+"): PIN ต้องเป็นตัวเลข 4–8 หลัก", "BAD")
		}
		if e.Start != "" && minutesOf(e.Start) < 0 {
			return nil, uerr(row+" ("+e.Name+"): เวลาเริ่มงานต้องเป็นแบบ 16:00", "BAD")
		}
		if e.Rate < 0 {
			e.Rate = 0
		}
		clean = append(clean, e)
	}
	s.emps = clean
	return map[string]any{"employees": s.emps}, s.saveEmployees()
}

func (s *Store) apiGetSettings(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	return map[string]any{
		"shopName": s.set.ShopName, "requirePhoto": s.set.RequirePhoto, "kioskPhoto": s.set.KioskPhoto,
		"minGapMinutes": s.set.MinGapMinutes, "maxShiftHours": s.set.MaxShiftHours,
		"photoKeepDays": s.set.PhotoKeepDays, "backupKeepDays": s.set.BackupKeepDays,
		"addresses": lanURLs(s.set.Port), "dataDir": s.dir, "local": isLoopback(r),
		"startup": startupState(),
	}, nil
}

func (s *Store) apiSaveSettings(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	var in struct {
		ShopName      string `json:"shopName"`
		RequirePhoto  bool   `json:"requirePhoto"`
		KioskPhoto    bool   `json:"kioskPhoto"`
		MinGapMinutes int    `json:"minGapMinutes"`
		PhotoKeepDays int    `json:"photoKeepDays"`
		NewPIN        string `json:"newPin"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if name := strings.TrimSpace(in.ShopName); name != "" {
		s.set.ShopName = name
	}
	s.set.RequirePhoto, s.set.KioskPhoto = in.RequirePhoto, in.KioskPhoto
	s.set.MinGapMinutes = clamp(in.MinGapMinutes, 0, 120)
	s.set.PhotoKeepDays = clamp(in.PhotoKeepDays, 0, 3650)
	if in.NewPIN != "" {
		if !pinRe.MatchString(in.NewPIN) {
			return nil, uerr("รหัสเจ้าของร้านต้องเป็นตัวเลข 4–8 หลัก", "BAD")
		}
		s.set.AdminPIN = in.NewPIN
		s.setAdminCookie(w)
	}
	return nil, s.saveSettings()
}

func (s *Store) apiStartup(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if err := decode(r, &in); err != nil {
		return nil, err
	}
	if err := setStartup(in.Enabled); err != nil {
		return nil, uerr("ตั้งค่าไม่สำเร็จ: "+err.Error(), "BAD")
	}
	return map[string]any{"startup": startupState()}, nil
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func (s *Store) servePhoto(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/photo/")
	base := filepath.Clean(s.photoDir())
	full := filepath.Clean(filepath.Join(base, filepath.FromSlash(rel)))
	if !strings.HasPrefix(full, base+string(os.PathSeparator)) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, full)
}

// ───────────────────────── สรุปรายเดือน ─────────────────────────

type shiftRow struct {
	Date, ID, Name, In, Out, Note string
	Hours                         float64
	HasHours                      bool
	Late                          int
}

type totalRow struct {
	ID, Name                 string
	Days                     int
	Hours                    float64
	Late, LateCount, Missing int
	Rate, Pay                float64
}

func (s *Store) pairShifts() []shiftRow {
	maxMs := int64(s.set.MaxShiftHours) * 3600000
	byEmp := map[string][]Punch{}
	ids := []string{}
	for _, p := range s.punches {
		if _, ok := byEmp[p.ID]; !ok {
			ids = append(ids, p.ID)
		}
		byEmp[p.ID] = append(byEmp[p.ID], p)
	}
	rows := []shiftRow{}
	push := func(in, out *Punch) {
		base := in
		if base == nil {
			base = out
		}
		r := shiftRow{ID: base.ID, Name: base.Name}
		if in != nil {
			r.Date, r.In = dayOf(in.TS), hm(in.TS)
			if e := s.emp(in.ID); e != nil && minutesOf(e.Start) >= 0 {
				diff := minutesOf(r.In) - minutesOf(e.Start)
				if diff > 720 {
					diff -= 1440
				}
				if diff < -720 {
					diff += 1440
				}
				if diff > 0 {
					r.Late = diff
				}
			}
		} else {
			r.Date = shiftDay(out.TS)
		}
		if out != nil {
			r.Out = hm(out.TS)
		}
		if in != nil && out != nil {
			r.Hours = math.Round(float64(out.TS-in.TS)/36000) / 100
			r.HasHours = true
		}
		switch {
		case in == nil:
			r.Note = "ลืมลงเวลาเข้า"
		case out == nil && nowMS()-in.TS < maxMs:
			r.Note = "ยังทำงานอยู่"
		case out == nil:
			r.Note = "ลืมลงเวลาออก"
		}
		rows = append(rows, r)
	}
	for _, id := range ids {
		var pending *Punch
		for i := range byEmp[id] {
			p := &byEmp[id][i]
			if p.Type == "IN" {
				if pending != nil {
					push(pending, nil)
				}
				pending = p
			} else if pending != nil && p.TS-pending.TS <= maxMs {
				push(pending, p)
				pending = nil
			} else {
				if pending != nil {
					push(pending, nil)
				}
				pending = nil
				push(nil, p)
			}
		}
		if pending != nil {
			push(pending, nil)
		}
	}
	sort.SliceStable(rows, func(a, b int) bool {
		if rows[a].Date != rows[b].Date {
			return rows[a].Date < rows[b].Date
		}
		return rows[a].In < rows[b].In
	})
	return rows
}

func (s *Store) summary(month string) ([]totalRow, []shiftRow, []Punch) {
	rows := []shiftRow{}
	for _, r := range s.pairShifts() {
		if strings.HasPrefix(r.Date, month) {
			rows = append(rows, r)
		}
	}
	totals := map[string]*totalRow{}
	days := map[string]map[string]bool{}
	for _, r := range rows {
		t := totals[r.ID]
		if t == nil {
			t = &totalRow{ID: r.ID, Name: r.Name}
			totals[r.ID] = t
			days[r.ID] = map[string]bool{}
		}
		if r.In != "" {
			days[r.ID][r.Date] = true
		}
		t.Hours += r.Hours
		if r.Late > 0 {
			t.Late += r.Late
			t.LateCount++
		}
		if r.Note == "ลืมลงเวลาออก" || r.Note == "ลืมลงเวลาเข้า" {
			t.Missing++
		}
	}
	out := []totalRow{}
	for id, t := range totals {
		t.Days = len(days[id])
		t.Hours = math.Round(t.Hours*100) / 100
		if e := s.emp(id); e != nil {
			t.Name, t.Rate = e.Name, e.Rate
		}
		t.Pay = float64(t.Days) * t.Rate
		out = append(out, *t)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	flagged := []Punch{}
	for _, p := range s.punches {
		if p.Flags != "" && strings.HasPrefix(shiftDay(p.TS), month) {
			flagged = append(flagged, p)
		}
	}
	return out, rows, flagged
}

func monthParam(r *http.Request) string {
	m := r.URL.Query().Get("m")
	if _, err := time.Parse("2006-01", m); err != nil {
		return shiftDay(nowMS())[:7]
	}
	return m
}

func (s *Store) apiSummary(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	month := monthParam(r)
	totals, rows, flagged := s.summary(month)
	t, _ := time.ParseInLocation("2006-01", month, ict)
	fl := []map[string]string{}
	for _, p := range flagged {
		fl = append(fl, map[string]string{"date": shiftDay(p.TS), "time": hm(p.TS), "name": p.Name, "label": typeLabel[p.Type], "deviceId": p.DeviceID, "flags": p.Flags})
	}
	totalPay := 0.0
	for _, t := range totals {
		totalPay += t.Pay
	}
	return map[string]any{
		"month": month, "label": thaiMonths[t.Month()-1] + " " + strconv.Itoa(t.Year()+543),
		"totals": totals, "rows": rows, "flagged": fl, "totalPay": totalPay,
	}, nil
}

// ───────────────────────── สำรองข้อมูล / ดูแลประจำวัน ─────────────────────────

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// สำรองไฟล์ข้อมูลวันละครั้ง (หลัง 06:00) เก็บ BackupKeepDays วัน + ลบรูปเก่ากว่า PhotoKeepDays
func (s *Store) maintenance() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := nowFunc().In(ict)
	today := now.Format("2006-01-02")
	if s.lastMain == today || now.Hour() < 6 {
		return
	}
	dst := filepath.Join(s.backupDir(), today)
	if _, err := os.Stat(dst); errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(dst, 0o755); err == nil {
			for _, f := range []string{"settings.json", "employees.json", "devices.json", "punches.jsonl"} {
				if _, err := os.Stat(s.path(f)); err == nil {
					if err := copyFile(s.path(f), filepath.Join(dst, f)); err != nil {
						log.Printf("สำรอง %s ไม่สำเร็จ: %v", f, err)
					}
				}
			}
		}
	}
	cutoff := now.AddDate(0, 0, -s.set.BackupKeepDays).Format("2006-01-02")
	if entries, err := os.ReadDir(s.backupDir()); err == nil {
		for _, e := range entries {
			if e.IsDir() && len(e.Name()) == 10 && e.Name() < cutoff && !strings.HasSuffix(e.Name(), "-01") {
				_ = os.RemoveAll(filepath.Join(s.backupDir(), e.Name()))
			}
		}
	}
	if s.set.PhotoKeepDays > 0 {
		old := now.AddDate(0, 0, -s.set.PhotoKeepDays)
		_ = filepath.WalkDir(s.photoDir(), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if info, err := d.Info(); err == nil && info.ModTime().Before(old) {
				_ = os.Remove(p)
			}
			return nil
		})
	}
	s.lastMain = today
}

func (s *Store) backupZip(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range []string{"settings.json", "employees.json", "devices.json", "punches.jsonl"} {
		b, err := os.ReadFile(s.path(f))
		if err != nil {
			continue
		}
		fw, _ := zw.Create(f)
		_, _ = fw.Write(b)
	}
	if r.URL.Query().Get("photos") == "1" {
		_ = filepath.WalkDir(s.photoDir(), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(s.dir, p)
			b, err := os.ReadFile(p)
			if err == nil {
				fw, _ := zw.Create(filepath.ToSlash(rel))
				_, _ = fw.Write(b)
			}
			return nil
		})
	}
	_ = zw.Close()
	name := "amacamp-backup-" + nowFunc().In(ict).Format("2006-01-02") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	_, _ = w.Write(buf.Bytes())
}

// ───────────────────────── เครือข่าย / เริ่มโปรแกรม ─────────────────────────

// ที่อยู่ในวง Wi-Fi ของร้าน (ข้ามการ์ดเครือข่ายเสมือน) — อันแรกคืออันที่น่าจะใช่ที่สุด
func lanURLs(port int) []string {
	type cand struct {
		url   string
		score int
	}
	cands := []cand{}
	ifaces, _ := net.Interfaces()
	skip := regexp.MustCompile(`(?i)virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth|tailscale|zerotier|tap|tun`)
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || skip.MatchString(ifc.Name) {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			score := 1
			if ip[0] == 192 && ip[1] == 168 {
				score = 3
			} else if ip[0] == 10 {
				score = 2
			}
			if regexp.MustCompile(`(?i)wi-?fi|wlan|wireless`).MatchString(ifc.Name) {
				score += 2
			}
			cands = append(cands, cand{fmt.Sprintf("http://%s:%d/", ip.String(), port), score})
		}
	}
	sort.SliceStable(cands, func(a, b int) bool { return cands[a].score > cands[b].score })
	out := []string{}
	// กำหนดที่อยู่เองได้ ถ้าโปรแกรมเลือกการ์ดเครือข่ายผิด: ตั้งตัวแปร AMACAMP_URL=http://192.168.1.50:8080/
	if v := strings.TrimSpace(os.Getenv("AMACAMP_URL")); v != "" {
		out = append(out, v)
	}
	for _, c := range cands {
		if !contains(out, c.url) {
			out = append(out, c.url)
		}
	}
	return out
}

func openBrowser(url string) {
	if os.Getenv("AMACAMP_NO_BROWSER") != "" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func alreadyRunning(port int) bool {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/ping", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return bytes.Contains(b, []byte("amacamp-attendance"))
}

func pause() {
	if runtime.GOOS == "windows" && os.Getenv("AMACAMP_NO_BROWSER") == "" {
		fmt.Println("\nกด Enter เพื่อปิดหน้าต่าง (Press Enter to close)")
		_, _ = fmt.Scanln()
	}
}

func main() {
	enableUTF8Console()
	exe, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	dir := filepath.Join(filepath.Dir(exe), "ข้อมูลลงเวลา")
	if v := os.Getenv("AMACAMP_DATA"); v != "" {
		dir = v
	}
	s, err := openStore(dir)
	if err != nil {
		fmt.Println("เปิดข้อมูลไม่สำเร็จ:", err)
		pause()
		os.Exit(1)
	}
	port := s.set.Port
	if v, err := strconv.Atoi(os.Getenv("AMACAMP_PORT")); err == nil {
		port = v
	}

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		if alreadyRunning(port) {
			fmt.Println("โปรแกรมเปิดอยู่แล้ว กำลังเปิดหน้าจอให้... (already running)")
			openBrowser(fmt.Sprintf("http://localhost:%d/kiosk", port))
			time.Sleep(2 * time.Second)
			return
		}
		for p := 8081; p <= 8099 && err != nil; p++ {
			ln, err = net.Listen("tcp", fmt.Sprintf(":%d", p))
			if err == nil {
				port = p
			}
		}
		if err != nil {
			fmt.Println("เปิดพอร์ตไม่ได้:", err)
			pause()
			os.Exit(1)
		}
		s.mu.Lock()
		s.set.Port = port
		_ = s.saveSettings()
		s.mu.Unlock()
	}

	keepAwake()
	go func() {
		for {
			s.maintenance()
			time.Sleep(20 * time.Minute)
		}
	}()

	urls := lanURLs(port)
	phone := "(ไม่พบ Wi-Fi — ต่อ Wi-Fi ร้านก่อน)"
	if len(urls) > 0 {
		phone = urls[0]
	}
	fmt.Println("==============================================")
	fmt.Println("  " + appTitle)
	fmt.Println("==============================================")
	fmt.Println("โปรแกรมทำงานแล้ว — ห้ามปิดหน้าต่างนี้ (ย่อเก็บได้)")
	fmt.Println("Running. Do NOT close this window (minimize is OK).")
	fmt.Println()
	fmt.Printf("หน้าจอร้าน (Shop screen):  http://localhost:%d/kiosk\n", port)
	fmt.Printf("เจ้าของร้าน (Owner):        http://localhost:%d/admin\n", port)
	fmt.Printf("มือถือพนักงาน (Staff):      %s\n", phone)
	fmt.Printf("ข้อมูลเก็บที่ (Data):       %s\n", dir)
	fmt.Println()

	s.mu.Lock()
	first := s.set.AdminPIN == "" || len(s.emps) == 0
	s.mu.Unlock()
	if first {
		openBrowser(fmt.Sprintf("http://localhost:%d/admin", port))
	} else {
		openBrowser(fmt.Sprintf("http://localhost:%d/kiosk", port))
	}

	srv := &http.Server{Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}
	if err := srv.Serve(ln); err != nil {
		fmt.Println("เซิร์ฟเวอร์หยุดทำงาน:", err)
		pause()
	}
}
