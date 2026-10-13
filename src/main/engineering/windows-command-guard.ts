/** Native Job Object ownership. No credentials in this source.
 * JOB_LIST assigns at CreateProcess time, before any command instruction can run.
 * The job handle is non-inheritable and kill-on-close; normal exit also drains descendants.
 */
export function windowsCommandGuard(): string {
  return String.raw`using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading;
public static class CoprojerJob {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show, reservedSize; public IntPtr reserved2, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref LIMIT data,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,out ACCOUNT data,uint length,IntPtr ret);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref SIX startup,out PI process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr result,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string arg) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in arg) { if(c=='\\') { slashes++; continue; } if(c=='"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes); b.Append(c); slashes=0; }
    b.Append('\\',slashes*2); return b.Append('"').ToString();
  }
  public class Result { public uint pid, activeProcesses; public int code; public bool cancelled, stoppedConfirmed; }
  public static int Main(string[] input) {
    try {
      string[] args=new string[input.Length-5]; Array.Copy(input,5,args,0,args.Length);
      Result proof=Run(input[0],args,input[1],Int32.Parse(input[2]));
      string text="{\"version\":1,\"pid\":"+proof.pid+",\"code\":"+proof.code+",\"cancelled\":"+proof.cancelled.ToString().ToLowerInvariant()+",\"activeProcesses\":"+proof.activeProcesses+",\"stoppedConfirmed\":"+proof.stoppedConfirmed.ToString().ToLowerInvariant()+",\"containment\":\"windows-job-list-v1\",\"nonce\":\""+input[4]+"\"}";
      byte[] bytes=Encoding.UTF8.GetBytes(text);
      using(var stream=new FileStream(input[3]+".tmp",FileMode.Create,FileAccess.Write,FileShare.None)) { stream.Write(bytes,0,bytes.Length); stream.Flush(true); }
      File.Move(input[3]+".tmp",input[3]); return proof.stoppedConfirmed ? 0 : 126;
    } catch(Exception error) { Console.Error.WriteLine(error); return 126; }
  }
  public static Result Run(string executable,string[] args,string root,int timeout) {
    IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobs=IntPtr.Zero,outHandle=IntPtr.Zero,errHandle=IntPtr.Zero;
    PI pi=new PI(); bool initialized=false; uint code=0; bool cancelled=false; uint active=1;
    try {
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      var limit=new LIMIT(); limit.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
      Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit)));
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,1,0,ref size)); initialized=true;
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-11),GetCurrentProcess(),out outHandle,0,true,2));
      Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-12),GetCurrentProcess(),out errHandle,0,true,2));
      var si=new SIX(); si.si.cb=Marshal.SizeOf(si); si.attributes=list; si.si.flags=0x100; si.si.output=outHandle; si.si.error=errHandle;
      // Child has no stdin. Only this guard reads the owner's lifetime pipe.
      var command=new StringBuilder(Quote(executable)); foreach(string arg in args) command.Append(" ").Append(Quote(arg));
      var lease=Console.OpenStandardInput().ReadAsync(new byte[1],0,1);
      if(lease.IsCompleted) throw new IOException("Owner closed before launch");
      Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,root,ref si,out pi));
      var clock=System.Diagnostics.Stopwatch.StartNew();
      while(WaitForSingleObject(pi.process,25)==258) { if(lease.IsCompleted || clock.ElapsedMilliseconds>=timeout) { cancelled=true; break; } }
      Check(GetExitCodeProcess(pi.process,out code));
      // Parent completion is not tree completion. Terminate even on exit 0, then query active=0.
      Check(TerminateJobObject(job,125));
      var drain=System.Diagnostics.Stopwatch.StartNew();
      do { ACCOUNT account; Check(QueryInformationJobObject(job,1,out account,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero)); active=account.active;
        if(active==0) break; Thread.Sleep(10);
      } while(drain.ElapsedMilliseconds<5000);
      return new Result { pid=pi.pid, code=cancelled ? -1 : unchecked((int)code), cancelled=cancelled, activeProcesses=active, stoppedConfirmed=active==0 };
    } finally {
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
      if(job!=IntPtr.Zero) CloseHandle(job); if(outHandle!=IntPtr.Zero) CloseHandle(outHandle); if(errHandle!=IntPtr.Zero) CloseHandle(errHandle);
      if(initialized) DeleteProcThreadAttributeList(list); if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list); if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
    }
  }
}
`
}
