
const template_config_map = (data, opts) => {
  return {
    kind: "ConfigMap",
    metadata: {
      name: data.WEB_NAME,
      annotations: {
        ...opts.default.configmap.annotations
      },
      labels: {
        ...opts.default.configmap.labels
      }
    },
    data: data
  };
};

module.exports = template_config_map;
