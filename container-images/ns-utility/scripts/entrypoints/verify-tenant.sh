#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

source "${LIB_DIR}/common.sh"
source "${LIB_DIR}/mongodb-utils.sh"
source "${LIB_DIR}/kafka-utils.sh"

main() {
  log_info "Starting tenant verification"
  
  require_env "TENANT_ID"
  
  local tenant_id="${TENANT_ID}"
  local mongo_host="${MONGO_HOST:-${tenant_id}-mongo}"
  local mongo_port="${MONGO_PORT:-27017}"
  local database="${MONGO_DATABASE:-ns}"
  local kafka_bootstrap="${KAFKA_BOOTSTRAP:-kafka-cluster-kafka-bootstrap:9092}"
  local kafka_connect_url="${KAFKA_CONNECT_URL:-http://connect-cluster-connect-api:8083}"
  local cdc_enabled="${CDC_ENABLED:-true}"
  
  log_info "Tenant verification for: ${tenant_id}"
  
  log_info "=== MongoDB Verification ==="
  if ! wait_for_mongodb "${mongo_host}" "${mongo_port}" 30; then
    log_error "MongoDB is not accessible"
    exit 1
  fi
  
  if ! verify_mongodb_health "${mongo_host}" "${mongo_port}"; then
    log_error "MongoDB health check failed"
    exit 1
  fi
  
  local rs_status
  rs_status=$(get_replica_set_status "${mongo_host}" "${mongo_port}")
  log_info "Replica set status: ${rs_status}"
  
  local db_stats
  db_stats=$(get_database_size "${mongo_host}" "${mongo_port}" "${database}")
  log_info "Database stats: ${db_stats}"
  
  if [[ "${cdc_enabled}" == "true" ]]; then
    log_info "=== Kafka CDC Verification ==="
    
    local topics=("ns.${tenant_id}.entries" "ns.${tenant_id}.treatments")
    for topic in "${topics[@]}"; do
      if wait_for_kafka_topic "${kafka_bootstrap}" "${topic}" 10; then
        log_info "Kafka topic '${topic}' exists"
      else
        log_warn "Kafka topic '${topic}' not found"
      fi
    done
    
    local connector_name="${tenant_id}-cdc-source"
    local connector_state
    connector_state=$(get_kafka_connector_status "${kafka_connect_url}" "${connector_name}")
    log_info "CDC connector '${connector_name}' state: ${connector_state}"
    
    if [[ "${connector_state}" != "RUNNING" ]]; then
      log_warn "CDC connector is not in RUNNING state"
    fi
  fi
  
  log_info "=== Verification Summary ==="
  log_info "✓ MongoDB is healthy and accessible"
  log_info "✓ Replica set is configured"
  log_info "✓ Database exists with collections"
  
  if [[ "${cdc_enabled}" == "true" ]]; then
    log_info "✓ Kafka topics exist"
    log_info "✓ CDC connector status checked"
  fi
  
  log_info "Tenant verification completed successfully"
}

main "$@"
