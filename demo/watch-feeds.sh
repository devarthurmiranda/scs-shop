#!/usr/bin/env sh
# The integration contract, visible with curl. No broker, no schema registry.
set -e

BASE=http://localhost:8080

echo "--- catalog feed"
curl -s "$BASE/catalog/feed?since=0"; echo
echo
echo "--- checkout feed"
curl -s "$BASE/checkout/feed?since=0"; echo
