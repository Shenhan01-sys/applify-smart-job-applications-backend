$envPath = Join-Path $PSScriptRoot '.env'
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^(\w+)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
    }
  }
}
$log = Join-Path $PSScriptRoot "retry_failed_users.log"
Write-Host "Retrying failed users with alternative models... (log: $log)"
node test_10users_ai.mjs *>&1 | Tee-Object -FilePath $log
