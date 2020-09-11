#!/bin/bash

echo starting container...
whoami
pwd
env
ls -alh /etc/nginx
export INTERNAL_PORT=3434
export REDIRECTOR_PORT=3636
export RESOLVER_IP=$(dig +short consul.service.consul | ( read ip; test -z "$ip" && echo 8.8.8.8 || echo $ip:8600))

export PORT=4545

erb nginx.conf.erb | tee /etc/nginx/nginx.conf
service nginx restart

# clean things
rm -rf node_modules

(
  cd $WORKER_DIR
  mkdir -p tmp
  rm -rf node_modules
  npm cache verify
  cat .npmrc || echo "cross fingers"
  npm install
  npm cache verify

  
)
npm install
npm cache verify

trap "finalize" TERM

finalize ( ) {
echo finalize
kill -TERM $redirector_pid
kill -TERM $multienv_pid
}

export CLUSTER_CONSUL_ID="cluster:$HOSTNAME"
export BACKENDS_CONSUL_ID="backend:$HOSTNAME"
PM2=./node_modules/.bin/pm2
INTERNAL_PORT=$REDIRECTOR_PORT $PM2 start --exp-backoff-restart-delay=100 -i 4 redirector-server.js
exec -a multienv $PM2-runtime master.js
# INTERNAL_PORT=$REDIRECTOR_PORT node redirector-server.js &
#redirector_pid=$!
# node master.js  &
# multienv_pid=$!
# wait $multienv_pid

