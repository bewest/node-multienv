
const appLabel = process.env.TENANT_APP_LABEL || 'tenant';
const watchSelector = process.env.WATCH_LABEL_SELECTOR || 'app=tenant';

function parseWatchSelector(selector) {
  return selector.split(',').reduce((acc, pair) => {
    const [key, value] = pair.split('=');
    acc[key] = value;
    return acc;
  }, {});
}

function handleCustomize(request) {
  const watchLabels = parseWatchSelector(watchSelector);
  
  return {
    relatedResources: [
      {
        apiVersion: 'v1',
        resource: 'secrets',
        namespace: request.parent.metadata.namespace,
        labelSelector: {
          matchLabels: {
            ...watchLabels,
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
