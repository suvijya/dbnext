# Usage: .\shot.ps1 -Name hostile [-Query "case=hostile&theme=hc"] [-Size 1400,900] [-Dump]
# Screenshots go to <repo>/.tmp/shots. Run `npm run build` first. With -Dump, prints the #report text.
param([string]$Name, [string]$Query = "", [string]$Size = "1400,900", [switch]$Dump, [int]$Budget = 8000)
$repo = Resolve-Path "$PSScriptRoot\..\.."
$out = Join-Path $repo ".tmp\shots"
$prof = Join-Path $repo ".tmp\edge-profile"
New-Item -ItemType Directory -Force $out, $prof | Out-Null
if (-not $Query) { $Query = "case=$Name" }
$page = "file:///" + ((Join-Path $PSScriptRoot "index.html") -replace '\\', '/')
$url = "${page}?${Query}"
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$common = @("--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--user-data-dir=$prof", "--window-size=$Size", "--virtual-time-budget=$Budget", "--allow-file-access-from-files")
if ($Dump) {
  $dom = & $edge @common "--dump-dom" $url 2>$null | Out-String
  if ($dom -match '(?s)<pre id="report"[^>]*>(.*?)</pre>') { $Matches[1] } else { "(no report)" }
} else {
  $png = Join-Path $out "$Name.png"
  & $edge @common "--screenshot=$png" $url 2>$null | Out-Null
  $png
}
