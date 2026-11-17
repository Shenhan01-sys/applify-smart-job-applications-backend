# Applify - launch worker in BACKGROUND (tsx, from worker/.env).
$ErrorActionPreference = "Stop"
$root = "C:\Users\hansg\HansProject\SolveItAnd0GAndBinanceProject\project"
Get-Content "$root\worker\.env" | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), 'Process')
  }
}
$log  = "$root\worker\worker.log"
$errf = "$root\worker\worker.log.err"
Remove-Item $log, $errf -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath "npx" -ArgumentList "tsx","src/worker.ts" `
  -WorkingDirectory "$root\worker" `
  -RedirectStandardOutput $log -RedirectStandardError $errf `
  -PassThru -WindowStyle Hidden
Write-Output "Started worker PID=$($proc.Id) -> out=$log err=$errf"
