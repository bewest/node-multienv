
const appLabel = process.env.TENANT_APP_LABEL || 'tenant';
const watchSelector = process.env.WATCH_LABEL_SELECTOR || 'app=tenant';

function parseWatchSelector(selector) {
  return selector.split(',').reduce((acc, pair) => {
    const [key, value] = pair.split('=');
    acc[key] = value;
    return acc;
  }, {});
}

function handleCustomize (req, res, next) {
  var { controller, parent } = req.body;
  console.log("CUSTOMIZE REQUEST", req.headers, JSON.stringify(req.body, null, 2));
  console.log("CUSTOMIZE CONTROLLER", controller);
  console.log("CUSTOMIZE PARENT", parent);
  var relatedResources = template_instance_related_customize(req.body);
  console.log("CUSTOMIZE RESPONSE relatedResources", relatedResources.relatedResources);
  res.json(relatedResources);
  next( );
}

function template_instance_related_customize (request) {
  const watchLabels = parseWatchSelector(watchSelector);
  
  return {
    relatedResources: [
      {
        apiVersion: 'v1',
        resource: 'persistentvolumeclaims',
        namespace: request.parent.metadata.namespace,
        names: [ `pvc-${request.parent.spec.storageAccount}` ]
      },
      {
        apiVersion: 'v1',
        resource: 'secrets',
        namespace: request.parent.metadata.namespace,
        names: [ `${request.parent.spec.storageAccount}-secret` ]
      },
      {
        apiVersion: 'v1',
        resource: 'secrets',
        // namespace: request.parent.metadata.namespace,
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
        // namespace: request.parent.metadata.namespace,
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
        // namespace: request.parent.metadata.namespace,
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
