#!/usr/bin/env sh
# The point of the whole repo: checkout does not need catalog to be up,
# because it never calls it on the request path.
set -e

BASE=http://localhost:8080

echo "--- add a product to the cart (catalog up)"
curl -s -o /dev/null -X POST -d 'sku=KB-01' $BASE/checkout/cart/items
curl -s $BASE/checkout/fragment/minicart; echo

echo
echo "--- stopping catalog"
docker compose stop catalog

echo
echo "--- catalog page is gone, as it should be"
curl -s -o /dev/null -w 'GET /catalog  -> %{http_code}\n' $BASE/catalog

echo
echo "--- checkout still sells: names and prices come from its own replica"
curl -s -o /dev/null -w 'GET /checkout/cart -> %{http_code}\n' $BASE/checkout/cart
curl -s $BASE/checkout/cart | grep -E 'Mechanical Keyboard|Total' | sed 's/^[[:space:]]*/  /'

echo
echo "--- and an order can still be placed"
curl -s -o /dev/null -X POST $BASE/checkout/orders
sleep 6
curl -s $BASE/orders/ | grep -E 'Order [0-9a-f]{8}' | head -1 | sed 's/^[[:space:]]*/  /'

echo
echo "--- restarting catalog"
docker compose start catalog
