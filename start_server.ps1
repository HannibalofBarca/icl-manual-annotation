# Starts the ICL manual annotation server on the local LAN.
#
# Usage:
#   .\start_server.ps1
#   .\start_server.ps1 -Dataset "owner/other-dataset"
#   .\start_server.ps1 -Dataset "owner/other-dataset" -Port 9000
#
# -Dataset must be a lerobot v2.1 dataset on Hugging Face. The tool still
# assumes a bimanual robot with exactly 3 cameras keyed
# observation.images.{zed,fish0,fish1} — only the dataset itself is
# configurable, see README.md.
param(
    [string]$Dataset = "adityx23/icl-dataset",
    [string]$BindHost = "0.0.0.0",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notmatch "^169\.254\."
} | Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host "Starting server for dataset '$Dataset'..."
Write-Host "  Local:  http://127.0.0.1:$Port"
Write-Host "  LAN:    http://${ip}:${Port}"
Write-Host ""

conda run --no-capture-output -n lerobot python server.py --dataset $Dataset --host $BindHost --port $Port
