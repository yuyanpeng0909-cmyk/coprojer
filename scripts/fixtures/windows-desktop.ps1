param([string]$Request,[switch]$Server)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Accessibility
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DesktopInput {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 public delegate bool EnumProc(IntPtr h,IntPtr data);
 [StructLayout(LayoutKind.Sequential)] public struct RECT {public int left,top,right,bottom;}
 public class Tip {public string name;public int pid,x,y,width,height;}
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,System.Text.StringBuilder name,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,System.Text.StringBuilder name,int count);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
 public static Tip[] Tooltips(uint owner) {
  var result=new System.Collections.Generic.List<Tip>();
  EnumWindows((h,data)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid!=owner||!IsWindowVisible(h))return true;
   var cls=new System.Text.StringBuilder(128);GetClassName(h,cls,128);if(cls.ToString()!="tooltips_class32")return true;
   var name=new System.Text.StringBuilder(1024);GetWindowText(h,name,1024);RECT r;GetWindowRect(h,out r);
   result.Add(new Tip{name=name.ToString(),pid=(int)pid,x=r.left,y=r.top,width=r.right-r.left,height=r.bottom-r.top});return true;
  },IntPtr.Zero);return result.ToArray();
 }
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h,int index,System.Text.StringBuilder data,int length,out int needed);
}
'@
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) @'
using System;
using System.Runtime.InteropServices;
using Accessibility;
public class LegacyDesktop {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 public class Hit { public string name; public int role,x,y,width,height; public string error; }
 [DllImport("oleacc.dll")] static extern int AccessibleObjectFromPoint(POINT p, out IAccessible obj, [MarshalAs(UnmanagedType.Struct)] out object child);
 public static Hit At(int x,int y) {
  var h=new Hit(); try {
   IAccessible a; object c; int hr=AccessibleObjectFromPoint(new POINT{X=x,Y=y},out a,out c);
   if(hr!=0) {h.error="HRESULT "+hr;return h;}
   h.name=a.get_accName(c);h.role=Convert.ToInt32(a.get_accRole(c));
   a.accLocation(out h.x,out h.y,out h.width,out h.height,c);
   Marshal.ReleaseComObject(a);
  } catch(Exception e) {h.error=e.Message;}return h;
 }
}
'@
[void][DesktopInput]::SetProcessDPIAware()
function Invoke-DesktopRequest($req) {
 $script:lastEvents=$null
$root = [System.Windows.Automation.AutomationElement]::RootElement
function Describe($e) {
 $v=$e.Current; $b=$v.BoundingRectangle
 [pscustomobject]@{name=$v.Name;className=$v.ClassName;pid=$v.ProcessId;offscreen=$v.IsOffscreen;type=$v.ControlType.ProgrammaticName;rect=@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height};runtimeId=@($e.GetRuntimeId())}
}
function ShellWindows {
 $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition) | Where-Object {$_.Current.ClassName -in @('Shell_TrayWnd','Shell_SecondaryTrayWnd','NotifyIconOverflowWindow')}
}
$screens=@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{device=$_.DeviceName;primary=$_.Primary;bounds=@{x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height};workArea=@{x=$_.WorkingArea.X;y=$_.WorkingArea.Y;width=$_.WorkingArea.Width;height=$_.WorkingArea.Height}} })
$h=[DesktopInput]::OpenInputDesktop(0,$false,1)
$desktopName=New-Object System.Text.StringBuilder 256
$needed=0
if($h -ne [IntPtr]::Zero){[void][DesktopInput]::GetUserObjectInformation($h,2,$desktopName,512,[ref]$needed);[void][DesktopInput]::CloseDesktop($h)}
if($req.action -eq 'probe') {
 @{interactive=[Environment]::UserInteractive;inputDesktop=$desktopName.ToString();screens=$screens;shellWindows=@(ShellWindows | ForEach-Object {Describe $_});uia=$true} | ConvertTo-Json -Depth 8 -Compress
 return
}
if($desktopName.ToString() -ne 'Default'){throw 'The current input desktop is not the unlocked Default desktop.'}
$events=New-Object System.Collections.Generic.List[object]
$script:lastEvents=$events
function Capture([string]$file,$rect) {
 if(-not $file){return}
 $bmp=New-Object System.Drawing.Bitmap ([int]$rect.width),([int]$rect.height)
 $g=[System.Drawing.Graphics]::FromImage($bmp)
 try {$g.CopyFromScreen([int]$rect.x,[int]$rect.y,0,0,$bmp.Size);$bmp.Save($file,[System.Drawing.Imaging.ImageFormat]::Png)} finally {$g.Dispose();$bmp.Dispose()}
}
if($req.action -eq 'tray-tree') {
 @{windows=@(ShellWindows | ForEach-Object {@{window=(Describe $_);children=@($_.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {Describe $_})}})} | ConvertTo-Json -Depth 10 -Compress
 return
}
if($req.action -eq 'open-tray-overflow') {
 $r=$req.rect;$x=[int]($r.x+$r.width/2);$y=[int]($r.y+$r.height/2)
 $hit=[System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point $x,$y))
 $parent=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($hit)
 $shellPids=@(ShellWindows | ForEach-Object {$_.Current.ProcessId})
 $legacy=[LegacyDesktop]::At($x,$y)
 if($legacy.role -eq 43 -and $legacy.name -like ($req.expectedName -replace '\d{2}:\d{2}$','*') -and $hit.Current.ProcessId -in $shellPids) {
  @{events=@();alreadyVisible=$true;target=$legacy} | ConvertTo-Json -Depth 6 -Compress
  return
 }
 if($hit.Current.ClassName -ne 'Button' -or $parent.Current.ClassName -ne 'TrayNotifyWnd' -or $hit.Current.ProcessId -notin $shellPids -or $hit.Current.IsOffscreen){throw 'Owned Tray bounds do not resolve to the notification overflow entrance; no input sent.'}
 [void][DesktopInput]::SetCursorPos($x,$y)
 [DesktopInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[DesktopInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 350
 # Capture only the identified notification container. Do not archive
 # unrelated applications underneath the desktop as verification evidence.
 $visibleOverflow=@(ShellWindows | Where-Object {$_.Current.ClassName -eq 'NotifyIconOverflowWindow' -and -not $_.Current.IsOffscreen})
 if($visibleOverflow.Count -eq 1){Capture $req.screenshot (Describe $visibleOverflow[0]).rect}
 @{events=@(@{action='native-open-owned-tray-container';x=$x;y=$y;target=(Describe $hit);at=(Get-Date).ToUniversalTime().ToString('o')});windows=@(ShellWindows | ForEach-Object {Describe $_})} | ConvertTo-Json -Depth 10 -Compress
 return
}
if($req.action -eq 'tray') {
 # Bounds come from this run's own Tray instance. FromPoint independently
 # confirms a visible shell element carrying that instance's exact tooltip.
 $r=$req.rect; $x=[int]($r.x+$r.width/2);$y=[int]($r.y+$r.height/2)
 $e=[System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point $x,$y))
 $target=Describe $e
 $legacy=[LegacyDesktop]::At($x,$y)
 $nameMatches=$legacy.name -eq $req.expectedName
 if($req.expectedPrefix){$nameMatches=$legacy.name -and $legacy.name.StartsWith($req.expectedPrefix)}
 if($target.offscreen -or -not $nameMatches -or $legacy.role -ne 43) {throw ('Cannot uniquely locate the owned tray icon: '+(@{uia=$target;legacy=$legacy}|ConvertTo-Json -Depth 5 -Compress))}
 $shellPids=@(ShellWindows | ForEach-Object {$_.Current.ProcessId})
 if($target.pid -notin $shellPids){throw 'Tray coordinate resolves outside the Windows notification area.'}
 # Force a fresh hover within the identified icon even if the pointer was
 # already at its centre. Never move to an unrelated application control.
 [void][DesktopInput]::SetCursorPos($x-2,$y)
 Start-Sleep -Milliseconds 100
 [void][DesktopInput]::SetCursorPos($x,$y)
 $events.Add(@{action='native-move';x=$x;y=$y;target=$target;legacy=$legacy;at=(Get-Date).ToUniversalTime().ToString('o')})
 # Bounded observation covers shell hover delay and an independent Win32
 # tooltip window read, without substituting the application's getToolTip API.
 $tips=@();$hoverWatch=[Diagnostics.Stopwatch]::StartNew()
 do {
  Start-Sleep -Milliseconds 200
  $tips=@($root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition) | Where-Object {$_.Current.ClassName -eq 'tooltips_class32' -and $_.Current.ProcessId -in $shellPids} | ForEach-Object {Describe $_})
  foreach($shellProcess in $shellPids){
   $tips+=@([DesktopInput]::Tooltips([uint32]$shellProcess)|ForEach-Object {@{name=$_.name;pid=$_.pid;offscreen=$false;source='Win32 visible shell tooltip';rect=@{x=$_.x;y=$_.y;width=$_.width;height=$_.height}}})
  }
 }while(-not ($tips|Where-Object {$_.name -eq $legacy.name}) -and $hoverWatch.ElapsedMilliseconds -lt 4000)
 $cursor=New-Object DesktopInput+POINT
 [void][DesktopInput]::GetCursorPos([ref]$cursor)
 if($cursor.X -ne $x -or $cursor.Y -ne $y){throw ('Input ownership changed during hover; no click sent. Expected '+$x+','+$y+' observed '+$cursor.X+','+$cursor.Y)}
 if($req.click -eq 'right') {
  $current=[System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point $x,$y))
  $currentLegacy=[LegacyDesktop]::At($x,$y)
  if($current.Current.ProcessId -notin $shellPids -or $currentLegacy.name -ne $legacy.name){throw 'Owned icon changed or became occluded during hover; no click sent.'}
  [DesktopInput]::mouse_event(8,0,0,0,[UIntPtr]::Zero);[DesktopInput]::mouse_event(16,0,0,0,[UIntPtr]::Zero)
  $events.Add(@{action='native-right-click';target=$target;at=(Get-Date).ToUniversalTime().ToString('o')})
  Start-Sleep -Milliseconds 400
 }
 $menus=@($root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition) | Where-Object {$_.Current.ProcessId -eq $req.targetPid -and $_.Current.ClassName -eq '#32768'})
 $menuRecords=@($menus | ForEach-Object {@{window=(Describe $_);items=@($_.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)|ForEach-Object {Describe $_})}})
 Capture $req.screenshot $legacy
 $matchingTips=@($tips | Where-Object {$_.name -eq $legacy.name -and -not $_.offscreen}|Select-Object -First 1)
 if($matchingTips.Count -eq 1){Capture ($req.screenshot+'.tooltip.png') $matchingTips[0].rect}
 foreach($menu in $menuRecords){Capture ($req.screenshot+'.menu.png') $menu.window.rect}
 @{events=$events;hoverObservationMs=$hoverWatch.ElapsedMilliseconds;cursor=@{x=$cursor.X;y=$cursor.Y};tooltipWindows=$tips;menus=$menuRecords;screenshot=$req.screenshot} | ConvertTo-Json -Depth 12 -Compress
 return
}
if($req.action -eq 'menu-click') {
 $menus=@($root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition) | Where-Object {$_.Current.ProcessId -eq $req.targetPid -and $_.Current.ClassName -eq '#32768'})
 $items=@($menus | ForEach-Object {$_.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)} | Where-Object {$_.Current.Name -eq $req.label -and -not $_.Current.IsOffscreen})
 if($items.Count -ne 1){throw ('Expected exactly one menu item owned by test PID; found '+$items.Count)}
 $target=Describe $items[0];$r=$target.rect;$x=[int]($r.x+$r.width/2);$y=[int]($r.y+$r.height/2)
 $hit=[System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point $x,$y))
 if($hit.Current.ProcessId -ne $req.targetPid -or $hit.Current.Name -ne $req.label){throw 'Menu item is occluded; no input sent.'}
 [void][DesktopInput]::SetCursorPos($x,$y)
 [DesktopInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[DesktopInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
 @{events=@(@{action='native-left-click';target=$target;x=$x;y=$y;at=(Get-Date).ToUniversalTime().ToString('o')})} | ConvertTo-Json -Depth 8 -Compress
 return
}
throw 'Unknown bounded desktop action.'
}
if($Server) {
 while(($line=[Console]::ReadLine()) -ne $null) {
  try {
   $result=Invoke-DesktopRequest ($line | ConvertFrom-Json)
   [Console]::WriteLine(($result -join [Environment]::NewLine))
  } catch {
   $failure=$_.Exception.Message
   $recordedEvents=if($null -ne $script:lastEvents){$script:lastEvents.ToArray()}else{@()}
   [Console]::WriteLine((@{driverError=$failure;events=$recordedEvents}|ConvertTo-Json -Depth 12 -Compress))
  }
 }
} else {
 Invoke-DesktopRequest (Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json)
}
