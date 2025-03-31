
const storage = require('./storage');
const mongodb = require('./mongodb');
const nightscout = require('./nightscout');
const provisioner = require('./provisioner');
const deployment = require('./deployment');
const storage = require('./storage');

module.exports = {
  ...storage,
  ...mongodb,
  ...nightscout,
  ...provisioner,
  ...deployment
};
