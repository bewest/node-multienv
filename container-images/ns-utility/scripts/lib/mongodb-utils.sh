#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

wait_for_mongodb() {
  local host="${1}"
  local port="${2:-27017}"
  local timeout="${3:-120}"
  local elapsed=0
  
  log_info "Waiting for MongoDB at ${host}:${port} (timeout: ${timeout}s)"
  
  while [[ ${elapsed} -lt ${timeout} ]]; do
    if mongosh --host "${host}" --port "${port}" --eval "db.adminCommand('ping')" --quiet &>/dev/null; then
      log_info "MongoDB is ready at ${host}:${port}"
      return 0
    fi
    
    sleep 3
    ((elapsed+=3))
  done
  
  log_error "Timeout waiting for MongoDB at ${host}:${port}"
  return 1
}

init_replica_set() {
  local host="$1"
  local port="${2:-27017}"
  local rs_name="${3:-rs0}"
  
  log_info "Initializing replica set '${rs_name}' on ${host}:${port}"
  
  local rs_config=$(cat <<EOF
{
  _id: '${rs_name}',
  members: [
    { _id: 0, host: '${host}:${port}' }
  ]
}
EOF
)
  
  local result
  result=$(mongosh --host "${host}" --port "${port}" --quiet --eval "
    try {
      const status = rs.status();
      print('ALREADY_INITIALIZED');
    } catch(e) {
      if (e.codeName === 'NotYetInitialized') {
        const result = rs.initiate(${rs_config});
        if (result.ok === 1) {
          print('INITIALIZED');
        } else {
          print('ERROR: ' + JSON.stringify(result));
        }
      } else {
        print('ERROR: ' + e.message);
      }
    }
  " 2>&1)
  
  case "${result}" in
    ALREADY_INITIALIZED)
      log_info "Replica set already initialized"
      return 0
      ;;
    INITIALIZED)
      log_info "Replica set initialized successfully"
      wait_for_replica_set_ready "${host}" "${port}"
      return 0
      ;;
    ERROR*)
      log_error "Failed to initialize replica set: ${result}"
      return 1
      ;;
    *)
      log_warn "Unexpected result: ${result}"
      return 1
      ;;
  esac
}

wait_for_replica_set_ready() {
  local host="$1"
  local port="${2:-27017}"
  local timeout="${3:-60}"
  local elapsed=0
  
  log_info "Waiting for replica set to become ready"
  
  while [[ ${elapsed} -lt ${timeout} ]]; do
    local status
    status=$(mongosh --host "${host}" --port "${port}" --quiet --eval "
      try {
        const status = rs.status();
        const primary = status.members.find(m => m.state === 1);
        if (primary) {
          print('READY');
        } else {
          print('NOT_READY');
        }
      } catch(e) {
        print('ERROR');
      }
    " 2>&1)
    
    if [[ "${status}" == "READY" ]]; then
      log_info "Replica set is ready with primary elected"
      return 0
    fi
    
    sleep 2
    ((elapsed+=2))
  done
  
  log_error "Timeout waiting for replica set to become ready"
  return 1
}

verify_mongodb_health() {
  local host="$1"
  local port="${2:-27017}"
  
  log_info "Verifying MongoDB health at ${host}:${port}"
  
  local ping_result
  ping_result=$(mongosh --host "${host}" --port "${port}" --quiet --eval "
    const result = db.adminCommand('ping');
    print(result.ok === 1 ? 'OK' : 'FAILED');
  " 2>&1)
  
  if [[ "${ping_result}" != "OK" ]]; then
    log_error "MongoDB health check failed"
    return 1
  fi
  
  log_info "MongoDB health check passed"
  return 0
}

# URI-based MongoDB helper functions for authenticated connections
# These mirror the host/port functions above but use connection URIs

wait_for_mongodb_uri() {
  local uri="${1}"
  local timeout="${2:-120}"
  local elapsed=0
  
  log_info "Waiting for MongoDB via URI (timeout: ${timeout}s)"
  
  while [[ ${elapsed} -lt ${timeout} ]]; do
    if mongosh "${uri}" --eval "db.adminCommand('ping')" --quiet &>/dev/null; then
      log_info "MongoDB is ready via URI"
      return 0
    fi
    
    sleep 3
    ((elapsed+=3))
  done
  
  log_error "Timeout waiting for MongoDB via URI"
  return 1
}

init_replica_set_uri() {
  local uri="$1"
  local host="$2"
  local port="$3"
  local rs_name="$4"
  
  log_info "Initializing replica set '${rs_name}' via authenticated URI"
  
  local rs_config=$(cat <<EOF
{
  _id: '${rs_name}',
  members: [
    { _id: 0, host: '${host}:${port}' }
  ]
}
EOF
)
  
  local result
  result=$(mongosh "${uri}" --quiet --eval "
    try {
      const status = rs.status();
      print('ALREADY_INITIALIZED');
    } catch(e) {
      if (e.codeName === 'NotYetInitialized') {
        const result = rs.initiate(${rs_config});
        if (result.ok === 1) {
          print('INITIALIZED');
        } else {
          print('ERROR: ' + JSON.stringify(result));
        }
      } else {
        print('ERROR: ' + e.message);
      }
    }
  " 2>&1)
  
  case "${result}" in
    ALREADY_INITIALIZED)
      log_info "Replica set already initialized"
      return 0
      ;;
    INITIALIZED)
      log_info "Replica set initialized successfully"
      wait_for_replica_set_ready_uri "${uri}"
      return 0
      ;;
    ERROR*)
      log_error "Failed to initialize replica set: ${result}"
      return 1
      ;;
    *)
      log_warn "Unexpected result: ${result}"
      return 1
      ;;
  esac
}

wait_for_replica_set_ready_uri() {
  local uri="$1"
  local timeout="${2:-60}"
  local elapsed=0
  
  log_info "Waiting for replica set to become ready via URI"
  
  while [[ ${elapsed} -lt ${timeout} ]]; do
    local status
    status=$(mongosh "${uri}" --quiet --eval "
      try {
        const status = rs.status();
        const primary = status.members.find(m => m.state === 1);
        if (primary) {
          print('READY');
        } else {
          print('NOT_READY');
        }
      } catch(e) {
        print('ERROR');
      }
    " 2>&1)
    
    if [[ "${status}" == "READY" ]]; then
      log_info "Replica set is ready with primary elected"
      return 0
    fi
    
    sleep 2
    ((elapsed+=2))
  done
  
  log_error "Timeout waiting for replica set to become ready"
  return 1
}

verify_mongodb_health_uri() {
  local uri="$1"
  
  log_info "Verifying MongoDB health via URI"
  
  local ping_result
  ping_result=$(mongosh "${uri}" --quiet --eval "
    const result = db.adminCommand('ping');
    print(result.ok === 1 ? 'OK' : 'FAILED');
  " 2>&1)
  
  if [[ "${ping_result}" != "OK" ]]; then
    log_error "MongoDB health check failed"
    return 1
  fi
  
  log_info "MongoDB health check passed"
  return 0
}

get_replica_set_status() {
  local host="$1"
  local port="${2:-27017}"
  
  mongosh --host "${host}" --port "${port}" --quiet --eval "
    try {
      const status = rs.status();
      print(JSON.stringify({
        set: status.set,
        members: status.members.length,
        primary: status.members.find(m => m.state === 1)?.name || 'none'
      }));
    } catch(e) {
      print(JSON.stringify({ error: e.message }));
    }
  "
}

create_user() {
  local host="$1"
  local port="$2"
  local database="$3"
  local username="$4"
  local password="$5"
  
  log_info "Creating user '${username}' in database '${database}'"
  
  mongosh --host "${host}" --port "${port}" --quiet --eval "
    db = db.getSiblingDB('${database}');
    try {
      db.createUser({
        user: '${username}',
        pwd: '${password}',
        roles: [{ role: 'readWrite', db: '${database}' }]
      });
      print('User created successfully');
    } catch(e) {
      if (e.codeName === 'DuplicateKey') {
        print('User already exists');
      } else {
        throw e;
      }
    }
  " >&2
}

get_database_size() {
  local host="$1"
  local port="$2"
  local database="$3"
  
  mongosh --host "${host}" --port "${port}" --quiet --eval "
    db = db.getSiblingDB('${database}');
    const stats = db.stats();
    print(JSON.stringify({
      collections: stats.collections,
      dataSize: stats.dataSize,
      indexSize: stats.indexSize,
      totalSize: stats.dataSize + stats.indexSize
    }));
  "
}

backup_database_mongodump() {
  local host="$1"
  local port="$2"
  local database="$3"
  local output_dir="$4"
  local username="${5:-}"
  local password="${6:-}"
  
  log_info "Backing up database '${database}' to ${output_dir}"
  
  local auth_opts=""
  if [[ -n "${username}" ]]; then
    auth_opts="--username=${username} --password=${password} --authenticationDatabase=${database}"
  fi
  
  mongodump --host="${host}" --port="${port}" --db="${database}" \
    --out="${output_dir}" ${auth_opts} --gzip
  
  log_info "Backup completed: ${output_dir}"
}

restore_database_mongorestore() {
  local host="$1"
  local port="$2"
  local database="$3"
  local input_dir="$4"
  local username="${5:-}"
  local password="${6:-}"
  
  log_info "Restoring database '${database}' from ${input_dir}"
  
  local auth_opts=""
  if [[ -n "${username}" ]]; then
    auth_opts="--username=${username} --password=${password} --authenticationDatabase=${database}"
  fi
  
  mongorestore --host="${host}" --port="${port}" --db="${database}" \
    "${input_dir}/${database}" ${auth_opts} --gzip --drop
  
  log_info "Restore completed"
}
