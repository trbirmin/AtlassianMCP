# Connect this MCP Server to Microsoft Copilot Studio

This guide walks you end-to-end: deploy to Azure App Service with GitHub Actions (OIDC) and wire it up as a Custom Connector in Copilot Studio.

## 1) Deploy to Azure App Service

Prerequisites
- Azure subscription with RBAC to create a Web App and assign roles
- GitHub repository for this code

Steps
1. Create a Web App (Linux):
   - Runtime stack: Node 20 LTS or Node 22 LTS
   - Enable Always On
2. Configure App Settings:
   - ALLOWED_ORIGINS: optional, comma-separated origins if a browser will call the API
   - WEBSITE_NODE_DEFAULT_VERSION: ~20 (optional)
   - Confluence (optional): CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN
3. Set up Entra ID OIDC for GitHub Actions login:
   - Create an App registration (service principal)
   - Add a Federated credential
     - Provider: GitHub Actions
     - Entity: Branch
     - Repository: OWNER/REPO
     - Branch: main
     - Subject will be repo:OWNER/REPO:ref:refs/heads/main
   - Assign RBAC to the Web App (or resource group)
     - Role: Website Contributor (or Contributor)
4. Add GitHub Secrets (Settings > Secrets and variables > Actions):
   - AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID, AZURE_WEBAPP_NAME
5. Push to main. The workflow at `.github/workflows/azure-webapps.yml` builds and deploys.
6. Validate:
   - GET https://<app>.azurewebsites.net/healthz → ok
   - POST https://<app>.azurewebsites.net/mcp → accepts MCP JSON-RPC

Troubleshooting
- AADSTS70025: Re-check Federated credential organization/repo/branch and that permissions include id-token: write.
- 403 on deploy: Ensure the app registration has RBAC on the Web App.

## 2) Prepare the OpenAPI for the connector

- The repo includes `openapi-mcp.yaml`.
- Ensure the `host:` value matches your Web App host, e.g.:
  host: your-app.azurewebsites.net
- No auth is defined; the sample server is open. Add auth if required for production.

## 3) Create the Custom Connector in Copilot Studio

1. Open Copilot Studio (Power Platform) → Custom connectors → New custom connector → Import an OpenAPI file.
2. Upload `openapi-mcp.yaml` from this repo.
3. General tab:
   - Host: your-app.azurewebsites.net
   - Base URL: /
4. Security tab: No authentication.
5. Definition tab: Operation `InvokeMCP` on path `/mcp` with `x-ms-agentic-protocol: mcp-streamable-1.0`.
6. Create the connector and then create a Connection for it.

## 4) Add the connector to your Copilot

1. Open your Copilot in Copilot Studio.
2. Go to Actions/Plugins → Add your custom connector.
3. Select the `InvokeMCP` operation.
4. Test with prompts like:
   - "list confluence spaces"
   - "list recent confluence pages"
   - "find a page titled 'Team Charter' in space ENG"

## 5) Notes and best practices

- SSE deprecation: This server favors JSON responses. SSE is only used when requested via Accept: text/event-stream.
- CORS: If calling from a browser, set `ALLOWED_ORIGINS` to your allowed domains.
- Health checks: App Service can probe `/healthz`.
- Logs: Use App Service Log Stream and Application Insights (optional) to observe requests.
- Security: Add auth (Key Vault, APIM, or static keys) for production scenarios.
