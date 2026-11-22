curl -X POST "https://passbook.mobile/api/v1/templates/0193a1b2-7c00-7000-8000-0000000000b1/candidates/0193a1b2-7c00-7000-8000-0000000000e1/approve" \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "orgId": "0193a1b2-7c00-7000-8000-0000000000a1",
  "mode": "test",
  "provider": "apple",
  "candidateHash": "25a764cd27b2dece6d5111f0fdee90bba3c9490ac89039d9591a4c814f08bd85",
  "alone": false
}'
