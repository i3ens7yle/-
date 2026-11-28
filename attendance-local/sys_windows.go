//go:build windows

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")

// ให้หน้าต่างดำแสดงภาษาไทยได้ + ตั้งชื่อหน้าต่าง
func enableUTF8Console() {
	_, _, _ = kernel32.NewProc("SetConsoleOutputCP").Call(65001)
	if t, err := syscall.UTF16PtrFromString(appTitle + " — ห้ามปิดหน้าต่างนี้"); err == nil {
		_, _, _ = kernel32.NewProc("SetConsoleTitleW").Call(uintptr(unsafe.Pointer(t)))
	}
}

// กันคอมเข้าโหมด Sleep ระหว่างที่โปรแกรมเปิดอยู่ (จอดับได้ แต่เครื่องยังรับการลงเวลา)
func keepAwake() {
	go func() {
		runtime.LockOSThread()
		const esContinuous, esSystemRequired = 0x80000000, 0x00000001
		_, _, _ = kernel32.NewProc("SetThreadExecutionState").Call(uintptr(esContinuous | esSystemRequired))
		select {}
	}()
}

func startupFile() string {
	return filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs\Startup`, "AmaCampTime.bat")
}

func startupState() map[string]any {
	_, err := os.Stat(startupFile())
	return map[string]any{"supported": true, "enabled": err == nil}
}

// เปิดโปรแกรมอัตโนมัติเมื่อเปิดคอม (วางไฟล์ .bat ในโฟลเดอร์ Startup ของ Windows)
func setStartup(on bool) error {
	f := startupFile()
	if !on {
		if err := os.Remove(f); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	bat := "@echo off\r\nchcp 65001 >nul\r\ncd /d \"" + filepath.Dir(exe) + "\"\r\nstart \"\" \"" + exe + "\"\r\n"
	return os.WriteFile(f, []byte(bat), 0o644)
}
