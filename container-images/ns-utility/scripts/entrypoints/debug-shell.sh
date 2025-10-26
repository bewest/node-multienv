#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

source "${LIB_DIR}/common.sh"
source "${LIB_DIR}/mongodb-utils.sh"
source "${LIB_DIR}/kafka-utils.sh"

cat <<'EOF'
╔═══════════════════════════════════════════════════════════════╗
║   Nightscout Multi-Tenant Platform - Debug Shell             ║
║                                                               ║
║   Available utilities:                                        ║
║                                                               ║
║   MongoDB Functions:                                          ║
║     wait_for_mongodb <host> [port] [timeout]                 ║
║     init_replica_set <host> [port] [rs_name]                 ║
║     verify_mongodb_health <host> [port]                      ║
║     get_replica_set_status <host> [port]                     ║
║     get_database_size <host> <port> <database>               ║
║     backup_database_mongodump <host> <port> <db> <out_dir>   ║
║     restore_database_mongorestore <host> <port> <db> <dir>   ║
║                                                               ║
║   Kafka Functions:                                            ║
║     wait_for_kafka_topic <bootstrap> <topic> [timeout]       ║
║     get_kafka_connector_status <connect_url> <name>          ║
║     wait_for_kafka_connector_running <url> <name> [timeout]  ║
║     restart_kafka_connector <connect_url> <name>             ║
║     pause_kafka_connector <connect_url> <name>               ║
║     resume_kafka_connector <connect_url> <name>              ║
║     list_kafka_topics <bootstrap> [pattern]                  ║
║                                                               ║
║   Common Functions:                                           ║
║     log_info <message>                                        ║
║     log_warn <message>                                        ║
║     log_error <message>                                       ║
║     retry <max_attempts> <delay> <command...>                ║
║     wait_for_port <host> <port> [timeout]                    ║
║     safe_curl <url> [curl_opts...]                           ║
║                                                               ║
║   Environment Variables:                                      ║
║     TENANT_ID: ${TENANT_ID:-<not set>}
║     MONGO_HOST: ${MONGO_HOST:-<not set>}
║     KAFKA_BOOTSTRAP: ${KAFKA_BOOTSTRAP:-<not set>}
║     KAFKA_CONNECT_URL: ${KAFKA_CONNECT_URL:-<not set>}
║                                                               ║
║   Tools Available:                                            ║
║     mongosh, mongodump, mongorestore, kafka-*.sh             ║
║     curl, jq, kubectl (if kubeconfig available)              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

EOF

if [[ -n "${TENANT_ID:-}" ]]; then
  log_info "Debug shell initialized for tenant: ${TENANT_ID}"
fi

export PS1='\[\033[01;32m\][ns-debug]\[\033[00m\] \[\033[01;34m\]\w\[\033[00m\]\$ '

exec /bin/bash --norc
