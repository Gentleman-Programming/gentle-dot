//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
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

func TestOwnerMismatchDiagnosticIncludesBothPrincipals(t *testing.T) {
	ownerSID := "S-1-5-32-544"
	userSID := "S-1-5-21-1328270225-4188850109-826311960-1001"
	err := ownerMismatch(ownerSID, userSID)
	if err == nil {
		t.Fatal("expected an owner mismatch diagnostic")
	}
	want := "private-storage object owner SID " + ownerSID + " does not match current Windows user SID " + userSID
	if err.Error() != want {
		t.Fatalf("owner mismatch diagnostic = %q, want %q", err, want)
	}
}

func TestPrivateDescriptorsSetCurrentUserAsOwner(t *testing.T) {
	user, err := currentSID()
	if err != nil {
		t.Fatal(err)
	}
	userText, err := sidString(user)
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []bool{true, false} {
		name := "file"
		if directory {
			name = "directory"
		}
		t.Run(name, func(t *testing.T) {
			sd, err := descriptor(directory)
			if err != nil {
				t.Fatal(err)
			}
			defer procLocalFree.Call(sd)
			sddl, err := descriptorString(sd)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(sddl, "O:"+userText+"D:") {
				t.Fatalf("private %s descriptor owner is not the current user: %s", name, sddl)
			}
		})
	}
}
