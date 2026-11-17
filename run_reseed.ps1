$envPath = Join-Path $PSScriptRoot '.env'
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^(\w+)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
    }
  }
}
Write-Host "Re-seeding profiles for 10 dummy users..."
node reseed_10_profiles.mjs