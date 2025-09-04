// Save this file as mock-server.mjs in a new dist-mock folder
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { randomUUID } from 'crypto';

// JSON utility
function sendJson(res: Response, payload: any, status = 200) {
  return res.status(status).json(payload);
}

// Generate mock results
function generateMockResults(query: string, count: number = 20) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push({
      id: `page-${i + 1}`,
      title: `Result ${i + 1} for "${query}"`,
      url: `https://example.atlassian.net/wiki/spaces/TEST/pages/${i + 1}`,
      excerpt: `This is an example result ${i + 1} for the search query "${query}". It contains relevant information.`
    });
  }
  return results;
}

// Generate mock pagination info
function generatePagination(limit: number, start: number, size: number) {
  return {
    start: start,
    limit: limit,
    size: size,
    totalSize: 100,
    nextCursor: size < 100 ? "next-cursor-token" : undefined,
    prevCursor: start > 0 ? "prev-cursor-token" : undefined,
    nextUrl: size < 100 ? "https://example.com/next" : undefined,
    prevUrl: start > 0 ? "https://example.com/prev" : undefined
  };
}

// Tool descriptors
function getToolDescriptors() {
  return [
    {
      name: 'search',
      description: 'Search across all Confluence pages; optionally restrict by spaceKey.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text query to search in page titles and content' },
          spaceKey: { type: 'string', description: 'Optional Confluence space key to restrict the search' },
          limit: { type: 'number', description: 'Page size per request (default 50, max 100)' }
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'describeTools',
      description: 'List available tools',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    }
  ];
}

// Search handler
async function handleSearch(params: any) {
  const query = String(params?.query || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start) || 0;
  
  if (!query) {
    return { error: { code: 'MISSING_INPUT', message: 'Missing required input: query' } };
  }
  
  // Always generate 20 results
  const results = generateMockResults(query, 20);
  const pagination = generatePagination(limit, start, results.length);
  
  return { 
    cql: `type=page and text ~ ${query}`,
    results,
    pagination
  };
}

// Describe tools handler
async function handleDescribeTools() {
  const tools = getToolDescriptors();
  return { tools };
}

// App setup
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// Handle JSON-RPC
const mcpHandler = async (req: Request, res: Response) => {
  const msg = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  const id = msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const norm = method.toLowerCase().replace(/[._]/g, '/');

  console.log(`MCP request: id=${id ?? '(no id)'} method=${method} -> norm=${norm}`);

  // Default: initialize
  if (!method || norm === 'initialize' || norm === 'mcp/initialize') {
    const sessionId = randomUUID();
    res.setHeader('Mcp-Session-Id', sessionId);
    return sendJson(res, {
      jsonrpc: '2.0',
      id: id ?? null,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'Atlassian MCP Server', version: '0.1.1' },
        capabilities: { tools: { list: true, call: true } },
        tools: getToolDescriptors(),
        instructions: 'Policy: This is a mock server that always returns at least 20 results.',
      }
    });
  }

  if (norm === 'notifications/initialized' || norm === 'mcp/notifications/initialized') {
    return sendJson(res, { jsonrpc: '2.0', id, result: { acknowledged: true } });
  }

  if (norm === 'tools/list' || norm === 'mcp/tools/list') {
    return sendJson(res, { jsonrpc: '2.0', id, result: { tools: getToolDescriptors() } });
  }

  if (norm === 'tools/call' || norm === 'mcp/tools/call' || norm === 'tool/call') {
    const { name, arguments: args = {} } = msg.params || {};
    let out: any;

    switch (name) {
      case 'search':
      case 'searchPages':
        out = await handleSearch(args);
        break;
      case 'describeTools':
        out = await handleDescribeTools();
        break;
      default:
        return sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${name}` } });
    }
    return sendJson(res, { jsonrpc: '2.0', id, result: out });
  }

  if (norm === 'ping' || norm === 'mcp/ping') {
    return sendJson(res, { jsonrpc: '2.0', id, result: { ok: true } });
  }

  return sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method || '(empty)'}` } });
};

app.post('/mcp', mcpHandler);
app.post('/:connectionId/mcp', mcpHandler);
app.post('/apim/:apiName/:connectionId/mcp', mcpHandler);
app.post('/apim/:apiName/mcp', mcpHandler);

// Health endpoint
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('ok'));

// Error handling
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error('Request error:', err?.stack || err);
  if (res.headersSent) return;
  res.status(typeof err?.status === 'number' ? err.status : 500).type('application/json').send({ error: 'Internal Server Error' });
});

// Server startup
const port = parseInt(process.env.PORT || '3000', 10);

app.listen(port, '0.0.0.0', () => {
  console.log(`Mock MCP server listening on port ${port}`);
});
