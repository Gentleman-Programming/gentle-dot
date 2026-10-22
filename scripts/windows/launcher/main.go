package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// engineEntry is set from the installed engine package's bin.pi entry at build time.
var engineEntry string

func runtimePaths(executable string) (node, engine string) {
	runtime := filepath.Dir(filepath.Dir(executable))
	return filepath.Join(runtime, "node", "node.exe"),
		filepath.Join(runtime, "daemon", "node_modules", filepath.FromSlash(engineEntry))
}

func run() int {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "pi launcher: resolve executable path: %v\n", err)
		return 1
	}
	node, engine := runtimePaths(executable)
	args := append([]string{engine}, os.Args[1:]...)
	child := exec.Command(node, args...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "pi launcher: start runtime Node: %v\n", err)
		return 1
	}
	return 0
}

func main() {
	os.Exit(run())
}
