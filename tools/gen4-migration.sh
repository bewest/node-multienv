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
    create-storage <account_id>                        Create storage Secret via provisioner API
    trigger-migration <account_id> <mongo_uri>         Add migration annotations to Secret
    validate-migration <account_id>                    Check migration Job completion
    label-configmap <tenant_id> <account_id>           Add Gen 4 labels to ConfigMap
    rollback-tenant <account_id>                       Rollback to shared MongoDB
    migrate-tenant <tenant_id> <account_id> <mongo_uri>  Complete migration workflow (all steps)

  Batch Migration:
    batch-migrate <file>                Migrate tenants from space-delimited file
                                        Format: tenant_id account_id mongo_uri
    batch-validate <file>               Validate migration for all tenants in file
    batch-rollback <file>               Rollback all tenants in file

  Migration Status:
    list-pending                        List tenants needing migration
    list-migrated                       List successfully migrated tenants
    migration-progress                  Show overall migration progress

ARCHITECTURE:
  - Storage Account (Secret): Owns MongoDB resources, identified by account ID
  - Tenant (ConfigMap): Owns Nightscout compute, identified by tenant ID
  - ConfigMap links to storage via storage.nightscout.org/account label
  - Account ID ≠ Tenant ID (separate identifiers from legacy system)

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
  # Migrate single tenant with separate tenant ID and storage account ID
  $0 migrate-tenant demo1234 507f1f77bcf86cd799439011 "mongodb://user:pass@shared:27017/ns"

  # Batch migrate from file (space-delimited: tenant_id account_id mongo_uri)
  cat > tenants.txt <<EOF
demo1234 507f1f77bcf86cd799439011 mongodb://user:pass@shared:27017/ns_demo
demo5678 507f1f77bcf86cd799439022 mongodb://user:pass@shared:27017/ns_other
EOF
  $0 batch-migrate tenants.txt

  # Check progress
  $0 migration-progress
EOF
      ;;

    # Single tenant operations
    create-storage)
      account_id=$2
      test -z "$account_id" && (echo "Error: Missing account ID" && exit 1)
      
      echo "Creating storage account: $account_id..."
      
      # Use provisioner API to create storage account with existing account ID
      # POST /accounts/:account - records existing storage account ID (preserves external mapping)
      # API creates Secret named "{accountId}-secret" with storageType: shared (no migration yet)
      response=$(curl -s -X POST -H "Content-Type: application/json" \
        -d '{"storageType": "shared", "tier": "basic"}' \
        "$CONTROLLER/accounts/$account_id")
      
      returned_account_id=$(echo "$response" | json account)
      secret_name=$(echo "$response" | json resource.metadata.name)
      
      if [ -z "$returned_account_id" ] || [ -z "$secret_name" ]; then
        echo "✗ Failed to create storage account"
        echo "$response" | json
        exit 1
      fi
      
      echo "✓ Storage account created:"
      echo "  - Account ID: $returned_account_id"
      echo "  - Secret name: $secret_name"
      echo "  - Storage type: shared (do nothing, ready for migration)"
      echo "  - Tier: basic"
      ;;

    trigger-migration)
      account_id=$2
      mongo_uri=$3
      test -z "$account_id" && (echo "Error: Missing account ID" && exit 1)
      test -z "$mongo_uri" && (echo "Error: Missing MongoDB URI" && exit 1)
      
      secret_name="$account_id-secret"
      
      echo "Triggering migration for storage account: $account_id..."
      echo "  - Source MongoDB: $mongo_uri"
      
      # Add migration annotations to storage Secret (primes for migration)
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
      echo "  - Account ID: $account_id"
      echo "  - Secret: $secret_name"
      echo "  - Target: Dedicated MongoDB StatefulSet"
      echo "  - Storage webhook will create migration Job: $account_id-migration"
      echo "  - Check status: $0 validate-migration $account_id"
      ;;

    validate-migration)
      account_id=$2
      test -z "$account_id" && (echo "Error: Missing account ID" && exit 1)
      
      secret_name="$account_id-secret"
      
      echo "Validating migration for storage account: $account_id..."
      
      # Check migration complete annotation on storage Secret
      migration_complete=$(curl -s "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-complete" 2>/dev/null | json)
      
      if [ "$migration_complete" = "true" ]; then
        echo "✓ Migration COMPLETE"
        echo "  - Account ID: $account_id"
        echo "  - Secret: $secret_name"
        
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
        echo "  - Account ID: $account_id"
        
        # Check for migration Job status
        echo ""
        echo "Migration Job status:"
        kubectl get job "$account_id-migration" -n "$NAMESPACE" 2>/dev/null || echo "  Migration Job not found (may not be created yet)"
        
        exit 1
      fi
      ;;

    rollback-tenant)
      account_id=$2
      test -z "$account_id" && (echo "Error: Missing account ID" && exit 1)
      
      secret_name="$account_id-secret"
      
      echo "Rolling back storage account $account_id to shared MongoDB..."
      
      # Remove migration annotations from storage Secret
      curl -s -X DELETE "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-needed" > /dev/null
      curl -s -X DELETE "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-source-uri" > /dev/null
      curl -s -X DELETE "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fmigration-complete" > /dev/null
      
      # Revert storage type: dedicated → shared
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/storage-type":"shared"}' \
        "$CONTROLLER/secrets/$secret_name/metadata/annotations/ns.mdn.io%2Fstorage-type" > /dev/null
      
      echo "✓ Rollback complete:"
      echo "  - Account ID: $account_id"
      echo "  - Storage type: dedicated → shared"
      echo "  - Migration annotations removed"
      echo "  - Storage webhook will delete dedicated MongoDB StatefulSet"
      ;;

    label-configmap)
      tenant_id=$2
      account_id=$3
      test -z "$tenant_id" && (echo "Error: Missing tenant ID" && exit 1)
      test -z "$account_id" && (echo "Error: Missing account ID" && exit 1)
      
      echo "Labeling tenant ConfigMap $tenant_id for Gen 4..."
      echo "  - Tenant ID: $tenant_id (compute)"
      echo "  - Storage account: $account_id"
      
      # Add composite label (triggers compute controller)
      curl -s -X POST -H "Content-Type: application/json" \
        -d '{"ns.mdn.io/composite":"compute"}' \
        "$CONTROLLER/configmaps/$tenant_id/metadata/labels/ns.mdn.io%2Fcomposite" > /dev/null
      
      # Add storage account link - links compute (ConfigMap) to storage (Secret)
      curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"storage.nightscout.org/account\":\"$account_id\"}" \
        "$CONTROLLER/configmaps/$tenant_id/metadata/labels/storage.nightscout.org%2Faccount" > /dev/null
      
      # Remove old Gen 3b label (cleanup, triggers old deployment deletion)
      curl -s -X DELETE "$CONTROLLER/configmaps/$tenant_id/metadata/labels/ns.mdn.io%2Fcontroller" > /dev/null 2>&1
      
      echo "✓ ConfigMap labeled:"
      echo "  - Added: ns.mdn.io/composite=compute (triggers compute controller)"
      echo "  - Added: storage.nightscout.org/account=$account_id (links to storage)"
      echo "  - Removed: ns.mdn.io/controller (old Gen 3b deployment deleted)"
      echo "  - Gen 4 webhooks now render Deployment + Service"
      ;;

    migrate-tenant)
      tenant_id=$2
      account_id=$3
      mongo_uri=$4
      test -z "$tenant_id" && (echo "Error: Missing tenant ID" && exit 1)
      test -z "$account_id" && (echo "Error: Missing account ID" && exit 1)
      test -z "$mongo_uri" && (echo "Error: Missing MongoDB URI" && exit 1)
      
      echo "=== Migrating tenant to Gen 4 ==="
      echo "  - Tenant ID: $tenant_id (compute ConfigMap)"
      echo "  - Storage account: $account_id (storage Secret)"
      echo "  - Source MongoDB: $mongo_uri"
      echo ""
      
      # Step 1: Create storage account via provisioner API
      # Creates Secret "{account_id}-secret" with storageType: shared (do nothing, ready for migration)
      $0 create-storage "$account_id" || exit 1
      echo ""
      
      # Wait for Secret to be created
      sleep 2
      
      # Step 2: Trigger migration to dedicated MongoDB
      # Primes Secret with annotations, then switches storageType: shared → dedicated
      $0 trigger-migration "$account_id" "$mongo_uri" || exit 1
      echo ""
      
      # Step 3: Wait and validate migration (with timeout)
      echo "Waiting for migration Job to complete (timeout: 5 minutes)..."
      timeout=300
      elapsed=0
      while [ $elapsed -lt $timeout ]; do
        if $0 validate-migration "$account_id" > /dev/null 2>&1; then
          echo ""
          $0 validate-migration "$account_id"
          echo ""
          
          # Step 4: Label ConfigMap for Gen 4 (triggers compute controller, deletes old deployment)
          # Links ConfigMap (compute) to Secret (storage) via storage.nightscout.org/account label
          $0 label-configmap "$tenant_id" "$account_id" || exit 1
          echo ""
          
          # Step 5: Wait for Consul registration (critical validation)
          echo "Waiting for Consul registration..."
          if "$SCRIPT_DIR/tenant-operations.sh" wait-for-srv "$tenant_id" 1 30 > /dev/null 2>&1; then
            echo "✓ Consul registration confirmed for $tenant_id"
            echo ""
            echo "=== Migration Complete ==="
            echo "  - Tenant ID: $tenant_id"
            echo "  - Storage account: $account_id"
            echo "  - Storage: Dedicated MongoDB StatefulSet"
            echo "  - Compute: Nightscout Deployment (Gen 4)"
            echo "  - Traffic: Resolver → Consul → Pod"
            exit 0
          else
            echo "⚠ Migration complete but Consul registration failed for $tenant_id"
            echo "Check pod status: kubectl get pods -n $NAMESPACE -l tenant=$tenant_id"
            exit 1
          fi
        fi
        sleep 10
        elapsed=$((elapsed + 10))
        echo -n "."
      done
      
      echo ""
      echo "✗ Migration timed out"
      echo "  - Tenant ID: $tenant_id"
      echo "  - Account ID: $account_id"
      echo "Check Job logs: kubectl logs -n $NAMESPACE job/$account_id-migration"
      exit 1
      ;;

    # Batch operations
    batch-migrate)
      file=$2
      test -z "$file" && (echo "Error: Missing migration file" && exit 1)
      test ! -f "$file" && (echo "Error: File not found: $file" && exit 1)
      
      total=$(wc -l < "$file")
      current=0
      success=0
      failed=0
      
      echo "=== Batch Migration: $total tenants ==="
      echo "File format: tenant_id account_id mongo_uri (space-delimited)"
      echo ""
      
      while read -r tenant_id account_id mongo_uri; do
        # Skip empty lines and comments
        [[ -z "$tenant_id" || "$tenant_id" =~ ^# ]] && continue
        
        current=$((current + 1))
        echo "[$current/$total] Migrating..."
        echo "  - Tenant: $tenant_id"
        echo "  - Account: $account_id"
        
        if $0 migrate-tenant "$tenant_id" "$account_id" "$mongo_uri"; then
          success=$((success + 1))
          echo "✓ Success: $tenant_id"
        else
          failed=$((failed + 1))
          echo "✗ Failed: $tenant_id (rolling back...)"
          $0 rollback-tenant "$account_id"
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
      test -z "$file" && (echo "Error: Missing migration file" && exit 1)
      
      echo "Validating migrations from file..."
      while read -r tenant_id account_id mongo_uri; do
        # Skip empty lines and comments
        [[ -z "$tenant_id" || "$tenant_id" =~ ^# ]] && continue
        
        echo "Validating $tenant_id (account: $account_id)..."
        $0 validate-migration "$account_id"
      done < "$file"
      ;;

    batch-rollback)
      file=$2
      test -z "$file" && (echo "Error: Missing migration file" && exit 1)
      
      echo "Rolling back tenants from file..."
      while read -r tenant_id account_id mongo_uri; do
        # Skip empty lines and comments
        [[ -z "$tenant_id" || "$tenant_id" =~ ^# ]] && continue
        
        echo "Rolling back $tenant_id (account: $account_id)..."
        $0 rollback-tenant "$account_id"
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
