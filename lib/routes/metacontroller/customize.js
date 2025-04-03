
function handleCustomize(request, config) {
  const watchLabels = {
    [config.labels.appLabel]: config.labels.watchSelector.split('=')[1]
  };
  
  return {
    relatedResources: [
      {
        apiVersion: 'v1',
        resource: 'secrets',
        namespace: request.parent.metadata.namespace,
        labelSelector: {
          matchLabels: {
            ...watchLabels,
            [config.labels.tenantIdLabel]: request.parent.metadata.name
          }
        }
      },
      {
        apiVersion: 'v1',
        resource: 'configmaps',
        namespace: request.parent.metadata.namespace,
        labelSelector: {
          matchLabels: {
            [config.labels.appLabel]: config.labels.watchSelector.split('=')[1],
            [config.labels.tenantIdLabel]: request.parent.metadata.name
          }
        }
      },
      {
        apiVersion: 'apps/v1',
        resource: 'statefulsets',
        namespace: request.parent.metadata.namespace,
        labelSelector: {
          matchLabels: {
            [config.labels.appLabel]: config.labels.watchSelector.split('=')[1],
            [config.labels.tenantIdLabel]: request.parent.metadata.name
          }
        }
      }
    ]
  };
}

module.exports = handleCustomize;
