#!/bin/bash

# Tenant Operations Script
# 
# Environment variables:
#   CONTROLLER - URL of deployment controller (default: http://multienv-deployment-controller:3000)
#   NAMESPACE - Kubernetes namespace (default: hosted-tenants)

CONTROLLER=${CONTROLLER:-'http://multienv-deployment-controller:3000'}
NAMESPACE=${NAMESPACE:-'hosted-tenants'}

function main() {
  op=${1:-'help'}
  case $op in
    bash)
      set -- "$@"
      exec "$@"
      ;;
    help)
      cat <<EOF
$0 - Tenant operations tool for Gen 3b/Gen 4 migration

USAGE:
  $0 <command> [args...]

COMMANDS:
  ConfigMap Operations:
    list-tenants [labelSelector]       List all tenant ConfigMaps
    get-tenant <name>                   Get tenant ConfigMap details
    check-config <name> <field>         Check if config field is non-empty
    apply-label <name> <key> <value>    Apply label to ConfigMap
    remove-label <name> <key>           Remove label from ConfigMap
    check-label <name> <key> [expected] Check label value

  Secret Operations:
    list-secrets [labelSelector]        List all storage Secrets
    get-secret <name>                   Get storage Secret details
    apply-annotation <name> <key> <value>  Apply annotation to Secret
    remove-annotation <name> <key>      Remove annotation from Secret
    check-annotation <name> <key>       Check annotation value
    get-secret-status <name>            Get Secret status (from webhook)

  Consul Integration:
    check-srv <tenant>                  Check Consul SRV records
    
  Migration Helpers:
    is-migrated <tenant>                Check if tenant has dedicated MongoDB
    needs-migration <tenant>            Check if migration is needed
    tenant-health <tenant>              Overall tenant health check

EXAMPLES:
  # List all tenants
  $0 list-tenants

  # List tenants needing migration
  $0 list-tenants 'ns.mdn.io/storage-type=shared'

  # Check if tenant has valid config
  $0 check-config demo MONGODB_URI

  # Apply migration annotation
  $0 apply-annotation storage-demo ns.mdn.io/migration-needed true

  # Check migration status
  $0 get-secret-status storage-demo | json status.conditions
EOF
      ;;

    # ConfigMap operations
    list-tenants)
      labelSelector=$2
      if [ -n "$labelSelector" ]; then
        curl -s "$CONTROLLER/configmaps?labelSelector=$labelSelector" | json -a response.body.items | json -a metadata.name
      else
        curl -s "$CONTROLLER/configmaps" | json -a response.body.items | json -a metadata.name
      fi
      ;;

    get-tenant)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      curl -s "$CONTROLLER/configmaps/$tenant" | json
      ;;

    check-config)
      tenant=$2
      field=$3
      test -z "$tenant" || test -z "$field" && (echo "Error: Missing arguments" && exit 1)
      value=$(curl -s "$CONTROLLER/configmaps/$tenant/env/$field" | json)
      if [ -n "$value" ] && [ "$value" != "null" ]; then
        echo "OK: $field=$value"
        exit 0
      else
        echo "MISSING: $field"
        exit 1
      fi
      ;;

    apply-label)
      tenant=$2
      label=$3
      value=$4
      test -z "$tenant" || test -z "$label" && (echo "Error: Missing arguments" && exit 1)
      curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"$label\":\"$value\"}" \
        "$CONTROLLER/configmaps/$tenant/metadata/labels/$label" | json
      ;;

    check-label)
      tenant=$2
      label=$3
      expect=$4
      test -z "$tenant" || test -z "$label" && (echo "Error: Missing arguments" && exit 1)
      value=$(curl -s "$CONTROLLER/configmaps/$tenant/metadata/labels/$label" | json)
      echo "$value"
      if [ -n "$expect" ] && [ "$expect" != "$value" ]; then
        exit 1
      fi
      test -z "$value" && exit 1
      exit 0
      ;;

    remove-label)
      tenant=$2
      label=$3
      test -z "$tenant" || test -z "$label" && (echo "Error: Missing arguments" && exit 1)
      curl -s -X DELETE "$CONTROLLER/configmaps/$tenant/metadata/labels/$label"
      ;;

    # Secret operations
    list-secrets)
      labelSelector=$2
      if [ -n "$labelSelector" ]; then
        curl -s "$CONTROLLER/secrets?labelSelector=$labelSelector" | json -a response.body.items | json -a metadata.name
      else
        curl -s "$CONTROLLER/secrets" | json -a response.body.items | json -a metadata.name
      fi
      ;;

    get-secret)
      secret=$2
      test -z "$secret" && (echo "Error: Missing secret name" && exit 1)
      curl -s "$CONTROLLER/secrets/$secret" | json
      ;;

    apply-annotation)
      secret=$2
      annotation=$3
      value=$4
      test -z "$secret" || test -z "$annotation" && (echo "Error: Missing arguments" && exit 1)
      curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"$annotation\":\"$value\"}" \
        "$CONTROLLER/secrets/$secret/metadata/annotations/$annotation" | json
      ;;

    remove-annotation)
      secret=$2
      annotation=$3
      test -z "$secret" || test -z "$annotation" && (echo "Error: Missing arguments" && exit 1)
      curl -s -X DELETE "$CONTROLLER/secrets/$secret/metadata/annotations/$annotation"
      ;;

    check-annotation)
      secret=$2
      annotation=$3
      test -z "$secret" || test -z "$annotation" && (echo "Error: Missing arguments" && exit 1)
      value=$(curl -s "$CONTROLLER/secrets/$secret/metadata/annotations/$annotation" | json)
      echo "$value"
      test -z "$value" && exit 1
      exit 0
      ;;

    get-secret-status)
      secret=$2
      test -z "$secret" && (echo "Error: Missing secret name" && exit 1)
      curl -s "$CONTROLLER/secrets/$secret" | json status
      ;;

    # Consul integration
    check-srv)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      dig +short "$tenant.backends.service.consul" SRV | sort | uniq
      ;;

    # Migration helpers
    is-migrated)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      storage_type=$(curl -s "$CONTROLLER/secrets/storage-$tenant/metadata/annotations/ns.mdn.io%2Fstorage-type" | json)
      migration_complete=$(curl -s "$CONTROLLER/secrets/storage-$tenant/metadata/annotations/ns.mdn.io%2Fmigration-complete" | json)
      
      if [ "$storage_type" = "dedicated" ] && [ "$migration_complete" = "true" ]; then
        echo "MIGRATED: $tenant has dedicated MongoDB"
        exit 0
      else
        echo "NOT MIGRATED: storage_type=$storage_type, migration_complete=$migration_complete"
        exit 1
      fi
      ;;

    needs-migration)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      storage_type=$(curl -s "$CONTROLLER/secrets/storage-$tenant/metadata/annotations/ns.mdn.io%2Fstorage-type" | json)
      
      if [ "$storage_type" = "shared" ]; then
        echo "NEEDS MIGRATION: $tenant on shared MongoDB"
        exit 0
      else
        echo "NO MIGRATION NEEDED: storage_type=$storage_type"
        exit 1
      fi
      ;;

    tenant-health)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      echo "=== Tenant Health Check: $tenant ==="
      echo ""
      
      # Check ConfigMap exists
      echo -n "ConfigMap exists: "
      if curl -s -f "$CONTROLLER/configmaps/$tenant" > /dev/null 2>&1; then
        echo "✓"
      else
        echo "✗"
      fi
      
      # Check storage Secret exists
      echo -n "Storage Secret exists: "
      if curl -s -f "$CONTROLLER/secrets/storage-$tenant" > /dev/null 2>&1; then
        echo "✓"
      else
        echo "✗"
      fi
      
      # Check Consul registration
      echo -n "Consul SRV records: "
      srv_count=$(dig +short "$tenant.backends.service.consul" SRV | wc -l)
      echo "$srv_count record(s)"
      
      # Check storage type
      storage_type=$(curl -s "$CONTROLLER/secrets/storage-$tenant/metadata/annotations/ns.mdn.io%2Fstorage-type" 2>/dev/null | json)
      echo "Storage type: ${storage_type:-unknown}"
      
      # Check migration status
      migration_complete=$(curl -s "$CONTROLLER/secrets/storage-$tenant/metadata/annotations/ns.mdn.io%2Fmigration-complete" 2>/dev/null | json)
      if [ -n "$migration_complete" ]; then
        echo "Migration complete: $migration_complete"
      fi
      ;;

    *)
      echo "Unknown command: $op"
      echo "Run '$0 help' for usage"
      exit 1
      ;;
  esac
}

main "$@"
