# Requires PowerShell 7. Does not change Windows network or certificate settings.
param([string]$LanIp, [switch]$ReplaceLaptopSession,
      [ValidateRange(0,900)][int]$WaitSeconds=0, [int]$LaptopServerPid=0,
      [ValidateLength(1,64)][string]$RouterNetworkName)
$ErrorActionPreference = 'Stop'
if (!$LanIp) {
  $deadline=[DateTime]::UtcNow.AddSeconds($WaitSeconds)
  $expectedNetwork=if($RouterNetworkName){$RouterNetworkName}else{'FieldLink-Local'}
  if($WaitSeconds){Write-Output ('Waiting for this laptop to join '+$expectedNetwork+'.')}
  do {
    if($RouterNetworkName){
      $aliases=@(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq $RouterNetworkName } | ForEach-Object InterfaceAlias)
      $addresses=@([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq 'Up' -and $_.Name -in $aliases } |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        ForEach-Object Address | Where-Object {
          $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and
          $_.ToString() -match '^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)'
        } | ForEach-Object ToString | Select-Object -Unique)
    } else {
      $addresses = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object OperationalStatus -eq Up |
        ForEach-Object { $_.GetIPProperties() } |
        Where-Object { @($_.GatewayAddresses | ForEach-Object { $_.Address.ToString() }) -contains '192.168.4.1' } |
        ForEach-Object { $_.UnicastAddresses } |
        ForEach-Object { $_.Address.ToString() } |
        Where-Object { $_ -match '^192\.168\.4\.(?:[2-9]|\d{2,3})$' } |
        Select-Object -Unique)
    }
    if($addresses.Count -eq 1 -or [DateTime]::UtcNow -ge $deadline){break}
    Start-Sleep -Seconds 2
  } while ($true)
  if ($addresses.Count -ne 1) { throw ('Join '+$expectedNetwork+' on the laptop, or provide its verified LAN IPv4 address with -LanIp.') }
  $LanIp = $addresses[0]
}
$parsedIp = [Net.IPAddress]::Parse($LanIp)
if ($parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or [Net.IPAddress]::IsLoopback($parsedIp) -or $parsedIp.Equals([Net.IPAddress]::Any)) {
  throw 'Enter the laptop IPv4 address on the local network.'
}
$LanIp = $parsedIp.ToString()
$tlsRoot = Join-Path (Join-Path $PSScriptRoot 'tls') $LanIp
if (!(Test-Path -LiteralPath $tlsRoot)) {
  & (Join-Path $PSScriptRoot 'New-LocalCertificate.ps1') -LanIp $LanIp -PerAddress
}
$cert = Join-Path $tlsRoot 'server.pem'
$key = Join-Path $tlsRoot 'server-key.pem'
$ca = Join-Path $tlsRoot 'field-link-ca.crt'
foreach ($file in @($cert,$key,$ca)) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The phone certificate folder is incomplete. Move it aside and retry.' }
}
if ($ReplaceLaptopSession) {
  $localPage = try { (Invoke-WebRequest 'http://127.0.0.1:8443/' -NoProxy -TimeoutSec 2).Content } catch { '' }
  if ($localPage) {
    $line = netstat -ano -p tcp | Select-String '127\.0\.0\.1:8443\s+\S+\s+LISTENING\s+(\d+)' | Select-Object -First 1
    if ($localPage -notmatch '<title>Field Link' -or (!$line -and !$LaptopServerPid)) { throw 'Could not confirm that Field Link owns port 8443. Stop the existing server manually.' }
    $owner = if($line){[int]$line.Matches[0].Groups[1].Value}else{$LaptopServerPid}
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId='+$owner)
    if (!$process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'server\.mjs') { throw 'Could not confirm the Field Link process. Stop the existing server manually.' }
    if ($process.CommandLine -match '\s--lan\s+"?(\d{1,3}(?:\.\d{1,3}){3})') {
      $oldAddress=$Matches[1]
      $assigned=@([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object OperationalStatus -eq Up |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        ForEach-Object { $_.Address.ToString() })
      if($oldAddress -in $assigned){throw 'Phone mode is already running on an attached address. Stop it manually before changing networks.'}
    } elseif($process.CommandLine -match '\s--lan\s'){
      throw 'Could not verify the previous phone listener address. Stop it manually before changing networks.'
    }
    Stop-Process -Id $owner -ErrorAction Stop
    Wait-Process -Id $owner -Timeout 5 -ErrorAction SilentlyContinue
  }
}
Write-Output ('Phone CA to transfer: '+$ca)
Write-Output ('CA SHA-256: '+(Get-FileHash -LiteralPath $ca -Algorithm SHA256).Hash)
& node (Join-Path $PSScriptRoot 'server.mjs') --lan $LanIp $cert $key
exit $LASTEXITCODE
