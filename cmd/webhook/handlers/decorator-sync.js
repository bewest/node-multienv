async function decoratorSync(req, res) {
  const { object } = req.body;
  
  console.log('Decorator sync for PVC:', object.metadata?.name);
  
  try {
    const response = {
      attachments: []
    };

    const pvc = {
      apiVersion: object.apiVersion,
      kind: object.kind,
      metadata: {
        ...object.metadata,
        annotations: {
          ...object.metadata.annotations,
          'ns.mdn.io/backup-policy': object.metadata.annotations?.['ns.mdn.io/backup-policy'] || 'snapshot',
          'ns.mdn.io/backup-ttl': object.metadata.annotations?.['ns.mdn.io/backup-ttl'] || '30d'
        },
        finalizers: [
          ...(object.metadata.finalizers || []),
          'mdn.io/backup-protect'
        ].filter((v, i, a) => a.indexOf(v) === i)
      }
    };

    response.attachments.push(pvc);

    res.json(response);
  } catch (error) {
    console.error('Error in decorator sync:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = decoratorSync;
