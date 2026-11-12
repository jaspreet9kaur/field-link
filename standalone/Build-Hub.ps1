param([ValidatePattern('^COM\d+$')][string]$Port,
      [switch]$UploadOnly, [string]$ArduinoCli='arduino-cli')
$ErrorActionPreference='Stop'
if($UploadOnly -and !$Port){throw 'Specify -Port with -UploadOnly.'}
$cli=$ArduinoCli
if($PSBoundParameters.ContainsKey('Port') -and !$Port){throw 'Specify the board COM port.'}
$sketch=Join-Path $PSScriptRoot 'firmware\FieldLinkHub'
$build=Join-Path $PSScriptRoot '.build\esp32'
if(!$UploadOnly){
  & node (Join-Path $PSScriptRoot 'Embed-Web.mjs')
  if($LASTEXITCODE){exit $LASTEXITCODE}
  & $cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app --jobs 5 --build-path $build $sketch
  if($LASTEXITCODE){exit $LASTEXITCODE}
}
if($Port){
  & $cli upload --fqbn esp32:esp32:esp32:PartitionScheme=huge_app,UploadSpeed=115200 --port $Port --input-dir $build $sketch
  if($LASTEXITCODE){exit $LASTEXITCODE}
}
