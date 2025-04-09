
function handleStorageDecorator(request) {
  const { object: secret, attachments } = request;
  const account = secret.metadata.labels['storage.nightscout.org/account'];
  
  return {
    attachments: [{
      apiVersion: 'nightscout.k8s/v1alpha1',
      kind: 'TenantStorage',
      metadata: {
        name: account,
        labels: {
          'storage.nightscout.org/account': account
        }
      },
      spec: {
        storageAccount: account,
        needsProvisioning: true
      }
    }]
  };
}

module.exports = handleStorageDecorator;
