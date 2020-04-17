#!/bin/bash

echo starting container...
whoami
pwd
env
ls -alh /etc/nginx
export INTERNAL_PORT=3434
export REDIRECTOR_PORT=3636
export RESOLVER_IP=$(dig +short consul.service.consul | ( read ip; test -z "$ip" && echo 8.8.8.8 || echo $ip))

export PORT=4545

erb nginx.conf.erb | tee /etc/nginx/nginx.conf
service nginx restart

# clean things
rm -rf node_modules
npm cache clean
(
  cd $WORKER_DIR
  mkdir -p tmp
  rm -rf node_modules
  npm cache verify
  npm install
  npm cache verify

  
)
npm install
npm cache verify
node master.js &
INTERNAL_PORT=3636 node redirector-server.js

