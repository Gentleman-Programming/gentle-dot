//go:build windows

// private-storage provides only the daemon's private-directory and atomic private-file
// operations. It is bundled with the Windows runtime; it is not a general ACL utility.
package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	readControl                = 0x00020000
	writeDAC                   = 0x00040000
	fileReadAttributes         = 0x00000080
	fileShareRead              = 0x00000001
	fileShareWrite             = 0x00000002
	fileShareDelete            = 0x00000004
	createNew                  = 1
	openExisting               = 3
	fileFlagOpenReparsePoint   = 0x00200000
	fileFlagBackupSemantics    = 0x02000000
	fileAttributeReparsePoint  = 0x00000400
	fileAttributeDirectory     = 0x00000010
	driveUnknown               = 0
	driveNoRoot                = 1
	driveRemote                = 4
	seFileObject               = 1
	ownerSecurityInformation   = 0x00000001
	daclSecurityInformation    = 0x00000004
	protectedDACLInformation   = 0x80000000
	securityDescriptorRevision = 1
	tokenQuery                 = 0x0008
	tokenUserInformation       = 1
	moveFileReplaceExisting    = 0x00000001
	moveFileWriteThrough       = 0x00000008
	seDACLProtected            = 0x1000
	fileAttributeNormal        = 0x00000080
)

var (
	advapi32                         = syscall.NewLazyDLL("advapi32.dll")
	kernel32                         = syscall.NewLazyDLL("kernel32.dll")
	procConvertSDDL                  = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	procConvertSDToSDDL              = advapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
	procGetSecurityInfo              = advapi32.NewProc("GetSecurityInfo")
	procSetSecurityInfo              = advapi32.NewProc("SetSecurityInfo")
	procGetSecurityDescriptorControl = advapi32.NewProc("GetSecurityDescriptorControl")
	procEqualSid                     = advapi32.NewProc("EqualSid")
	procLocalFree                    = kernel32.NewProc("LocalFree")
	procGetFileInformation           = kernel32.NewProc("GetFileInformationByHandle")
	procMoveFileEx                   = kernel32.NewProc("MoveFileExW")
	procDeleteFile                   = kernel32.NewProc("DeleteFileW")
	procGetDriveType                 = kernel32.NewProc("GetDriveTypeW")
)

type fileInformation struct {
	FileAttributes uint32
	CreationTime   syscall.Filetime
	LastAccessTime syscall.Filetime
	LastWriteTime  syscall.Filetime
	VolumeSerial   uint32
	FileSizeHigh   uint32
	FileSizeLow    uint32
	Links          uint32
	FileIndexHigh  uint32
	FileIndexLow   uint32
}

func main() {
	if len(os.Args) < 3 {
		fail("usage: private-storage.exe ensure-dir <path> | secure-file <path> | write-file <path>")
	}
	var err error
	switch os.Args[1] {
	case "ensure-dir":
		if len(os.Args) != 3 {
			fail("ensure-dir requires one path")
		}
		err = ensurePrivateDir(os.Args[2])
	case "secure-file":
		if len(os.Args) != 3 {
			fail("secure-file requires one path")
		}
		err = secureExistingFile(os.Args[2])
	case "write-file":
		if len(os.Args) != 3 {
			fail("write-file requires one path")
		}
		var content []byte
		content, err = io.ReadAll(os.Stdin)
		if err == nil {
			err = writePrivateFile(os.Args[2], content)
		}
	default:
		fail("unsupported private-storage operation")
	}
	if err != nil {
		fail("private storage operation failed: " + err.Error())
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}

func wide(value string) (*uint16, error) { return syscall.UTF16PtrFromString(value) }

func descriptor(directory bool) (uintptr, error) {
	user, err := currentSID()
	if err != nil {
		return 0, err
	}
	userText, err := sidString(user)
	if err != nil {
		return 0, err
	}
	sddl := "D:P(A;;FA;;;" + userText + ")(A;;FA;;;SY)"
	if directory {
		sddl = "D:P(A;OICI;FA;;;" + userText + ")(A;OICI;FA;;;SY)"
	}
	text, err := wide(sddl)
	if err != nil {
		return 0, err
	}
	var result uintptr
	var size uint32
	ok, _, callErr := procConvertSDDL.Call(uintptr(unsafe.Pointer(text)), securityDescriptorRevision, uintptr(unsafe.Pointer(&result)), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return 0, callError(callErr)
	}
	return result, nil
}

func callError(callErr error) error {
	if callErr != nil && callErr != syscall.Errno(0) {
		return callErr
	}
	return syscall.GetLastError()
}

func currentSID() (*syscall.SID, error) {
	var token syscall.Token
	process, err := syscall.GetCurrentProcess()
	if err != nil {
		return nil, err
	}
	if err := syscall.OpenProcessToken(process, tokenQuery, &token); err != nil {
		return nil, err
	}
	defer token.Close()
	var needed uint32
	_ = syscall.GetTokenInformation(token, tokenUserInformation, nil, 0, &needed)
	if needed == 0 {
		return nil, syscall.GetLastError()
	}
	buffer := make([]byte, needed)
	if err := syscall.GetTokenInformation(token, tokenUserInformation, &buffer[0], needed, &needed); err != nil {
		return nil, err
	}
	return *(**syscall.SID)(unsafe.Pointer(&buffer[0])), nil
}

func sidString(sid *syscall.SID) (string, error) {
	var text *uint16
	if err := syscall.ConvertSidToStringSid(sid, &text); err != nil {
		return "", err
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(text))))
	var value []uint16
	for cursor := text; *cursor != 0; cursor = (*uint16)(unsafe.Add(unsafe.Pointer(cursor), unsafe.Sizeof(*cursor))) {
		value = append(value, *cursor)
	}
	return syscall.UTF16ToString(value), nil
}

func openPath(path string, directory bool, access uint32) (syscall.Handle, fileInformation, error) {
	name, err := wide(path)
	if err != nil {
		return syscall.InvalidHandle, fileInformation{}, err
	}
	flags := uint32(fileFlagOpenReparsePoint)
	if directory {
		flags |= fileFlagBackupSemantics
	}
	handle, err := syscall.CreateFile(name, access, fileShareRead|fileShareWrite|fileShareDelete, nil, openExisting, flags, 0)
	if err != nil {
		return syscall.InvalidHandle, fileInformation{}, err
	}
	var info fileInformation
	ok, _, callErr := procGetFileInformation.Call(uintptr(handle), uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		syscall.CloseHandle(handle)
		return syscall.InvalidHandle, fileInformation{}, callError(callErr)
	}
	if info.FileAttributes&fileAttributeReparsePoint != 0 {
		syscall.CloseHandle(handle)
		return syscall.InvalidHandle, fileInformation{}, errors.New("reparse points are not accepted for private storage")
	}
	if directory != (info.FileAttributes&fileAttributeDirectory != 0) {
		syscall.CloseHandle(handle)
		return syscall.InvalidHandle, fileInformation{}, errors.New("private-storage path has the wrong file type")
	}
	return handle, info, nil
}

func verifyOwner(handle syscall.Handle) error {
	user, err := currentSID()
	if err != nil {
		return err
	}
	var owner, group, dacl, sacl, securityDescriptor uintptr
	status, _, _ := procGetSecurityInfo.Call(uintptr(handle), seFileObject, ownerSecurityInformation, uintptr(unsafe.Pointer(&owner)), uintptr(unsafe.Pointer(&group)), uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&sacl)), uintptr(unsafe.Pointer(&securityDescriptor)))
	if status != 0 {
		return syscall.Errno(status)
	}
	defer procLocalFree.Call(securityDescriptor)
	if owner == 0 {
		return errors.New("private-storage object has no owner")
	}
	equal, _, _ := procEqualSid.Call(owner, uintptr(unsafe.Pointer(user)))
	if equal == 0 {
		return errors.New("private-storage object is not owned by the current Windows user")
	}
	return nil
}

func setProtectedACL(handle syscall.Handle, directory bool) error {
	sd, err := descriptor(directory)
	if err != nil {
		return err
	}
	defer procLocalFree.Call(sd)
	var present, defaulted int32
	var dacl uintptr
	getDACL := advapi32.NewProc("GetSecurityDescriptorDacl")
	ok, _, callErr := getDACL.Call(sd, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || present == 0 || dacl == 0 {
		return callError(callErr)
	}
	status, _, _ := procSetSecurityInfo.Call(uintptr(handle), seFileObject, daclSecurityInformation|protectedDACLInformation, 0, 0, dacl, 0)
	if status != 0 {
		return syscall.Errno(status)
	}
	return verifyACL(handle, directory)
}

func verifyACL(handle syscall.Handle, directory bool) error {
	var owner, group, dacl, sacl, sd uintptr
	status, _, _ := procGetSecurityInfo.Call(uintptr(handle), seFileObject, ownerSecurityInformation|daclSecurityInformation, uintptr(unsafe.Pointer(&owner)), uintptr(unsafe.Pointer(&group)), uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&sacl)), uintptr(unsafe.Pointer(&sd)))
	if status != 0 {
		return syscall.Errno(status)
	}
	defer procLocalFree.Call(sd)
	var control uint16
	var revision uint32
	ok, _, callErr := procGetSecurityDescriptorControl.Call(sd, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 {
		return callError(callErr)
	}
	if control&seDACLProtected == 0 {
		return errors.New("private-storage DACL is not protected from inheritance")
	}
	sddl, err := descriptorString(sd)
	if err != nil {
		return err
	}
	user, err := currentSID()
	if err != nil {
		return err
	}
	userText, err := sidString(user)
	if err != nil {
		return err
	}
	expected := "D:P(A;;FA;;;" + userText + ")(A;;FA;;;SY)"
	if directory {
		expected = "D:P(A;OICI;FA;;;" + userText + ")(A;OICI;FA;;;SY)"
	}
	index := strings.Index(sddl, "D:")
	if index < 0 {
		return errors.New("private-storage DACL is missing")
	}
	actual := sddl[index:]
	if strings.HasPrefix(actual, "D:PAI") {
		actual = "D:P" + actual[len("D:PAI"):]
	}
	if actual != expected {
		return errors.New("private-storage DACL contains unexpected principals or permissions")
	}
	return nil
}

func descriptorString(sd uintptr) (string, error) {
	var text uintptr
	var length uint32
	ok, _, callErr := procConvertSDToSDDL.Call(sd, securityDescriptorRevision, ownerSecurityInformation|daclSecurityInformation, uintptr(unsafe.Pointer(&text)), uintptr(unsafe.Pointer(&length)))
	if ok == 0 {
		return "", callError(callErr)
	}
	defer procLocalFree.Call(text)
	var value []uint16
	for cursor := (*uint16)(unsafe.Pointer(text)); *cursor != 0; cursor = (*uint16)(unsafe.Add(unsafe.Pointer(cursor), unsafe.Sizeof(*cursor))) {
		value = append(value, *cursor)
	}
	return syscall.UTF16ToString(value), nil
}

func secureHandle(handle syscall.Handle, directory bool) error {
	if err := verifyOwner(handle); err != nil {
		return err
	}
	return setProtectedACL(handle, directory)
}

func absolutePath(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("private-storage path must be absolute")
	}
	clean := filepath.Clean(path)
	volume := filepath.VolumeName(clean)
	if volume == "" || clean == volume+string(filepath.Separator) {
		return "", errors.New("a drive root cannot be used as private storage")
	}
	root, err := syscall.UTF16PtrFromString(volume + string(filepath.Separator))
	if err != nil {
		return "", fmt.Errorf("resolve private-storage volume: %w", err)
	}
	driveType, _, _ := procGetDriveType.Call(uintptr(unsafe.Pointer(root)))
	if driveType == driveUnknown || driveType == driveNoRoot || driveType == driveRemote {
		return "", errors.New("private storage requires an available local volume")
	}
	return clean, nil
}

func ensurePrivateDir(path string) error {
	clean, err := absolutePath(path)
	if err != nil {
		return err
	}
	root := filepath.VolumeName(clean) + string(filepath.Separator)
	parts := strings.Split(strings.TrimPrefix(clean, root), string(filepath.Separator))
	current := root
	for index, part := range parts {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		isTarget := index == len(parts)-1
		if err := createOrCheckDirectory(current, isTarget); err != nil {
			return err
		}
	}
	return nil
}

func verifyNoReparseAncestors(path string) error {
	clean, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	clean = filepath.Clean(clean)
	root := filepath.VolumeName(clean) + string(filepath.Separator)
	if root == string(filepath.Separator) {
		return errors.New("private-storage path must use a local absolute volume")
	}
	current := root
	for _, part := range strings.Split(strings.TrimPrefix(clean, root), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		handle, _, err := openPath(current, true, fileReadAttributes)
		if err != nil {
			return err
		}
		_ = syscall.CloseHandle(handle)
	}
	return nil
}

func createOrCheckDirectory(path string, target bool) error {
	access := uint32(fileReadAttributes)
	if target {
		access |= readControl | writeDAC
	}
	handle, _, err := openPath(path, true, access)
	if err == nil {
		defer syscall.CloseHandle(handle)
		if target {
			if err := secureHandle(handle, true); err != nil {
				return fmt.Errorf("secure existing private directory: %w", err)
			}
			return nil
		}
		return nil
	}
	if !errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) && !errors.Is(err, syscall.ERROR_PATH_NOT_FOUND) {
		return err
	}
	sd, err := descriptor(true)
	if err != nil {
		return err
	}
	defer procLocalFree.Call(sd)
	sa := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: sd}
	name, err := wide(path)
	if err != nil {
		return err
	}
	if err = syscall.CreateDirectory(name, &sa); err != nil {
		if !errors.Is(err, syscall.ERROR_ALREADY_EXISTS) {
			return err
		}
		handle, _, err = openPath(path, true, access)
		if err != nil {
			return err
		}
		defer syscall.CloseHandle(handle)
		if target {
			if err := secureHandle(handle, true); err != nil {
				return fmt.Errorf("secure existing private directory: %w", err)
			}
			return nil
		}
		return nil
	}
	handle, _, err = openPath(path, true, readControl|fileReadAttributes)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	if err := verifyOwner(handle); err != nil {
		return err
	}
	if err := verifyACL(handle, true); err != nil {
		return fmt.Errorf("verify newly created private directory: %w", err)
	}
	return nil
}

func secureExistingFile(path string) error {
	clean, err := absolutePath(path)
	if err != nil {
		return err
	}
	if err = verifyNoReparseAncestors(filepath.Dir(clean)); err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND) {
			return nil
		}
		return err
	}
	parent, _, err := openPath(filepath.Dir(clean), true, readControl|fileReadAttributes)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(parent)
	if err = verifyOwner(parent); err != nil {
		return fmt.Errorf("file parent owner check failed: %w", err)
	}
	if err = verifyACL(parent, true); err != nil {
		return fmt.Errorf("file parent is not private: %w", err)
	}
	file, info, err := openPath(clean, false, readControl|writeDAC|fileReadAttributes)
	if err != nil {
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_PATH_NOT_FOUND) {
			return nil
		}
		return err
	}
	defer syscall.CloseHandle(file)
	if info.Links != 1 {
		return errors.New("hard-linked files are not accepted for private storage")
	}
	return secureHandle(file, false)
}

func writePrivateFile(path string, content []byte) error {
	clean, err := absolutePath(path)
	if err != nil {
		return err
	}
	if err = verifyNoReparseAncestors(filepath.Dir(clean)); err != nil {
		return err
	}
	parent, _, err := openPath(filepath.Dir(clean), true, readControl|fileReadAttributes)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(parent)
	if err = verifyOwner(parent); err != nil {
		return fmt.Errorf("file parent owner check failed: %w", err)
	}
	if err = verifyACL(parent, true); err != nil {
		return fmt.Errorf("file parent is not private: %w", err)
	}
	if target, info, openErr := openPath(clean, false, readControl|fileReadAttributes); openErr == nil {
		if ownerErr := verifyOwner(target); ownerErr != nil {
			syscall.CloseHandle(target)
			return ownerErr
		}
		syscall.CloseHandle(target)
		if info.Links != 1 {
			return errors.New("hard-linked files are not accepted for private storage")
		}
	} else if !errors.Is(openErr, syscall.ERROR_FILE_NOT_FOUND) {
		return openErr
	}

	var suffix [12]byte
	if _, err = rand.Read(suffix[:]); err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(clean), "."+filepath.Base(clean)+"."+fmt.Sprintf("%x", suffix[:])+".tmp")
	if err = createPrivateTemp(temp, content); err != nil {
		return err
	}
	tempName, err := wide(temp)
	if err != nil {
		_ = deletePath(temp)
		return err
	}
	targetName, err := wide(clean)
	if err != nil {
		_ = deletePath(temp)
		return err
	}
	ok, _, callErr := procMoveFileEx.Call(uintptr(unsafe.Pointer(tempName)), uintptr(unsafe.Pointer(targetName)), moveFileReplaceExisting|moveFileWriteThrough)
	if ok == 0 {
		_ = deletePath(temp)
		return callError(callErr)
	}
	return nil
}

func createPrivateTemp(path string, content []byte) error {
	sd, err := descriptor(false)
	if err != nil {
		return err
	}
	defer procLocalFree.Call(sd)
	sa := syscall.SecurityAttributes{Length: uint32(unsafe.Sizeof(syscall.SecurityAttributes{})), SecurityDescriptor: sd}
	name, err := wide(path)
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_WRITE|readControl|writeDAC, fileShareRead|fileShareWrite|fileShareDelete, &sa, createNew, fileAttributeNormal|fileFlagOpenReparsePoint, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	if err = secureHandle(handle, false); err != nil {
		_ = deletePath(path)
		return err
	}
	for len(content) != 0 {
		var written uint32
		writeErr := syscall.WriteFile(handle, content, &written, nil)
		if writeErr != nil {
			_ = deletePath(path)
			return writeErr
		}
		if written == 0 {
			_ = deletePath(path)
			return errors.New("private file write made no progress")
		}
		content = content[written:]
	}
	return syscall.FlushFileBuffers(handle)
}

func deletePath(path string) error {
	name, err := wide(path)
	if err != nil {
		return err
	}
	ok, _, callErr := procDeleteFile.Call(uintptr(unsafe.Pointer(name)))
	if ok == 0 {
		return callError(callErr)
	}
	return nil
}
