param([int]$Count = 10)
$envPath = Join-Path $PSScriptRoot '.env'
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^(\w+)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
    }
  }
}
$env:SEED_COUNT = [string]$Count
$log = Join-Path $PSScriptRoot "seed_${Count}_users.log"
Write-Host "Seeding $Count users... (log: $log)"
node seed_10_users.mjs *>&1 | Tee-Object -FilePath $log
