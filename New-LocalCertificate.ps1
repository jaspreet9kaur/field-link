# PowerShell 7. Writes PEM files only. Does not change any certificate store.
param([Parameter(Mandatory)][string]$LanIp, [switch]$PerAddress)
$ErrorActionPreference = 'Stop'
$ip = [System.Net.IPAddress]::Parse($LanIp)
if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or [System.Net.IPAddress]::IsLoopback($ip) -or $ip.Equals([System.Net.IPAddress]::Any)) {
  throw 'Enter the laptop IPv4 address on the demonstration network.'
}
$out = Join-Path $PSScriptRoot 'tls'
if ($PerAddress) { $out = Join-Path $out $ip.ToString() }
foreach ($file in @('field-link-ca.crt','server.pem','server-key.pem')) {
  if (Test-Path -LiteralPath (Join-Path $out $file)) { throw 'Certificate files already exist. Use the existing certificate or move those files aside first.' }
}
$start = [DateTimeOffset]::UtcNow.AddMinutes(-10)
$end = $start.AddDays(30)
$hash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
$padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
$rootKey = [System.Security.Cryptography.RSA]::Create(3072)
$key = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $rootRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Field Link Demo CA',$rootKey,$hash,$padding)
  $rootRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$true,0,$true))
  $usage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
  $rootRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage,$true))
  $root = $rootRequest.CreateSelfSigned($start,$end.AddDays(1))
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$LanIp",$key,$hash,$padding)
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddIpAddress($ip)
  $request.CertificateExtensions.Add($san.Build())
  $oids = [System.Security.Cryptography.OidCollection]::new()
  [void]$oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
  $serial = [byte[]]::new(16)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($serial)
  $serial[0] = ($serial[0] -band 127) -bor 1
  $cert = $request.Create($root,$start,$end,$serial)
  New-Item -ItemType Directory -Path $out -Force | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $out 'field-link-ca.crt'),$root.RawData)
  [IO.File]::WriteAllText((Join-Path $out 'server.pem'),$cert.ExportCertificatePem())
  [IO.File]::WriteAllText((Join-Path $out 'server-key.pem'),$key.ExportPkcs8PrivateKeyPem())
  Write-Output ('Created a 30-day certificate for https://'+$LanIp+':8443. See README for device trust setup.')
} finally {
  if ($cert) { $cert.Dispose() }
  if ($root) { $root.Dispose() }
  $rootKey.Dispose()
  $key.Dispose()
}
