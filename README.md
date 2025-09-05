# Atlassian MCP Streamable HTTP Server

A minimal Model Context Protocol (MCP) server implementing the Streamable HTTP transport, deployable to Azure App Service and connectable to Microsoft Copilot Studio via a custom connector.

## Features
- Streamable HTTP MCP endpoint at `/mcp` supporting POST and GET per spec (2025-03-26)
- JSON-first responses; optional SSE when client sends `Accept: text/event-stream`
- `Mcp-Session-Id` header returned on initialize
- Secure CORS allowlist via `ALLOWED_ORIGINS`
- OpenAPI (`openapi-mcp.yaml`) with `x-ms-agentic-protocol: mcp-streamable-1.0`
- GitHub Actions OIDC pipeline to deploy to Azure App Service
- Confluence integration with real API

## Prerequisites
- Node.js 18+ (Node 20 recommended)
- Azure subscription with permission to create App Service and role assignments
- GitHub repository for this source code
- Atlassian Confluence account with API token

## Local run
```powershell
# Set your Confluence domain (even for mock data)
$env:CUSTOM_CONFLUENCE_DOMAIN = "your-domain.atlassian.net"

## Local run
```powershell
# Set your Confluence credentials
$env:CONFLUENCE_BASE_URL = "https://your-domain.atlassian.net"
$env:CONFLUENCE_EMAIL = "your-email@example.com"
$env:CONFLUENCE_API_TOKEN = "your-api-token"

# Run the server
npm ci
npm run build
npm start
# or dev
npm run dev
```

## Deploy to Azure App Service (GitHub Actions + OIDC)
1) Create the Web App (Linux, Node 20 or 22):
  - Runtime stack: Node 20 LTS or Node 22 LTS
  - Enable Always On (Configuration > General settings)
  - App Settings (Configuration > Application settings):
    - `ALLOWED_ORIGINS` (optional): comma-separated origins if your caller is a browser
    - `WEBSITE_NODE_DEFAULT_VERSION` (optional): `~20`
    - `CONFLUENCE_BASE_URL`: Your Confluence base URL (required)
    - `CONFLUENCE_EMAIL`: Your Atlassian account email (required)
    - `CONFLUENCE_API_TOKEN`: Your Atlassian API token (required)
    - For real Confluence API integration (optional):
      - `CONFLUENCE_BASE_URL`: Full URL (e.g., https://your-domain.atlassian.net)
      - `CONFLUENCE_EMAIL`: Your Atlassian account email
      - `CONFLUENCE_API_TOKEN`: Your Atlassian API token (create at https://id.atlassian.com/manage-profile/security/api-tokens)

2) Grant deployment identity via Entra ID (OIDC):
  - Create (or use) an App registration (Service Principal)
  - Copy its IDs for later:
    - Application (client) ID = AZURE_CLIENT_ID
    - Directory (tenant) ID = AZURE_TENANT_ID
  - Add a Federated credential:
    - Provider: GitHub Actions
    - Entity type: Branch
    - Organization/Repository: your GitHub `owner/repo`
    - Branch: `main`
    - Subject will look like: `repo:OWNER/REPO:ref:refs/heads/main`
  - Assign RBAC to the Web App (or resource group):
    - Role: Website Contributor (or Contributor)

3) Add GitHub repository secrets (Repo Settings > Secrets and variables > Actions):
  - `AZURE_CLIENT_ID` = App registration client ID
  - `AZURE_TENANT_ID` = Directory (tenant) ID
  - `AZURE_SUBSCRIPTION_ID` = your subscription ID
  - `AZURE_WEBAPP_NAME` = the Web App name you created

4) Push to `main` to deploy:
  - The workflow `.github/workflows/azure-webapps.yml` builds the project and deploys the `dist/` bundle with startup `node dist/server.js`.

5) Verify:
  - Browse `https://<your-app>.azurewebsites.net/healthz` → should return `ok`
  - MCP endpoint: `POST https://<your-app>.azurewebsites.net/mcp`

## Create the Copilot Studio custom connector (MCP)
Use the included `openapi-mcp.yaml` to define a single MCP action endpoint.

1) Open Copilot Studio (Power Platform) and go to Custom connectors.
2) New custom connector → Import an OpenAPI file → upload `openapi-mcp.yaml` from this repo.
3) On the General tab:
  - Ensure Host matches your App Service host (e.g., `your-app.azurewebsites.net`).
  - Base URL: `/`
4) Security tab: choose “No authentication” (the sample server has no auth).
5) Definition tab: you should see operation `InvokeMCP` on path `/mcp` with `x-ms-agentic-protocol: mcp-streamable-1.0`.
6) Create connector, then create a Connection for it.

## Add the connector to a Copilot (actions)
1) Open your Copilot in Copilot Studio.
2) Go to the Actions/Plugins area and add your custom connector.
3) Select the operation (InvokeMCP). The agent will send MCP JSON-RPC messages to `/mcp`.
4) Test: Ask the Copilot to “list Confluence spaces”, “list recent Confluence pages”, or “who am I in Confluence?”.

Notes
- SSE is being deprecated in August 2025; this server prefers JSON and supports SSE only when explicitly requested.
- If you change your Web App host, update `openapi-mcp.yaml` `host:` accordingly before importing.

For an expanded, screenshot-ready walkthrough, see `docs/CONNECTOR.md`.

## MCP basics implemented
- initialize, tools/list, tools/call with friendly JSON-RPC errors
- Confluence search integration with real API (returns up to 50 results)
- Automatic initialization of MCP tools before handling requests
- Session tracking for stateful interactions
- Enhanced result display with explicit instructions to show all results

## Troubleshooting
- Make sure all three Confluence variables are set: `CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, and `CONFLUENCE_API_TOKEN`
- Check the server logs for error messages and warnings
- Verify the server is accessible from your Copilot Studio by testing the connection

## Testing Confluence Credentials

To verify your Confluence credentials are working correctly, you can use the included test scripts:

### For Windows (PowerShell):
```powershell
# Set your credentials first
$env:CONFLUENCE_BASE_URL = "https://your-domain.atlassian.net"
$env:CONFLUENCE_EMAIL = "your-email@example.com"
$env:CONFLUENCE_API_TOKEN = "your-api-token"

# Run the test script
./scripts/test-confluence-credentials.ps1
```

### For Linux/macOS (Bash):
```bash
# Set your credentials first
export CONFLUENCE_BASE_URL="https://your-domain.atlassian.net"
export CONFLUENCE_EMAIL="your-email@example.com"
export CONFLUENCE_API_TOKEN="your-api-token"

# Make the script executable
chmod +x ./scripts/test-confluence-credentials.sh

# Run the test script
./scripts/test-confluence-credentials.sh
```

For more information on obtaining an Atlassian API token, see [docs/ATLASSIAN_API_TOKEN.md](docs/ATLASSIAN_API_TOKEN.md).
Extend by adding MCP tools/resources/prompts in `src/server.ts`.
