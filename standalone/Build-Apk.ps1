param([string]$Sdk=$env:ANDROID_HOME,[string]$JavaHome=$env:JAVA_HOME,[switch]$BundledHub)
$ErrorActionPreference='Stop'
if(!$Sdk -or !$JavaHome){throw 'Set ANDROID_HOME and JAVA_HOME, or supply -Sdk and -JavaHome.'}
$env:JAVA_HOME=$JavaHome
$jdkBin=Join-Path $JavaHome 'bin'
$env:Path=$jdkBin+[IO.Path]::PathSeparator+$env:Path
$tools=Join-Path $Sdk 'build-tools\35.0.0'
$platform=Join-Path $Sdk 'platforms\android-35\android.jar'
if(!(Test-Path -LiteralPath $platform)){throw 'Android platform 35 is not installed.'}
$src=Join-Path $PSScriptRoot 'android'
$out=Join-Path $PSScriptRoot '.build\android'
$private=Join-Path $PSScriptRoot 'private'
$release=Join-Path $PSScriptRoot 'release'
$gen=Join-Path $out 'gen';$classes=Join-Path $out 'classes';$dex=Join-Path $out 'dex'
New-Item -ItemType Directory -Force -Path $gen,$classes,$dex,$private,$release | Out-Null
function Checked([string]$Command,[string[]]$Arguments) {
  & $Command @Arguments
  if($LASTEXITCODE){throw ((Split-Path -Leaf $Command)+' failed (exit '+$LASTEXITCODE+').')}
}
$compiled=Join-Path $out 'resources.zip';$base=Join-Path $out 'base.apk';$aligned=Join-Path $out 'aligned.apk'
$res=Join-Path $out ('res-'+[Guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath (Join-Path $src 'res') -Destination $res -Recurse
$hub=''
if($BundledHub){
  $ca=Join-Path $private 'field-link-hub-ca.crt'
  if(!(Test-Path -LiteralPath $ca)){throw 'Provision the ESP32 hub before bundling its public certificate.'}
  $record=Get-Content -LiteralPath (Join-Path $private 'hub-access.log') | Where-Object {$_ -match '^URL https://[\d.]+$'} | Select-Object -First 1
  if(!$record){throw 'The hub URL is missing.'};$hub=$record.Substring(4)
  $raw=Join-Path $res 'raw';New-Item -ItemType Directory -Force -Path $raw | Out-Null
  Copy-Item -LiteralPath $ca -Destination (Join-Path $raw 'fieldlink_hub_ca.crt')
  $config=Join-Path $res 'xml\network_security.xml'
  (Get-Content -Raw -LiteralPath $config).Replace('<certificates src="user"/>','<certificates src="@raw/fieldlink_hub_ca"/>') |
    Set-Content -LiteralPath $config -Encoding utf8
}
Set-Content -LiteralPath (Join-Path $res 'values\hub.xml') -Encoding utf8 -Value ('<resources><string name="configured_hub">'+$hub+'</string></resources>')
Checked (Join-Path $tools 'aapt2.exe') @('compile','--dir',$res,'-o',$compiled)
Checked (Join-Path $tools 'aapt2.exe') @('link','-I',$platform,'--manifest',(Join-Path $src 'AndroidManifest.xml'),'--java',$gen,'--version-code','4','--version-name','0.4.0-demo','-o',$base,$compiled)
$java=@(Get-ChildItem -LiteralPath (Join-Path $src 'src'),$gen -Filter '*.java' -Recurse | ForEach-Object FullName)
Checked (Join-Path $jdkBin 'javac.exe') (@('--release','8','-encoding','UTF-8','-classpath',$platform,'-d',$classes)+$java)
$jar=Join-Path $out 'classes.jar'
Checked (Join-Path $jdkBin 'jar.exe') @('cf',$jar,'-C',$classes,'.')
Checked (Join-Path $tools 'd8.bat') @('--lib',$platform,'--min-api','26','--output',$dex,$jar)
Checked (Join-Path $jdkBin 'jar.exe') @('uf',$base,'-C',$dex,'classes.dex')
Checked (Join-Path $tools 'zipalign.exe') @('-f','-p','4',$base,$aligned)
$keystore=Join-Path $private 'android-demo-signing.p12'
$passFile=Join-Path $private 'android-demo-signing.pass'
if((Test-Path -LiteralPath $keystore) -ne (Test-Path -LiteralPath $passFile)){throw 'Demo signing material is incomplete.'}
if(!(Test-Path -LiteralPath $passFile)){
  $random=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
  [IO.File]::WriteAllText($passFile,$random)
}
$env:FIELDLINK_APK_KEY=[IO.File]::ReadAllText($passFile)
try{
  if(!(Test-Path -LiteralPath $keystore)){
    Checked (Join-Path $jdkBin 'keytool.exe') @('-genkeypair','-alias','fieldlink-demo','-keyalg','RSA','-keysize','2048','-validity','3650',
      '-dname','CN=Field Link Local Demo','-storetype','PKCS12','-keystore',$keystore,'-storepass:env','FIELDLINK_APK_KEY','-noprompt')
  }
  $apk=Join-Path $release $(if($BundledHub){'Field-Link-Android-Router.apk'}else{'Field-Link-Android.apk'})
  Checked (Join-Path $tools 'apksigner.bat') @('sign','--ks',$keystore,'--ks-key-alias','fieldlink-demo','--ks-pass','env:FIELDLINK_APK_KEY','--out',$apk,$aligned)
  Checked (Join-Path $tools 'apksigner.bat') @('verify','--verbose',$apk)
  Get-FileHash -LiteralPath $apk -Algorithm SHA256
}finally{Remove-Item Env:FIELDLINK_APK_KEY -ErrorAction SilentlyContinue}
