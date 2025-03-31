const storage = require('./storage');
const mongodb = require('./mongodb');
const nightscout = require('./nightscout');
const provisioner = require('./provisioner');
const deployment = require('./deployment');
const configmap = require('./configmap'); // Added
const statefulset = require('./statefulset'); // Added

module.exports = {
  ...storage,
  ...mongodb,
  ...nightscout,
  ...provisioner,
  ...deployment,
  ...configmap, // Added
  ...statefulset // Added
};