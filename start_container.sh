#!/bin/bash

echo starting container...
whoami
pwd
env
function setup_main ( ) {
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
}


PM2=./node_modules/.bin/pm2
RUNTIME=$PM2-runtime

function main ( ) {
export CLUSTER_CONSUL_ID="cluster:$HOSTNAME"
export BACKENDS_CONSUL_ID="backend:$HOSTNAME"
INTERNAL_PORT=$REDIRECTOR_PORT $PM2 start --exp-backoff-restart-delay=100 -i 4 redirector-server.js
exec -a multienv $PM2-runtime master.js
# INTERNAL_PORT=$REDIRECTOR_PORT node redirector-server.js &
#redirector_pid=$!
# node master.js  &
# multienv_pid=$!
# wait $multienv_pid
}

case "$1" in 
  sh|bash)
    set -- "$@"
  ;;
  multienv)
    setup_main
    main
  ;;
  resolver)
    export INTERNAL_PORT=$REDIRECTOR_PORT 
    exec -a resolver $RUNTIME --exp-backoff-restart-delay=100 -i max redirector-server.js
  ;;
  runner)
    export CLUSTER_CONSUL_ID="cluster:$HOSTNAME"
    export BACKENDS_CONSUL_ID="backend:$HOSTNAME"
    exec -a multienv $RUNTIME master.js
  ;;
  inspector)
    exec -a inspector $RUNTIME --exp-backoff-restart-delay=100 -i max k8s-inspector.js
  ;;
  dispatcher)
    exec -a dispatcher $RUNTIME --exp-backoff-restart-delay=100 k8s-dispatcher.js
  ;;
  demuxer)
    exec -a demuxer $RUNTIME --exp-backoff-restart-delay=100 -i max tenant-availability-keeper.js
  ;;
  help|--help)
    echo $0 [command]
    cat <<-EOF
      $1 - this messsage
      bash - run bash
      multienv - classic setup with master/server, redirector-server.js
      resolver - just redirector-server.js
      runner - just master.js
      inspector - k8s-inspector.js - REST API using ConfigMaps
      dispatcher - k8s-dispatcher.js
      demuxer - tenant-availability-keeper.js
EOF
  ;;
esac



