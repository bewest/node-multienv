
function handleCustomize(request) {
  return {
    relatedResources: [
      {
        apiVersion: 'v1',
        resource: 'secrets',
        namespace: request.parent.metadata.namespace,
        labelSelector: {
          matchLabels: {
            'app': 'tenant',
            'tenant': request.parent.metadata.name
          }
        }
      },
      {
        apiVersion: 'v1',
        resource: 'configmaps',
        namespace: request.parent.metadata.namespace,
        labelSelector: {
          matchLabels: {
            'app': 'tenant',
            'tenant': request.parent.metadata.name
          }
        }
      },
      {
        apiVersion: 'apps/v1',
        resource: 'statefulsets',
        namespace: request.parent.metadata.namespace,
        labelSelector: {
          matchLabels: {
            'app': 'tenant',
            'tenant': request.parent.metadata.name
          }
        }
      }
    ]
  };
}

module.exports = handleCustomize;
