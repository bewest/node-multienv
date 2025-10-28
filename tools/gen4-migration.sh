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

ARCHITECTURE:
  - Storage Account (Secret): Owns MongoDB resources, identified by account ID
  - Tenant (ConfigMap): Owns Nightscout compute, linked to storage via label
  - For Gen 3b migration: account ID = tenant name (1:1 mapping)

WORKFLOW:
  1. Create storage account via provisioner API (POST /accounts/:accountId)
     → Creates Secret "{accountId}-secret" with storageType: shared
  2. Trigger migration by adding annotations to storage Secret
     → Switches storageType: shared → dedicated
  3. Storage webhook renders migration Job
     → Job copies data from shared MongoDB URI → dedicated StatefulSet
  4. Validate migration completed successfully
     → Check migration-complete annotation on Secret
  5. Label ConfigMap with ns.mdn.io/composite: compute
     → Links ConfigMap to storage account via storage.nightscout.org/account
  6. Compute controller creates Deployment + Service
     → Points to dedicated MongoDB, registers with Consul
  7. Resolver routes traffic via Consul to new Deployment

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
      
      echo "Creating storage account for $tenant..."
      
      # Use provisioner API to create storage account
      # For Gen 3b migration: use tenant name as account ID (1:1 mapping)
      # API creates Secret named "{accountId}-secret" with storageType: shared (no migration yet)
      response=$(curl -s -X POST -H "Content-Type: application/json" \
        -d '{"storageType": "shared", "tier": "basic"}' \
        "$CONTROLLER/accounts/$tenant")
      
      account_id=$(echo "$response" | json account)
      secret_name=$(echo "$response" | json resource.metadata.name)
      
      if [ -z "$account_id" ] || [ -z "$secret_name" ]; then
        echo "✗ Failed to create storage account"
        echo "$response" | json
        exit 1
      fi
      
      echo "✓ Storage account created:"
      echo "  - Account ID: $account_id"
      echo "  - Secret name: $secret_name"
      echo "  - Storage type: shared (do nothing, ready for migration)"
      echo "  - Tier: basic"
      ;;

    trigger-migration)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      # For Gen 3b migration: account ID = tenant name (1:1)
      account_id=$tenant
      secret_name="$account_id-secret"
      
      echo "Triggering migration for tenant $tenant (account: $account_id)..."
      
      # Get current MongoDB URI from ConfigMap (shared MongoDB connection string)
      mongo_uri=$(curl -s "$CONTROLLER/configmaps/$tenant/env/MONGODB_URI" 2>/dev/null | json)
      
      if [ -z "$mongo_uri" ]; then
        echo "✗ Could not retrieve MONGODB_URI from ConfigMap $tenant"
        exit 1
      fi
      
      # Add migration annotations to storage Secret
      # This primes the Secret to trigger migration Job when switched to dedicated
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/migration-needed":"true"}' \
        "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-needed" > /dev/null
      
      curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"ns.mdn.io/migration-source-uri\":\"$mongo_uri\"}" \
        "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-source-uri" > /dev/null
      
      # Switch storage type: shared → dedicated (triggers migration Job)
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/storage-type":"dedicated"}' \
        "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fstorage-type" > /dev/null
      
      echo "✓ Migration triggered:"
      echo "  - Source: $mongo_uri"
      echo "  - Target: Dedicated MongoDB StatefulSet"
      echo "  - Storage webhook will create migration Job"
      echo "  - Check status: $0 validate-migration $tenant"
      ;;

    validate-migration)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      # For Gen 3b migration: account ID = tenant name (1:1)
      account_id=$tenant
      secret_name="$account_id-secret"
      
      echo "Validating migration for tenant $tenant (account: $account_id)..."
      
      # Check migration complete annotation on storage Secret
      migration_complete=$(curl -s "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-complete" 2>/dev/null | json)
      
      if [ "$migration_complete" = "true" ]; then
        echo "✓ Migration COMPLETE"
        
        # Check Secret status
        ready_condition=$(curl -s "$CONTROLLER/secrets/$secret_name" | json status.conditions | json -c 'this.type=="Ready" && this.status=="True"')
        if [ -n "$ready_condition" ]; then
          echo "✓ Storage Secret is Ready"
          echo "✓ Dedicated MongoDB StatefulSet operational"
        else
          echo "⚠ Storage Secret not yet ready"
        fi
        
        exit 0
      else
        echo "⏳ Migration IN PROGRESS or FAILED"
        
        # Check for migration Job status
        echo ""
        echo "Migration Job status:"
        kubectl get job "$account_id-migration" -n "$NAMESPACE" 2>/dev/null || echo "  Migration Job not found (may not be created yet)"
        
        exit 1
      fi
      ;;

    rollback-tenant)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      # For Gen 3b migration: account ID = tenant name (1:1)
      account_id=$tenant
      secret_name="$account_id-secret"
      
      echo "Rolling back tenant $tenant (account: $account_id) to shared MongoDB..."
      
      # Remove migration annotations from storage Secret
      curl -s -X DELETE "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-needed" > /dev/null
      curl -s -X DELETE "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-source-uri" > /dev/null
      curl -s -X DELETE "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-complete" > /dev/null
      
      # Revert storage type: dedicated → shared
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/storage-type":"shared"}' \
        "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fstorage-type" > /dev/null
      
      echo "✓ Rollback complete:"
      echo "  - Storage type: dedicated → shared"
      echo "  - Migration annotations removed"
      echo "  - Storage webhook will delete dedicated MongoDB StatefulSet"
      echo "  - Tenant will use shared MongoDB again"
      ;;

    label-configmap)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      # For Gen 3b migration: account ID = tenant name (1:1)
      account_id=$tenant
      
      echo "Labeling tenant ConfigMap $tenant for Gen 4 (storage account: $account_id)..."
      
      # Add composite label (triggers compute controller)
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/composite":"compute"}' \
        "$CONTROLLER/configmaps/$tenant/metadata/labels/ns.mdn.io%2Fcomposite" > /dev/null
      
      # Add storage account link - links compute (ConfigMap) to storage (Secret)
      curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"storage.nightscout.org/account\":\"$account_id\"}" \
        "$CONTROLLER/configmaps/$tenant/metadata/labels/storage.nightscout.org%2Faccount" > /dev/null
      
      # Remove old Gen 3b label (optional cleanup)
      curl -s -X DELETE "$CONTROLLER/configmaps/$tenant/metadata/labels/ns.mdn.io%2Fcontroller" > /dev/null 2>&1
      
      echo "✓ ConfigMap labeled for Gen 4:"
      echo "  - Tenant: $tenant (compute)"
      echo "  - Storage account: $account_id"
      echo "  - Added: ns.mdn.io/composite=compute (triggers compute controller)"
      echo "  - Added: storage.nightscout.org/account=$account_id (links to storage Secret)"
      echo "  - Removed: ns.mdn.io/controller (old Gen 3b label)"
      ;;

    migrate-tenant)
      tenant=$2
      test -z "$tenant" && (echo "Error: Missing tenant name" && exit 1)
      
      # For Gen 3b migration: account ID = tenant name (1:1)
      account_id=$tenant
      
      echo "=== Migrating tenant $tenant to Gen 4 ==="
      echo "  - Tenant: $tenant (compute ConfigMap)"
      echo "  - Storage account: $account_id (storage Secret)"
      echo ""
      
      # Step 1: Create storage account via provisioner API
      # Creates Secret "{account_id}-secret" with storageType: shared (no migration yet)
      $0 create-storage "$tenant" || exit 1
      echo ""
      
      # Wait for Secret to be created
      sleep 2
      
      # Step 2: Trigger migration to dedicated MongoDB
      # Adds migration annotations and switches storageType: shared → dedicated
      $0 trigger-migration "$tenant" || exit 1
      echo ""
      
      # Step 3: Wait and validate migration (with timeout)
      echo "Waiting for migration Job to complete (timeout: 5 minutes)..."
      timeout=300
      elapsed=0
      while [ $elapsed -lt $timeout ]; do
        if $0 validate-migration "$tenant" > /dev/null 2>&1; then
          echo ""
          $0 validate-migration "$tenant"
          echo ""
          
          # Step 4: Label ConfigMap for Gen 4 (triggers compute controller)
          # Links ConfigMap (compute) to Secret (storage) via storage.nightscout.org/account label
          $0 label-configmap "$tenant" || exit 1
          echo ""
          
          # Step 5: Wait for Consul registration (critical validation)
          echo "Waiting for Consul registration..."
          if "$SCRIPT_DIR/tenant-operations.sh" wait-for-srv "$tenant" 1 30 > /dev/null 2>&1; then
            echo "✓ Consul registration confirmed for $tenant"
            echo ""
            echo "=== Migration Complete for $tenant ==="
            echo "  - Storage: Dedicated MongoDB StatefulSet ($account_id)"
            echo "  - Compute: Nightscout Deployment ($tenant)"
            echo "  - Traffic: Resolver → Consul → Pod"
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
      echo "Check Job logs: kubectl logs -n $NAMESPACE job/$account_id-migration"
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
