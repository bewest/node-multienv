
const template_nightscout_deployment = (data, opts = {}) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: data.WEB_NAME,
    labels: {
      app: 'nightscout',
      instance: data.WEB_NAME
    }
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        app: 'nightscout'
      }
    },
    template: {
      metadata: {
        labels: {
          app: 'nightscout'
        }
      },
      spec: {
        containers: [{
          name: 'nightscout',
          image: 'nightscout/cgm-remote-monitor:latest',
          env: [{
            name: 'MONGODB_URI',
            value: `mongodb://${data.WEB_NAME}-mongodb:27017/${data.WEB_NAME}`
          }],
          resources: opts.resources || {
            requests: {
              cpu: '5m',
              memory: '120Mi'
            },
            limits: {
              cpu: '500m',
              memory: '500Mi'
            }
          }
        }]
      }
    }
  }
});

module.exports = {
  template_nightscout_deployment
};
