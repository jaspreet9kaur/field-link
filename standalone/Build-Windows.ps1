param([Parameter(Mandatory)][string]$SdkPackage,[switch]$UseExistingHubPin)
$ErrorActionPreference='Stop'
$version='1.0.4314.35'
$expected='70E6A256A3F7066407327C46A59CC034CDB6B545E0C9CAE2B322478C818DCC868CB26F225E3ECAC7E71E620F916D8C09B734F4D3DA9F7054E872F54B63E7A433'
if(!(Test-Path -LiteralPath $SdkPackage)){throw 'Download Microsoft.Web.WebView2 1.0.4314.35 from NuGet first.'}
if((Get-FileHash -LiteralPath $SdkPackage -Algorithm SHA512).Hash -ne $expected){throw 'Unexpected WebView2 package checksum.'}
$src=Join-Path $PSScriptRoot 'windows'
$build=Join-Path $PSScriptRoot '.build\windows'
$sdk=Join-Path $build ('webview2-'+$version)
$release=Join-Path $PSScriptRoot 'release'
$app=Join-Path $release 'Field-Link-Windows'
New-Item -ItemType Directory -Force -Path $build,$app | Out-Null
if(!(Test-Path -LiteralPath (Join-Path $sdk 'LICENSE.txt'))){
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($SdkPackage,$sdk)
}
$pinFile=Join-Path $build 'hub.txt'
if($UseExistingHubPin){
  $pin=@(Get-Content -LiteralPath $pinFile)
  $provisioned=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'private\hub-access.log') |
    Where-Object {$_ -match '^URL https://[\d.]+$'} | Select-Object -First 1
  if(!$provisioned -or $pin.Count -ne 2 -or ('URL '+$pin[0]) -ne $provisioned -or $pin[1] -cnotmatch '^[a-f0-9]{64}$'){
    throw 'The cached certificate pin does not match the provisioned hub configuration.'
  }
}else{
  $pin=& node (Join-Path $src 'Read-HubPin.mjs')
  if($LASTEXITCODE -ne 0 -or $pin.Count -ne 2){throw 'Could not verify the local hub certificate.'}
  $pin | Set-Content -LiteralPath $pinFile -Encoding ascii
}
$lib=Join-Path $sdk 'lib\net462'
$core=Join-Path $lib 'Microsoft.Web.WebView2.Core.dll'
$winForms=Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll'
$framework=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$exe=Join-Path $app 'Field-Link.exe'
$compilerArgs=@('/nologo','/target:winexe','/platform:x64','/optimize+',"/out:$exe", "/reference:$core", "/reference:$winForms",
  '/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Security.dll','/reference:System.Web.Extensions.dll',
  "/resource:$pinFile,hub.txt", "/resource:$(Join-Path $src 'bridge.js'),bridge.js", (Join-Path $src 'Program.cs'), (Join-Path $src 'Hub.cs'))
& (Join-Path $framework 'csc.exe') @compilerArgs
if($LASTEXITCODE -ne 0){throw 'Windows compilation failed.'}
$bundle=@($exe)
foreach($dependency in @($core,$winForms,(Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll'),(Join-Path $sdk 'LICENSE.txt'))){
  Copy-Item -LiteralPath $dependency -Destination $app -Force
  $bundle+=Join-Path $app (Split-Path -Leaf $dependency)
}
$archive=Join-Path $release 'Field-Link-Windows-x64.zip'
Compress-Archive -LiteralPath $bundle -DestinationPath $archive -Force
Get-Item -LiteralPath $exe,$archive | Select-Object Name,Length,FullName
