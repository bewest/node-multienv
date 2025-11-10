


function createDecoratorSync(config) {
  /*
   * Watches configmaps, label role=config-as-deploy (parameterized via env variables)
   * Related: compute, storage resources, migration annotations on compute resource.
   * Two deployments should potentially exist.  Gen3 is configured to produce
   * labels tenant=$tenantId and role=config-as-deploy
   * In hybrid/shared mode gen3 and gen4 configmaps and depoyments are
   * co-existing as each storage and compute resource are created to mirror each
   * gen3 resource during a migration.  At the end of a successful migration,
   * we will be watching the configmap name=$tenantId, role=config-as-deploy,
   * that also has a successfully migrated compute resource and storage
   * resource in dedicated storageType.
   * We want to recognize when storageType is dedicated post migration and then
   * remove or change the role label of the configmap.  We are doing this with
   * the configmap as a parent resource in order to use metacontroller
   * facilities to adjust the labels without changing the parent/child
   * ownership model of the configmap.  This keeps the configmap's lifecycle
   * out of band to the compute and storage resources.
   *
  */
  function initializeContext (req, res, next) {
    // Create data structure to be passed to the handlers in our pipeline.
    // Determine or mark which actions need to be taken, or don't.
    next( );
  }

  // Define pipeline stages
  const sync = [
    initializeContext,
    // planArchiveConfigMap, // placing a copy in a parameterized archive namespace safely stores it out of the way
    // planLabelAdjustment, // modifying the role label removes it from an old category and places it in a new one
    assembleResponse
  ];

  function customize_userdata_related (req, res, next) {
    var { controller, parent } = req.body;
    // Gather up 
    var relatedResources = [
    ];

  }
  var customize = [ customize_userdata_related ];

  return { sync, customize };
  
}

