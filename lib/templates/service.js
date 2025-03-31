function template_mongodb_service(data) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${data.WEB_NAME}-mongodb`,
      labels: {
        app: 'tenant',
        tenant: data.WEB_NAME
      }
    },
    spec: {
      selector: {
        app: `${data.WEB_NAME}-mongodb`
      },
      ports: [{
        port: 27017,
        targetPort: 27017
      }]
    }
  };
}

module.exports = {
  template_mongodb_service
};