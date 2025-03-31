
const template_deployment = (data, opts) => ({
  kind: "Deployment",
  metadata: {
    name: data.WEB_NAME,
    annotations: {
      ...opts.default.deployment.annotations
    },
    labels: {
      ...opts.default.deployment.labels,
      internal_name: data.WEB_NAME
    }
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: {
        internal_name: data.WEB_NAME
      }
    },
    template: {
      metadata: {
        name: data.WEB_NAME,
        annotations: {
          ...opts.default.deployment.annotations
        },
        labels: {
          ...opts.default.deployment.labels,
          internal_name: data.WEB_NAME,
          tenant: data.WEB_NAME
        }
      }
    }
  }
});

module.exports = {
  template_deployment
};
