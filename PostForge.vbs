' =====================================================================
'  PostForge launcher - double-click to open the PostForge Control Panel
'  (start/stop the app, open it in your browser, set the admin login).
'  On first run it also adds a "PostForge" shortcut to your Desktop and
'  Start menu. No Command Prompt needed.
' =====================================================================
Option Explicit
Dim sh, fso, root, panel, icon, desktop, programs
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root  = fso.GetParentFolderName(WScript.ScriptFullName)
panel = root & "\launcher\control-panel.ps1"
icon  = root & "\launcher\postforge.ico"

Sub MakeShortcut(folder)
  Dim lnkPath, lnk
  If folder = "" Then Exit Sub
  If Not fso.FolderExists(folder) Then Exit Sub
  lnkPath = folder & "\PostForge.lnk"
  Set lnk = sh.CreateShortcut(lnkPath)
  lnk.TargetPath = sh.ExpandEnvironmentStrings("%WINDIR%") & "\System32\wscript.exe"
  lnk.Arguments = """" & WScript.ScriptFullName & """"
  lnk.WorkingDirectory = root
  If fso.FileExists(icon) Then lnk.IconLocation = icon
  lnk.Description = "PostForge - start the app and manage settings"
  lnk.Save
End Sub

' Create / refresh the Desktop and Start-menu shortcuts (keeps them pointing here if the folder moves)
On Error Resume Next
desktop  = sh.SpecialFolders("Desktop")
programs = sh.SpecialFolders("Programs")
MakeShortcut desktop
MakeShortcut programs
On Error GoTo 0

If Not fso.FileExists(panel) Then
  MsgBox "Cannot find launcher\control-panel.ps1 next to this file." & vbCrLf & "Please keep PostForge.vbs inside the postforge-app folder.", vbExclamation, "PostForge"
  WScript.Quit 1
End If

' Open the control panel with no console window
sh.Run "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & panel & """", 0, False
