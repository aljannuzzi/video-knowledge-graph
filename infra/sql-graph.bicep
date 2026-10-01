targetScope = 'resourceGroup'

@description('Short workload name used in resource names.')
param workloadName string = 'video-kg'

@description('Azure region that hosts the shared app environment, bootstrap identity, and SQL private endpoint.')
param location string = resourceGroup().location

@description('Azure region for the dedicated Azure SQL Graph logical server and database.')
param graphLocation string = 'centralus'

@description('Azure SQL database SKU name for the dedicated graph database.')
param graphSku string = 'S0'

@description('Subnet resource ID used for private endpoints.')
param privateEndpointSubnetId string

@description('Virtual network resource ID linked to the SQL private DNS zone.')
param privateDnsVirtualNetworkId string

@description('Principal ID of the runtime user-assigned managed identity that receives database grants during bootstrap.')
param runtimeManagedIdentityPrincipalId string

var suffix = toLower(uniqueString(resourceGroup().id, workloadName))
var compactPrefix = take(replace(toLower(workloadName), '-', ''), 10)
var sqlGraphServerName = take('${compactPrefix}${suffix}graphsql', 63)
var sqlGraphDatabaseName = 'video-graph'
var graphBootstrapIdentityName = '${workloadName}-graph-bootstrap-uami'
var sqlPrivateDnsZoneName = 'privatelink.database.windows.net'

resource graphBootstrapIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: graphBootstrapIdentityName
  location: location
}

resource sqlGraphServer 'Microsoft.Sql/servers@2023-08-01' = {
  name: sqlGraphServerName
  location: graphLocation
  properties: {
    administrators: {
      administratorType: 'ActiveDirectory'
      azureADOnlyAuthentication: true
      login: graphBootstrapIdentity.name
      principalType: 'Application'
      sid: graphBootstrapIdentity.properties.principalId
      tenantId: subscription().tenantId
    }
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    version: '12.0'
  }
}

resource sqlGraphServerAdOnlyAuthentication 'Microsoft.Sql/servers/azureADOnlyAuthentications@2023-08-01' = {
  parent: sqlGraphServer
  name: 'Default'
  properties: {
    azureADOnlyAuthentication: true
  }
}

resource sqlGraphServerConnectionPolicy 'Microsoft.Sql/servers/connectionPolicies@2023-08-01' = {
  parent: sqlGraphServer
  name: 'default'
  properties: {
    connectionType: 'Proxy'
  }
}

resource sqlGraphDatabase 'Microsoft.Sql/servers/databases@2023-08-01' = {
  parent: sqlGraphServer
  name: sqlGraphDatabaseName
  location: graphLocation
  sku: {
    name: graphSku
    tier: 'Standard'
  }
}

resource sqlPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: sqlPrivateDnsZoneName
  location: 'global'
}

resource sqlPrivateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: sqlPrivateDnsZone
  name: '${workloadName}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: privateDnsVirtualNetworkId
    }
  }
}

resource sqlPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${workloadName}-sql-graph-pe'
  location: location
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'sql-graph'
        properties: {
          privateLinkServiceId: sqlGraphServer.id
          groupIds: [
            'sqlServer'
          ]
        }
      }
    ]
  }
}

resource sqlPrivateEndpointZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: sqlPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: replace(sqlPrivateDnsZone.name, '.', '-')
        properties: {
          privateDnsZoneId: sqlPrivateDnsZone.id
        }
      }
    ]
  }
}

output sqlGraphServerId string = sqlGraphServer.id
output sqlGraphServerName string = sqlGraphServer.name
output sqlGraphServerFqdn string = '${sqlGraphServer.name}.database.windows.net'
output sqlGraphDatabase string = sqlGraphDatabaseName
output graphBootstrapIdentityId string = graphBootstrapIdentity.id
output graphBootstrapIdentityClientId string = graphBootstrapIdentity.properties.clientId
output graphBootstrapIdentityPrincipalId string = graphBootstrapIdentity.properties.principalId
output runtimeManagedIdentityPrincipalId string = runtimeManagedIdentityPrincipalId
