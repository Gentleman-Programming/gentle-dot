//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestPrivateDirectoryAndAtomicFileOperations(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "private", "nested")
	if err := ensurePrivateDir(directory); err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateDir(directory); err != nil {
		t.Fatalf("re-securing an owned private directory: %v", err)
	}
	parent, _, err := openPath(directory, true, readControl|fileReadAttributes)
	if err != nil {
		t.Fatal(err)
	}
	if err = verifyOwner(parent); err == nil {
		err = verifyACL(parent, true)
	}
	_ = syscall.CloseHandle(parent)
	if err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(directory, "secret.json")
	for _, value := range [][]byte{[]byte("first private value\n"), []byte("replacement Ω\n")} {
		if err := writePrivateFile(path, value); err != nil {
			t.Fatal(err)
		}
		actual, err := os.ReadFile(path)
		if err != nil || string(actual) != string(value) {
			t.Fatalf("private atomic write got %q, err %v", actual, err)
		}
	}
	if err := secureExistingFile(path); err != nil {
		t.Fatal(err)
	}
	file, _, err := openPath(path, false, readControl|fileReadAttributes)
	if err != nil {
		t.Fatal(err)
	}
	if err = verifyOwner(file); err == nil {
		err = verifyACL(file, false)
	}
	_ = syscall.CloseHandle(file)
	if err != nil {
		t.Fatal(err)
	}
}

func TestPrivateDirectoryRejectsRootsAndRelativePaths(t *testing.T) {
	root := filepath.VolumeName(t.TempDir()) + string(filepath.Separator)
	if _, err := absolutePath(root); err == nil {
		t.Fatal("drive root was accepted as private data")
	}
	if _, err := absolutePath("relative"); err == nil {
		t.Fatal("relative path was accepted as private data")
	}
}
