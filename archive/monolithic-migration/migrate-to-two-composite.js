#!/usr/bin/env node

/**
 * Migration Utility: Gen 3b → Gen 4 Two-Composite Architecture
 * 
 * Transitions existing ConfigMap-based tenants (Gen 3b) to two-composite architecture:
 * 1. Creates storage Secret from ConfigMap (extracts storage account + credentials)
 * 2. Updates ConfigMap to reference storage account (removes credentials)
 * 3. Changes labels for gradual migration (controller → composite)
 * 
 * Usage:
 *   # Dry run (show what would happen)
 *   node migrate-to-two-composite.js --dry-run
 * 
 *   # Migrate single tenant
 *   node migrate-to-two-composite.js --tenant demo
 * 
 *   # Migrate all tenants with confirmation
 *   node migrate-to-two-composite.js --all
 * 
 *   # Batch migrate (10 at a time)
 *   node migrate-to-two-composite.js --batch 10
 */

const k8s = require('@kubernetes/client-node');
const crypto = require('crypto');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

// Configuration
const NAMESPACE = process.env.NAMESPACE || 'hosted-tenants';
const DRY_RUN = process.argv.includes('--dry-run');
const TENANT = process.argv.find((arg, i) => process.argv[i - 1] === '--tenant');
const ALL = process.argv.includes('--all');
const BATCH_SIZE = parseInt(process.argv.find((arg, i) => process.argv[i - 1] === '--batch') || '0');

async function main() {
  console.log('🔄 Gen 3b → Gen 4 Two-Composite Migration Utility\n');
  console.log(`Namespace: ${NAMESPACE}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}\n`);

  // Find existing Gen 3b ConfigMaps
  const configMaps = await findGen3bConfigMaps();
  console.log(`Found ${configMaps.length} Gen 3b tenants\n`);

  if (configMaps.length === 0) {
    console.log('✅ No Gen 3b tenants found. All migrated or no tenants exist.');
    return;
  }

  let tenantsToMigrate = configMaps;

  // Filter by tenant name if specified
  if (TENANT) {
    tenantsToMigrate = configMaps.filter(cm => cm.metadata.name === TENANT);
    if (tenantsToMigrate.length === 0) {
      console.error(`❌ Tenant '${TENANT}' not found or already migrated`);
      process.exit(1);
    }
    console.log(`Migrating single tenant: ${TENANT}\n`);
  }

  // Batch processing
  if (BATCH_SIZE > 0) {
    tenantsToMigrate = tenantsToMigrate.slice(0, BATCH_SIZE);
    console.log(`Migrating batch of ${BATCH_SIZE} tenants\n`);
  }

  // Show summary
  console.log('📋 Migration Plan:');
  tenantsToMigrate.forEach((cm, i) => {
    const storageAccount = extractStorageAccount(cm);
    console.log(`  ${i + 1}. ${cm.metadata.name} → storage account: ${storageAccount}`);
  });
  console.log('');

  if (!DRY_RUN && !TENANT && !confirm()) {
    console.log('❌ Migration cancelled');
    return;
  }

  // Execute migration
  let succeeded = 0;
  let failed = 0;

  for (const cm of tenantsToMigrate) {
    try {
      await migrateTenant(cm);
      succeeded++;
    } catch (error) {
      console.error(`  ❌ Failed: ${error.message}`);
      failed++;
    }
  }

  console.log('\n✅ Migration Summary:');
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Remaining Gen 3b tenants: ${configMaps.length - succeeded}`);

  if (DRY_RUN) {
    console.log('\n💡 Run without --dry-run to apply changes');
  }
}

/**
 * Find existing Gen 3b ConfigMaps
 */
async function findGen3bConfigMaps() {
  const response = await k8sApi.listNamespacedConfigMap(
    NAMESPACE,
    undefined,
    undefined,
    undefined,
    undefined,
    'ns.mdn.io/controller=deployment' // Gen 3b label selector
  );

  return response.body.items.filter(cm => {
    // Skip if already migrated
    return cm.metadata.labels?.['ns.mdn.io/composite'] !== 'compute';
  });
}

/**
 * Extract storage account ID from ConfigMap
 */
function extractStorageAccount(configMap) {
  // Try annotation first
  const annotation = configMap.metadata.annotations?.['storage.nightscout.org/account'];
  if (annotation) return annotation;

  // Fall back to ConfigMap name or hash
  const name = configMap.metadata.name;
  
  // Check if using shared MongoDB (most of the 1300 sites)
  const mongoConnection = configMap.data?.MONGO_CONNECTION || '';
  if (mongoConnection.includes('shared-mongodb')) {
    return 'shared-cluster';
  }

  // Dedicated MongoDB - use tenant name as storage account
  return name;
}

/**
 * Migrate a single tenant to two-composite architecture
 */
async function migrateTenant(configMap) {
  const tenantId = configMap.metadata.name;
  const storageAccount = extractStorageAccount(configMap);

  console.log(`\n🔄 Migrating ${tenantId}...`);

  // Step 1: Create storage Secret (if doesn't exist)
  const secret = await createStorageSecret(configMap, storageAccount);
  console.log(`  ✅ Storage Secret: ${secret.metadata.name}`);

  // Step 2: Update ConfigMap (remove credentials, add labels)
  const updatedConfigMap = await updateConfigMapForCompute(configMap, storageAccount);
  console.log(`  ✅ ConfigMap updated: ${updatedConfigMap.metadata.name}`);

  console.log(`  ✅ Migration complete for ${tenantId}`);
}

/**
 * Create storage Secret from ConfigMap
 */
async function createStorageSecret(configMap, storageAccount) {
  const secretName = `storage-${storageAccount}`;

  // Check if Secret already exists
  try {
    const existing = await k8sApi.readNamespacedSecret(secretName, NAMESPACE);
    console.log(`  ℹ️  Storage Secret already exists: ${secretName}`);
    return existing.body;
  } catch (error) {
    if (error.response?.statusCode !== 404) throw error;
  }

  // Extract storage configuration from ConfigMap
  const mongoConnection = configMap.data?.MONGO_CONNECTION || '';
  const mongoUser = configMap.data?.MONGO_USER || 'nsuser';
  const mongoPassword = configMap.data?.MONGO_PASSWORD || generatePassword();
  const mongoDb = configMap.data?.MONGO_DB || 'nightscout';

  // Determine storage type (shared vs dedicated)
  const isShared = mongoConnection.includes('shared-mongodb') || storageAccount === 'shared-cluster';
  const storageType = isShared ? 'shared' : 'dedicated';

  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace: NAMESPACE,
      labels: {
        'ns.mdn.io/composite': 'storage',
        'storage.nightscout.org/account': storageAccount,
        'ns.mdn.io/tier': configMap.metadata.labels?.['ns.mdn.io/tier'] || 'basic',
        'ns.mdn.io/migrated-from': 'gen3b'
      },
      annotations: {
        'ns.mdn.io/storage-type': storageType,
        'ns.mdn.io/created-at': new Date().toISOString(),
        'ns.mdn.io/original-tenant': configMap.metadata.name
      }
    },
    type: 'Opaque',
    stringData: isShared ? {
      // Shared MongoDB - just connection details
      mongoHost: 'shared-mongodb.database.svc.cluster.local',
      username: mongoUser,
      password: mongoPassword,
      database: mongoDb
    } : {
      // Dedicated MongoDB - StatefulSet will be created
      replicas: '1',
      storageGi: '2',
      mongoImage: 'mongo:6',
      imagePullPolicy: 'IfNotPresent',
      cpuRequest: '100m',
      cpuLimit: '500m',
      memRequest: '256Mi',
      memLimit: '512Mi',
      username: mongoUser,
      password: mongoPassword,
      database: mongoDb
    }
  };

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would create Secret: ${secretName} (${storageType})`);
    return secret;
  }

  const response = await k8sApi.createNamespacedSecret(NAMESPACE, secret);
  return response.body;
}

/**
 * Update ConfigMap for compute composite
 */
async function updateConfigMapForCompute(configMap, storageAccount) {
  const updated = {
    ...configMap,
    metadata: {
      ...configMap.metadata,
      labels: {
        ...configMap.metadata.labels,
        // Change from Gen 3b to Gen 4
        'ns.mdn.io/controller': undefined, // Remove Gen 3b label
        'ns.mdn.io/composite': 'compute', // Add Gen 4 label
        'storage.nightscout.org/account': storageAccount,
        'ns.mdn.io/migrated-from': 'gen3b'
      },
      annotations: {
        ...configMap.metadata.annotations,
        'ns.mdn.io/migrated-at': new Date().toISOString()
      }
    },
    data: {
      ...configMap.data,
      // Remove MongoDB credentials (now in Secret)
      MONGO_CONNECTION: undefined,
      MONGO_USER: undefined,
      MONGO_PASSWORD: undefined,
      MONGO_DB: undefined
    }
  };

  // Clean up undefined values
  Object.keys(updated.metadata.labels).forEach(key => {
    if (updated.metadata.labels[key] === undefined) {
      delete updated.metadata.labels[key];
    }
  });
  Object.keys(updated.data).forEach(key => {
    if (updated.data[key] === undefined) {
      delete updated.data[key];
    }
  });

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ConfigMap: ${configMap.metadata.name}`);
    return updated;
  }

  const response = await k8sApi.replaceNamespacedConfigMap(
    configMap.metadata.name,
    NAMESPACE,
    updated
  );
  return response.body;
}

/**
 * Generate random password
 */
function generatePassword(length = 32) {
  return crypto.randomBytes(length).toString('base64').slice(0, length);
}

/**
 * Prompt for confirmation
 */
function confirm() {
  // In non-interactive environments, require explicit --tenant or --batch flag
  if (!process.stdin.isTTY) {
    console.error('❌ Interactive confirmation not available. Use --tenant or --batch flags.');
    return false;
  }

  // Simple sync confirmation (for demo - use proper readline in production)
  console.log('⚠️  This will modify ConfigMaps and create Secrets.');
  console.log('Press Ctrl+C to cancel, or use --dry-run first.\n');
  return true;
}

// Run migration
main().catch(error => {
  console.error('❌ Migration failed:', error.message);
  console.error(error.stack);
  process.exit(1);
});
