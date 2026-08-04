#ifndef SourceDir
  #define SourceDir "publish"
#endif

#define MyAppName "Group Relay"
#define MyAppVersion "1.2.5"
#define MyAppPublisher "Group Relay"
#define MyAppExeName "GroupRelay.exe"

[Setup]
AppId={{1CE64E5B-B1F9-49B4-9B2C-86516E0B6E31}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Group Relay
DefaultGroupName=Group Relay
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=Group-Relay-Windows-x64-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Group Relay"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\Group Relay"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 Group Relay"; Flags: nowait postinstall skipifsilent
