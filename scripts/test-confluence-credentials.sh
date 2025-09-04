#!/bin/bash
# test-confluence-credentials.sh - Test Confluence API credentials

# Check if required environment variables are set
if [ -z "$CONFLUENCE_BASE_URL" ]; then
  echo "Error: CONFLUENCE_BASE_URL is not set"
  echo "Example: export CONFLUENCE_BASE_URL=https://your-domain.atlassian.net"
  exit 1
fi

if [ -z "$CONFLUENCE_EMAIL" ]; then
  echo "Error: CONFLUENCE_EMAIL is not set"
  echo "Example: export CONFLUENCE_EMAIL=your-email@example.com"
  exit 1
fi

if [ -z "$CONFLUENCE_API_TOKEN" ]; then
  echo "Error: CONFLUENCE_API_TOKEN is not set"
  echo "Example: export CONFLUENCE_API_TOKEN=your-api-token"
  exit 1
fi

# Create auth header
AUTH=$(echo -n "$CONFLUENCE_EMAIL:$CONFLUENCE_API_TOKEN" | base64)

# Make API request to test credentials
echo "Testing connection to Confluence API..."
echo "Base URL: $CONFLUENCE_BASE_URL"
echo "Email: $CONFLUENCE_EMAIL"

# Try to get current user info
response=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Basic $AUTH" \
  -H "Accept: application/json" \
  "$CONFLUENCE_BASE_URL/wiki/rest/api/user/current")

# Extract status code and body
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

# Check if request was successful
if [ "$http_code" -eq 200 ]; then
  echo "✅ Connection successful!"
  echo "User information:"
  echo "$body" | grep -E '"displayName"|"email"'
else
  echo "❌ Connection failed with status code: $http_code"
  echo "Response:"
  echo "$body"
  echo ""
  echo "Check your credentials and try again."
  exit 1
fi

# Try a simple search query
echo ""
echo "Testing search API..."
search_response=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Basic $AUTH" \
  -H "Accept: application/json" \
  "$CONFLUENCE_BASE_URL/wiki/rest/api/search?cql=type=page&limit=1")

search_code=$(echo "$search_response" | tail -n1)
search_body=$(echo "$search_response" | sed '$d')

if [ "$search_code" -eq 200 ]; then
  echo "✅ Search API test successful!"
  # Count results
  result_count=$(echo "$search_body" | grep -o '"size":[0-9]*' | cut -d':' -f2)
  echo "Found $result_count results"
else
  echo "❌ Search API test failed with status code: $search_code"
  echo "Response:"
  echo "$search_body"
  exit 1
fi

echo ""
echo "All tests passed! Your Confluence credentials are working correctly."
echo "You can now run the MCP server with these credentials."
