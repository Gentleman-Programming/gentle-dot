//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"
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
