# Setting Up Atlassian API Token

To use real Confluence data with this MCP server, you'll need to generate an API token from your Atlassian account. Here's how:

## Steps to Create an API Token

1. **Go to the Atlassian API tokens page**
   - Visit https://id.atlassian.com/manage-profile/security/api-tokens

2. **Log in to your Atlassian account**
   - Use your regular Atlassian account credentials

3. **Create a new API token**
   - Click the "Create API token" button
   - Give your token a meaningful label (e.g., "MCP Server Integration")
   - Click "Create"

4. **Copy your API token**
   - The token will be displayed once - make sure to copy it immediately
   - Store it securely as you won't be able to view it again

5. **Configure your environment variables**
   - Set the following environment variables:
     ```
     CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
     CONFLUENCE_EMAIL=your-atlassian-account-email
     CONFLUENCE_API_TOKEN=your-api-token
     ```

## Security Considerations

- Never commit your API token to version control
- Use environment variables or secure configuration management
- For Azure deployments, use App Service Application Settings
- Rotate your token periodically for better security
- Consider using restricted permission API tokens when available

## Troubleshooting API Access

If you're having issues connecting to the Confluence API:

1. Verify your token is correct and hasn't expired
2. Ensure your Atlassian account has appropriate permissions in Confluence
3. Check that your base URL is correct (should be your full Atlassian URL)
4. Verify your email matches the one used with your Atlassian account
5. Look for any error messages in the server logs
