# =====================================================================
#  PostGenX Control Panel (Windows)
#  Start / stop the app, open it in the browser, and set the admin
#  email + password - no Command Prompt needed.
#  Launched by "PostGenX.vbs" (or the PostGenX desktop shortcut).
# =====================================================================
param([switch]$SelfTest)

$ErrorActionPreference = 'Continue'
$Root    = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root '.env'
$EnvExample = Join-Path $Root '.env.example'
$DataDir = Join-Path $Root 'data'
$PidFile = Join-Path $DataDir 'server.pid'
$LogFile = Join-Path $DataDir 'server.log'
$ErrFile = Join-Path $DataDir 'server-error.log'
$PrefFile = Join-Path $DataDir 'launcher.json'
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }

# ---------------------------------------------------------------------
#  .env helpers (keeps every other line and comment untouched)
# ---------------------------------------------------------------------
function Read-EnvFile {
  $vals = @{}
  if (Test-Path $EnvFile) {
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
        $k = $Matches[1]; $v = $Matches[2].Trim()
        if ($v.StartsWith('"')) { $end = $v.IndexOf('"', 1); if ($end -gt 0) { $v = $v.Substring(1, $end - 1) } else { $v = $v.Substring(1) } }
        elseif ($v.StartsWith("'")) { $end = $v.IndexOf("'", 1); if ($end -gt 0) { $v = $v.Substring(1, $end - 1) } else { $v = $v.Substring(1) } }
        else { $hash = $v.IndexOf(' #'); if ($hash -ge 0) { $v = $v.Substring(0, $hash).Trim() } }
        $vals[$k] = $v
      }
    }
  }
  return $vals
}

function Set-EnvValues([hashtable]$pairs) {
  if (-not (Test-Path $EnvFile)) {
    if (Test-Path $EnvExample) { Copy-Item $EnvExample $EnvFile } else { Set-Content -Path $EnvFile -Value '' -Encoding ASCII }
  }
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.AddRange([string[]][System.IO.File]::ReadAllLines($EnvFile))
  foreach ($k in $pairs.Keys) {
    $newLine = $k + '="' + $pairs[$k] + '"'
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match ('^\s*' + [regex]::Escape($k) + '\s*=')) { $lines[$i] = $newLine; $found = $true; break }
    }
    if (-not $found) { $lines.Add($newLine) }
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($EnvFile, $lines, $utf8NoBom)
}

function Test-AdminInput([string]$email, [string]$pw, [string]$pw2) {
  if ($email -notmatch '^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$') { return 'Enter a valid email address.' }
  if ($pw.Length -lt 10) { return 'Password must be at least 10 characters.' }
  if ($pw -notmatch '[A-Za-z]' -or $pw -notmatch '[0-9]') { return 'Password needs at least one letter and one number.' }
  if ($pw.Contains('"') -or $pw.Contains("`n") -or $pw.Contains("`r")) { return 'Password cannot contain double quotes (").' }
  if ($pw -ne $pw2) { return 'The two passwords do not match.' }
  return $null
}

function Get-Port {
  $v = Read-EnvFile
  $p = 3000
  if ($v.ContainsKey('PORT') -and $v['PORT'] -match '^\d+$') { $p = [int]$v['PORT'] }
  return $p
}

# ---------------------------------------------------------------------
#  Self-test (used by the developer on any OS: pwsh control-panel.ps1 -SelfTest)
# ---------------------------------------------------------------------
if ($SelfTest) {
  Set-EnvValues @{ ADMIN_EMAIL = 'owner@example.com'; ADMIN_PASSWORD = 'Secret#Pass 123'; PORT = '3100' }
  $v = Read-EnvFile
  "email=$($v['ADMIN_EMAIL']) pw=$($v['ADMIN_PASSWORD']) port=$(Get-Port)"
  "check-bad=" + (Test-AdminInput 'x' 'short' 'short')
  "check-ok=" + [string]::IsNullOrEmpty((Test-AdminInput 'a@b.co' 'GoodPass123' 'GoodPass123'))
  return
}

# ---------------------------------------------------------------------
#  Launcher preferences
# ---------------------------------------------------------------------
function Get-Prefs {
  $d = @{ autoStart = $true; openBrowser = $true }
  if (Test-Path $PrefFile) {
    try { $j = Get-Content $PrefFile -Raw | ConvertFrom-Json; if ($null -ne $j.autoStart) { $d.autoStart = [bool]$j.autoStart }; if ($null -ne $j.openBrowser) { $d.openBrowser = [bool]$j.openBrowser } } catch {}
  }
  return $d
}
function Save-Prefs($p) { ($p | ConvertTo-Json) | Set-Content -Path $PrefFile -Encoding ASCII }

# ---------------------------------------------------------------------
#  Process helpers
# ---------------------------------------------------------------------
function Test-Running {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$(Get-Port)/health")
    $req.Timeout = 900
    $res = $req.GetResponse(); $ok = [int]$res.StatusCode -eq 200; $res.Close(); return $ok
  } catch { return $false }
}

function Get-ServerProcesses {
  $list = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
    foreach ($p in $procs) {
      if ($p.CommandLine -and $p.CommandLine -like '*server*index.js*') {
        # only our copy of the app
        $exe = $p.CommandLine
        if ($exe -like "*$Root*" -or ((Test-Path $PidFile) -and ((Get-Content $PidFile -Raw).Trim() -eq [string]$p.ProcessId))) { $list += $p.ProcessId }
      }
    }
  } catch {}
  if (-not $list.Count -and (Test-Path $PidFile)) {
    $id = (Get-Content $PidFile -Raw).Trim()
    if ($id -match '^\d+$') { $gp = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue; if ($gp -and $gp.ProcessName -eq 'node') { $list += [int]$id } }
  }
  return $list
}

function Get-NodeInfo {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) {
    foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
      if ($c -and (Test-Path $c)) { $cmd = Get-Item $c; break }
    }
  }
  if (-not $cmd) { return $null }
  $path = if ($cmd.Source) { $cmd.Source } else { $cmd.FullName }
  $ver = (& $path -v) 2>$null
  return @{ Path = $path; Version = "$ver".Trim() }
}
function Test-NodeVersion([string]$v) {
  if ($v -notmatch '^v(\d+)\.(\d+)') { return $false }
  $maj = [int]$Matches[1]; $min = [int]$Matches[2]
  return ($maj -gt 22) -or ($maj -eq 22 -and $min -ge 13)
}

# ---------------------------------------------------------------------
#  UI
# ---------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Coral = [System.Drawing.Color]::FromArgb(255, 107, 74)
$Ink   = [System.Drawing.Color]::FromArgb(26, 26, 46)
$Paper = [System.Drawing.Color]::FromArgb(247, 245, 241)
$Green = [System.Drawing.Color]::FromArgb(29, 122, 95)
$Muted = [System.Drawing.Color]::FromArgb(110, 109, 128)
$FontUI   = New-Object System.Drawing.Font('Segoe UI', 9.5)
$FontBold = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
$FontBig  = New-Object System.Drawing.Font('Segoe UI Semibold', 16)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PostGenX Control Panel'
$form.Size = New-Object System.Drawing.Size(600, 700)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = $Paper
$form.Font = $FontUI
$iconPath = Join-Path $PSScriptRoot 'postforge.ico'
if (Test-Path $iconPath) { $form.Icon = New-Object System.Drawing.Icon($iconPath) }

function New-Btn($text, $x, $y, $w, $h, $primary) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, $h)
  $b.FlatStyle = 'Flat'; $b.Font = $FontBold; $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  if ($primary) { $b.BackColor = $Coral; $b.ForeColor = [System.Drawing.Color]::White; $b.FlatAppearance.BorderSize = 0 }
  else { $b.BackColor = [System.Drawing.Color]::White; $b.ForeColor = $Ink; $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(220, 216, 208) }
  return $b
}
function New-Label($text, $x, $y, $w, $h) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.Size = New-Object System.Drawing.Size($w, $h)
  return $l
}
function New-Group($text, $y, $h) {
  $g = New-Object System.Windows.Forms.GroupBox
  $g.Text = $text; $g.Font = $FontBold; $g.ForeColor = $Ink
  $g.Location = New-Object System.Drawing.Point(16, $y); $g.Size = New-Object System.Drawing.Size(552, $h)
  return $g
}

# --- header ---
$title = New-Label 'PostGenX' 18 12 300 34; $title.Font = $FontBig; $title.ForeColor = $Ink
$status = New-Label 'Checking...' 330 20 240 24; $status.TextAlign = 'MiddleRight'; $status.Font = $FontBold; $status.ForeColor = $Muted
$form.Controls.AddRange(@($title, $status))

# --- App group ---
$gApp = New-Group 'App' 56 150
$btnStart = New-Btn 'Start && open' 16 28 170 40 $true
$btnStop  = New-Btn 'Stop app' 196 28 110 40 $false
$btnOpen  = New-Btn 'Open in browser' 316 28 130 40 $false
$btnAdmin = New-Btn 'Admin' 456 28 80 40 $false
$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = 'Start the app automatically when this window opens'; $chkAuto.Location = New-Object System.Drawing.Point(18, 80); $chkAuto.Size = New-Object System.Drawing.Size(500, 22); $chkAuto.Font = $FontUI
$chkBrowser = New-Object System.Windows.Forms.CheckBox
$chkBrowser.Text = 'Open the browser after starting'; $chkBrowser.Location = New-Object System.Drawing.Point(18, 104); $chkBrowser.Size = New-Object System.Drawing.Size(500, 22); $chkBrowser.Font = $FontUI
$hint = New-Label 'Closing this window keeps the app running. Use "Stop app" to turn it off.' 18 126 520 18; $hint.Font = $FontUI; $hint.ForeColor = $Muted
$gApp.Controls.AddRange(@($btnStart, $btnStop, $btnOpen, $btnAdmin, $chkAuto, $chkBrowser, $hint))

# --- Admin login group ---
$gAdm = New-Group 'Platform admin login' 216 214
$lEmail = New-Label 'Admin email' 18 30 140 20; $lEmail.Font = $FontUI
$tEmail = New-Object System.Windows.Forms.TextBox; $tEmail.Location = New-Object System.Drawing.Point(160, 27); $tEmail.Size = New-Object System.Drawing.Size(370, 24); $tEmail.Font = $FontUI
$lPw = New-Label 'Password' 18 64 140 20; $lPw.Font = $FontUI
$tPw = New-Object System.Windows.Forms.TextBox; $tPw.Location = New-Object System.Drawing.Point(160, 61); $tPw.Size = New-Object System.Drawing.Size(370, 24); $tPw.UseSystemPasswordChar = $true; $tPw.Font = $FontUI
$lPw2 = New-Label 'Confirm password' 18 98 140 20; $lPw2.Font = $FontUI
$tPw2 = New-Object System.Windows.Forms.TextBox; $tPw2.Location = New-Object System.Drawing.Point(160, 95); $tPw2.Size = New-Object System.Drawing.Size(370, 24); $tPw2.UseSystemPasswordChar = $true; $tPw2.Font = $FontUI
$chkShow = New-Object System.Windows.Forms.CheckBox; $chkShow.Text = 'Show password'; $chkShow.Location = New-Object System.Drawing.Point(160, 124); $chkShow.Size = New-Object System.Drawing.Size(160, 22); $chkShow.Font = $FontUI
$btnSave = New-Btn 'Save admin login' 380 124 150 34 $true
$admNote = New-Label 'At least 10 characters with a letter and a number. Saved in the .env file and applied when the app (re)starts - use it to sign in and open /admin.' 18 164 520 40; $admNote.Font = $FontUI; $admNote.ForeColor = $Muted
$gAdm.Controls.AddRange(@($lEmail, $tEmail, $lPw, $tPw, $lPw2, $tPw2, $chkShow, $btnSave, $admNote))

# --- Settings group ---
$gSet = New-Group 'Settings & shortcuts' 440 92
$lPort = New-Label 'Port' 18 32 40 20; $lPort.Font = $FontUI
$nPort = New-Object System.Windows.Forms.NumericUpDown; $nPort.Location = New-Object System.Drawing.Point(60, 29); $nPort.Size = New-Object System.Drawing.Size(80, 24); $nPort.Minimum = 1024; $nPort.Maximum = 65535; $nPort.Font = $FontUI
$btnPort = New-Btn 'Save port' 148 26 90 30 $false
$btnShortcut = New-Btn 'Desktop shortcut' 248 26 140 30 $false
$btnFolder = New-Btn 'Open app folder' 396 26 140 30 $false
$setNote = New-Label 'Change the port only if 3000 is already used by another program.' 18 62 520 20; $setNote.Font = $FontUI; $setNote.ForeColor = $Muted
$gSet.Controls.AddRange(@($lPort, $nPort, $btnPort, $btnShortcut, $btnFolder, $setNote))

# --- Log ---
$lLog = New-Label 'Activity' 18 540 200 18; $lLog.Font = $FontBold; $lLog.ForeColor = $Ink
$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true; $log.ReadOnly = $true; $log.ScrollBars = 'Vertical'; $log.WordWrap = $true
$log.Location = New-Object System.Drawing.Point(16, 560); $log.Size = New-Object System.Drawing.Size(552, 90)
$log.Font = New-Object System.Drawing.Font('Consolas', 8.5); $log.BackColor = [System.Drawing.Color]::White
$form.Controls.AddRange(@($gApp, $gAdm, $gSet, $lLog, $log))

function Write-Log([string]$msg) {
  $log.AppendText((Get-Date -Format 'HH:mm:ss') + '  ' + $msg + "`r`n")
}

# ---------------------------------------------------------------------
#  Actions
# ---------------------------------------------------------------------
function Update-Status {
  if (Test-Running) {
    $status.Text = "Running  -  localhost:$(Get-Port)"; $status.ForeColor = $Green
    $btnStart.Text = 'Open app'; $btnStop.Enabled = $true
  } else {
    $status.Text = 'Stopped'; $status.ForeColor = $Muted
    $btnStart.Text = 'Start && open'; $btnStop.Enabled = $false
  }
}

function Open-App([string]$path = '/') { Start-Process ("http://localhost:$(Get-Port)" + $path) }

function Wait-Process-UI($proc) {
  while (-not $proc.HasExited) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 150 }
}

function Start-App {
  if (Test-Running) { if ($chkBrowser.Checked) { Open-App '/' }; Update-Status; return }

  $node = Get-NodeInfo
  if (-not $node) {
    $r = [System.Windows.Forms.MessageBox]::Show("Node.js is not installed.`r`n`r`nInstall the LTS version from nodejs.org (default options), then open PostGenX again.`r`n`r`nOpen nodejs.org now?", 'PostGenX', 'YesNo', 'Warning')
    if ($r -eq 'Yes') { Start-Process 'https://nodejs.org/en/download' }
    return
  }
  if (-not (Test-NodeVersion $node.Version)) {
    [System.Windows.Forms.MessageBox]::Show("Node.js $($node.Version) is too old. PostGenX needs version 22.13 or newer.`r`nInstall the current LTS from nodejs.org, then try again.", 'PostGenX', 'OK', 'Warning') | Out-Null
    Start-Process 'https://nodejs.org/en/download'; return
  }

  $vals = Read-EnvFile
  if (-not $vals['ADMIN_EMAIL'] -or -not $vals['ADMIN_PASSWORD']) {
    [System.Windows.Forms.MessageBox]::Show('Please set the admin email and password first (Platform admin login), then click Start again.', 'PostGenX', 'OK', 'Information') | Out-Null
    $tEmail.Focus() | Out-Null; return
  }

  $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor; $btnStart.Enabled = $false
  try {
    # Install packages on first run, and again whenever an update changed package.json
    $pkgHash = (Get-FileHash (Join-Path $Root 'package.json') -Algorithm SHA256).Hash
    $hashFile = Join-Path $DataDir 'packages.hash'
    $oldHash = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { '' }
    if (-not (Test-Path (Join-Path $Root 'node_modules')) -or $oldHash -ne $pkgHash) {
      Write-Log 'Installing app packages (about a minute)...'
      $status.Text = 'Installing...'; $status.ForeColor = $Coral
      $npm = Join-Path (Split-Path $node.Path) 'npm.cmd'
      if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }
      # cmd /s /c "<whole line>": the outer quotes keep paths with spaces (e.g. "content creator") intact
      $cmdLine = '/d /s /c "' + "`"$npm`" install --no-audit --no-fund > `"$DataDir\install.log`" 2>&1" + '"'
      $p = Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine -WorkingDirectory $Root -WindowStyle Hidden -PassThru
      $null = $p.Handle   # keeps the exit code readable after the process ends
      Wait-Process-UI $p
      if ($p.ExitCode -ne 0 -or -not (Test-Path (Join-Path $Root 'node_modules'))) {
        Write-Log 'Package install failed - see data\install.log'
        [System.Windows.Forms.MessageBox]::Show("Installing packages failed. Check your internet connection and see data\install.log.", 'PostGenX', 'OK', 'Error') | Out-Null
        return
      }
      Set-Content -Path $hashFile -Value $pkgHash -Encoding ASCII
      Write-Log 'Packages installed.'
    }

    Write-Log 'Starting PostGenX...'
    $status.Text = 'Starting...'; $status.ForeColor = $Coral
    $proc = Start-Process -FilePath $node.Path -ArgumentList '--disable-warning=ExperimentalWarning', 'server/index.js' `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile
    Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII

    $ok = $false
    for ($i = 0; $i -lt 60; $i++) {
      [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 250
      if ($proc.HasExited) { break }
      if (Test-Running) { $ok = $true; break }
    }
    if ($ok) {
      Write-Log "PostGenX is running at http://localhost:$(Get-Port)"
      if ($chkBrowser.Checked) { Open-App '/login' }
    } else {
      $err = ''
      if (Test-Path $ErrFile) { $err = (Get-Content $ErrFile -Tail 6) -join "`r`n" }
      if ($err -match 'EADDRINUSE') { $err = "Port $(Get-Port) is already used by another program. Pick another port under Settings." }
      Write-Log ('Could not start. ' + $err)
      [System.Windows.Forms.MessageBox]::Show("PostGenX could not start.`r`n`r`n$err", 'PostGenX', 'OK', 'Error') | Out-Null
    }
  } finally {
    $form.Cursor = [System.Windows.Forms.Cursors]::Default; $btnStart.Enabled = $true; Update-Status
  }
}

function Stop-App {
  $ids = Get-ServerProcesses
  if (-not $ids.Count) { Write-Log 'The app is not running.'; Update-Status; return }
  foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 400
  Write-Log 'PostGenX stopped.'
  Update-Status
}

function Test-PackagesChanged {
  $hashFile = Join-Path $DataDir 'packages.hash'
  $old = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { '' }
  return $old -ne (Get-FileHash (Join-Path $Root 'package.json') -Algorithm SHA256).Hash
}

function Restart-IfRunning([string]$why) {
  if (Test-Running) {
    $r = [System.Windows.Forms.MessageBox]::Show("$why`r`n`r`nRestart PostGenX now to apply it?", 'PostGenX', 'YesNo', 'Question')
    if ($r -eq 'Yes') {
      $keep = $chkBrowser.Checked; $chkBrowser.Checked = $false
      Stop-App; Start-App
      $chkBrowser.Checked = $keep
    }
  }
}

function New-DesktopShortcut([bool]$quiet) {
  $sh = New-Object -ComObject WScript.Shell
  $vbs = Join-Path $Root 'PostGenX.vbs'
  foreach ($dir in @($sh.SpecialFolders.Item('Desktop'), $sh.SpecialFolders.Item('Programs'))) {
    if (-not $dir) { continue }
    $lnk = $sh.CreateShortcut((Join-Path $dir 'PostGenX.lnk'))
    $lnk.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe')
    $lnk.Arguments = '"' + $vbs + '"'
    $lnk.WorkingDirectory = $Root
    if (Test-Path $iconPath) { $lnk.IconLocation = $iconPath }
    $lnk.Description = 'PostGenX - start the app and manage settings'
    $lnk.Save()
  }
  if (-not $quiet) { Write-Log 'Shortcut "PostGenX" added to your Desktop and Start menu.' }
}

# ---------------------------------------------------------------------
#  Wire up events
# ---------------------------------------------------------------------
$btnStart.Add_Click({ try { Start-App } catch { Write-Log ('Error: ' + $_.Exception.Message) } })
$btnStop.Add_Click({ try { Stop-App } catch { Write-Log ('Error: ' + $_.Exception.Message) } })
$btnOpen.Add_Click({ if (Test-Running) { Open-App '/' } else { Write-Log 'Start the app first.' } })
$btnAdmin.Add_Click({ if (Test-Running) { Open-App '/admin' } else { Write-Log 'Start the app first.' } })
$chkShow.Add_CheckedChanged({ $tPw.UseSystemPasswordChar = -not $chkShow.Checked; $tPw2.UseSystemPasswordChar = -not $chkShow.Checked })
$chkAuto.Add_CheckedChanged({ $p = Get-Prefs; $p.autoStart = $chkAuto.Checked; Save-Prefs $p })
$chkBrowser.Add_CheckedChanged({ $p = Get-Prefs; $p.openBrowser = $chkBrowser.Checked; Save-Prefs $p })

$btnSave.Add_Click({
  $email = $tEmail.Text.Trim().ToLower()
  $problem = Test-AdminInput $email $tPw.Text $tPw2.Text
  if ($problem) { [System.Windows.Forms.MessageBox]::Show($problem, 'PostGenX', 'OK', 'Warning') | Out-Null; return }
  Set-EnvValues @{ ADMIN_EMAIL = $email; ADMIN_PASSWORD = $tPw.Text }
  $tPw2.Text = ''
  Write-Log "Admin login saved for $email."
  Restart-IfRunning 'Admin login saved.'
  if (-not (Test-Running)) { Write-Log 'It will be applied the next time the app starts.' }
})

$btnPort.Add_Click({
  $port = [int]$nPort.Value
  $vals = Read-EnvFile
  $pairs = @{ PORT = "$port" }
  if (-not $vals['APP_URL'] -or $vals['APP_URL'] -match '^https?://localhost(:\d+)?/?$') { $pairs['APP_URL'] = "http://localhost:$port" }
  $wasRunning = Test-Running
  if ($wasRunning) { Stop-App }
  Set-EnvValues $pairs
  Write-Log "Port set to $port."
  if ($wasRunning) { Start-App }
})
$btnShortcut.Add_Click({ New-DesktopShortcut $false })
$btnFolder.Add_Click({ Start-Process explorer.exe $Root })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.Add_Tick({ Update-Status })

$form.Add_Shown({
  $vals = Read-EnvFile
  $tEmail.Text = $vals['ADMIN_EMAIL']
  $tPw.Text = $vals['ADMIN_PASSWORD']; $tPw2.Text = $vals['ADMIN_PASSWORD']
  $nPort.Value = [Math]::Min(65535, [Math]::Max(1024, (Get-Port)))
  $prefs = Get-Prefs
  $chkAuto.Checked = $prefs.autoStart; $chkBrowser.Checked = $prefs.openBrowser
  Update-Status
  $timer.Start()
  if (-not $vals['ADMIN_EMAIL'] -or -not $vals['ADMIN_PASSWORD']) {
    Write-Log 'Welcome! Set your admin email and password below, then click Start & open.'
    $tEmail.Focus() | Out-Null
  } elseif ($chkAuto.Checked -and -not (Test-Running)) {
    Start-App
  } elseif ((Test-Running) -and (Test-PackagesChanged)) {
    Write-Log 'An update was installed. PostGenX needs a restart to finish it.'
    Restart-IfRunning 'An update was installed and needs new app packages (about a minute).'
  } else {
    Write-Log 'Ready.'
  }
})

[void]$form.ShowDialog()
