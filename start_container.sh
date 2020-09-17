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

function print_multienv_nginx_template ( ) {
export INTERNAL_PORT=3434
export REDIRECTOR_PORT=3636
export RESOLVER_IP=$(dig +short consul.service.consul | ( read ip; test -z "$ip" && echo 8.8.8.8 || echo $ip:8600))

export PORT=4545

erb nginx.conf.erb 
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

case "${1-help}" in 
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
  env)
    env
  ;;
  nginx-for)
    # allows naming a file to copy the output into but none by default
    OUT=${3-/dev/null}
    test -d $(dirname $OUT) && : || mkdir -p $(dirname $OUT)
    case "$2" in
      std-multienv)
        print_multienv_nginx_template | tee $OUT
      ;;
      inspector)
        erb nginx.conf.erb | tee $OUT
      ;;
      demuxer)
        export NGINX_PORT=$PORT
        export UPSTREAM_SUBREQUEST=${DEMUXER_SERVICE_URI-http://demuxers:3000}
        # eg 169.254.1.1
        # eg kube-dns.kube-system.svc.cluster.local
        export RESOLVER_IP
        erb nginx.demuxer.conf.erb | tee $OUT
      ;;
      resolver)
        export NGINX_PORT=$PORT
        export UPSTREAM_SUBREQUEST=${RESOLVER_SERVICE_URI-http://resolvers:3000}
        export RESOLVER_IP
        erb nginx.resolver.conf.erb | tee $OUT
      ;;
    esac
  ;;
  setup_workdir)
    (
      cd $WORKER_DIR
      rm -Rf node_modules/
      if [[ ! -f .npmrc ]] ; then
        echo "unsafe-perm = true" | tee .npmrc
      fi
      npm install
    )
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


      Helpers
      setup_workdir - (cd \$WORKER_DIR && npm install)
      nginx-for <container> [/dev/stdout]
        Print and optionally save nginx configuration for container.
        * std-multienv - configure legacy nginx config for hybrid runner+resolver
        * inspector - nginx config for inspector interface
        * demuxer - nginx config for cluster-wide cluster demuxer
        * resolver - nginx config for resolver interface
        

EOF
  ;;
esac



