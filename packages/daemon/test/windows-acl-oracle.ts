import { execFileSync } from "node:child_process";

export interface WindowsAclEvidence {
	owner: string;
	currentSid: string;
	protected: boolean;
	rules: { sid: string; type: string; inherited: boolean }[];
}

/** Reads the actual owner and DACL through .NET, independently of the private-storage helper. */
export function inspectWindowsAcl(path: string): WindowsAclEvidence {
	const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:GENTLE_DOT_ACL_TARGET
$sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
if ((Get-Item -LiteralPath $path).PSIsContainer) { $acl = ([System.IO.DirectoryInfo]::new($path)).GetAccessControl($sections) }
else { $acl = ([System.IO.FileInfo]::new($path)).GetAccessControl($sections) }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
$rules = @($acl.Access | ForEach-Object { [pscustomobject]@{ Sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; Type = $_.AccessControlType.ToString(); Inherited = $_.IsInherited } })
[pscustomobject]@{ Owner = $owner; CurrentSid = $sid; Protected = $acl.AreAccessRulesProtected; Rules = $rules } | ConvertTo-Json -Depth 4 -Compress`;
	const output = execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{ encoding: "utf8", env: { ...process.env, GENTLE_DOT_ACL_TARGET: path }, windowsHide: true },
	);
	const data = JSON.parse(output) as {
		Owner: string;
		CurrentSid: string;
		Protected: boolean;
		Rules: { Sid: string; Type: string; Inherited: boolean }[];
	};
	return {
		owner: data.Owner,
		currentSid: data.CurrentSid,
		protected: data.Protected,
		rules: data.Rules.map((rule) => ({ sid: rule.Sid, type: rule.Type, inherited: rule.Inherited })),
	};
}
