$envPath = Join-Path $PSScriptRoot '.env'
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^(\w+)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])
    }
  }
}
node check_dummy_profiles.mjs