# Enter the actual router Wi-Fi password at the hidden prompt. This script
# sends it directly over USB and does not write it to a file or command line.
param([Parameter(Mandatory)][ValidatePattern('^COM\d+$')][string]$Port,[string]$Ssid,
      [switch]$UseSavedWifi,[switch]$InfoOnly)
$ErrorActionPreference='Stop'
if(!$UseSavedWifi -and !$InfoOnly -and [string]::IsNullOrWhiteSpace($Ssid)){throw 'Supply the router SSID with -Ssid.'}
$store=Join-Path $PSScriptRoot 'private'
New-Item -ItemType Directory -Force -Path $store | Out-Null
$serial=[IO.Ports.SerialPort]::new($Port,115200)
$serial.NewLine=[string][char]10;$serial.ReadTimeout=350;$serial.WriteTimeout=2500
function Read-Hub([string]$Pattern,[int]$Seconds){
  $until=[DateTime]::UtcNow.AddSeconds($Seconds)
  while([DateTime]::UtcNow -lt $until){
    try{$line=$serial.ReadLine().Trim();if($line -match $Pattern){return $line}}catch [TimeoutException]{}
  }
  throw ('No ESP32 reply for: '+$Pattern)
}
function Write-Frame($Frame){
  $serial.WriteLine((ConvertTo-Json -InputObject $Frame -Compress))
}
function Get-HubInfo{
  $serial.DiscardInBuffer();$serial.WriteLine('INFO')
  $state=Read-Hub '^FLHUB (?:-|[\d.]+) (?:READY|WAIT)$' 3
  $member=Read-Hub '^MEMBER [0-9a-f]{20}$' 3
  $operator=Read-Hub '^OPERATOR [0-9a-f]{24}$' 3
  @($state,$member,$operator)
}
function Save-HubInfo($Info){
  $foundIp=($Info[0] -split ' ')[1]
  $url='https://'+$foundIp
  @(('URL '+$url),$Info[1],$Info[2]) | Set-Content -LiteralPath (Join-Path $store 'hub-access.log') -Encoding utf8
  Write-Output ('Hub page: '+$url)
  Write-Output ('Invites are in '+(Join-Path $store 'hub-access.log'))
}
try {
  $serial.Open();Start-Sleep -Milliseconds 850
  $info=Get-HubInfo
  if($InfoOnly){
    if($info[0] -notmatch ' READY$'){throw 'Hub is not ready; complete provisioning first.'}
    Save-HubInfo $info;exit
  }
  if(!$UseSavedWifi){
    $password=Read-Host "Wi-Fi password for $Ssid" -AsSecureString
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    try{Write-Frame @{action='wifi';ssid=$Ssid;password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}}
    finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$password.Dispose()}
    if((Read-Hub '^WIFI (?:SAVED|ERROR)$' 6) -ne 'WIFI SAVED'){throw 'The board rejected the Wi-Fi settings.'}
    Start-Sleep -Seconds 3
  }
  $until=[DateTime]::UtcNow.AddSeconds(28);$ip=''
  do{
    $info=Get-HubInfo
    if($info[0] -match '^FLHUB ([\d.]+) (?:READY|WAIT)$'){$ip=$Matches[1];break}
    Start-Sleep -Seconds 2
  }while([DateTime]::UtcNow -lt $until)
  if(!$ip){throw 'The board has not joined the router. Check SSID, password and 2.4 GHz Wi-Fi.'}
  $hostIp=[Net.IPAddress]::Parse($ip)
  $name='fieldlink.local'
  $hash=[Security.Cryptography.HashAlgorithmName]::SHA256
  $caKey=[Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
  $leafKey=[Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
  try{
    $before=[DateTimeOffset]::UtcNow.AddMinutes(-20);$after=$before.AddDays(180)
    $caReq=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Field Link ESP32 Demo CA',$caKey,$hash)
    $caReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$true,0,$true))
    $flags=[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
    $caReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($flags,$true))
    $ca=$caReq.CreateSelfSigned($before,$after.AddDays(1))
    $leafReq=[Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$name",$leafKey,$hash)
    $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress($hostIp);$san.AddDnsName($name);$leafReq.CertificateExtensions.Add($san.Build())
    $usage=[Security.Cryptography.OidCollection]::new();[void]$usage.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $leafReq.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usage,$false))
    $serialNumber=[Security.Cryptography.RandomNumberGenerator]::GetBytes(16);$serialNumber[0]=($serialNumber[0] -band 127) -bor 1
    $leaf=$leafReq.Create($ca,$before,$after,$serialNumber)
    Write-Frame @{action='tls';cert=$leaf.ExportCertificatePem();key=$leafKey.ExportPkcs8PrivateKeyPem()}
    if((Read-Hub '^TLS (?:SAVED|ERROR)$' 7) -ne 'TLS SAVED'){throw 'The board rejected the HTTPS certificate.'}
    [IO.File]::WriteAllBytes((Join-Path $store 'field-link-hub-ca.crt'),$ca.RawData)
  }finally{
    if($leaf){$leaf.Dispose()};if($ca){$ca.Dispose()};$leafKey.Dispose();$caKey.Dispose()
  }
  $ready=Read-Hub '^HTTPS (?:READY [\d.]+|ERROR)$' 24
  if($ready -eq 'HTTPS ERROR'){throw 'The HTTPS server failed to start.'}
  $info=Get-HubInfo;Save-HubInfo $info
  Write-Output ('Public demo CA: '+(Join-Path $store 'field-link-hub-ca.crt'))
}finally{$serial.Dispose()}
