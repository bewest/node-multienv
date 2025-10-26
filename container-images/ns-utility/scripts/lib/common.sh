#!/bin/bash
set -euo pipefail

readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
readonly LOG_LEVEL="${LOG_LEVEL:-INFO}"

log() {
  local level="$1"
  shift
  local message="$*"
  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "[${timestamp}] [${level}] [${SCRIPT_NAME}] ${message}" >&2
}

log_info() {
  log "INFO" "$@"
}

log_warn() {
  log "WARN" "$@"
}

log_error() {
  log "ERROR" "$@"
}

log_debug() {
  if [[ "${LOG_LEVEL}" == "DEBUG" ]]; then
    log "DEBUG" "$@"
  fi
}

die() {
  log_error "$@"
  exit 1
}

require_env() {
  local var_name="$1"
  local var_value="${!var_name:-}"
  
  if [[ -z "${var_value}" ]]; then
    die "Required environment variable ${var_name} is not set"
  fi
  
  log_debug "Environment variable ${var_name} is set"
}

retry() {
  local max_attempts="${1:-5}"
  local delay="${2:-5}"
  shift 2
  local command=("$@")
  local attempt=1
  
  while [[ ${attempt} -le ${max_attempts} ]]; do
    log_info "Attempt ${attempt}/${max_attempts}: ${command[*]}"
    
    if "${command[@]}"; then
      log_info "Command succeeded on attempt ${attempt}"
      return 0
    fi
    
    if [[ ${attempt} -lt ${max_attempts} ]]; then
      log_warn "Command failed, retrying in ${delay} seconds..."
      sleep "${delay}"
    fi
    
    ((attempt++))
  done
  
  log_error "Command failed after ${max_attempts} attempts"
  return 1
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout="${3:-60}"
  local elapsed=0
  
  log_info "Waiting for ${host}:${port} to become available (timeout: ${timeout}s)"
  
  while [[ ${elapsed} -lt ${timeout} ]]; do
    if timeout 1 bash -c "echo > /dev/tcp/${host}/${port}" 2>/dev/null; then
      log_info "Port ${host}:${port} is ready"
      return 0
    fi
    
    sleep 2
    ((elapsed+=2))
  done
  
  log_error "Timeout waiting for ${host}:${port}"
  return 1
}

get_timestamp() {
  date -u +"%Y%m%d-%H%M%S"
}

get_iso_timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

safe_curl() {
  local url="$1"
  shift
  local curl_opts=("$@")
  
  curl -fsSL --retry 3 --retry-delay 2 --max-time 30 "${curl_opts[@]}" "${url}"
}

check_command() {
  local cmd="$1"
  if ! command -v "${cmd}" &> /dev/null; then
    die "Required command '${cmd}' not found in PATH"
  fi
}

parse_mongo_uri() {
  local uri="$1"
  local component="${2:-host}"
  
  case "${component}" in
    host)
      echo "${uri}" | sed -E 's#mongodb://([^@]+@)?([^:/]+).*#\2#'
      ;;
    port)
      echo "${uri}" | sed -E 's#mongodb://.*:([0-9]+).*#\1#'
      ;;
    database)
      echo "${uri}" | sed -E 's#mongodb://[^/]+/([^?]+).*#\1#'
      ;;
    *)
      die "Invalid component: ${component}"
      ;;
  esac
}

cleanup_on_exit() {
  local cleanup_function="$1"
  trap "${cleanup_function}" EXIT INT TERM
}
