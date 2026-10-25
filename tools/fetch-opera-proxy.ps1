# Скачивание бинарника opera-proxy v1.31.0 для Windows / Android arm64
$ErrorActionPreference = "Stop"
$Proj = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $Proj "modules\opera-proxy\android\src\main\jniLibs\arm64-v8a"
$TargetSo = Join-Path $TargetDir "libopera_proxy.so"
$HashFile = Join-Path $Proj "tools\opera-proxy.sha256"

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
$Url = "https://github.com/Alexey71/opera-proxy/releases/download/v1.31.0/opera-proxy.android-arm64"

Write-Host "=== Скачивание opera-proxy v1.31.0 (arm64) ==="
Invoke-WebRequest -Uri $Url -OutFile $TargetSo

if (Test-Path $HashFile) {
    $Expected = (Get-Content $HashFile | Select-Object -First 1).Split(' ')[0]
    $Actual = (Get-FileHash -Path $TargetSo -Algorithm SHA256).Hash.ToLower()
    if ($Expected -ne $Actual) {
        Write-Error "SHA-256 mismatch ($Actual != $Expected)"
        exit 1
    }
    Write-Host "SHA-256 verified: $Actual"
}

Write-Host "opera-proxy saved to $TargetSo"
