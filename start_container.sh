#!/bin/bash

echo starting container...
whoami
pwd
env
ls -alh /etc/nginx
export INTERNAL_PORT=3434
export PORT=4545

erb nginx.conf.erb | tee /etc/nginx/nginx.conf
service nginx restart

# clean things
rm -rf node_modules
npm cache clean
(
  cd $WORKER_DIR
  rm -rf node_modules
  npm cache clean
  npm install
  
)
npm install
node master.js

