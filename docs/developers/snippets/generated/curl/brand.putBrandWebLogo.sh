curl -X PUT "https://passbook.mobile/api/v1/brand/web-logo" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "png": "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR42mOQz3/9nxLMMGrAqAGjBgwXAwCBLngfV/beKAAAAABJRU5ErkJggg=="
}'
