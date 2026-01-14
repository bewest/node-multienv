# Nightscout Utility Container

Production-ready utility container for Nightscout multi-tenant Kubernetes platform. Provides reusable, versioned scripts for MongoDB initialization, database migration, CDC verification, and debugging.

## Overview

This container replaces embedded bash scripts in Kubernetes Job and initContainer specifications with:
- **Versioned scripts**: Track changes, rollback if needed
- **Testable logic**: Unit and integration tests outside of K8s
- **Standardized logging**: Consistent structured output
- **Reusable functions**: Share utilities across operations
- **Better debugging**: Interactive shell with preloaded tools

## Quick Start

### Build Container

```bash
cd container-images/ns-utility
./build.sh ns-utility v1.0.0

# Push to registry
REGISTRY=your-registry.io PUSH=true ./build.sh ns-utility v1.0.0
```

### Use in Kubernetes

#### 1. MongoDB Replica Set Initialization (initContainer)

```yaml
initContainers:
- name: init-replica-set
  image: ns-utility:v1.0.0
  command: ['init-replica-set.sh']
  env:
  - name: MONGO_HOST
    value: "demo-mongo-0.demo-mongo"
  - name: MONGO_PORT
    value: "27017"
  - name: MONGO_RS_NAME
    value: "rs0"
```

#### 2. Database Migration (Job)

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: tenant-migration
spec:
  template:
    spec:
      containers:
      - name: migration
        image: ns-utility:v1.0.0
        command: ['migrate-database.sh']
        env:
        - name: SOURCE_MONGO_URI
          valueFrom:
            secretKeyRef:
              name: source-credentials
              key: uri
        - name: TARGET_MONGO_HOST
          value: "demo-mongo-0.demo-mongo"
        - name: TARGET_MONGO_PORT
          value: "27017"
        - name: MIGRATION_METHOD
          value: "mongodump-restore-single-db"
        - name: MIGRATION_SOURCE_DB
          value: "nightscout"
        - name: MIGRATION_TARGET_DB
          value: "ns"
```

#### 3. Tenant Verification (Job)

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: verify-tenant
spec:
  template:
    spec:
      containers:
      - name: verify
        image: ns-utility:v1.0.0
        command: ['verify-tenant.sh']
        env:
        - name: TENANT_ID
          value: "demo"
        - name: MONGO_HOST
          value: "demo-mongo"
        - name: CDC_ENABLED
          value: "true"
        - name: KAFKA_BOOTSTRAP
          value: "kafka-cluster-kafka-bootstrap:9092"
        - name: KAFKA_CONNECT_URL
          value: "http://connect-cluster-connect-api:8083"
```

#### 4. Debug Shell (Pod)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: debug-shell
spec:
  containers:
  - name: debug
    image: ns-utility:v1.0.0
    command: ['debug-shell.sh']
    env:
    - name: TENANT_ID
      value: "demo"
    - name: MONGO_HOST
      value: "demo-mongo"
    stdin: true
    tty: true
```

Then attach:
```bash
kubectl exec -it debug-shell -- /bin/bash
```

## Available Scripts

### Entrypoints (in PATH)

| Script | Purpose | Environment Variables |
|--------|---------|----------------------|
| `init-replica-set.sh` | Initialize MongoDB replica set | `MONGO_HOST`, `MONGO_PORT`, `MONGO_RS_NAME` |
| `migrate-database.sh` | Database migration with verification | `SOURCE_MONGO_URI`, `TARGET_MONGO_HOST`, `TARGET_MONGO_PORT`, `MIGRATION_METHOD`, `MIGRATION_SOURCE_DB`, `MIGRATION_TARGET_DB` |
| `verify-tenant.sh` | Verify tenant health (MongoDB + CDC) | `TENANT_ID`, `MONGO_HOST`, `CDC_ENABLED`, `KAFKA_BOOTSTRAP`, `KAFKA_CONNECT_URL` |
| `debug-shell.sh` | Interactive shell with utilities | Any (informational display) |

### Library Functions

#### Common (`lib/common.sh`)

```bash
source /opt/ns-utility/scripts/lib/common.sh

# Logging
log_info "Starting operation"
log_warn "Warning message"
log_error "Error occurred"
log_debug "Debug info"  # Only shown when LOG_LEVEL=DEBUG

# Error handling
die "Fatal error - exiting"

# Environment validation
require_env "REQUIRED_VAR"

# Retry logic
retry 5 3 command_that_might_fail arg1 arg2

# Wait for network
wait_for_port "mongodb" 27017 60

# HTTP requests
safe_curl "https://api.example.com/status"

# Timestamps
get_timestamp          # 20251026-143022
get_iso_timestamp      # 2025-10-26T14:30:22Z
```

#### MongoDB (`lib/mongodb-utils.sh`)

```bash
source /opt/ns-utility/scripts/lib/mongodb-utils.sh

# Wait for MongoDB to be ready
wait_for_mongodb "demo-mongo" 27017 120

# Initialize replica set
init_replica_set "demo-mongo" 27017 "rs0"

# Wait for RS ready with primary
wait_for_replica_set_ready "demo-mongo" 27017

# Health check
verify_mongodb_health "demo-mongo" 27017

# Get RS status (JSON)
get_replica_set_status "demo-mongo" 27017

# Create user
create_user "demo-mongo" 27017 "mydb" "username" "password"

# Database stats (JSON)
get_database_size "demo-mongo" 27017 "nightscout"

# Backup/restore
backup_database_mongodump "host" 27017 "db" "/backup/dir" "user" "pass"
restore_database_mongorestore "host" 27017 "db" "/backup/dir" "user" "pass"
```

#### Kafka (`lib/kafka-utils.sh`)

```bash
source /opt/ns-utility/scripts/lib/kafka-utils.sh

# Wait for topic
wait_for_kafka_topic "kafka:9092" "ns.demo.entries" 60

# Connector status
get_kafka_connector_status "http://connect:8083" "demo-cdc-source"

# Wait for connector running
wait_for_kafka_connector_running "http://connect:8083" "demo-cdc-source" 120

# Connector management
restart_kafka_connector "http://connect:8083" "demo-cdc-source"
pause_kafka_connector "http://connect:8083" "demo-cdc-source"
resume_kafka_connector "http://connect:8083" "demo-cdc-source"

# Topic operations
list_kafka_topics "kafka:9092" "ns\.demo\..*"
get_kafka_topic_lag "kafka:9092" "consumer-group" "ns.demo.entries"
```

## REST API Integration

If you have a REST API controller for tenant management (as mentioned), you can integrate these scripts:

### Example: Trigger Migration via REST API

```bash
# Your REST API endpoint
CONTROLLER_URL="https://ns-controller.example.com"
TENANT_ID="demo"

# Trigger migration
curl -X POST "${CONTROLLER_URL}/tenants/${TENANT_ID}/migrate" \
  -H "Content-Type: application/json" \
  -d '{
    "source_uri_secret": "legacy-mongo-credentials",
    "method": "mongodump-restore-single-db",
    "source_db": "nightscout"
  }'

# Check migration status
curl "${CONTROLLER_URL}/tenants/${TENANT_ID}/migration/status"
```

### Example: Update Tenant Labels

```bash
# Update tier label
curl -X PATCH "${CONTROLLER_URL}/environs/${TENANT_ID}/labels" \
  -d "ns.mdn.io/tier=premium"

# Restart instance
curl -X POST "${CONTROLLER_URL}/environs/${TENANT_ID}/env/d" -d "d=1"
```

### Example: List All Tenants

```bash
# List all tenants
curl "${CONTROLLER_URL}/tenants" | jq '.[] | {id: .id, tier: .labels["ns.mdn.io/tier"]}'

# Find tenants by tier
curl "${CONTROLLER_URL}/tenants?label=ns.mdn.io/tier=premium"
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `INFO` | Logging level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `MONGO_HOST` | - | MongoDB hostname |
| `MONGO_PORT` | `27017` | MongoDB port |
| `MONGO_RS_NAME` | `rs0` | Replica set name |
| `SOURCE_MONGO_URI` | - | Source MongoDB connection URI for migration |
| `TARGET_MONGO_HOST` | - | Target MongoDB hostname |
| `TARGET_MONGO_PORT` | `27017` | Target MongoDB port |
| `MIGRATION_METHOD` | `mongodump-restore` | Migration method |
| `MIGRATION_SOURCE_DB` | `nightscout` | Source database name |
| `MIGRATION_TARGET_DB` | `ns` | Target database name |
| `TENANT_ID` | - | Tenant identifier |
| `CDC_ENABLED` | `true` | Whether CDC is enabled |
| `KAFKA_BOOTSTRAP` | - | Kafka bootstrap servers |
| `KAFKA_CONNECT_URL` | - | Kafka Connect REST API URL |

## Development

### Running Locally

```bash
# Test init script
docker run --rm \
  -e MONGO_HOST=host.docker.internal \
  -e MONGO_PORT=27017 \
  ns-utility:latest init-replica-set.sh

# Test migration script
docker run --rm \
  -e SOURCE_MONGO_URI="mongodb://source:27017/nightscout" \
  -e TARGET_MONGO_HOST=host.docker.internal \
  -e MIGRATION_METHOD=mongodump-restore-single-db \
  ns-utility:latest migrate-database.sh

# Interactive debug shell
docker run --rm -it \
  -e TENANT_ID=demo \
  -e MONGO_HOST=host.docker.internal \
  ns-utility:latest debug-shell.sh
```

### Testing Scripts

```bash
# Unit tests (TBD)
cd scripts/tests
./test-common.sh
./test-mongodb-utils.sh

# Integration tests require running MongoDB/Kafka
docker-compose up -d
./test-integration.sh
docker-compose down
```

## Audit Metadata

The utility container integrates with the platform's audit metadata system:

### Labels Added to Resources

- `ns.mdn.io/tier`: Tenant tier (basic, premium)
- `ns.mdn.io/data-class`: Data classification (production, test)
- `ns.mdn.io/region`: Deployment region

### Annotations Added to Resources

- `ns.mdn.io/created-at`: ISO 8601 timestamp of creation
- `ns.mdn.io/parent-generation`: ConfigMap generation number
- `ns.mdn.io/tenant-email`: Tenant contact email
- `ns.mdn.io/backup-schedule`: Backup schedule (daily, weekly, etc.)
- `ns.mdn.io/migrated-from`: Source of migration
- `ns.mdn.io/migration-started`: Migration start timestamp
- `ns.mdn.io/last-backup-check`: Last backup verification time

These metadata fields enable:
- **Data recovery**: Find all resources for a tenant
- **Compliance**: Filter by data-class for GDPR/HIPAA queries
- **Billing**: Track resource usage by tier
- **Auditing**: Trace resource lineage and changes

Example queries:
```bash
# Find all production data PVCs
kubectl get pvc -l ns.mdn.io/data-class=production

# Find resources for tenant demo
kubectl get all,pvc -l ns.mdn.io/tenant=demo

# Find premium tier tenants
kubectl get configmap -l ns.mdn.io/tier=premium,ns.mdn.io/enabled=true
```

## Version History

- **v1.0.0** (2025-10-26): Initial release
  - MongoDB replica set initialization
  - Database migration with mongodump/restore
  - Tenant verification scripts
  - Debug shell with utilities
  - Standardized logging and error handling

## License

Part of the Nightscout Multi-Tenant Kubernetes Platform.
