# test-confluence-credentials.ps1 - Test Confluence API credentials

# Check if required environment variables are set
if (-not $env:CONFLUENCE_BASE_URL) {
    Write-Host "Error: CONFLUENCE_BASE_URL is not set" -ForegroundColor Red
    Write-Host "Example: `$env:CONFLUENCE_BASE_URL = 'https://your-domain.atlassian.net'" -ForegroundColor Yellow
    exit 1
}

if (-not $env:CONFLUENCE_EMAIL) {
    Write-Host "Error: CONFLUENCE_EMAIL is not set" -ForegroundColor Red
    Write-Host "Example: `$env:CONFLUENCE_EMAIL = 'your-email@example.com'" -ForegroundColor Yellow
    exit 1
}

if (-not $env:CONFLUENCE_API_TOKEN) {
    Write-Host "Error: CONFLUENCE_API_TOKEN is not set" -ForegroundColor Red
    Write-Host "Example: `$env:CONFLUENCE_API_TOKEN = 'your-api-token'" -ForegroundColor Yellow
    exit 1
}

# Create auth header
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($env:CONFLUENCE_EMAIL):$($env:CONFLUENCE_API_TOKEN)"))

# Make API request to test credentials
Write-Host "Testing connection to Confluence API..." -ForegroundColor Cyan
Write-Host "Base URL: $($env:CONFLUENCE_BASE_URL)" -ForegroundColor Cyan
Write-Host "Email: $($env:CONFLUENCE_EMAIL)" -ForegroundColor Cyan

# Try to get current user info
$headers = @{
    "Authorization" = "Basic $auth"
    "Accept" = "application/json"
}

try {
    $response = Invoke-RestMethod -Uri "$($env:CONFLUENCE_BASE_URL)/wiki/rest/api/user/current" -Headers $headers -Method Get
    Write-Host "✅ Connection successful!" -ForegroundColor Green
    Write-Host "User information:" -ForegroundColor Cyan
    Write-Host "  Display Name: $($response.displayName)" -ForegroundColor White
    Write-Host "  Email: $($response.email)" -ForegroundColor White
}
catch {
    Write-Host "❌ Connection failed with status code: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
    Write-Host "Error message: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Check your credentials and try again." -ForegroundColor Yellow
    exit 1
}

# Try a simple search query
Write-Host ""
Write-Host "Testing search API..." -ForegroundColor Cyan

try {
    $searchResponse = Invoke-RestMethod -Uri "$($env:CONFLUENCE_BASE_URL)/wiki/rest/api/search?cql=type=page&limit=1" -Headers $headers -Method Get
    Write-Host "✅ Search API test successful!" -ForegroundColor Green
    Write-Host "Found $($searchResponse.size) results" -ForegroundColor White
}
catch {
    Write-Host "❌ Search API test failed with status code: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
    Write-Host "Error message: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "All tests passed! Your Confluence credentials are working correctly." -ForegroundColor Green
Write-Host "You can now run the MCP server with these credentials." -ForegroundColor Green
