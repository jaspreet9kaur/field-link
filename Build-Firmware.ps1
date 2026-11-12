param([ValidatePattern('^COM\d+$')][string]$Port,
      [switch]$UploadOnly, [string]$ArduinoCli='arduino-cli')
$ErrorActionPreference='Stop'
if($UploadOnly -and !$Port){throw 'Specify -Port with -UploadOnly.'}
$cli=$ArduinoCli
if($PSBoundParameters.ContainsKey('Port') -and !$Port){throw 'Specify the board COM port.'}
$build=Join-Path $PSScriptRoot '.build\desk'
$sketch=Join-Path $PSScriptRoot 'firmware\FieldLinkDesk'
if (!$UploadOnly) {
  New-Item -ItemType Directory -Force -Path $build | Out-Null
  & $Cli compile --fqbn esp32:esp32:esp32 --jobs 4 --build-path $build $sketch
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
if ($Port) {
  if ($Port -notmatch '^COM\d+$') { throw 'Select a Windows COM port.' }
  & $Cli upload --fqbn esp32:esp32:esp32:UploadSpeed=115200 --input-dir $build --port $Port $sketch
  exit $LASTEXITCODE
}
