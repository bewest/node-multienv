#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

source "${LIB_DIR}/common.sh"
source "${LIB_DIR}/mongodb-utils.sh"

main() {
  log_info "MongoDB User Creation"
  log_info "===================="
  
  # Validate required environment variables
  require_env "MONGO_HOST"
  require_env "MONGO_ADMIN_URI"
  require_env "NSUSER_USERNAME"
  require_env "NSUSER_PASSWORD"
  require_env "NSUSER_DATABASE"
  
  local mongo_host="${MONGO_HOST}"
  local mongo_port="${MONGO_PORT:-27017}"
  local admin_uri="${MONGO_ADMIN_URI}"
  local nsuser_username="${NSUSER_USERNAME}"
  local nsuser_password="${NSUSER_PASSWORD}"
  local nsuser_database="${NSUSER_DATABASE}"
  local force_create="${FORCE_USER_CREATE:-false}"
  local storage_account="${STORAGE_ACCOUNT:-unknown}"
  
  log_info "Configuration:"
  log_info "  MongoDB: ${mongo_host}:${mongo_port}"
  log_info "  Username: ${nsuser_username}"
  log_info "  Database: ${nsuser_database}"
  log_info "  Force create: ${force_create}"
  log_info "  Storage account: ${storage_account}"
  
  # Wait for MongoDB to be ready
  if ! wait_for_mongodb "${mongo_host}" "${mongo_port}" 120; then
    die "MongoDB is not available at ${mongo_host}:${mongo_port}"
  fi
  
  # Create user
  create_nightscout_user \
    "${mongo_host}" \
    "${mongo_port}" \
    "${admin_uri}" \
    "${nsuser_username}" \
    "${nsuser_password}" \
    "${nsuser_database}" \
    "${force_create}"
  
  # Verify user creation
  verify_user_access \
    "${mongo_host}" \
    "${mongo_port}" \
    "${nsuser_username}" \
    "${nsuser_password}" \
    "${nsuser_database}"
  
  log_info "User creation completed successfully"
  log_info "User '${nsuser_username}' can access database '${nsuser_database}'"
}

create_nightscout_user() {
  local host="$1"
  local port="$2"
  local admin_uri="$3"
  local username="$4"
  local password="$5"
  local database="$6"
  local force="${7:-false}"
  
  # local admin_uri="mongodb://admin:${admin_uri}@${host}:${port}/admin?authSource=admin"
  
  log_info "Creating user '${username}' in database '${database}'"
  
  # Check if user exists
  local user_exists
  user_exists=$(mongosh "${admin_uri}" --quiet --eval "
    try {
      const users = db.getSiblingDB('${database}').getUsers();
      const user = users.users.find(u => u.user === '${username}');
      print(user ? 'true' : 'false');
    } catch(e) {
      print('error: ' + e.message);
    }
  " 2>&1)
  
  if [[ "${user_exists}" == "error:"* ]]; then
    die "Failed to check if user exists: ${user_exists}"
  fi
  
  # Handle existing user
  if [[ "${user_exists}" == "true" ]]; then
    if [[ "${force}" == "true" ]]; then
      log_info "User exists - dropping and recreating (force mode)"
      
      local drop_result
      drop_result=$(mongosh "${admin_uri}" --quiet --eval "
        try {
          db.getSiblingDB('${database}').dropUser('${username}');
          print('DROPPED');
        } catch(e) {
          print('ERROR: ' + e.message);
        }
      " 2>&1)
      
      if [[ "${drop_result}" != "DROPPED" ]]; then
        die "Failed to drop existing user: ${drop_result}"
      fi
      
      log_info "Existing user dropped successfully"
    else
      die "User '${username}' already exists in database '${database}'. Use FORCE_USER_CREATE=true to drop and recreate."
    fi
  fi
  
  # Create user with appropriate roles
  log_info "Creating user with readWrite and dbAdmin roles"
  
  local create_result
  create_result=$(mongosh "${admin_uri}" --quiet --eval "
    try {
      db.getSiblingDB('${database}').createUser({
        user: '${username}',
        pwd: '${password}',
        roles: [
          { role: 'readWrite', db: '${database}' },
          { role: 'dbAdmin', db: '${database}' }
        ]
      });
      print('CREATED');
    } catch(e) {
      print('ERROR: ' + e.message);
    }
  " 2>&1)
  
  if [[ "${create_result}" != "CREATED" ]]; then
    die "Failed to create user: ${create_result}"
  fi
  
  log_info "User '${username}' created successfully"
}

verify_user_access() {
  local host="$1"
  local port="$2"
  local username="$3"
  local password="$4"
  local database="$5"
  
  log_info "Verifying user access"
  
  local user_uri="mongodb://${username}:${password}@${host}:${port}/${database}?authSource=${database}"
  
  local verify_result
  verify_result=$(mongosh "${user_uri}" --quiet --eval "
    try {
      db.adminCommand('ping');
      const stats = db.stats();
      print('OK:' + stats.db);
    } catch(e) {
      print('ERROR: ' + e.message);
    }
  " 2>&1)
  
  if [[ "${verify_result}" == "ERROR:"* ]]; then
    die "User verification failed: ${verify_result}"
  fi
  
  if [[ "${verify_result}" == "OK:"* ]]; then
    local verified_db="${verify_result#OK:}"
    log_info "User access verified - connected to database '${verified_db}'"
    return 0
  fi
  
  die "User verification returned unexpected result: ${verify_result}"
}

# Run main function
main "$@"
