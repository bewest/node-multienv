#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

wait_for_kafka_topic() {
  local bootstrap_server="$1"
  local topic="$2"
  local timeout="${3:-60}"
  local elapsed=0
  
  log_info "Waiting for Kafka topic '${topic}' (timeout: ${timeout}s)"
  
  while [[ ${elapsed} -lt ${timeout} ]]; do
    if kafka-topics.sh --bootstrap-server="${bootstrap_server}" \
         --describe --topic="${topic}" &>/dev/null; then
      log_info "Kafka topic '${topic}' exists"
      return 0
    fi
    
    sleep 3
    ((elapsed+=3))
  done
  
  log_error "Timeout waiting for Kafka topic '${topic}'"
  return 1
}

get_kafka_connector_status() {
  local connect_url="$1"
  local connector_name="$2"
  
  local status
  status=$(safe_curl "${connect_url}/connectors/${connector_name}/status" 2>/dev/null || echo "{}")
  
  echo "${status}" | jq -r '.connector.state // "UNKNOWN"'
}

wait_for_kafka_connector_running() {
  local connect_url="$1"
  local connector_name="$2"
  local timeout="${3:-120}"
  local elapsed=0
  
  log_info "Waiting for Kafka connector '${connector_name}' to be RUNNING (timeout: ${timeout}s)"
  
  while [[ ${elapsed} -lt ${timeout} ]]; do
    local state
    state=$(get_kafka_connector_status "${connect_url}" "${connector_name}")
    
    log_debug "Connector state: ${state}"
    
    if [[ "${state}" == "RUNNING" ]]; then
      log_info "Kafka connector '${connector_name}' is RUNNING"
      return 0
    elif [[ "${state}" == "FAILED" ]]; then
      log_error "Kafka connector '${connector_name}' is FAILED"
      return 1
    fi
    
    sleep 5
    ((elapsed+=5))
  done
  
  log_error "Timeout waiting for Kafka connector '${connector_name}'"
  return 1
}

restart_kafka_connector() {
  local connect_url="$1"
  local connector_name="$2"
  
  log_info "Restarting Kafka connector '${connector_name}'"
  
  safe_curl -X POST "${connect_url}/connectors/${connector_name}/restart"
  
  wait_for_kafka_connector_running "${connect_url}" "${connector_name}"
}

pause_kafka_connector() {
  local connect_url="$1"
  local connector_name="$2"
  
  log_info "Pausing Kafka connector '${connector_name}'"
  
  safe_curl -X PUT "${connect_url}/connectors/${connector_name}/pause"
  
  sleep 2
  local state
  state=$(get_kafka_connector_status "${connect_url}" "${connector_name}")
  
  if [[ "${state}" == "PAUSED" ]]; then
    log_info "Kafka connector paused successfully"
    return 0
  else
    log_warn "Connector state is '${state}' (expected PAUSED)"
    return 1
  fi
}

resume_kafka_connector() {
  local connect_url="$1"
  local connector_name="$2"
  
  log_info "Resuming Kafka connector '${connector_name}'"
  
  safe_curl -X PUT "${connect_url}/connectors/${connector_name}/resume"
  
  wait_for_kafka_connector_running "${connect_url}" "${connector_name}"
}

get_kafka_connector_config() {
  local connect_url="$1"
  local connector_name="$2"
  
  safe_curl "${connect_url}/connectors/${connector_name}/config" | jq .
}

list_kafka_topics() {
  local bootstrap_server="$1"
  local pattern="${2:-.*}"
  
  kafka-topics.sh --bootstrap-server="${bootstrap_server}" --list | grep -E "${pattern}" || true
}

get_kafka_topic_lag() {
  local bootstrap_server="$1"
  local consumer_group="$2"
  local topic="$3"
  
  kafka-consumer-groups.sh --bootstrap-server="${bootstrap_server}" \
    --group="${consumer_group}" --describe | grep "${topic}" || true
}
