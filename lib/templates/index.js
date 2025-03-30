
const storage = require('./storage');
const mongodb = require('./mongodb');
const nightscout = require('./nightscout');

module.exports = {
  ...storage,
  ...mongodb,
  ...nightscout
};
