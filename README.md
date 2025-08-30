# Atlassian MCP Streamable HTTP Server

A minimal Model Context Protocol (MCP) server implementing the Streamable HTTP transport, deployable to Azure App Service and connectable to Microsoft Copilot Studio via a custom connector.

## Features
- Streamable HTTP MCP endpoint at `/mcp` supporting POST and GET per spec (2025-03-26)
- SSE streaming for batched request responses when client sends `Accept: text/event-stream`
- Session header `Mcp-Session-Id` returned on initialize
- Secure CORS origin allowlist via `ALLOWED_ORIGINS`
- OpenAPI file (`openapi-mcp.yaml`) with `x-ms-agentic-protocol: mcp-streamable-1.0`
- GitHub Actions workflow to build and deploy to Azure App Service

## Configure
- Node.js 18+
- Env vars:
  - `PORT` (optional)
  - `ALLOWED_ORIGINS` comma-separated list for CORS

## Local run
```powershell
npm ci
npm run build
npm start
# or dev
npm run dev
```

## Azure App Service
- Create a Windows or Linux Web App with Node 20 or 22 runtime and enable Always On.
- Set App Settings:
  - `WEBSITE_NODE_DEFAULT_VERSION` to ~20 if needed
  - `ALLOWED_ORIGINS` per your Copilot domain(s)
- Add the publish profile secret `AZURE_WEBAPP_PUBLISH_PROFILE` and `AZURE_WEBAPP_NAME` to GitHub repo secrets.
- Push to `main` to trigger deployment.

## Copilot Studio custom connector
- In Power Apps, create a Custom Connector and import `openapi-mcp.yaml`.
- Ensure `host` is your Azure Web App host (e.g., `atlassian-mcp.azurewebsites.net`).
- Copilot Studio will use Streamable (GA); SSE is being deprecated Aug 2025 per docs.

## MCP basics implemented
- initialize request handling with capability negotiation and session header
- error for unknown methods until you add tools/resources

Extend by adding MCP methods for tools/resources/prompts as needed.
