#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

source "${LIB_DIR}/common.sh"
source "${LIB_DIR}/mongodb-utils.sh"

main() {
  log_info "Starting MongoDB replica set initialization"
  
  require_env "MONGO_HOST"
  
  local mongo_host="${MONGO_HOST}"
  local mongo_port="${MONGO_PORT:-27017}"
  local rs_name="${MONGO_RS_NAME:-rs0}"
  
  log_info "Configuration:"
  log_info "  Host: ${mongo_host}"
  log_info "  Port: ${mongo_port}"
  log_info "  Replica Set: ${rs_name}"
  
  if ! wait_for_mongodb "${mongo_host}" "${mongo_port}" 120; then
    die "MongoDB is not available"
  fi
  
  if ! init_replica_set "${mongo_host}" "${mongo_port}" "${rs_name}"; then
    die "Failed to initialize replica set"
  fi
  
  if ! verify_mongodb_health "${mongo_host}" "${mongo_port}"; then
    die "MongoDB health check failed after initialization"
  fi
  
  log_info "Replica set initialization completed successfully"
  
  local status
  status=$(get_replica_set_status "${mongo_host}" "${mongo_port}")
  log_info "Replica set status: ${status}"
}

main "$@"
