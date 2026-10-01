param location string
param workloadName string
param keyVaultId string
param storageId string
param sqlAccountId string

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${workloadName}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.84.0.0/16']
    }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.84.0.0/23'
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.84.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

var zoneNames = [
  'privatelink.vaultcore.azure.net'
  'privatelink.blob.core.windows.net'
  'privatelink.queue.core.windows.net'
  'privatelink.documents.azure.com'
]
resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for name in zoneNames: {
  name: name
  location: 'global'
}]
resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (name, i) in zoneNames: {
  name: '${zones[i].name}/${workloadName}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}]
var endpoints = [
  { name: 'vault', resourceId: keyVaultId, group: 'vault', zones: [0] }
  { name: 'blob', resourceId: storageId, group: 'blob', zones: [1] }
  { name: 'queue', resourceId: storageId, group: 'queue', zones: [2] }
  { name: 'sql', resourceId: sqlAccountId, group: 'Sql', zones: [3] }
]
resource privateEndpoints 'Microsoft.Network/privateEndpoints@2024-05-01' = [for endpoint in endpoints: {
  name: '${workloadName}-${endpoint.name}-pe'
  location: location
  properties: {
    subnet: {
      id: '${vnet.id}/subnets/private-endpoints'
    }
    privateLinkServiceConnections: [
      {
        name: endpoint.name
        properties: {
          privateLinkServiceId: endpoint.resourceId
          groupIds: [endpoint.group]
        }
      }
    ]
  }
}]
resource zoneGroups 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [for (endpoint, i) in endpoints: {
  name: '${privateEndpoints[i].name}/default'
  properties: {
    privateDnsZoneConfigs: [for zoneIndex in endpoint.zones: {
      name: replace(zoneNames[zoneIndex], '.', '-')
      properties: {
        privateDnsZoneId: zones[zoneIndex].id
      }
    }]
  }
}]

output infrastructureSubnetId string = '${vnet.id}/subnets/apps'
output privateEndpointSubnetId string = '${vnet.id}/subnets/private-endpoints'
output virtualNetworkId string = vnet.id
