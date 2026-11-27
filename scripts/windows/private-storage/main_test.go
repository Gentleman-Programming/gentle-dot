//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

// Run the public helper command without starting the application or using its profile.
func TestProviderFixtureHelper(t *testing.T) {
	if len(os.Args) != 5 || os.Args[2] != "--" {
		return
	}
	os.Args = os.Args[2:]
	main()
	os.Exit(0)
}

func TestProviderCreateIfAbsent(t *testing.T) {
	root, err := os.MkdirTemp("", "dot-provider-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("retained synthetic fixture: %s", root)
	directory := filepath.Join(root, "private")
	if err := ensurePrivateDir(directory); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "fixture.json")
	command := func(operation, path string) *exec.Cmd {
		return exec.Command(os.Args[0], "-test.run=^TestProviderFixtureHelper$", "--", operation, path)
	}
	run := func(t *testing.T, operation, path string) {
		t.Helper()
		if out, err := command(operation, path).CombinedOutput(); err != nil || len(out) != 0 {
			t.Fatalf("%s: %v, output %q", operation, err, out)
		}
	}
	read := func(t *testing.T, want string) {
		t.Helper()
		if content, err := os.ReadFile(path); err != nil || string(content) != want {
			t.Fatalf("fixture = %q, %v; want %q", content, err, want)
		}
	}
	const operation = "create-file-if-absent"
	const synthetic = `{"example":"synthetic value"}`
	t.Run("first creation", func(t *testing.T) {
		run(t, operation, path)
		read(t, "{}")
		file, _, err := openPath(path, false, readControl|fileReadAttributes)
		if err != nil {
			t.Fatal(err)
		}
		defer syscall.CloseHandle(file)
		if err := verifyOwner(file); err != nil {
			t.Fatal(err)
		}
		if err := verifyACL(file, false); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("preserve existing and legacy operations", func(t *testing.T) {
		writer := command("write-file", path)
		writer.Stdin = strings.NewReader(synthetic)
		if out, err := writer.CombinedOutput(); err != nil || len(out) != 0 {
			t.Fatalf("write-file: %v, output %q", err, out)
		}
		run(t, "secure-file", path)
		run(t, operation, path)
		read(t, synthetic)
	})
	t.Run("hard link refusal", func(t *testing.T) {
		if err := os.Link(path, filepath.Join(directory, "alias.json")); err != nil {
			t.Fatal(err)
		}
		if out, err := command(operation, path).CombinedOutput(); err == nil || commandExitCode(err) != 1 || string(out) != "private storage operation failed: hard-linked files are not accepted for private storage\n" {
			t.Fatalf("hard-link refusal: %v, output %q", err, out)
		}
		read(t, synthetic)
	})
	t.Run("concurrent initializers", func(t *testing.T) {
		path := filepath.Join(directory, "race.json")
		for range 8 {
			t.Run("create", func(t *testing.T) {
				t.Parallel()
				run(t, operation, path)
				// The peer may still be closing its publishing handle. Observe bytes after all peers exit.
			})
		}
		t.Cleanup(func() {
			content, err := os.ReadFile(path)
			if err != nil || string(content) != "{}" {
				t.Errorf("race fixture = %q, %v; want {}", content, err)
			}
			entries, err := os.ReadDir(directory)
			if err != nil || len(entries) != 3 {
				t.Errorf("expected only fixture, alias and race winner: %v, %v", entries, err)
			}
		})
	})
}

func TestProviderAncestryPinsDirectoryNames(t *testing.T) {
	root, err := os.MkdirTemp("", "dot-provider-ancestry-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("retained synthetic fixture: %s", root)
	ancestor := filepath.Join(root, "ancestor")
	parent := filepath.Join(ancestor, "private")
	if err := ensurePrivateDir(parent); err != nil {
		t.Fatal(err)
	}
	alternate := ancestor + "-renamed"
	renameRoundTrip := func() {
		t.Helper()
		if err := os.Rename(ancestor, alternate); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(alternate, ancestor); err != nil {
			t.Fatal(err)
		}
	}
	renameRoundTrip()
	var renameErr, deleteOpenErr error
	if err := withProviderParent(filepath.Join(parent, "fixture.json"), func(_, _ string) error {
		name, err := wide(ancestor)
		if err != nil {
			return err
		}
		handle, err := syscall.CreateFile(name, deleteAccess, fileShareRead|fileShareWrite|fileShareDelete, nil, openExisting, fileFlagBackupSemantics|fileFlagOpenReparsePoint, 0)
		deleteOpenErr = err
		if err == nil {
			_ = syscall.CloseHandle(handle)
		}
		renameErr = os.Rename(ancestor, alternate)
		if renameErr == nil {
			return os.Rename(alternate, ancestor)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if renameErr == nil {
		t.Error("renaming a guarded ancestor succeeded")
	}
	if !errors.Is(deleteOpenErr, syscall.Errno(32)) { // ERROR_SHARING_VIOLATION
		t.Errorf("opening a guarded ancestor for DELETE: got %v, want sharing violation", deleteOpenErr)
	}
	renameRoundTrip()
}

func TestProviderRefusesReparseAncestor(t *testing.T) {
	root, err := os.MkdirTemp("", "dot-provider-reparse-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("retained synthetic fixture: %s", root)
	directory := filepath.Join(root, "private")
	if err := ensurePrivateDir(directory); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(directory, link); err != nil {
		if errors.Is(err, syscall.Errno(1314)) { // ERROR_PRIVILEGE_NOT_HELD
			t.Skipf("ordinary test token cannot create a symlink: %v", err)
		}
		t.Fatal(err)
	}
	if err := createPrivateFileIfAbsent(filepath.Join(link, "fixture.json")); err == nil || err.Error() != "reparse points are not accepted for private storage" {
		t.Fatalf("reparse ancestor refusal: %v", err)
	}
	if entries, err := os.ReadDir(directory); err != nil || len(entries) != 0 {
		t.Fatalf("reparse target changed: %v, %v", entries, err)
	}
}

func commandExitCode(err error) int {
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.ExitCode()
	}
	return -1
}

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

func TestACLRejectionReportsActualAndExpectedDACL(t *testing.T) {
	root := t.TempDir()
	handle, _, err := openPath(root, true, readControl|writeDAC|fileReadAttributes)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(handle)

	unsafeSDDL, err := syscall.UTF16PtrFromString("D:P(A;OICI;FA;;;WD)(A;OICI;FA;;;SY)")
	if err != nil {
		t.Fatal(err)
	}
	var unsafeSD uintptr
	var size uint32
	ok, _, callErr := procConvertSDDL.Call(uintptr(unsafe.Pointer(unsafeSDDL)), securityDescriptorRevision, uintptr(unsafe.Pointer(&unsafeSD)), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		t.Fatal(callError(callErr))
	}
	defer procLocalFree.Call(unsafeSD)
	var present, defaulted int32
	var dacl uintptr
	getDACL := advapi32.NewProc("GetSecurityDescriptorDacl")
	ok, _, callErr = getDACL.Call(unsafeSD, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || present == 0 || dacl == 0 {
		t.Fatal(callError(callErr))
	}
	status, _, _ := procSetSecurityInfo.Call(uintptr(handle), seFileObject, daclSecurityInformation|protectedDACLInformation, 0, 0, dacl, 0)
	if status != 0 {
		t.Fatal(syscall.Errno(status))
	}

	err = verifyACL(handle, true)
	if err == nil {
		t.Fatal("unsafe DACL was accepted")
	}
	if !strings.Contains(err.Error(), "WD") || !strings.Contains(err.Error(), "SY") {
		t.Fatalf("ACL rejection omitted actual and expected DACLs: %v", err)
	}
}

func TestLocalAdministratorAliasMatchesItsNumericSID(t *testing.T) {
	text, err := syscall.UTF16PtrFromString("O:LA D:P(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)")
	if err != nil {
		t.Fatal(err)
	}
	var descriptor uintptr
	var size uint32
	ok, _, callErr := procConvertSDDL.Call(uintptr(unsafe.Pointer(text)), securityDescriptorRevision, uintptr(unsafe.Pointer(&descriptor)), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		t.Fatal(callError(callErr))
	}
	defer procLocalFree.Call(descriptor)
	var owner uintptr
	var defaulted int32
	getOwner := advapi32.NewProc("GetSecurityDescriptorOwner")
	ok, _, callErr = getOwner.Call(descriptor, uintptr(unsafe.Pointer(&owner)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || owner == 0 {
		t.Fatal(callError(callErr))
	}
	adminSID, err := sidString((*syscall.SID)(unsafe.Pointer(owner)))
	if err != nil {
		t.Fatal(err)
	}
	actualSDDL, err := descriptorString(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	index := strings.Index(actualSDDL, "D:")
	if index < 0 || !strings.Contains(actualSDDL[index:], "LA") {
		t.Fatalf("Windows did not preserve the local Administrator SDDL alias: %q", actualSDDL)
	}
	expected := "D:P(A;OICI;FA;;;" + adminSID + ")(A;OICI;FA;;;SY)"
	if err := compareDACLs(actualSDDL[index:], expected); err != nil {
		t.Fatalf("equivalent local Administrator SID was rejected: %v", err)
	}
	for _, bad := range []struct {
		name string
		dacl string
	}{
		{name: "Everyone ACE", dacl: "D:P(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)"},
		{name: "wrong SID", dacl: "D:P(A;OICI;FA;;;BU)(A;OICI;FA;;;SY)"},
		{name: "wrong mask", dacl: "D:P(A;OICI;FR;;;LA)(A;OICI;FA;;;SY)"},
		{name: "wrong inheritance", dacl: "D:P(A;OI;FA;;;LA)(A;OICI;FA;;;SY)"},
	} {
		t.Run(bad.name, func(t *testing.T) {
			if err := compareDACLs(bad.dacl, expected); err == nil {
				t.Fatalf("accepted invalid DACL %q", bad.dacl)
			}
		})
	}
}
