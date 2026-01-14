#!/bin/bash

set -e

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3000}"

echo "Testing Metacontroller Webhooks"
echo "================================"
echo ""

echo "1. Testing health endpoint..."
curl -s "$WEBHOOK_URL/health" | jq .
echo ""

echo "2. Testing composite/sync (initial - no children)..."
curl -s -X POST "$WEBHOOK_URL/composite/sync" \
  -H "Content-Type: application/json" \
  -d @test/fixtures/composite-sync-request.json | jq '.status, .children | length'
echo ""

echo "3. Testing composite/sync (MongoDB ready)..."
curl -s -X POST "$WEBHOOK_URL/composite/sync" \
  -H "Content-Type: application/json" \
  -d @test/fixtures/composite-sync-mongo-ready.json | jq '.status'
echo ""

echo "4. Testing decorator/sync..."
curl -s -X POST "$WEBHOOK_URL/decorator/sync" \
  -H "Content-Type: application/json" \
  -d @test/fixtures/decorator-sync-request.json | jq '.attachments[0].metadata.annotations'
echo ""

echo "5. Testing decorator/finalize..."
curl -s -X POST "$WEBHOOK_URL/decorator/finalize" \
  -H "Content-Type: application/json" \
  -d @test/fixtures/decorator-finalize-request.json | jq '.finalized, .attachments | length'
echo ""

echo "All tests completed!"
