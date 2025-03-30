
const template_migration_job = (data, oldMongoUri, newMongoUri, webhookUrl) => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: {
    name: `${data.WEB_NAME}-migration`,
    labels: {
      app: 'tenant',
      tenant: data.WEB_NAME,
      component: 'migration'
    }
  },
  spec: {
    backoffLimit: 4,
    template: {
      spec: {
        containers: [{
          name: 'migration',
          image: 'nightscout/provisioner:latest',
          command: ['migrate-tenant-isolated-db'],
          env: [
            {
              name: 'OLD_MONGO_URI',
              value: oldMongoUri
            },
            {
              name: 'NEW_MONGO_URI', 
              value: newMongoUri
            },
            {
              name: 'MIGRATED_DB_WEBHOOK',
              value: webhookUrl
            }
          ]
        }],
        restartPolicy: 'OnFailure'
      }
    }
  }
});

const template_init_storage_job = (data, rootMongoUri, webhookUrl) => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: {
    name: `${data.WEB_NAME}-storage-init`,
    labels: {
      app: 'tenant',
      tenant: data.WEB_NAME,
      component: 'storage'
    }
  },
  spec: {
    backoffLimit: 4,
    template: {
      spec: {
        containers: [{
          name: 'storage-init',
          image: 'nightscout/provisioner:latest',
          command: ['mint-userdb-creds'],
          env: [
            {
              name: 'MONGODB_ROOT_URI',
              value: rootMongoUri
            },
            {
              name: 'INITIALIZED_STORAGE_WEBHOOK',
              value: webhookUrl
            },
            {
              name: 'TENANT_ID',
              value: data.WEB_NAME
            }
          ]
        }],
        restartPolicy: 'OnFailure'
      }
    }
  }
});

module.exports = {
  template_migration_job,
  template_init_storage_job
};
