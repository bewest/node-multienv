// Example 1: Gen 3 Only (Backward Compatible)
//
// This is the default configuration - exactly what you have today.
// Gen 4 is disabled by default, so existing environments work unchanged.
//
// Deploy with:
//   tk apply environments/default

local config = import '../../lib/config.libsonnet';

// Your original Gen 3 deployment (import your current main.jsonnet)
(import '../main.jsonnet.original') + config + {
  _config+:: {
    // Your existing overrides work exactly as before
    num_runners: 5,
    scaling: {
      resolvers: 10,
      backends: 10,
    },
    
    // Gen 4 is disabled by default - no changes needed
    gen4+:: {
      enabled: false,
    },
  },
}
