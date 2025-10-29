// k.libsonnet - Alias for k8s-libsonnet
//
// This file provides an alias to the Kubernetes API library generated from
// the Kubernetes OpenAPI spec. It must be installed via jsonnet-bundler.
//
// Installation:
//   jb init  # Initialize jsonnet-bundler (creates jsonnetfile.json)
//   jb install github.com/jsonnet-libs/k8s-libsonnet/1.29@main
//
// The version (1.29) should match your Kubernetes cluster version.
// Supported versions: 1.24, 1.25, 1.26, 1.27, 1.28, 1.29, 1.30, 1.31
//
// After installation, this alias allows you to:
//   local k = import 'k.libsonnet';
//   k.core.v1.service.new(...)
//
// Without this alias, you would need:
//   local k = import 'github.com/jsonnet-libs/k8s-libsonnet/1.29/main.libsonnet';

(import 'github.com/jsonnet-libs/k8s-libsonnet/1.29/main.libsonnet')
