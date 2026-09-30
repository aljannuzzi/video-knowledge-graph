#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaseUrl,
    [Parameter(Mandatory)][string]$VideoPath,
    [Parameter(Mandatory)][string]$SubscriptionId,
    [string]$KeyVaultName,
    [SecureString]$Password,
    [int]$TimeoutMinutes = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
if ($Password) {
    $loginPassword = [Net.NetworkCredential]::new('', $Password).Password
}
else {
    if (!$KeyVaultName) { throw 'Supply Password, or KeyVaultName from a network with vault access.' }
    $loginPassword = & az keyvault secret show --subscription $SubscriptionId --vault-name $KeyVaultName `
        --name app-password --query value -o tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or !$loginPassword) { throw 'Cannot read the demo login secret.' }
}
$session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$headers = @{ Origin = $BaseUrl }
Invoke-RestMethod -Uri "$BaseUrl/api/session" -Method Post -WebSession $session -Headers $headers `
    -ContentType 'application/json' -Body (@{ password = $loginPassword } | ConvertTo-Json) | Out-Null
$loginPassword = $null

function Call-Api([string]$Path, [string]$Method = 'GET', $Payload = $null) {
    $args = @{
        Uri = "$BaseUrl/api/$Path"; Method = $Method; WebSession = $session
        Headers = $headers; TimeoutSec = 240
    }
    if ($null -ne $Payload) {
        $args.ContentType = 'application/json'
        $args.Body = $Payload | ConvertTo-Json -Depth 20
    }
    return Invoke-RestMethod @args
}

function Wait-Job([string]$Id) {
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes($TimeoutMinutes)
    do {
        $job = Call-Api "jobs/$Id"
        Write-Host "$($job.kind): $($job.status) / $($job.stage) / $($job.progress)"
        if ($job.status -eq 'failed') { throw "Job failed: $($job.error)" }
        if ($job.status -eq 'completed') { return $job }
        Start-Sleep -Seconds 10
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "Job $Id did not complete within $TimeoutMinutes minutes."
}

$anonymous = Invoke-WebRequest -Uri "$BaseUrl/api/videos" -SkipHttpErrorCheck
if ($anonymous.StatusCode -ne 401) { throw 'Anonymous catalog access was not blocked.' }

$upload = Invoke-RestMethod -Uri "$BaseUrl/api/videos" -Method Post -WebSession $session -Headers $headers `
    -Form @{ title = 'Acervo ilustrado original / sem pessoas reais'; video = Get-Item -LiteralPath $VideoPath } -TimeoutSec 240
Wait-Job $upload.job.id | Out-Null
$allScenes = Call-Api "videos/$($upload.video.id)/scenes"
if (@($allScenes.scenes).Count -eq 0) { throw 'Ingestion produced no scenes.' }

$results = Call-Api search POST @{ query = 'pessoa e gato sentados no mesmo sofa'; limit = 10 }
if (@($results.hits).Count -eq 0) { throw 'Expected person/cat/sofa scene was not found.' }
$hit = $results.hits[0]
if (!$hit.graphVerified) { throw 'The hit is not graph verified.' }
$graph = Call-Api "graph/$($hit.scene.videoId)/$($hit.scene.id)"
if (@($graph.edges).Count -eq 0) { throw 'No native graph evidence returned.' }

$negative = Call-Api search POST @{ query = 'helicoptero pousando em uma plataforma no oceano'; limit = 10 }
if (@($negative.hits).Count -gt 0) { throw 'Unrelated helicopter query returned matches.' }

$person = @($hit.scene.entities | Where-Object type -eq 'person')[0]
Call-Api "scenes/$($hit.scene.videoId)/$($hit.scene.id)/identity" PATCH @{
    entityId = $person.id; actorName = 'Artista Ficticio da Demo'
} | Out-Null

$export = Call-Api clips/extract POST @{
    clips = @(@{
        sceneId = $hit.scene.id; videoId = $hit.scene.videoId; timecode = $hit.matchedTimecode
    })
}
$completed = Wait-Job $export.id
$output = Join-Path ([IO.Path]::GetDirectoryName((Resolve-Path $VideoPath))) 'smoke-export.zip'
Invoke-WebRequest -Uri "$BaseUrl$($completed.outputUri)" -WebSession $session -OutFile $output -TimeoutSec 240
$archive = [IO.Compression.ZipFile]::OpenRead($output)
try {
    if (!@($archive.Entries | Where-Object FullName -like '*.mp4')) { throw 'ZIP has no MP4 clips.' }
    if (!@($archive.Entries | Where-Object FullName -like '*.json')) { throw 'ZIP has no JSON manifest.' }
    $archive.Entries | Select-Object FullName, Length
}
finally { $archive.Dispose() }
Write-Host "Completed real ingest/search/graph/editorial/export workflow. Video ID: $($upload.video.id)"
