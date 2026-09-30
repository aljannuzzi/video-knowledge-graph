targetScope = 'resourceGroup'

@description('Short workload name used in resource names.')
param workloadName string = 'video-kg'

@description('Azure region for the deployment.')
param location string = resourceGroup().location

@description('Azure Container Registry login server created by bootstrap.')
param containerRegistryLoginServer string

@description('Key Vault name created by bootstrap.')
param keyVaultName string

@description('User-assigned managed identity name created by bootstrap.')
param managedIdentityName string

@description('Principal ID of the shared user-assigned managed identity.')
param managedIdentityPrincipalId string

@description('Container image for the API service.')
param apiImage string = ''

@description('Container image for the worker service.')
param workerImage string = ''

@description('Set to false to skip the API and worker container app deployment.')
param deployApps bool = true

@secure()
@description('Only supplied when initializing or explicitly rotating the demo password.')
param appPassword string = ''

@description('Existing Azure OpenAI resource ID to reuse.')
param existingOpenAiResourceId string = ''

@description('Existing Azure OpenAI endpoint to inject into the apps.')
param existingOpenAiEndpoint string = ''

@description('Create a dedicated Azure OpenAI account when true.')
param createOpenAiAccount bool = false

@description('Dedicated Azure OpenAI account name when createOpenAiAccount is true.')
param openAiAccountName string = ''

@description('Azure region for a dedicated Azure OpenAI account.')
param openAiLocation string = location

@description('SKU name for a dedicated Azure OpenAI account.')
param openAiSkuName string = 'S0'

@description('Optional custom subdomain name for a dedicated Azure OpenAI account.')
param openAiCustomSubdomain string = ''

@description('Set to false when you only want the Azure OpenAI account and will create deployments separately.')
param deployOpenAiModels bool = true

@description('Chat deployment name used by the application.')
param openAiChatDeploymentName string = 'gpt-4.1'

@description('Chat model name for a dedicated Azure OpenAI deployment.')
param openAiChatModelName string = 'gpt-4.1'

@description('Chat model version for a dedicated Azure OpenAI deployment.')
param openAiChatModelVersion string = '2025-04-14'

@description('Chat deployment SKU name for a dedicated Azure OpenAI deployment.')
param openAiChatDeploymentSkuName string = 'GlobalStandard'

@description('Chat deployment capacity for a dedicated Azure OpenAI deployment.')
param openAiChatDeploymentCapacity int = 10

@description('Embeddings deployment name used by the application.')
param openAiEmbeddingsDeploymentName string = 'text-embedding-3-large'

@description('Embeddings model name for a dedicated Azure OpenAI deployment.')
param openAiEmbeddingsModelName string = 'text-embedding-3-large'

@description('Embeddings model version for a dedicated Azure OpenAI deployment.')
param openAiEmbeddingsModelVersion string = '1'

@description('Embeddings deployment SKU name for a dedicated Azure OpenAI deployment.')
param openAiEmbeddingsDeploymentSkuName string = 'GlobalStandard'

@description('Embeddings deployment capacity for a dedicated Azure OpenAI deployment.')
param openAiEmbeddingsDeploymentCapacity int = 10

var suffix = toLower(uniqueString(resourceGroup().id, workloadName))
var compactPrefix = take(replace(toLower(workloadName), '-', ''), 10)
var storageName = take('${compactPrefix}${suffix}st', 24)
var cosmosSqlName = take('${compactPrefix}${suffix}sql', 44)
var cosmosGremlinName = take('${compactPrefix}${suffix}gremlin', 44)
var logAnalyticsName = '${workloadName}-logs'
var containerEnvironmentName = '${workloadName}-private-env'
var cosmosDatabaseName = 'video-kg'
var gremlinDatabaseName = 'video-kg'
var gremlinGraphName = 'knowledge'
var jobsQueueName = 'jobs'
var appPasswordSecretName = 'app-password'
var gremlinKeySecretName = 'gremlin-key'
var openAiResourceIdParts = split(empty(existingOpenAiResourceId) ? '/subscriptions/placeholder/resourceGroups/placeholder/providers/Microsoft.CognitiveServices/accounts/placeholder' : existingOpenAiResourceId, '/')
var existingOpenAiSubscriptionId = openAiResourceIdParts[2]
var existingOpenAiResourceGroupName = openAiResourceIdParts[4]
var existingOpenAiAccountName = openAiResourceIdParts[8]
var effectiveOpenAiSubdomain = empty(openAiCustomSubdomain) ? openAiAccountName : openAiCustomSubdomain
var effectiveOpenAiAccountName = empty(openAiAccountName) ? '${compactPrefix}${suffix}ai' : openAiAccountName
var shouldCreateOpenAi = createOpenAiAccount && !empty(openAiAccountName)
var effectiveOpenAiEndpoint = shouldCreateOpenAi ? openAiAccount!.properties.endpoint : existingOpenAiEndpoint

var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var storageQueueDataContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var openAiUserRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
var cosmosSqlDataContributorRoleDefinitionResourceId = '${cosmosSql.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: managedIdentityName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    supportsHttpsTrafficOnly: true
  }
}

resource videosContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${storage.name}/default/videos'
  properties: {
    publicAccess: 'None'
  }
}

resource evidenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${storage.name}/default/evidence'
  properties: {
    publicAccess: 'None'
  }
}

resource exportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${storage.name}/default/exports'
  properties: {
    publicAccess: 'None'
  }
}

resource jobsQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  name: '${storage.name}/default/${jobsQueueName}'
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource cosmosSql 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosSqlName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    capabilities: [
      {
        name: 'EnableNoSQLVectorSearch'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    databaseAccountOfferType: 'Standard'
    disableLocalAuth: true
    locations: [
      {
        failoverPriority: 0
        isZoneRedundant: false
        locationName: location
      }
    ]
    publicNetworkAccess: 'Disabled'
  }
}

resource cosmosSqlDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  name: '${cosmosSql.name}/${cosmosDatabaseName}'
  properties: {
    resource: {
      id: cosmosDatabaseName
    }
  }
}

resource scenesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2025-04-15' = {
  name: '${cosmosSqlDatabase.name}/scenes'
  properties: {
    options: {
      throughput: 400
    }
    resource: {
      id: 'scenes'
      indexingPolicy: {
        automatic: true
        excludedPaths: [
          {
            path: '/"_etag"/?'
          }
          {
            path: '/embedding/*'
          }
        ]
        includedPaths: [
          {
            path: '/*'
          }
        ]
        indexingMode: 'consistent'
        vectorIndexes: [
          {
            path: '/embedding'
            type: 'quantizedFlat'
          }
        ]
      }
      partitionKey: {
        kind: 'Hash'
        paths: [
          '/videoId'
        ]
        version: 2
      }
      vectorEmbeddingPolicy: {
        vectorEmbeddings: [
          {
            dataType: 'float32'
            dimensions: 1536
            distanceFunction: 'cosine'
            path: '/embedding'
          }
        ]
      }
    }
  }
}

resource catalogContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  name: '${cosmosSqlDatabase.name}/catalog'
  properties: {
    options: {
      throughput: 400
    }
    resource: {
      id: 'catalog'
      indexingPolicy: {
        automatic: true
        excludedPaths: [
          {
            path: '/"_etag"/?'
          }
        ]
        includedPaths: [
          {
            path: '/*'
          }
        ]
        indexingMode: 'consistent'
      }
      partitionKey: {
        kind: 'Hash'
        paths: [
          '/id'
        ]
        version: 2
      }
    }
  }
}

resource cosmosGremlin 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosGremlinName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    capabilities: [
      {
        name: 'EnableGremlin'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        failoverPriority: 0
        isZoneRedundant: false
        locationName: location
      }
    ]
    publicNetworkAccess: 'Disabled'
  }
}

resource gremlinDatabase 'Microsoft.DocumentDB/databaseAccounts/gremlinDatabases@2024-05-15' = {
  name: '${cosmosGremlin.name}/${gremlinDatabaseName}'
  properties: {
    options: {
      throughput: 400
    }
    resource: {
      id: gremlinDatabaseName
    }
  }
}

resource knowledgeGraph 'Microsoft.DocumentDB/databaseAccounts/gremlinDatabases/graphs@2024-05-15' = {
  name: '${gremlinDatabase.name}/${gremlinGraphName}'
  properties: {
    resource: {
      id: gremlinGraphName
      partitionKey: {
        kind: 'Hash'
        paths: [
          '/videoId'
        ]
        version: 2
      }
    }
  }
}

resource sharedIdentityCanAccessBlobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, managedIdentityPrincipalId, storageBlobDataContributorRoleDefinitionId)
  scope: storage
  properties: {
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
  }
}

resource sharedIdentityCanAccessQueues 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, managedIdentityPrincipalId, storageQueueDataContributorRoleDefinitionId)
  scope: storage
  properties: {
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageQueueDataContributorRoleDefinitionId
  }
}

resource demoPassword 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(appPassword)) {
  parent: keyVault
  name: appPasswordSecretName
  properties: {
    value: appPassword
  }
}

resource graphKey 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: gremlinKeySecretName
  properties: {
    value: cosmosGremlin.listKeys().primaryMasterKey
  }
}

resource cosmosSqlDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosSql
  name: guid(cosmosSql.id, managedIdentityPrincipalId, cosmosSqlDataContributorRoleDefinitionResourceId)
  properties: {
    principalId: managedIdentityPrincipalId
    roleDefinitionId: cosmosSqlDataContributorRoleDefinitionResourceId
    scope: cosmosSql.id
  }
}

resource openAiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' = if (shouldCreateOpenAi) {
  name: effectiveOpenAiAccountName
  location: openAiLocation
  kind: 'OpenAI'
  sku: {
    name: openAiSkuName
  }
  properties: {
    customSubDomainName: effectiveOpenAiSubdomain
    disableLocalAuth: true
    dynamicThrottlingEnabled: false
    publicNetworkAccess: 'Enabled'
    restrictOutboundNetworkAccess: false
  }
}

resource openAiChatDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (shouldCreateOpenAi && deployOpenAiModels) {
  parent: openAiAccount
  name: openAiChatDeploymentName
  sku: {
    capacity: openAiChatDeploymentCapacity
    name: openAiChatDeploymentSkuName
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: openAiChatModelName
      version: openAiChatModelVersion
    }
    versionUpgradeOption: 'OnceCurrentVersionExpired'
  }
}

resource openAiEmbeddingsDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (shouldCreateOpenAi && deployOpenAiModels) {
  parent: openAiAccount
  name: openAiEmbeddingsDeploymentName
  sku: {
    capacity: openAiEmbeddingsDeploymentCapacity
    name: openAiEmbeddingsDeploymentSkuName
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: openAiEmbeddingsModelName
      version: openAiEmbeddingsModelVersion
    }
    versionUpgradeOption: 'OnceCurrentVersionExpired'
  }
}

resource sharedIdentityCanUseCreatedOpenAi 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (shouldCreateOpenAi) {
  name: guid(openAiAccount.id, managedIdentityPrincipalId, openAiUserRoleDefinitionId)
  scope: openAiAccount
  properties: {
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: openAiUserRoleDefinitionId
  }
}

module existingOpenAiRole 'modules/existing-ai-role.bicep' = if (!empty(existingOpenAiResourceId) && !shouldCreateOpenAi) {
  name: 'existing-openai-role'
  scope: resourceGroup(existingOpenAiSubscriptionId, existingOpenAiResourceGroupName)
  params: {
    openAiAccountName: existingOpenAiAccountName
    principalId: managedIdentityPrincipalId
  }
}

module privateNetwork 'modules/private-network.bicep' = {
  name: 'private-network'
  params: {
    location: location
    workloadName: workloadName
    keyVaultId: keyVault.id
    storageId: storage.id
    sqlAccountId: cosmosSql.id
    gremlinAccountId: cosmosGremlin.id
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerEnvironmentName
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: privateNetwork.outputs.infrastructureSubnetId
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource apiApp 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
  name: '${workloadName}-api'
  location: location
  dependsOn: [
    graphKey
    demoPassword
  ]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          identity: managedIdentity.id
          server: containerRegistryLoginServer
        }
      ]
      secrets: [
        {
          identity: managedIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${appPasswordSecretName}'
          name: appPasswordSecretName
        }
        {
          identity: managedIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${gremlinKeySecretName}'
          name: gremlinKeySecretName
        }
      ]
    }
    template: {
      containers: [
        {
          image: apiImage
          name: 'api'
          env: [
            {
              name: 'ENVIRONMENT'
              value: 'azure'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: managedIdentity.properties.clientId
            }
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'FRONTEND_DIST'
              value: '/app/apps/frontend/dist'
            }
            {
              name: 'APP_PASSWORD'
              secretRef: appPasswordSecretName
            }
            {
              name: 'SESSION_COOKIE_SECURE'
              value: 'true'
            }
            {
              name: 'TRUST_PROXY'
              value: 'true'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT'
              value: storage.name
            }
            {
              name: 'STORAGE_QUEUE_NAME'
              value: jobsQueueName
            }
            {
              name: 'STORAGE_VIDEO_CONTAINER'
              value: 'videos'
            }
            {
              name: 'STORAGE_EVIDENCE_CONTAINER'
              value: 'evidence'
            }
            {
              name: 'STORAGE_EXPORTS_CONTAINER'
              value: 'exports'
            }
            {
              name: 'COSMOS_ENDPOINT'
              value: cosmosSql.properties.documentEndpoint
            }
            {
              name: 'COSMOS_DATABASE'
              value: cosmosDatabaseName
            }
            {
              name: 'COSMOS_SCENES_CONTAINER'
              value: 'scenes'
            }
            {
              name: 'COSMOS_CATALOG_CONTAINER'
              value: 'catalog'
            }
            {
              name: 'GREMLIN_ENDPOINT'
              value: 'wss://${cosmosGremlin.name}.gremlin.cosmos.azure.com:443/'
            }
            {
              name: 'GREMLIN_DATABASE'
              value: gremlinDatabaseName
            }
            {
              name: 'GREMLIN_GRAPH'
              value: gremlinGraphName
            }
            {
              name: 'GREMLIN_KEY'
              secretRef: gremlinKeySecretName
            }
            {
              name: 'AZURE_OPENAI_ENDPOINT'
              value: effectiveOpenAiEndpoint
            }
            {
              name: 'AZURE_OPENAI_VISION_DEPLOYMENT'
              value: openAiChatDeploymentName
            }
            {
              name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT'
              value: openAiEmbeddingsDeploymentName
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 8080
                scheme: 'HTTP'
              }
              failureThreshold: 30
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 8080
                scheme: 'HTTP'
              }
              failureThreshold: 3
              initialDelaySeconds: 10
              periodSeconds: 10
              timeoutSeconds: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
                scheme: 'HTTP'
              }
              failureThreshold: 3
              initialDelaySeconds: 20
              periodSeconds: 20
              timeoutSeconds: 3
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        maxReplicas: 2
        minReplicas: 1
      }
    }
  }
}

resource workerApp 'Microsoft.App/containerApps@2024-03-01' = if (deployApps) {
  name: '${workloadName}-worker'
  location: location
  dependsOn: [
    graphKey
    demoPassword
  ]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          identity: managedIdentity.id
          server: containerRegistryLoginServer
        }
      ]
      secrets: [
        {
          identity: managedIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${appPasswordSecretName}'
          name: appPasswordSecretName
        }
        {
          identity: managedIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${gremlinKeySecretName}'
          name: gremlinKeySecretName
        }
      ]
    }
    template: {
      containers: [
        {
          command: [
            'node'
            'apps/worker/dist/metadataGenerator.js'
          ]
          image: workerImage
          name: 'worker'
          env: [
            {
              name: 'ENVIRONMENT'
              value: 'azure'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: managedIdentity.properties.clientId
            }
            {
              name: 'APP_PASSWORD'
              secretRef: appPasswordSecretName
            }
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'AZURE_STORAGE_ACCOUNT'
              value: storage.name
            }
            {
              name: 'STORAGE_QUEUE_NAME'
              value: jobsQueueName
            }
            {
              name: 'STORAGE_VIDEO_CONTAINER'
              value: 'videos'
            }
            {
              name: 'STORAGE_EVIDENCE_CONTAINER'
              value: 'evidence'
            }
            {
              name: 'STORAGE_EXPORTS_CONTAINER'
              value: 'exports'
            }
            {
              name: 'COSMOS_ENDPOINT'
              value: cosmosSql.properties.documentEndpoint
            }
            {
              name: 'COSMOS_DATABASE'
              value: cosmosDatabaseName
            }
            {
              name: 'COSMOS_SCENES_CONTAINER'
              value: 'scenes'
            }
            {
              name: 'COSMOS_CATALOG_CONTAINER'
              value: 'catalog'
            }
            {
              name: 'GREMLIN_ENDPOINT'
              value: 'wss://${cosmosGremlin.name}.gremlin.cosmos.azure.com:443/'
            }
            {
              name: 'GREMLIN_DATABASE'
              value: gremlinDatabaseName
            }
            {
              name: 'GREMLIN_GRAPH'
              value: gremlinGraphName
            }
            {
              name: 'GREMLIN_KEY'
              secretRef: gremlinKeySecretName
            }
            {
              name: 'AZURE_OPENAI_ENDPOINT'
              value: effectiveOpenAiEndpoint
            }
            {
              name: 'AZURE_OPENAI_VISION_DEPLOYMENT'
              value: openAiChatDeploymentName
            }
            {
              name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT'
              value: openAiEmbeddingsDeploymentName
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
      scale: {
        maxReplicas: 1
        minReplicas: 1
        rules: [
          {
            name: 'worker-cpu'
            custom: {
              type: 'cpu'
              metadata: {
                type: 'Utilization'
                value: '80'
              }
            }
          }
        ]
      }
    }
  }
}

output apiUrl string = deployApps ? 'https://${reference(resourceId('Microsoft.App/containerApps', '${workloadName}-api'), '2024-03-01', 'Full').properties.configuration.ingress.fqdn}' : ''
output containerEnvironmentName string = containerEnvironment.name
output cosmosEndpoint string = cosmosSql.properties.documentEndpoint
output cosmosAccountName string = cosmosSql.name
output gremlinAccountName string = cosmosGremlin.name
output gremlinEndpoint string = 'wss://${cosmosGremlin.name}.gremlin.cosmos.azure.com:443/'
output gremlinDatabase string = gremlinDatabaseName
output gremlinGraph string = gremlinGraphName
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output managedIdentityId string = managedIdentity.id
output storageAccount string = storage.name
output jobsQueueName string = jobsQueueName
output videoContainerName string = 'videos'
output evidenceContainerName string = 'evidence'
output exportsContainerName string = 'exports'
output openAiEndpoint string = effectiveOpenAiEndpoint
output openAiChatDeployment string = openAiChatDeploymentName
output openAiEmbeddingsDeployment string = openAiEmbeddingsDeploymentName
