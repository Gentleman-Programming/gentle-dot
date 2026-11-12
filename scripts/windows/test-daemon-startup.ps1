<#
.SYNOPSIS
CI-only packaged Node and daemon launch contract; not installed or agent-idle acceptance.
.PARAMETER Runtime
Fresh CI staged runtime containing node/node.exe and daemon/cli.mjs.
.DESCRIPTION
Clears the child environment, creates a fresh isolated profile, probes loopback health,
and stops only the owned process tree. Prints one fixed outcome; no raw child logs.
#>
param([string]$Runtime = '')

function New-DaemonStartupEnvironment {
    param([string]$Runtime, [string]$Scratch, [int]$Port)
    @{
        OS = $env:OS; SystemRoot = $env:SystemRoot; WINDIR = $env:WINDIR
        PATH = (Join-Path $Runtime 'node') + ';' + (Join-Path $env:SystemRoot 'System32')
        GENTLE_DOT_RUNTIME = $Runtime
        GENTLE_DOT_DATA_DIR = Join-Path $Scratch 'data'
        GENTLE_DOT_PORT = [string]$Port
        HOME = Join-Path $Scratch 'home'; USERPROFILE = Join-Path $Scratch 'home'
        APPDATA = Join-Path $Scratch 'appdata'; LOCALAPPDATA = Join-Path $Scratch 'localappdata'
        TEMP = Join-Path $Scratch 'temp'; TMP = Join-Path $Scratch 'temp'; TMPDIR = Join-Path $Scratch 'temp'
        XDG_CACHE_HOME = Join-Path $Scratch 'cache'
    }
}

function New-DaemonStartupStartInfo {
    param([string]$Runtime, [System.Collections.IDictionary]$Environment)
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $Runtime 'node/node.exe'
    $info.ArgumentList.Add((Join-Path $Runtime 'daemon/cli.mjs'))
    $info.WorkingDirectory = $Runtime
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.Environment.Clear()
    foreach ($key in $Environment.Keys) { $info.Environment[$key] = [string]$Environment[$key] }
    return $info
}

function New-DaemonStartupScratch {
    $path = Join-Path $PSScriptRoot ('../../build/arise-ci-t6/daemon-' + [guid]::NewGuid().ToString('N'))
    return [IO.Directory]::CreateDirectory($path).FullName
}

function Get-DaemonStartupPort {
    # Same ephemeral-loopback reservation pattern as the existing installer smoke.
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Get-DaemonStartupNativeSource {
    # Compiled only by the actual CI OS adapter, never by dot-sourcing/inert tests.
    return @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace GentleDot.CI {
    public sealed class OwnedDaemon : IDisposable {
        const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
        const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_NO_WINDOW = 0x08000000;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        static readonly IntPtr HANDLE_LIST = new IntPtr(0x20002);
        IntPtr job, process;
        OwnedDaemon(IntPtr job, IntPtr process) { this.job = job; this.process = process; }
        [StructLayout(LayoutKind.Sequential)] struct Security {
            public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
        }
        [StructLayout(LayoutKind.Sequential)] struct Startup {
            public uint Size; public IntPtr Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
            public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Info; public IntPtr Attributes; }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
            public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)] struct Accounting {
            public long User, Kernel, PeriodUser, PeriodKernel;
            public uint Faults, Total, ActiveProcesses, Terminated;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
        [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint sharing, ref Security security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll")] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll")] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo process);
        static void Require(bool ok) { if (!ok) throw new InvalidOperationException("Contained launch failed"); }
        static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero; }
        public static OwnedDaemon Start(string executable, string entry, string directory, IDictionary<string,string> environment) {
            IntPtr job = IntPtr.Zero, sink = IntPtr.Zero, attributes = IntPtr.Zero;
            IntPtr handles = IntPtr.Zero, block = IntPtr.Zero;
            ProcessInfo child = new ProcessInfo(); bool initialized = false, assigned = false;
            try {
                // No breakaway flags: descendants inherit this private, unnamed job.
                job = CreateJobObjectW(IntPtr.Zero, null); Require(job != IntPtr.Zero);
                ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()));
                Security security = new Security { Length=Marshal.SizeOf<Security>(), Inherit=true };
                // Direct OS null sink; no raw pipes, callbacks, files or console forwarding.
                sink = CreateFileW("NUL", 0xC0000000, 3, ref security, 3, 0, IntPtr.Zero);
                Require(sink != new IntPtr(-1));
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                Require(size.ToInt64() > 0);
                attributes = Marshal.AllocHGlobal(size);
                Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); initialized = true;
                handles = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handles, sink);
                // Inherit ONLY the null sink, never runner credentials/stdio/job handles.
                Require(UpdateProcThreadAttribute(attributes, 0, HANDLE_LIST, handles, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
                var text = new StringBuilder(); var keys = new List<string>(environment.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
                foreach (string key in keys) {
                    string value = environment[key] ?? "";
                    Require(key.IndexOf('\0') < 0 && key.IndexOf('=') < 0 && value.IndexOf('\0') < 0);
                    text.Append(key).Append('=').Append(value).Append('\0');
                }
                text.Append('\0'); block = Marshal.StringToHGlobalUni(text.ToString());
                StartupEx startup = new StartupEx(); startup.Info.Size = (uint)Marshal.SizeOf<StartupEx>();
                startup.Info.Flags = 0x100; startup.Info.Input = sink; startup.Info.Output = sink; startup.Info.Error = sink;
                startup.Attributes = attributes;
                // These are exact Windows file paths (not shell commands); reject embedded quotes.
                Require(executable.IndexOf('"') < 0 && entry.IndexOf('"') < 0);
                var command = new StringBuilder("\"" + executable + "\" \"" + entry + "\"");
                Require(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                    block, directory, ref startup, out child));
                Require(AssignProcessToJobObject(job, child.Process)); assigned = true;
                Require(ResumeThread(child.Thread) != UInt32.MaxValue);
                var owner = new OwnedDaemon(job, child.Process); job = IntPtr.Zero; child.Process = IntPtr.Zero;
                return owner;
            } catch {
                if (child.Process != IntPtr.Zero) {
                    // Before assignment the child is still suspended and cannot have descendants.
                    if (assigned) TerminateJobObject(job, 1); else TerminateProcess(child.Process, 1);
                    WaitForSingleObject(child.Process, 5000);
                }
                throw new InvalidOperationException("Contained launch failed");
            } finally {
                Close(ref child.Thread); Close(ref child.Process); Close(ref job); Close(ref sink);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
                if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
            }
        }
        public bool HasExited {
            get { uint state = WaitForSingleObject(process, 0); Require(state == 0 || state == 258); return state == 0; }
        }
        public bool Stop() {
            // Root exit is irrelevant: terminate and verify the ENTIRE owned job.
            if (job == IntPtr.Zero || !TerminateJobObject(job, 1)) return false;
            var watch = Stopwatch.StartNew();
            do {
                Accounting accounting;
                if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero)) return false;
                if (accounting.ActiveProcesses == 0) return true;
                Thread.Sleep(10);
            } while (watch.ElapsedMilliseconds < 5000);
            return false;
        }
        public void Dispose() { Close(ref job); Close(ref process); }
    }
}
'@
}

function New-DaemonStartupOwner($Info) {
    if (-not ('GentleDot.CI.OwnedDaemon' -as [type])) {
        Add-Type -TypeDefinition (Get-DaemonStartupNativeSource) -ErrorAction Stop 2>$null
    }
    return [GentleDot.CI.OwnedDaemon]::Start($Info.FileName, $Info.ArgumentList[0], $Info.WorkingDirectory, $Info.Environment)
}

function Start-DaemonStartupProcess {
    param([string]$Runtime, [System.Collections.IDictionary]$Environment)
    $info = New-DaemonStartupStartInfo -Runtime $Runtime -Environment $Environment
    return New-DaemonStartupOwner $info
}

function Test-DaemonStartupExited($Owner) { return $Owner.HasExited }

function Stop-DaemonStartupProcess($Owner) {
    try { return $Owner.Stop() } catch { return $false }
    finally { $Owner.Dispose() }
}

function Receive-DaemonStartupHealth([int]$Port) {
    $probe = Get-SmokeObservation -Port $Port
    # Listener + successful HTTP + valid health shape, deliberately NOT agentState=idle proof.
    return ($probe.tcpState -eq 'connected' -and $probe.httpState -eq 'response' -and
        $probe.httpStatus -eq 200 -and $probe.jsonState -eq 'valid' -and $probe.healthState -eq 'valid')
}
function Wait-DaemonStartupPoll { Start-Sleep -Milliseconds 250 }

function Invoke-DaemonStartupContract {
    param([string]$Runtime)
    $ErrorActionPreference = 'Stop'
    if ($env:CI -cne 'true') { return 'daemon-startup-not-ci' }
    try {
        if (-not $Runtime) { return 'daemon-startup-invalid-runtime' }
        $Runtime = [IO.Path]::GetFullPath($Runtime)
        foreach ($relative in @('node/node.exe','daemon/cli.mjs')) {
            if (-not [IO.File]::Exists((Join-Path $Runtime $relative))) { return 'daemon-startup-invalid-runtime' }
        }
    } catch { return 'daemon-startup-invalid-runtime' }
    $owner = $null; $outcome = 'daemon-startup-failed'
    try {
        Import-Module "$PSScriptRoot/smoke-diagnostics.psm1" -Force
        $scratch = New-DaemonStartupScratch
        $port = Get-DaemonStartupPort
        $environment = New-DaemonStartupEnvironment -Runtime $Runtime -Scratch $scratch -Port $port
        foreach ($key in @('GENTLE_DOT_DATA_DIR','HOME','APPDATA','LOCALAPPDATA','TEMP','XDG_CACHE_HOME')) {
            [void][IO.Directory]::CreateDirectory($environment[$key])
        }
        $owner = Start-DaemonStartupProcess -Runtime $Runtime -Environment $environment
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        $outcome = 'daemon-startup-timeout'
        for ($poll = 0; $poll -lt 12 -and [DateTime]::UtcNow -lt $deadline; $poll++) {
            if (Test-DaemonStartupExited $owner) { $outcome = 'daemon-startup-earlyexit'; break }
            if (Receive-DaemonStartupHealth -Port $port) { $outcome = 'daemon-startup-passed'; break }
            Wait-DaemonStartupPoll
        }
    } catch { $outcome = 'daemon-startup-failed' }
    finally {
        if ($null -ne $owner) {
            try { if (-not (Stop-DaemonStartupProcess $owner)) { $outcome = 'daemon-startup-cleanup-failed' } }
            catch { $outcome = 'daemon-startup-cleanup-failed' }
        }
    }
    return $outcome
}

# Dot-sourcing exposes contracts for inert tests; direct execution is CI-only.
if ($MyInvocation.InvocationName -ne '.') {
    $outcome = Invoke-DaemonStartupContract -Runtime $Runtime
    Write-Output $outcome
    if ($outcome -eq 'daemon-startup-passed') { exit 0 }
    exit 1
}
