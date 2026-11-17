$envPath = Join-Path $PSScriptRoot '.env'
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^(\w+)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
    }
  }
}
$log = Join-Path $PSScriptRoot "test_10users_ai.log"
Write-Host "Running AI matching test for 10 users... (log: $log)"
node test_10users_ai.mjs *>&1 | Tee-Object -FilePath $log
