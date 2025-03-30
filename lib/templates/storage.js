
const template_persistent_volume_claim = (data) => ({
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: {
    name: `${data.WEB_NAME}-mongodb-data`,
    labels: {
      app: 'tenant',
      tenant: data.WEB_NAME
    }
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    resources: {
      requests: {
        storage: '1Gi'
      }
    }
  }
});

module.exports = {
  template_persistent_volume_claim
};
