import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verify } from './runtime-integrity.mjs';

// Legacy limits, excluding NUL: MAX_PATH=260; CreateDirectory reserves 12
// characters for an 8.3 name. Reserve the terminator as well (247, not 248).
export const FILE_LIMIT = 259;
export const DIRECTORY_LIMIT = 247;
const manifestName = 'WINDOWS-INTEGRITY.json';
const safeKey = key => typeof key === 'string' && key.split('/').every(part =>
  part && part !== '.' && part !== '..' && !/[<>:"\\|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part));
export function stagedBudget(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, manifestName), 'utf8'));
  if (manifest.schema !== 1 || manifest.platform !== 'win32-x64' ||
      !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object' ||
      !Object.keys(manifest.files).length || Object.entries(manifest.files).some(([key, hash]) =>
        !safeKey(key) || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid Windows runtime manifest');
  // Reuse the inventory verifier: never derive permission from a stale/fake manifest.
  verify(root, manifest);
  const files = [...Object.keys(manifest.files).map(key => `runtime/${key}`),
    `runtime/${manifestName}`, 'gentle-dot.exe', 'uninstall.exe'];
  const directories = new Set(['runtime']);
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  // Inventory hashes files; include empty staged directories as well.
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) {
      const key = win32.relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/');
      if (!safeKey(key)) throw new Error('Invalid staged directory');
      directories.add(`runtime/${key}`);
    }
  }
  const longestFile = files.reduce((a, b) => a.length >= b.length ? a : b);
  const longestDirectory = [...directories].reduce((a, b) => a.length >= b.length ? a : b);
  const maxDestination = Math.min(FILE_LIMIT - 1 - longestFile.length, DIRECTORY_LIMIT - 1 - longestDirectory.length);
  if (maxDestination < 3) throw new Error(`Staged payload cannot fit legacy paths: destination budget ${maxDestination}`);
  return { maxDestination, longestFile, longestDirectory, fileLimit: FILE_LIMIT, directoryLimit: DIRECTORY_LIMIT };
}
export function destination(input, budget) {
  const value = input.replace(/[\\/]+$/, '').replaceAll('/', '\\');
  if (!/^[A-Za-z]:\\/.test(value) || !safeKey(value.slice(3).replaceAll('\\', '/'))) {
    throw new Error('Choose a local absolute Windows destination without traversal or reserved characters.');
  }
  if (value.length > budget.maxDestination) throw new Error(message(budget));
  return value;
}
function message(budget) {
  return `Gentle Dot destination is too long for this staged payload. Choose a shorter local installation folder (maximum ${budget.maxDestination} UTF-16 characters, excluding trailing separators) and run setup again.`;
}
export function renderHook(budget) {
  if (!Number.isInteger(budget.maxDestination) || budget.maxDestination < 3 || budget.maxDestination > FILE_LIMIT) throw new Error('Invalid destination budget');
  // MUI GUI-init precedes custom maintenance pages (and their previous uninstall).
  // Silent mode has no GUI/pages: the first hidden section guards that route.
  // Refuse callback ownership collisions instead of silently replacing one.
  return String.raw`; Generated from the verified staged runtime. Do not edit.
!include FileFunc.nsh
!ifdef MUI_CUSTOMFUNCTION_GUIINIT
  !error "Destination guard requires exclusive MUI_CUSTOMFUNCTION_GUIINIT ownership"
!endif
!define MUI_CUSTOMFUNCTION_GUIINIT GentlePathGuiInit
Function GentlePathGuiInit
  Call GentleValidateDestination
FunctionEnd
!macro NSIS_HOOK_PREINSTALL
  Call GentleValidateDestination
!macroend
Function GentleValidateDestination
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $0 $INSTDIR
  gentle_trim:
  StrCpy $1 $0 1 -1
  StrCmp $1 "\" gentle_strip
  StrCmp $1 "/" gentle_strip gentle_prefix
  gentle_strip:
  StrCpy $0 $0 -1
  Goto gentle_trim
  gentle_prefix:
  StrCpy $1 $0 2 1
  StrCmp $1 ":\" gentle_drive
  StrCmp $1 ":/" 0 gentle_reject
  gentle_drive:
  StrCpy $2 $0 1
  StrCpy $3 0
  gentle_letter:
  StrCpy $1 "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" 1 $3
  StrCmp $1 "" gentle_reject
  StrCmpS $1 $2 gentle_components
  IntOp $3 $3 + 1
  Goto gentle_letter
  gentle_components:
  StrCpy $4 "$2:\"
  StrCpy $2 ""
  StrCpy $3 3
  gentle_scan:
  StrCpy $1 $0 1 $3
  StrCmp $1 "" gentle_component
  StrCmp $1 "\" gentle_component
  StrCmp $1 "/" gentle_component
  StrCmp $1 "<" gentle_reject
  StrCmp $1 ">" gentle_reject
  StrCmp $1 ":" gentle_reject
  StrCmp $1 '$\"' gentle_reject
  StrCmp $1 "|" gentle_reject
  StrCmp $1 "?" gentle_reject
  StrCmp $1 "*" gentle_reject
  StrCmp $1 "$\t" gentle_reject
  StrCmp $1 "$\r" gentle_reject
  StrCmp $1 "$\n" gentle_reject
  StrCpy $2 "$2$1"
  IntOp $3 $3 + 1
  Goto gentle_scan
  gentle_component:
  StrCmp $2 "" gentle_reject
  StrCmp $2 "." gentle_reject
  StrCmp $2 ".." gentle_reject
  StrCpy $5 $2 1 -1
  StrCmp $5 "." gentle_reject
  StrCmp $5 " " gentle_reject
  StrCpy $4 "$4$2"
  StrCmp $1 "" gentle_measure
  StrCpy $4 "$4\"
  StrCpy $2 ""
  IntOp $3 $3 + 1
  Goto gentle_scan
  gentle_measure:
  StrLen $1 $4
  IntCmp $1 ${budget.maxDestination} gentle_ok gentle_ok gentle_reject
  gentle_reject:
  DetailPrint "Gentle Dot destination is invalid or too long. Choose a local absolute folder without traversal (maximum ${budget.maxDestination} UTF-16 characters) and run setup again."
  IfSilent gentle_exit
  ${'${GetOptions}'} $CMDLINE "/P" $1
  IfErrors 0 gentle_exit
  MessageBox MB_OK|MB_ICONSTOP "Gentle Dot destination is invalid or too long. Choose a local absolute folder without traversal (maximum ${budget.maxDestination} UTF-16 characters) and run setup again."
  gentle_exit:
  SetErrorLevel 2
  Quit
  gentle_ok:
  StrCpy $INSTDIR $4
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
Section "-Gentle Dot destination guard"
  Call GentleValidateDestination
SectionEnd
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, root, target] = process.argv.slice(2);
    if (!root || !target || !['hook', 'destination'].includes(mode)) throw new Error('Usage: installer-path-guard.mjs hook STAGED_ROOT OUTPUT.nsh | destination STAGED_ROOT ABSOLUTE_DESTINATION');
    const budget = stagedBudget(root);
    if (mode === 'hook') writeFileSync(target, renderHook(budget));
    else console.log(destination(target, budget));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
