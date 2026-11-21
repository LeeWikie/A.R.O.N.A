export const terminalSupervisorWindows=String.raw`
$ErrorActionPreference = 'Stop'
$statusFile=Join-Path $env:ARONA_TERMINAL_OBSERVER_DIRECTORY 'supervisor-state.json'
[IO.File]::WriteAllText($statusFile,'{"phase":"starting"}')
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TerminalProcessJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  static IntPtr job;
  public static void Open() {
    job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero)throw new InvalidOperationException("job_create_failed:"+Marshal.GetLastWin32Error());
    var limits=new ExtendedLimits();limits.Basic.Flags=0x2000;
    int size=Marshal.SizeOf(typeof(ExtendedLimits));IntPtr memory=Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits,memory,false);
      if(!SetInformationJobObject(job,9,memory,(uint)size))throw new InvalidOperationException("job_limits_failed:"+Marshal.GetLastWin32Error());
    }finally{Marshal.FreeHGlobal(memory);}
  }
  public static void Register(uint id) {
    IntPtr process=OpenProcess(0x0101,false,id);
    if(process==IntPtr.Zero)throw new InvalidOperationException("process_open_failed:"+Marshal.GetLastWin32Error());
    try {if(!AssignProcessToJobObject(job,process))throw new InvalidOperationException("job_assign_failed:"+Marshal.GetLastWin32Error());}
    finally{CloseHandle(process);}
  }
  public static void Close() {if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}}
  public static void Terminate() {if(job==IntPtr.Zero||!TerminateJobObject(job,137))throw new InvalidOperationException("job_terminate_failed:"+Marshal.GetLastWin32Error());}
}
'@ | Out-Null
try {
  [TerminalProcessJob]::Open()
  [IO.File]::WriteAllText($statusFile,'{"phase":"ready"}')
  [Console]::WriteLine('ready')
  while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line -match '^register ([0-9]{1,10})$') {
      [TerminalProcessJob]::Register([uint32]$Matches[1])
      [IO.File]::WriteAllText($statusFile,'{"phase":"registered"}')
      [Console]::WriteLine('registered '+$Matches[1])
    } elseif ($line -eq 'terminate') {
      [TerminalProcessJob]::Terminate()
      [Console]::WriteLine('terminated')
    }
  }
} finally {
  [IO.File]::WriteAllText($statusFile,'{"phase":"closing"}')
  [TerminalProcessJob]::Close()
  [IO.File]::WriteAllText($statusFile,'{"phase":"closed"}')
}
`;
