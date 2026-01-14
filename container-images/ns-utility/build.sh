#!/bin/bash
set -euo pipefail

IMAGE_NAME="${1:-ns-utility}"
IMAGE_TAG="${2:-latest}"
REGISTRY="${REGISTRY:-}"

FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"

if [[ -n "${REGISTRY}" ]]; then
  FULL_IMAGE="${REGISTRY}/${FULL_IMAGE}"
fi

echo "Building container image: ${FULL_IMAGE}"

docker build -t "${FULL_IMAGE}" .

echo "Build completed: ${FULL_IMAGE}"

if [[ "${PUSH:-false}" == "true" ]]; then
  echo "Pushing image to registry..."
  docker push "${FULL_IMAGE}"
  echo "Push completed"
fi
