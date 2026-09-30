#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [Parameter(Mandatory)][string]$ResourceGroupName,
    [Parameter(Mandatory)][string]$Location,
    [string]$ExpectedTenantId = '',
    [string]$WorkloadName = 'video-kg',
    [string]$ExistingOpenAiResourceId = '',
    [string]$ExistingOpenAiEndpoint = '',
    [switch]$CreateOpenAiAccount,
    [string]$OpenAiAccountName = '',
    [string]$OpenAiLocation = '',
    [string]$OpenAiChatDeploymentName = 'scene-reasoning',
    [string]$OpenAiChatModelName = 'gpt-5.4',
    [string]$OpenAiChatModelVersion = '2026-03-05',
    [int]$OpenAiChatDeploymentCapacity = 20,
    [string]$OpenAiEmbeddingsDeploymentName = 'scene-embedding',
    [string]$ImageTag = (Get-Date -Format 'yyyyMMddHHmmss'),
    [switch]$PrepareOnly,
    [switch]$SkipBuild,
    [SecureString]$DemoPassword,
    [string]$OutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (!$OutputPath) { $OutputPath = Join-Path $repoRoot '.local\deploy' }
if (!$OpenAiLocation) { $OpenAiLocation = $Location }
if ($CreateOpenAiAccount -and (!$OpenAiAccountName -or $ExistingOpenAiResourceId)) {
    throw 'For a new AI account supply OpenAiAccountName and omit ExistingOpenAiResourceId.'
}
if (!$CreateOpenAiAccount -and (!$ExistingOpenAiResourceId -or !$ExistingOpenAiEndpoint)) {
    throw 'Supply an existing Azure OpenAI resource ID and endpoint, or create a dedicated account.'
}
New-Item -ItemType Directory -Force $OutputPath | Out-Null

function Invoke-AzJson([string[]]$Arguments) {
    $text = & az @Arguments --subscription $SubscriptionId --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) {
        throw "Azure operation failed: $($Arguments[0..([Math]::Min(2, $Arguments.Length - 1))] -join ' '). See the error above."
    }
    if ($text) { return ($text | ConvertFrom-Json -Depth 100) }
}

function Deploy-Template([string]$Name, [string]$Template, [hashtable]$Parameters) {
    # Secure parameters are transient, not command-line arguments or deployment output.
    $parameterFile = [IO.Path]::GetTempFileName()
    try {
        $values = @{}
        foreach ($key in $Parameters.Keys) { $values[$key] = @{ value = $Parameters[$key] } }
        @{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'; parameters = $values } |
            ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $parameterFile -Encoding utf8
        return Invoke-AzJson @('deployment', 'group', 'create', '--resource-group', $ResourceGroupName,
            '--name', $Name, '--template-file', $Template, '--parameters', "@$parameterFile")
    }
    finally {
        Remove-Item -LiteralPath $parameterFile -Force
    }
}

function Save-Outputs([string]$Filename, $Outputs) {
    $Outputs | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $OutputPath $Filename) -Encoding utf8
}

$account = Invoke-AzJson @('account', 'show')
if ($ExpectedTenantId -and $account.tenantId -ne $ExpectedTenantId) {
    throw "Selected subscription belongs to tenant $($account.tenantId), not the expected tenant."
}
Write-Host "Target: $SubscriptionId / $ResourceGroupName / $Location"
Invoke-AzJson @('group', 'create', '--name', $ResourceGroupName, '--location', $Location) | Out-Null

$base = Deploy-Template "$WorkloadName-bootstrap" (Join-Path $repoRoot 'infra\base.bicep') @{
    workloadName = $WorkloadName
    location = $Location
}
$bootstrap = $base.properties.outputs
Save-Outputs 'bootstrap.json' $bootstrap

$params = @{
    workloadName = $WorkloadName
    location = $Location
    containerRegistryLoginServer = $bootstrap.containerRegistryLoginServer.value
    keyVaultName = $bootstrap.keyVaultName.value
    managedIdentityName = $bootstrap.managedIdentityName.value
    managedIdentityPrincipalId = $bootstrap.managedIdentityPrincipalId.value
    deployApps = $false
    existingOpenAiResourceId = $ExistingOpenAiResourceId
    existingOpenAiEndpoint = $ExistingOpenAiEndpoint
    createOpenAiAccount = $CreateOpenAiAccount.IsPresent
    openAiAccountName = $OpenAiAccountName
    openAiLocation = $OpenAiLocation
    openAiChatDeploymentName = $OpenAiChatDeploymentName
    openAiChatModelName = $OpenAiChatModelName
    openAiChatModelVersion = $OpenAiChatModelVersion
    openAiChatDeploymentCapacity = $OpenAiChatDeploymentCapacity
    openAiEmbeddingsDeploymentName = $OpenAiEmbeddingsDeploymentName
}

$vaultResourceId = $bootstrap.keyVaultId.value
$secrets = Invoke-AzJson @('rest', '--method', 'get', '--url', "https://management.azure.com$vaultResourceId/secrets?api-version=2023-07-01")
$hasPassword = @($secrets.value | Where-Object { $_.name -match '(^|/)app-password$' }).Count -gt 0
if ($DemoPassword) {
    $plainPassword = [Net.NetworkCredential]::new('', $DemoPassword).Password
    if ($plainPassword.Length -lt 24) { throw 'DemoPassword must contain at least 24 characters.' }
    $params.appPassword = $plainPassword
}
elseif (!$hasPassword) {
    $params.appPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
}

Write-Host 'Provisioning data services, model access, private artifacts and logging...'
$infrastructure = Deploy-Template "$WorkloadName-data" (Join-Path $repoRoot 'infra\main.bicep') $params
Save-Outputs 'infra.json' $infrastructure.properties.outputs
$params.Remove('appPassword')
$plainPassword = $null

if ($PrepareOnly) {
    Write-Host "Infrastructure ready. Non-secret outputs: $OutputPath"
    return
}

$registry = $bootstrap.containerRegistryName.value
$image = "$($bootstrap.containerRegistryLoginServer.value)/video-knowledge-graph:$ImageTag"
if ($SkipBuild) {
    Invoke-AzJson @('acr', 'repository', 'show', '--name', $registry, '--image', "video-knowledge-graph:$ImageTag") | Out-Null
}
else {
    Write-Host "Building $image with ACR..."
    $run = Invoke-AzJson @('acr', 'build', '--registry', $registry, '--image', "video-knowledge-graph:$ImageTag",
        '--file', 'Dockerfile', '--no-logs', $repoRoot)
    $deadline = [DateTimeOffset]::UtcNow.AddMinutes(30)
    do {
        $run = Invoke-AzJson @('acr', 'task', 'show-run', '--registry', $registry, '--run-id', $run.runId)
        if ($run.status -in @('Failed', 'Canceled', 'Error', 'Timeout')) {
            throw "ACR run $($run.runId) ended with $($run.status); container apps were not updated."
        }
        if ($run.status -eq 'Succeeded') { break }
        if ([DateTimeOffset]::UtcNow -ge $deadline) { throw "ACR run $($run.runId) exceeded the wait deadline." }
        Start-Sleep -Seconds 10
    } while ($true)
}

$params.deployApps = $true
$params.apiImage = $image
$params.workerImage = $image
Write-Host 'Deploying API and worker...'
$apps = Deploy-Template "$WorkloadName-apps" (Join-Path $repoRoot 'infra\main.bicep') $params
Save-Outputs 'apps.json' $apps.properties.outputs

$url = $apps.properties.outputs.apiUrl.value
$health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 30
if ($health.status -ne 'ok') { throw 'The application did not report healthy after deployment.' }
Write-Host "Application: $url"
Write-Host "Demo password: Key Vault $($bootstrap.keyVaultName.value), secret app-password (not printed)."
Write-Host "Non-secret deployment outputs: $OutputPath"
