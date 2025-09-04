# MCP Server Updates

## Summary of Recent Changes

1. **Real Confluence API Integration**
   - Added support for connecting to the real Confluence API
   - Implemented authentication with Atlassian credentials
   - Provided fallback to mock data when API is unavailable

2. **Mock Data Customization**
   - Added support for customizing mock data URLs with your actual Confluence domain
   - Configure via the `CUSTOM_CONFLUENCE_DOMAIN` environment variable

3. **Error Handling and Resilience**
   - Improved error handling for API requests
   - Added graceful fallback to mock data on API errors
   - Enhanced logging for troubleshooting

4. **Documentation Improvements**
   - Created test scripts for verifying Confluence credentials
   - Added detailed setup instructions
   - Included examples for local and Azure deployments

## Configuration Options

### Environment Variables

| Variable | Purpose | Required? | Example |
|----------|---------|-----------|---------|
| `CUSTOM_CONFLUENCE_DOMAIN` | Your Confluence domain | Yes | `your-domain.atlassian.net` |
| `CONFLUENCE_BASE_URL` | Full Confluence URL | For real API | `https://your-domain.atlassian.net` |
| `CONFLUENCE_EMAIL` | Atlassian account email | For real API | `your-email@example.com` |
| `CONFLUENCE_API_TOKEN` | Atlassian API token | For real API | `your-api-token` |

### Configuration Files

- `.env` - Local environment variables (copy from `.env.example`)
- `.azure-env.example` - Example of Azure App Service settings

## Testing Confluence Integration

1. **Local Testing with Mock Data**
   - Set `CUSTOM_CONFLUENCE_DOMAIN` environment variable
   - Start the server with `npm start`
   - Verify URLs in results show your domain

2. **Testing with Real API**
   - Set all Confluence environment variables
   - Use included test scripts to verify credentials
   - Start the server and check logs for "Using real Confluence API"

## Troubleshooting

If you encounter issues:

1. Check server logs for error messages
2. Verify environment variables are set correctly
3. Test your Confluence credentials with the provided scripts
4. Ensure your Atlassian account has appropriate permissions
