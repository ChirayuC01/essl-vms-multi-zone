; Phase 6 task 7 -- packages installer/release/ (staged by build-release.mjs)
; into one double-clickable installer. No client name anywhere (CLAUDE.md
; hard rule #1) -- this is a generic multi-client product.
;
; SourceDir / AppDirName / OutputBaseFilename are overridable via ISCC's /D
; command-line switch; TestBuild is a flag (no value) that also switches
; AppId to a separate, fixed GUID so a test install never collides with the
; real product's Add/Remove Programs entry. Example test compile:
;   iscc /DTestBuild /DSourceDir=release-test /DAppDirName=VMS-test ^
;        /DOutputBaseFilename=vms-setup-test vms-installer.iss
; This is how an isolated test build gets compiled without ever touching
; the real product's identity, install path, or service names -- the
; service names themselves live in install-services.ps1 and are untouched
; either way; a test run uses a separately-prepared copy of that script
; with the names substituted, never the committed source.

#ifndef SourceDir
#define SourceDir "release"
#endif
#ifndef AppDirName
#define AppDirName "VMS"
#endif
#ifndef OutputBaseFilename
#define OutputBaseFilename "vms-setup"
#endif

[Setup]
#ifdef TestBuild
AppId={{11111111-1111-1111-1111-111111111111}
#else
AppId={{A1F3E9B2-7C4D-4A6E-9F1B-2C6D4E8A0F31}
#endif
AppName=Visitor Management System
AppVersion=0.5.0
AppPublisher=Visitor Management System
DefaultDirName=C:\{#AppDirName}
DefaultGroupName=Visitor Management System
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputDir=Output
OutputBaseFilename={#OutputBaseFilename}
#ifdef TestBuild
Compression=zip
SolidCompression=no
#else
Compression=lzma2
SolidCompression=yes
#endif
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
DisableWelcomePage=no

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Code]
// Backend port only -- the web console's own port (FrontendPort) and the
// bundled Postgres port (DatabasePort) are fixed. The web console ships as
// a pre-built .next bundle with no rebuild step available here, so making
// ITS port choosable would need a rebuild; the backend's port has no such
// constraint, since the (already-runtime-configurable) backend URL the
// frontend calls is now resolved at request time, not baked in -- see
// web/src/app/layout.tsx and web/scripts/first-run-env.mjs.
const
  FrontendPort = '47101';
  DatabasePort = '47103';

var
  PortsPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  PortsPage := CreateInputQueryPage(wpSelectDir,
    'Backend Port',
    'Choose the port the VMS backend (operator API + device endpoints) will listen on.',
    'Leave the default unless something else on this machine already uses it. ' +
    'The web console (port ' + FrontendPort + ') and the bundled database use fixed ports.');
  PortsPage.Add('Backend port:', False);
  PortsPage.Values[0] := '47102';
end;

function IsValidPort(const S: String): Boolean;
var
  N: Integer;
begin
  N := StrToIntDef(S, -1);
  Result := (N >= 1) and (N <= 65535);
end;

// A tiny PowerShell probe, written to a temp file and run once per port
// checked (see PortOwner below). Get-NetTCPConnection is the fast path
// (built into Windows 8/Server 2012+); netstat -ano is the fallback for
// anywhere that cmdlet is missing. Deliberately has no dependency on
// anything else in the release payload -- this only ever runs from inside
// the wizard, before any files are even in their final place.
function PortCheckScript: String;
begin
  Result :=
    'param([int]$Port)' + #13#10 +
    '$owner = $null' + #13#10 +
    'try {' + #13#10 +
    '  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1' + #13#10 +
    '  if ($conn) {' + #13#10 +
    '    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue' + #13#10 +
    '    if ($proc) { $owner = $proc.ProcessName } else { $owner = "pid $($conn.OwningProcess)" }' + #13#10 +
    '  }' + #13#10 +
    '} catch {' + #13#10 +
    '  $line = netstat -ano | Select-String ":$Port\s.*LISTENING" | Select-Object -First 1' + #13#10 +
    '  if ($line) {' + #13#10 +
    '    $parts = ($line.ToString() -split "\s+")' + #13#10 +
    '    $ownerPid = $parts[-1]' + #13#10 +
    '    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue' + #13#10 +
    '    if ($proc) { $owner = $proc.ProcessName } else { $owner = "pid $ownerPid" }' + #13#10 +
    '  }' + #13#10 +
    '}' + #13#10 +
    'if ($owner) { Write-Output "$Port=$owner" } else { Write-Output "$Port=FREE" }';
end;

// Returns '' if the port looks free, OR if the check itself couldn't run for
// any reason -- this is a best-effort diagnostic, never a reason to block an
// install. Otherwise returns the name of whatever process is listening.
//
// Only trusts output shaped exactly like "<port>=<value>" (the one line the
// script above ever prints on success) -- anything else (a PowerShell error
// dumped to the same redirected file, a missing/partial write) is treated as
// "couldn't check", not misread as either a conflict or an all-clear.
function PortOwner(const Port: String): String;
var
  ScriptFile, ResultFile, Output, Prefix: String;
  Raw: AnsiString;
  ResultCode: Integer;
begin
  Result := '';
  ScriptFile := ExpandConstant('{tmp}\vms-check-port.ps1');
  ResultFile := ExpandConstant('{tmp}\vms-check-port-result.txt');
  if not SaveStringToFile(ScriptFile, PortCheckScript, False) then exit;
  DeleteFile(ResultFile);
  if not Exec('cmd.exe',
      '/C powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + ScriptFile + '" -Port ' + Port +
      ' > "' + ResultFile + '" 2>&1',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then exit;
  if not LoadStringFromFile(ResultFile, Raw) then exit;
  Output := Trim(String(Raw));
  Prefix := Port + '=';
  if Copy(Output, 1, Length(Prefix)) <> Prefix then exit;
  Output := Copy(Output, Length(Prefix) + 1, Length(Output));
  if Output = 'FREE' then exit;
  Result := Output;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Owner, Warning: String;
begin
  Result := True;
  if CurPageID = PortsPage.ID then
  begin
    if not IsValidPort(PortsPage.Values[0]) then
    begin
      MsgBox('Enter a valid backend port (1-65535).', mbError, MB_OK);
      Result := False; exit;
    end;
    if (PortsPage.Values[0] = FrontendPort) or (PortsPage.Values[0] = DatabasePort) then
    begin
      MsgBox('That port is reserved for the web console or the database. Choose a different one.', mbError, MB_OK);
      Result := False; exit;
    end;

    Warning := '';
    Owner := PortOwner(PortsPage.Values[0]);
    if Owner <> '' then
      Warning := Warning + 'Backend port ' + PortsPage.Values[0] + ' appears to be in use by "' + Owner + '".' + #13#10;
    Owner := PortOwner(FrontendPort);
    if Owner <> '' then
      Warning := Warning + 'Web console port ' + FrontendPort + ' appears to be in use by "' + Owner + '".' + #13#10;
    Owner := PortOwner(DatabasePort);
    if Owner <> '' then
      Warning := Warning + 'Database port ' + DatabasePort + ' appears to be in use by "' + Owner + '".' + #13#10;

    if Warning <> '' then
    begin
      Warning := Warning + #13#10 +
        'The affected service(s) may fail to start. If this is a previous ' +
        'VMS install, it will be safely replaced when Setup continues.' + #13#10#13#10 +
        'Continue anyway?';
      if MsgBox(Warning, mbConfirmation, MB_YESNO) = IDNO then
      begin
        Result := False; exit;
      end;
    end;
  end;
end;

function GetBackendPort(Param: String): String;
begin
  Result := PortsPage.Values[0];
end;

// Upgrades replace native DLLs loaded by the running backend. [Run] happens
// after [Files], so install-services.ps1 is too late to release those locks.
// Stop only our named services before copying; a fresh install has none and
// passes through unchanged. Setup starts/re-registers them again below.
function StopExistingServicesScript: String;
begin
  Result :=
    '$ErrorActionPreference = "Stop"' + #13#10 +
    'foreach ($name in @("VmsWeb", "VmsBackend", "VmsPostgres")) {' + #13#10 +
    '  $service = Get-Service -Name $name -ErrorAction SilentlyContinue' + #13#10 +
    '  if (($null -ne $service) -and ($service.Status -ne "Stopped")) {' + #13#10 +
    '    Stop-Service -Name $name -Force -ErrorAction Stop' + #13#10 +
    '    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))' + #13#10 +
    '  }' + #13#10 +
    '}';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ScriptFile: String;
  ResultCode: Integer;
begin
  Result := '';
  ScriptFile := ExpandConstant('{tmp}\vms-stop-existing-services.ps1');
  if not SaveStringToFile(ScriptFile, StopExistingServicesScript, False) then
  begin
    Result := 'Setup could not prepare the existing VMS services for upgrade.';
    exit;
  end;
  if (not Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptFile + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
    Result := 'Setup could not stop the existing VMS services. Close VMS tools and retry as Administrator.';
end;

[Run]
; Generates a real .env (fresh JWT_SECRET, bundled Postgres DATABASE_URL,
; and the chosen backend port) via the bundled node.exe -- no PATH
; dependency, works on a machine with nothing pre-installed. Same script
; already verified in tasks 3/6/7.
Filename: "{app}\node\node.exe"; \
    Parameters: """{app}\backend\scripts\first-run-env.mjs"" --backend-port={code:GetBackendPort}"; \
    WorkingDir: "{app}\backend"; \
    StatusMsg: "Configuring environment..."; \
    Flags: runhidden waituntilterminated

; Registers and starts VmsPostgres, VmsBackend, VmsWeb (which also
; configures web\.env so the pre-built frontend learns the chosen backend
; port -- see install-services.ps1). Runs elevated automatically --
; PrivilegesRequired=admin above means this whole installer, and everything
; it spawns, already holds an admin token.
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\backend\scripts\windows-services\install-services.ps1"" -BackendPort {code:GetBackendPort}"; \
    WorkingDir: "{app}\backend\scripts\windows-services"; \
    StatusMsg: "Registering Windows services..."; \
    Flags: runhidden waituntilterminated

; Interactive installs only (skipped under /VERYSILENT) -- lands directly
; on /setup for a fresh install, exactly as verified live in task 4.
Filename: "{sys}\cmd.exe"; \
    Parameters: "/c start """" ""http://localhost:47101"""; \
    Description: "Open the VMS operator console"; \
    Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stops and deregisters all three services BEFORE Inno Setup tries to
; delete their .exe files -- exactly the file-lock failure mode found and
; fixed in task 6 (Copy-Item on a running service's own executable).
Filename: "powershell.exe"; \
    Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\backend\scripts\windows-services\uninstall-services.ps1"""; \
    WorkingDir: "{app}\backend\scripts\windows-services"; \
    RunOnceId: "UninstallVmsServices"; \
    Flags: runhidden waituntilterminated

; No [UninstallDelete] section, deliberately. Inno Setup's generated
; uninstaller only ever removes files it tracked from [Files] above --
; backend\data (pgdata, and person photos: the durable identity artifact) is
; created at runtime by the running services, was never listed in [Files],
; and is therefore never a
; candidate for removal. Nothing needs to explicitly protect it; nothing
; here is capable of deleting it in the first place.
