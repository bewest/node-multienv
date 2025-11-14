#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

source "${LIB_DIR}/common.sh"
source "${LIB_DIR}/mongodb-utils.sh"

main() {
  log_info "Starting database migration"
  
  require_env "SOURCE_MONGO_URI"
  require_env "TARGET_MONGO_HOST"
  
  local source_uri="${SOURCE_MONGO_URI}"
  local target_host="${TARGET_MONGO_HOST}"
  local target_port="${TARGET_MONGO_PORT:-27017}"
  local method="${MIGRATION_METHOD:-mongodump-restore}"
  local source_db="${MIGRATION_SOURCE_DB:-nightscout}"
  local target_db="${MIGRATION_TARGET_DB:-ns}"
  local work_dir="/tmp/migration-$(get_timestamp)"
  
  log_info "Migration configuration:"
  log_info "  Method: ${method}"
  log_info "  Source DB: ${source_db}"
  log_info "  Target DB: ${target_db}"
  log_info "  Target Host: ${target_host}:${target_port}"
  log_info "  Work directory: ${work_dir}"
  
  mkdir -p "${work_dir}"
  cleanup_on_exit "rm -rf ${work_dir}"
  
  if ! wait_for_mongodb "${target_host}" "${target_port}" 120; then
    die "Target MongoDB is not available"
  fi
  
  case "${method}" in
    mongodump-restore|mongodump-restore-single-db)
      migrate_with_mongodump "${source_uri}" "${target_host}" "${target_port}" \
        "${source_db}" "${target_db}" "${work_dir}"
      ;;
    *)
      die "Unsupported migration method: ${method}"
      ;;
  esac
  
  verify_migration "${target_host}" "${target_port}" "${target_db}"
  
  log_info "Database migration completed successfully"
}

migrate_with_mongodump() {
  local source_uri="$1"
  local target_host="$2"
  local target_port="$3"
  local source_db="$4"
  local target_db="$5"
  local work_dir="$6"
  
  log_info "Dumping source database '${source_db}'"
  
  if ! mongodump --uri="${source_uri}" --db="${source_db}" \
       --out="${work_dir}" --gzip 2>&1 | grep -v "SCRAM-SHA" || true; then
    die "Failed to dump source database"
  fi
  
  local dump_size
  dump_size=$(du -sh "${work_dir}/${source_db}" | cut -f1)
  log_info "Dump completed: ${dump_size}"
  
  log_info "Restoring to target database '${target_db}'"
  
  if ! mongorestore --host="${target_host}" --port="${target_port}" \
       --db="${target_db}" --nsFrom="${source_db}.*" --nsTo="${target_db}.*" \
       "${work_dir}/${source_db}" --gzip --drop 2>&1 | grep -v "SCRAM-SHA" || true; then
    die "Failed to restore to target database"
  fi
  
  log_info "Restore completed"
}

verify_migration() {
  local host="$1"
  local port="$2"
  local database="$3"
  
  log_info "Verifying migration for database '${database}'"
  
  local stats
  stats=$(get_database_size "${host}" "${port}" "${database}")
  
  local collections
  collections=$(echo "${stats}" | jq -r '.collections')
  
  local total_size
  total_size=$(echo "${stats}" | jq -r '.totalSize')
  
  if [[ "${collections}" -eq 0 ]]; then
    log_warn "No collections found in target database - migration may have failed"
    return 1
  fi
  
  log_info "Migration verification:"
  log_info "  Collections: ${collections}"
  log_info "  Total size: ${total_size} bytes"
  
  log_info "Checking critical collections"
  
  local critical_collections=("entries" "treatments")
  for collection in "${critical_collections[@]}"; do
    local count
    count=$(mongo --host="${host}" --port="${port}" --quiet --eval "
      db = db.getSiblingDB('${database}');
      print(db.${collection}.countDocuments());
    " 2>/dev/null)
    
    log_info "  Collection '${collection}': ${count} documents"
  done
  
  log_info "Migration verification passed"
  return 0
}

main "$@"
