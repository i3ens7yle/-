//go:build !windows

package main

import "errors"

func enableUTF8Console() {}
func keepAwake()         {}

func startupState() map[string]any { return map[string]any{"supported": false, "enabled": false} }

func setStartup(on bool) error { return errors.New("ใช้ได้เฉพาะ Windows") }
