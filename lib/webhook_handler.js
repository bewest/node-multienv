
const templates = require('./templates/index');


// TODO: move/rename file to something like lib/routes/{helper,index}.js
// TODO: use same style as deployments.js
function createWebhookHandler(k8s, namespace) {
  return {
    handleSync: async function(parent, children = {}) {
      if (!parent.spec || !parent.spec.parameters || !parent.spec.parameters.tenantId) {
        throw new Error('TenantStack must have spec.parameters.tenantId');
      }

      const response = {
        status: {},
        children: []
      };

      const data = {
        WEB_NAME: parent.spec.parameters.tenantId
      };

      // Handle initial storage provisioning
      if (parent.spec.parameters.needsProvisioning) {
        response.children.push(
          templates.template_init_storage_job(data, 
            process.env.MONGODB_ROOT_URI,
            `http://deployment-controller:3000/storage/initialized/${data.WEB_NAME}`)
        );
      }

      // Handle migration if source URI provided
      if (parent.spec.parameters.migrateFrom) {
        const newMongoUri = `mongodb://${data.WEB_NAME}-mongodb:27017/${data.WEB_NAME}`;
        response.children.push(
          templates.template_migration_job(data,
            parent.spec.parameters.migrateFrom,
            newMongoUri,
            `http://deployment-controller:3000/migration/completed/${data.WEB_NAME}`)
        );
      }
      if (!parent.metadata || !parent.metadata.name) {
        throw new Error('Parent resource must have metadata.name');
      }

      const response = {
        status: {},
        children: []
      };

      const data = {
        WEB_NAME: parent.metadata.name
      };

      // Add PVC for MongoDB data
      response.children.push(
        templates.template_persistent_volume_claim(data)
      );

      // Add MongoDB StatefulSet
      response.children.push(
        templates.template_mongodb_statefulset(data)
      );

      // Add Nightscout Deployment with resource constraints  
      response.children.push(
        templates.template_nightscout_deployment(data, {
          resources: {
            requests: {
              cpu: '5m',
              memory: '120Mi'
            },
            limits: {
              cpu: '500m',
              memory: '500Mi'
            }
          }
        })
      );

      return response;
    }
  };
}

module.exports = createWebhookHandler;
