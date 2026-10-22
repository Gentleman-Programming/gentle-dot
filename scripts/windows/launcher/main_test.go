package main

import (
	"path/filepath"
	"testing"
)

func TestRuntimePathsFollowLauncherLocation(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "runtime Ω &", "bin", "pi.exe")
	engineEntry = "@earendil-works/pi-coding-agent/dist/bundle/cli.js"

	node, engine := runtimePaths(executable)
	runtime := filepath.Dir(filepath.Dir(executable))
	if want := filepath.Join(runtime, "node", "node.exe"); node != want {
		t.Errorf("node path = %q, want %q", node, want)
	}
	if want := filepath.Join(runtime, "daemon", "node_modules", filepath.FromSlash(engineEntry)); engine != want {
		t.Errorf("engine path = %q, want %q", engine, want)
	}
}
