package main

import (
	"fmt"
	"net/http"

	"github.com/xuri/excelize/v2"
)

// ส่งออกสรุปรายเดือนเป็นไฟล์ Excel (.xlsx)
func (s *Store) exportXLSX(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	month := monthParam(r)
	totals, rows, flagged := s.summary(month)
	all := []Punch{}
	for _, p := range s.punches {
		if len(shiftDay(p.TS)) >= 7 && shiftDay(p.TS)[:7] == month {
			all = append(all, p)
		}
	}
	shop := s.set.ShopName
	s.mu.Unlock()

	f := excelize.NewFile()
	defer f.Close()
	head, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}, Fill: excelize.Fill{Type: "pattern", Color: []string{"EFEAE0"}, Pattern: 1}})
	warn, _ := f.NewStyle(&excelize.Style{Font: &excelize.Font{Color: "B3261E"}})
	money, _ := f.NewStyle(&excelize.Style{NumFmt: 4})

	write := func(sheet string, header []string, data [][]any, widths []float64) {
		_ = f.SetSheetRow(sheet, "A1", &header)
		end, _ := excelize.CoordinatesToCellName(len(header), 1)
		_ = f.SetCellStyle(sheet, "A1", end, head)
		for i, row := range data {
			cell, _ := excelize.CoordinatesToCellName(1, i+2)
			r := row
			_ = f.SetSheetRow(sheet, cell, &r)
		}
		for i, wd := range widths {
			col, _ := excelize.ColumnNumberToName(i + 1)
			_ = f.SetColWidth(sheet, col, col, wd)
		}
		_ = f.SetPanes(sheet, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"})
	}

	const s1 = "สรุปเงินเดือน"
	_ = f.SetSheetName("Sheet1", s1)
	data := [][]any{}
	sum := 0.0
	for _, t := range totals {
		data = append(data, []any{t.ID, t.Name, t.Days, t.Hours, t.LateCount, t.Late, t.Missing, t.Rate, t.Pay})
		sum += t.Pay
	}
	data = append(data, []any{"", "รวม", "", "", "", "", "", "", sum})
	write(s1, []string{"รหัส", "ชื่อ", "วันที่มาทำงาน", "ชั่วโมงรวม", "มาสาย (ครั้ง)", "มาสายรวม (นาที)", "ลงเวลาไม่ครบ (ครั้ง)", "ค่าแรง/วัน", "ค่าแรงรวม"},
		data, []float64{8, 16, 14, 12, 13, 16, 18, 12, 14})
	_ = f.SetCellStyle(s1, "H2", fmt.Sprintf("I%d", len(data)+1), money)

	const s2 = "รายละเอียดรายวัน"
	_, _ = f.NewSheet(s2)
	data = [][]any{}
	for _, r := range rows {
		var h any = ""
		if r.HasHours {
			h = r.Hours
		}
		data = append(data, []any{r.Date, r.ID, r.Name, r.In, r.Out, h, r.Late, r.Note})
	}
	write(s2, []string{"วันที่", "รหัส", "ชื่อ", "เข้างาน", "ออกงาน", "ชั่วโมง", "สาย (นาที)", "หมายเหตุ"}, data, []float64{12, 8, 16, 10, 10, 10, 11, 16})

	const s3 = "รายการน่าสงสัย"
	_, _ = f.NewSheet(s3)
	data = [][]any{}
	for _, p := range flagged {
		data = append(data, []any{shiftDay(p.TS), hm(p.TS), p.ID, p.Name, typeLabel[p.Type], p.DeviceID, p.Flags})
	}
	write(s3, []string{"วันที่", "เวลา", "รหัส", "ชื่อ", "ประเภท", "รหัสเครื่อง", "เรื่อง"}, data, []float64{12, 8, 8, 16, 10, 13, 44})
	if len(data) > 0 {
		_ = f.SetCellStyle(s3, "G2", fmt.Sprintf("G%d", len(data)+1), warn)
	}

	const s4 = "บันทึกทั้งหมด"
	_, _ = f.NewSheet(s4)
	data = [][]any{}
	for _, p := range all {
		ch := "มือถือพนักงาน"
		if p.Channel == "kiosk" {
			ch = "เครื่องของร้าน"
		}
		data = append(data, []any{tOf(p.TS).Format("2006-01-02"), tOf(p.TS).Format("15:04:05"), p.ID, p.Name, typeLabel[p.Type], ch, p.DeviceID, p.DeviceName, p.Photo, p.Flags})
	}
	write(s4, []string{"วันที่", "เวลา", "รหัส", "ชื่อ", "ประเภท", "ช่องทาง", "รหัสเครื่อง", "อุปกรณ์", "ไฟล์รูป (ในโฟลเดอร์ รูป)", "ตรวจสอบ"},
		data, []float64{12, 10, 8, 16, 10, 14, 13, 24, 40, 36})

	name := fmt.Sprintf("amacamp-%s.xlsx", month)
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	_ = shop
	if err := f.Write(w); err != nil {
		http.Error(w, err.Error(), 500)
	}
}
