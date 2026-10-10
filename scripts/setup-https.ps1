param(
  [Parameter(Mandatory = $true)]
  [string]$IpAddress
)

$ErrorActionPreference = "Stop"

$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($IpAddress, [ref]$parsedAddress) -or $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw "Enter the laptop's IPv4 address from ipconfig."
}

$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envPath = Join-Path $projectDirectory ".env"
if (-not (Test-Path $envPath)) {
  throw "The project .env file was not found. Configure the database first, then rerun this script."
}

$certificateDirectory = Join-Path $projectDirectory "certs"
New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null

$caCertificate = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.Subject -eq "CN=NyayArchive Local Development CA" -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $caCertificate) {
  $caCertificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject "CN=NyayArchive Local Development CA" `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -TextExtension @("2.5.29.19={critical}{text}ca=1&pathlength=0") `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(5)
}

$serverCertificate = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=NyayArchive Local HTTPS" `
  -Signer $caCertificate `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -TextExtension @(
    "2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1&IPAddress=$IpAddress",
    "2.5.29.19={critical}{text}ca=0",
    "2.5.29.37={text}1.3.6.1.5.5.7.3.1"
  ) `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(2)

$pfxPath = Join-Path $certificateDirectory "nyayarchive.pfx"
$caPath = Join-Path $certificateDirectory "nyayarchive-root.cer"
$passwordBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($passwordBytes)
} finally {
  $random.Dispose()
}
$pfxPassword = ([BitConverter]::ToString($passwordBytes)).Replace("-", "")
$securePassword = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
Export-PfxCertificate -Cert $serverCertificate -FilePath $pfxPath -Password $securePassword | Out-Null
Export-Certificate -Cert $caCertificate -FilePath $caPath -Type CERT | Out-Null
if (-not (Test-Path $pfxPath) -or -not (Test-Path $caPath)) {
  throw "Certificate export did not create both expected certificate files."
}

Import-Certificate -FilePath $caPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null

$envContent = [System.IO.File]::ReadAllText($envPath)
$envContent = [regex]::Replace($envContent, "(?m)^HTTPS_PFX_PATH=.*(?:\r?\n|$)", "")
$envContent = [regex]::Replace($envContent, "(?m)^HTTPS_PFX_PASSWORD=.*(?:\r?\n|$)", "")
$envContent = [regex]::Replace($envContent, "(?m)^HTTPS_CERT_PATH=.*(?:\r?\n|$)", "")
$envContent = [regex]::Replace($envContent, "(?m)^HTTPS_KEY_PATH=.*(?:\r?\n|$)", "")
if ($envContent.Length -gt 0 -and -not $envContent.EndsWith("`n")) {
  $envContent += [Environment]::NewLine
}
$envContent += "HTTPS_PFX_PATH=certs/nyayarchive.pfx$([Environment]::NewLine)HTTPS_PFX_PASSWORD=$pfxPassword$([Environment]::NewLine)"
[System.IO.File]::WriteAllText($envPath, $envContent, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "HTTPS certificate created and trusted on this Windows user account."
Write-Host "Stop the running app with Ctrl+C, then run npm.cmd start."
Write-Host "Open https://$($IpAddress):3000 on the laptop and phone."
Write-Host "Transfer only this public CA certificate privately to the phone and install it as a trusted CA:"
Write-Host $caPath
Write-Host "Never share certs/nyayarchive.pfx or the password stored in .env."
