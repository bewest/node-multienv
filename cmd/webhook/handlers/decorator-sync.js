async function decoratorSync(req, res) {
  const { object } = req.body;
  
  console.log('Decorator sync for PVC:', object.metadata?.name);
  
  try {
    const response = {
      attachments: []
    };

    const currentAnnotations = object.metadata.annotations || {};
    const currentLabels = object.metadata.labels || {};
    
    const tenantId = currentLabels['ns.mdn.io/tenant'] || 'unknown';
    
    const enhancedAnnotations = {
      ...currentAnnotations,
      'ns.mdn.io/backup-policy': currentAnnotations['ns.mdn.io/backup-policy'] || 'snapshot',
      'ns.mdn.io/backup-ttl': currentAnnotations['ns.mdn.io/backup-ttl'] || '30d'
    };
    
    if (!currentAnnotations['ns.mdn.io/last-backup-check']) {
      enhancedAnnotations['ns.mdn.io/last-backup-check'] = new Date().toISOString();
    }
    
    if (!currentAnnotations['ns.mdn.io/backup-snapshot-class']) {
      enhancedAnnotations['ns.mdn.io/backup-snapshot-class'] = 'csi-snapclass';
    }

    const pvc = {
      apiVersion: object.apiVersion,
      kind: object.kind,
      metadata: {
        ...object.metadata,
        annotations: enhancedAnnotations,
        finalizers: [
          ...(object.metadata.finalizers || []),
          'ns.mdn.io/backup-protect'
        ].filter((v, i, a) => a.indexOf(v) === i)
      }
    };

    response.attachments.push(pvc);
    
    console.log(`Decorator processed PVC ${object.metadata.name} for tenant ${tenantId}`);

    res.json(response);
  } catch (error) {
    console.error('Error in decorator sync:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = decoratorSync;
