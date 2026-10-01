#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [Parameter(Mandatory)][string]$ResourceGroupName,
    [Parameter(Mandatory)][string]$JobName,
    [int]$TimeoutSeconds = 900,
    [int]$PollSeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-AzJson([string[]]$Arguments) {
    $text = & az @Arguments --subscription $SubscriptionId --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) {
        throw "Azure operation failed: $($Arguments[0..([Math]::Min(2, $Arguments.Length - 1))] -join ' '). See the error above."
    }
    if ($text) { return ($text | ConvertFrom-Json -Depth 100) }
}

function Get-ExecutionName($StartResult) {
    if ($StartResult -and $StartResult.PSObject.Properties['name'] -and $StartResult.name) {
        return (($StartResult.name -split '/')[-1])
    }
    if ($StartResult -and $StartResult.PSObject.Properties['id'] -and $StartResult.id) {
        return (($StartResult.id -split '/')[-1])
    }
    throw "Start did not return an execution identifier for $JobName; refusing to guess another execution."
}

function Get-ExecutionState($Execution) {
    if ($Execution.PSObject.Properties['properties'] -and $Execution.properties) {
        foreach ($key in @('status', 'runningState')) {
            if ($Execution.properties.PSObject.Properties[$key] -and $Execution.properties.$key) {
                return [string]$Execution.properties.$key
            }
        }
    }
    if ($Execution.PSObject.Properties['status'] -and $Execution.status) { return [string]$Execution.status }
    return 'Unknown'
}

Write-Host "Starting SQL graph bootstrap job $JobName..."
$start = Invoke-AzJson @('containerapp', 'job', 'start', '--resource-group', $ResourceGroupName, '--name', $JobName)
$executionName = Get-ExecutionName $start
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)

do {
    Start-Sleep -Seconds $PollSeconds
    $execution = Invoke-AzJson @('containerapp', 'job', 'execution', 'show', '--resource-group', $ResourceGroupName, '--name', $JobName, '--job-execution-name', $executionName)
    $state = Get-ExecutionState $execution
    Write-Host "Bootstrap execution $executionName status: $state"

    if ($state -in @('Succeeded', 'Completed', 'Success')) {
        return $execution
    }

    if ($state -in @('Failed', 'Error', 'Canceled', 'Cancelled', 'TimedOut')) {
        throw "Bootstrap execution $executionName ended with status $state."
    }

    if ([DateTimeOffset]::UtcNow -ge $deadline) {
        throw "Bootstrap execution $executionName exceeded the wait deadline."
    }
} while ($true)
