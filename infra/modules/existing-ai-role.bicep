targetScope = 'resourceGroup'

@description('Existing Azure OpenAI account name.')
param openAiAccountName string

@description('Principal ID of the workload user-assigned managed identity.')
param principalId string

var openAiUserRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')

resource openAiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: openAiAccountName
}

resource openAiUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(openAiAccount.id, principalId, openAiUserRoleDefinitionId)
  scope: openAiAccount
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: openAiUserRoleDefinitionId
  }
}

output accountId string = openAiAccount.id
