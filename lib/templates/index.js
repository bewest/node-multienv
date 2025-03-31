const storage = require('./storage');
const mongodb = require('./mongodb');
const nightscout = require('./nightscout');
const provisioner = require('./provisioner');
const deployment = require('./deployment');
const configmap = require('./configmap');
const statefulset = require('./statefulset');
const service = require('./service');
const pvc = require('./pvc');

module.exports = {
  ...storage,
  ...mongodb,
  ...nightscout,
  ...provisioner,
  ...deployment,
  ...configmap,
  ...statefulset,
  ...service,
  ...pvc
};