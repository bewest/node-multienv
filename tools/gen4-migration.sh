#!/bin/bash

# Gen 4 Migration Script
# Migrate tenants from Gen 3b (shared MongoDB) to Gen 4 (dedicated MongoDB via two-composite architecture)
#
# Environment variables:
#   CONTROLLER - URL of deployment controller (default: http://multienv-deployment-controller:3000)
#   NAMESPACE - Kubernetes namespace (default: hosted-tenants)
#   SHARED_MONGO_URI - Shared MongoDB connection string for migration source

CONTROLLER=${CONTROLLER:-'http://multienv-deployment-controller:3000'}
NAMESPACE=${NAMESPACE:-'hosted-tenants'}
SHARED_MONGO_URI=${SHARED_MONGO_URI:-'mongodb://shared-mongodb.database.svc.cluster.local:27017'}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tenant-operations.sh" 2>/dev/null || true

function main() {
  op=${1:-'help'}
  case $op in
    help)
      cat <<EOF
$0 - Gen 4 Migration Tool (Gen 3b → Gen 4 Two-Composite Architecture)

USAGE:
  $0 <command> [args...]

COMMANDS:
  Single Tenant Migration:
    create-storage <tenant>             Create storage Secret via provisioner API
    trigger-migration <tenant>          Add migration annotations to Secret
    validate-migration <tenant>         Check migration Job completion
    label-configmap <tenant>            Add Gen 4 labels to ConfigMap
    rollback-tenant <tenant>            Rollback tenant to shared MongoDB
    migrate-tenant <tenant>             Complete migration workflow (all steps)

  Batch Migration:
    batch-migrate <file>                Migrate tenants from line-delimited file
    batch-validate <file>               Validate migration for all tenants in file
    batch-rollback <file>               Rollback all tenants in file

  Migration Status:
    list-pending                        List tenants needing migration
    list-migrated                       List successfully migrated tenants
    migration-progress                  Show overall migration progress

WORKFLOW:
  1. Create storage Secret via provisioner API (POST /accounts/:tenant)
  2. Trigger migration by adding annotations (storageType: shared → dedicated)
  3. Storage webhook creates migration Job
  4. Job copies data from shared → dedicated MongoDB
  5. Validate migration completed successfully
  6. Label ConfigMap with ns.mdn.io/composite: compute (triggers compute controller)
  7. Compute controller creates Deployment + Service pointing to dedicated MongoDB

EXAMPLES:
  # Migrate single tenant
  $0 migrate-tenant demo

  # Batch migrate from file
  $0 list-pending > tenants.txt
  $0 batch-migrate tenants.txt

  # Check progress
  $0 migration-progress
EOF
      ;;

    # Single tenant operations
    create-storage)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      echo "Creating storage Secret for $tenant..."
      
      # Use provisioner API to create storage account
      # For Gen 3b migration, account ID = tenant ID (1:1 mapping)
      # The API creates a Secret named "{accountId}-secret" via template_initial_storage_secret()
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"storageType": "shared", "tier": "basic"}' \
        "$CONTROLLER/accounts/$tenant" | json
      
      echo "✓ Storage Secret created: $tenant-secret"
      echo "  - Account ID: $tenant"
      echo "  - Storage type: shared"
      echo "  - Tier: basic"
      ;;

    trigger-migration)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      echo "Triggering migration for $tenant..."
      
      # Get current MongoDB URI for migration source
      mongo_uri=$(curl -s "$CONTROLLER/configmaps/$tenant/env/MONGODB_URI" 2>/dev/null | json)
      
      # Add migration annotations to storage Secret
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/migration-needed":"true"}' \
        "$CONTROLLER/secrets/$tenant-secret/metadata/annotations/ns.mdn.io%2Fmigration-needed" > /dev/null
      
      curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"ns.mdn.io/migration-source-uri\":\"$mongo_uri\"}" \
        "$CONTROLLER/secrets/$tenant-secret/metadata/annotations/ns.mdn.io%2Fmigration-source-uri" > /dev/null
      
      # Change storage type to dedicated
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/storage-type":"dedicated"}' \
        "$CONTROLLER/secrets/$tenant-secret/metadata/annotations/ns.mdn.io%2Fstorage-type" > /dev/null
      
      echo "✓ Migration triggered for $tenant"
      echo "  - Migration Job will be created by storage webhook"
      echo "  - Check status with: $0 validate-migration $tenant"
      ;;

    validate-migration)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      echo "Validating migration for $tenant..."
      
      # Check migration complete annotation
      migration_complete=$(curl -s "$CONTROLLER/secrets/$tenant-secret/metadata/annotations/ns.mdn.io%2Fmigration-complete" 2>/dev/null | json)
      
      if [ "$migration_complete" = "true" ]; then
        echo "✓ Migration COMPLETE for $tenant"
        
        # Check Secret status
        ready_condition=$(curl -s "$CONTROLLER/secrets/$tenant-secret" | json status.conditions | json -c 'this.type=="Ready" && this.status=="True"')
        if [ -n "$ready_condition" ]; then
          echo "✓ Storage Secret is Ready"
        else
          echo "⚠ Storage Secret not yet ready"
        fi
        
        exit 0
      else
        echo "⏳ Migration IN PROGRESS or FAILED for $tenant"
        
        # Check for migration Job status
        kubectl get job "$tenant-migration" -n "$NAMESPACE" 2>/dev/null || echo "Migration Job not found"
        
        exit 1
      fi
      ;;

    rollback-tenant)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      echo "Rolling back $tenant to shared MongoDB..."
      
      # Remove migration annotations
      curl -s -X DELETE "$CONTROLLER/secrets/$tenant-secret/metadata/annotations/ns.mdn.io%2Fmigration-needed" > /dev/null
      curl -s -X DELETE "$CONTROLLER/secrets/$tenant-secret/metadata/annotations/ns.mdn.io%2Fmigration-source-uri" > /dev/null
      curl -s -X DELETE "$CONTROLLER/secrets/$tenant-secret/metadata/annotations/ns.mdn.io%2Fmigration-complete" > /dev/null
      
      # Revert to shared storage
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/storage-type":"shared"}' \
        "$CONTROLLER/secrets/$tenant-secret/metadata/annotations/ns.mdn.io%2Fstorage-type" > /dev/null
      
      echo "✓ Rollback complete for $tenant"
      echo "  - Storage type reverted to 'shared'"
      echo "  - Migration annotations removed"
      echo "  - StatefulSet will be deleted by storage webhook"
      ;;

    label-configmap)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      echo "Adding Gen 4 labels to ConfigMap $tenant..."
      
      # Add composite label (triggers compute controller)
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/composite":"compute"}' \
        "$CONTROLLER/configmaps/$tenant/metadata/labels/ns.mdn.io%2Fcomposite" > /dev/null
      
      # Add storage account link (for Gen 3b migration, account ID = tenant ID)
      curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"storage.nightscout.org/account\":\"$tenant\"}" \
        "$CONTROLLER/configmaps/$tenant/metadata/labels/storage.nightscout.org%2Faccount" > /dev/null
      
      # Remove old Gen 3b label (optional)
      curl -s -X DELETE "$CONTROLLER/configmaps/$tenant/metadata/labels/ns.mdn.io%2Fcontroller" > /dev/null 2>&1
      
      echo "✓ ConfigMap $tenant labeled for Gen 4"
      echo "  - Added: ns.mdn.io/composite=compute"
      echo "  - Added: storage.nightscout.org/account=$tenant"
      echo "  - Removed: ns.mdn.io/controller (Gen 3b label)"
      ;;

    migrate-tenant)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      echo "=== Migrating $tenant to Gen 4 ==="
      echo ""
      
      # Step 1: Create storage Secret via provisioner API
      $0 create-storage "$tenant" || exit 1
      echo ""
      
      # Wait for Secret to be created
      sleep 2
      
      # Step 2: Trigger migration to dedicated MongoDB
      $0 trigger-migration "$tenant" || exit 1
      echo ""
      
      # Step 3: Wait and validate migration (with timeout)
      echo "Waiting for migration to complete (timeout: 5 minutes)..."
      timeout=300
      elapsed=0
      while [ $elapsed -lt $timeout ]; do
        if $0 validate-migration "$tenant" > /dev/null 2>&1; then
          echo ""
          $0 validate-migration "$tenant"
          echo ""
          
          # Step 4: Label ConfigMap for Gen 4 (triggers compute controller)
          $0 label-configmap "$tenant" || exit 1
          echo ""
          
          # Step 5: Wait for Consul registration (critical validation)
          echo "Waiting for Consul registration..."
          if "$SCRIPT_DIR/tenant-operations.sh" wait-for-srv "$tenant" 1 30 > /dev/null 2>&1; then
            echo "✓ Consul registration confirmed for $tenant"
            echo ""
            echo "=== Migration Complete for $tenant ==="
            exit 0
          else
            echo "⚠ Migration complete but Consul registration failed for $tenant"
            echo "Check pod status: kubectl get pods -n $NAMESPACE -l tenant=$tenant"
            exit 1
          fi
        fi
        sleep 10
        elapsed=$((elapsed + 10))
        echo -n "."
      done
      
      echo ""
      echo "✗ Migration timed out for $tenant"
      echo "Check Job logs: kubectl logs -n $NAMESPACE job/$tenant-migration"
      exit 1
      ;;

    # Batch operations
    batch-migrate)
      file=$2
      test -z "$file" && (echo "Error: Missing tenant list file" && exit 1)
      test ! -f "$file" && (echo "Error: File not found: $file" && exit 1)
      
      total=$(wc -l < "$file")
      current=0
      success=0
      failed=0
      
      echo "=== Batch Migration: $total tenants ==="
      echo ""
      
      while IFS= read -r tenant; do
        current=$((current + 1))
        echo "[$current/$total] Migrating $tenant..."
        
        if $0 migrate-tenant "$tenant"; then
          success=$((success + 1))
          echo "✓ Success: $tenant"
        else
          failed=$((failed + 1))
          echo "✗ Failed: $tenant (rolling back...)"
          $0 rollback-tenant "$tenant"
        fi
        
        # Brief cooldown between tenants (avoid overwhelming system)
        sleep 2
        echo ""
      done < "$file"
      
      echo "=== Migration Summary ==="
      echo "Total: $total"
      echo "Success: $success"
      echo "Failed: $failed"
      
      # Extra sleep after batch to allow system to stabilize
      if [ $success -gt 0 ]; then
        echo ""
        echo "Batch complete. Allowing system to stabilize (30s)..."
        sleep 30
      fi
      
      test $failed -eq 0 && exit 0 || exit 1
      ;;

    batch-validate)
      file=$2
      test -z "$file" && (echo "Error: Missing tenant list file" && exit 1)
      
      while IFS= read -r tenant; do
        $0 validate-migration "$tenant"
      done < "$file"
      ;;

    batch-rollback)
      file=$2
      test -z "$file" && (echo "Error: Missing tenant list file" && exit 1)
      
      while IFS= read -r tenant; do
        echo "Rolling back $tenant..."
        $0 rollback-tenant "$tenant"
      done < "$file"
      ;;

    # Migration status
    list-pending)
      echo "Tenants needing migration (shared MongoDB):"
      curl -s "$CONTROLLER/secrets?labelSelector=ns.mdn.io%2Fcomposite%3Dstorage" \
        | json -a response.body.items \
        | json -c 'this.metadata.annotations["ns.mdn.io/storage-type"]=="shared"' \
        | json -a metadata.labels[\"storage.nightscout.org/account\"]
      ;;

    list-migrated)
      echo "Successfully migrated tenants (dedicated MongoDB):"
      curl -s "$CONTROLLER/secrets?labelSelector=ns.mdn.io%2Fcomposite%3Dstorage" \
        | json -a response.body.items \
        | json -c 'this.metadata.annotations["ns.mdn.io/storage-type"]=="dedicated" && this.metadata.annotations["ns.mdn.io/migration-complete"]=="true"' \
        | json -a metadata.labels[\"storage.nightscout.org/account\"]
      ;;

    migration-progress)
      echo "=== Gen 4 Migration Progress ==="
      echo ""
      
      total=$(curl -s "$CONTROLLER/secrets?labelSelector=ns.mdn.io%2Fcomposite%3Dstorage" | json -a response.body.items | json -a metadata.name | wc -l)
      migrated=$(curl -s "$CONTROLLER/secrets?labelSelector=ns.mdn.io%2Fcomposite%3Dstorage" | json -a response.body.items | json -c 'this.metadata.annotations["ns.mdn.io/migration-complete"]=="true"' | json -a metadata.name | wc -l)
      in_progress=$(curl -s "$CONTROLLER/secrets?labelSelector=ns.mdn.io%2Fcomposite%3Dstorage" | json -a response.body.items | json -c 'this.metadata.annotations["ns.mdn.io/migration-needed"]=="true" && !this.metadata.annotations["ns.mdn.io/migration-complete"]' | json -a metadata.name | wc -l)
      pending=$(curl -s "$CONTROLLER/secrets?labelSelector=ns.mdn.io%2Fcomposite%3Dstorage" | json -a response.body.items | json -c 'this.metadata.annotations["ns.mdn.io/storage-type"]=="shared" && !this.metadata.annotations["ns.mdn.io/migration-needed"]' | json -a metadata.name | wc -l)
      
      echo "Total tenants: $total"
      echo "Migrated: $migrated ($(( migrated * 100 / total ))%)"
      echo "In progress: $in_progress"
      echo "Pending: $pending"
      ;;

    *)
      echo "Unknown command: $op"
      echo "Run '$0 help' for usage"
      exit 1
      ;;
  esac
}

main "$@"
