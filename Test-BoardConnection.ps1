# Use with the browser disconnected from the USB port.
param([Parameter(Mandatory)][ValidatePattern('^COM\d+$')][string]$Port,
      [switch]$StartPhoneNetwork)
$ErrorActionPreference='Stop'
$serial=[IO.Ports.SerialPort]::new($Port,115200)
$serial.NewLine=[string][char]10
$serial.ReadTimeout=450
$serial.WriteTimeout=1000
function Wait-Reply([string]$Pattern,[int]$Seconds=6) {
  $end=[DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $end) {
    try {
      $line=$serial.ReadLine().Trim()
      if ($line -match $Pattern) { return $line }
    } catch [TimeoutException] {}
  }
  throw ('The board did not return the expected reply: '+$Pattern)
}
try {
  $serial.Open()
  Start-Sleep -Milliseconds 850
  $serial.DiscardInBuffer()
  $serial.WriteLine('PING')
  $heartbeat=Wait-Reply '^PONG (?:-|[0-9a-f-]{36}) [ILA]$'
  Write-Output ('Firmware heartbeat on '+$Port+': '+$heartbeat)
  $serial.WriteLine('AP?')
  $state=Wait-Reply '^AP (ON|OFF)$'
  Write-Output ('Current wireless mode: '+$state)
  if ($StartPhoneNetwork) {
    $password=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(10)).ToLowerInvariant()
    $serial.WriteLine('APSTART '+$password)
    $result=Wait-Reply '^AP (ON|ERROR)$' 9
    if ($result -ne 'AP ON') { throw 'The ESP32 could not start its access point.' }
    $localLog=Join-Path $PSScriptRoot 'field-link-phone-access.log'
    @('Network: FieldLink-Local',('Wi-Fi password: '+$password),'Expires on board reset or after one hour.') | Set-Content -LiteralPath $localLog -Encoding utf8
    Write-Output ('ESP32 confirmed AP ON. The temporary network password is in '+$localLog+'.')
  }
} finally {
  $serial.Dispose()
}
