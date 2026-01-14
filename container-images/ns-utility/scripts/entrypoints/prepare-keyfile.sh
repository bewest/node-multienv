#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/../lib"

source "${LIB_DIR}/common.sh"

main() {
  log_info "MongoDB Keyfile Preparation"
  log_info "============================"
  
  local keyfile_source="${KEYFILE_SOURCE:-/keyfile-secret/keyfile}"
  local keyfile_dest="${KEYFILE_DEST:-/keyfile-prep/keyfile}"
  local keyfile_uid="${KEYFILE_UID:-999}"
  local keyfile_gid="${KEYFILE_GID:-999}"
  
  log_info "Configuration:"
  log_info "  Source: ${keyfile_source}"
  log_info "  Destination: ${keyfile_dest}"
  log_info "  UID:GID: ${keyfile_uid}:${keyfile_gid}"
  
  # Verify source exists
  if [[ ! -f "${keyfile_source}" ]]; then
    die "Keyfile source not found: ${keyfile_source}"
  fi
  
  # Copy keyfile
  log_info "Copying keyfile..."
  if ! cp "${keyfile_source}" "${keyfile_dest}"; then
    die "Failed to copy keyfile from ${keyfile_source} to ${keyfile_dest}"
  fi
  
  # Set permissions (MongoDB requires 400)
  log_info "Setting permissions to 400..."
  if ! chmod 400 "${keyfile_dest}"; then
    die "Failed to chmod 400 ${keyfile_dest}"
  fi
  
  # Set ownership (MongoDB user is typically 999:999)
  log_info "Setting ownership to ${keyfile_uid}:${keyfile_gid}..."
  if ! chown "${keyfile_uid}:${keyfile_gid}" "${keyfile_dest}"; then
    die "Failed to chown ${keyfile_uid}:${keyfile_gid} ${keyfile_dest}"
  fi
  
  # Verify final state
  log_info "Verifying keyfile setup..."
  local perms
  perms=$(stat -c '%a' "${keyfile_dest}")
  local owner
  owner=$(stat -c '%u:%g' "${keyfile_dest}")
  
  log_info "Final state:"
  log_info "  Permissions: ${perms}"
  log_info "  Owner: ${owner}"
  
  if [[ "${perms}" != "400" ]]; then
    die "Keyfile permissions incorrect. Expected 400, got ${perms}"
  fi
  
  if [[ "${owner}" != "${keyfile_uid}:${keyfile_gid}" ]]; then
    die "Keyfile ownership incorrect. Expected ${keyfile_uid}:${keyfile_gid}, got ${owner}"
  fi
  
  log_info "Keyfile preparation completed successfully"
}

# Run main function
main "$@"
