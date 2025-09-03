import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fetch as undiciFetch } from 'undici';
import morgan from 'morgan';
import { randomUUID } from 'crypto';

// Use global fetch if available (Node 18+), otherwise fall back to undici
const httpFetch: typeof fetch = (globalThis as any).fetch ?? (undiciFetch as any);

// Minimal JSON utility
function sendJson(res: Response, payload: any, status = 200) {
  return res.status(status).json(payload);
}

// Structured error helper for tool results
function toolError(code: string, message: string, details?: any) {
  return { error: { code, message, details } };
}

// SSE headers
function sseHeaders(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

// Central list of tool descriptors for reuse across initialize, tools/list, and describeTools
function getToolDescriptors() {
  return [
    {
      name: 'search',
      description:
        'Alias of searchPages. Full-text search across all Confluence pages; optionally restrict by spaceKey.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text query to search in page titles and content' },
          spaceKey: { type: 'string', description: 'Optional Confluence space key to restrict the search' },
          limit: { type: 'number', description: 'Max results (default 10, max 100)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'searchPages',
      description:
        'Full-text search across all Confluence pages. Use this whenever the user asks a question or requests information. Optionally restrict by spaceKey.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text query to search in page titles and content' },
          spaceKey: { type: 'string', description: 'Optional Confluence space key to restrict the search' },
          limit: { type: 'number', description: 'Max results (default 10, max 100)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'searchByLabelInSpace',
      description:
        'Search pages by label within a space, sorted by latest modified; returns up to limit results (default 10).',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Confluence label (e.g., administration)' },
          spaceKey: { type: 'string', description: 'Space key (e.g., DOC)' },
          limit: { type: 'number', description: 'Max results (default 10, max 100)' },
        },
        required: ['label', 'spaceKey'],
        additionalProperties: false,
      },
    },
    {
      name: 'listLabels',
      description: 'List labels in the site. Optionally filter by prefix.',
      inputSchema: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Filter labels starting with this string' },
          limit: { type: 'number', description: 'Max labels to return (default 25, max 100)' },
        },
        required: ['prefix'],
        additionalProperties: false,
      },
    },
    {
      name: 'listSpaces',
      description: 'List Confluence spaces (global). Returns up to limit spaces (default 25).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max spaces to return (default 25, max 100)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'listPagesInSpace',
      description: 'List pages within a given space, sorted by latest modified.',
      inputSchema: {
        type: 'object',
        properties: {
          spaceKey: { type: 'string', description: 'Space key (e.g., DOC)' },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' },
        },
        required: ['spaceKey'],
        additionalProperties: false,
      },
    },
    {
      name: 'describeTools',
      description: 'Summarize what this MCP can do and list all available tools with descriptions.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ];
}

// === Tool handlers ===
// (unchanged except cleanup and consistency)
async function handleSearchByLabelInSpace(params: any) {
  // ... unchanged logic ...
}

async function handleListSpaces(params: any) {
  // ... unchanged logic ...
}

async function handleListPagesInSpace(params: any) {
  // ... unchanged logic ...
}

async function handleListLabels(params: any) {
  // ... unchanged logic ...
}

async function handleSearchPages(params: any) {
  // ... unchanged logic ...
}

async function handleDescribeTools(_params: any) {
  const tools = getToolDescriptors();
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Available MCP tools', weight: 'Bolder', size: 'Medium', wrap: true },
      ...tools.map((t: any) => ({ type: 'TextBlock', text: `${t.name}: ${t.description}`, wrap: true })),
    ],
  };
  return { tools, ui: { adaptiveCard: card } };
}

// === App setup ===
const app = express();
app.use(helmet());

// Configure CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (allowedOrigins.length > 0) {
  const corsOptions: cors.CorsOptions = {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Allow same-origin/non-browser
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false); // silently block
    },
    credentials: true,
  };
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
} else {
  app.use(cors());
  app.options('*', cors());
}

app.use(express.json({ limit: '1mb' }));

// Handle raw text for MCP clients
const mcpPaths = ['/mcp', '/:connectionId/mcp', '/apim/:apiName/:connectionId/mcp', '/apim/:apiName/mcp'];
app.use(mcpPaths, express.text({ type: '*/*', limit: '1mb' }));

// Access log
app.use(morgan('combined'));

// === JSON-RPC handler ===
const mcpHandler = async (req: Request, res: Response) => {
  const raw = (req as any).body;
  const msg = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : (raw || {});
  const id = msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const norm = method.toLowerCase().replace(/[._]/g, '/');

  console.log(`MCP request: id=${id ?? '(no id)'} method=${method} -> norm=${norm}`);

  // Default fallback: initialize
  if (!method) {
    const sessionId = randomUUID();
    res.setHeader('Mcp-Session-Id', sessionId);
    const result = {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'Atlassian MCP Server', version: '0.1.1' },
      capabilities: { tools: { list: true, call: true } },
      tools: getToolDescriptors(),
      instructions:
        'Policy: Never answer from model knowledge when the user asks about Confluence content. Always call tools and return their results. Default to the search tool (alias of searchPages) for any query phrased as search/find/lookup/question: set query to the user text and include spaceKey if the user mentions a space. Examples: "Search for Infor OS" -> {name: search, arguments: {query: "Infor OS"}}; "Search MFS for onboarding" -> {name: search, arguments: {query: "onboarding", spaceKey: "MFS"}}. For labels, call searchByLabelInSpace (requires label and spaceKey). To browse, call listSpaces and listPagesInSpace. To list labels, call listLabels with a prefix. If required inputs are missing, ask a clarifying question and then call the tool.',
    };
    return sendJson(res, { jsonrpc: '2.0', id: id ?? null, result });
  }

  if (norm === 'initialize' || norm === 'mcp/initialize') {
    const sessionId = randomUUID();
    res.setHeader('Mcp-Session-Id', sessionId);
    return sendJson(res, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'Atlassian MCP Server', version: '0.1.1' },
        capabilities: { tools: { list: true, call: true } },
        tools: getToolDescriptors(),
        instructions:
          'Policy: Never answer from model knowledge when the user asks about Confluence content. Always call tools and return their results. Default to the search tool (alias of searchPages) for any query phrased as search/find/lookup/question...',
      },
    });
  }

  if (norm === 'notifications/initialized' || norm === 'mcp/notifications/initialized') {
    if (id === undefined || id === null) return res.status(200).end();
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
        out = await handleSearchPages(args);
        break;
      case 'searchByLabelInSpace':
        out = await handleSearchByLabelInSpace(args);
        break;
      case 'listSpaces':
        out = await handleListSpaces(args);
        break;
      case 'listPagesInSpace':
        out = await handleListPagesInSpace(args);
        break;
      case 'listLabels':
        out = await handleListLabels(args);
        break;
      case 'describeTools':
        out = await handleDescribeTools(args);
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

// === SSE endpoint ===
const mcpGetHandler = (req: Request, res: Response) => {
  if (!(req.header('Accept') || '').includes('text/event-stream')) {
    return res.status(405).send('Method Not Allowed');
  }
  sseHeaders(res);
  res.end();
};
app.get('/mcp', mcpGetHandler);
app.get('/:connectionId/mcp', mcpGetHandler);
app.get('/apim/:apiName/:connectionId/mcp', mcpGetHandler);
app.get('/apim/:apiName/mcp', mcpGetHandler);

// === Health + root ===
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/', (_req, res) => res.status(200).send('ok'));

// Minimal OpenAPI
app.get('/.well-known/openapi.json', (_req, res) => {
  res.json({
    swagger: '2.0',
    info: { title: 'Atlassian MCP Server', version: '0.1.1' },
    schemes: ['https'],
    consumes: ['application/json'],
    produces: ['application/json'],
    paths: {
      '/mcp': { post: { 'x-ms-agentic-protocol': 'mcp-streamable-1.0', responses: { '200': { description: 'OK' } } } },
      '/healthz': { get: { responses: { '200': { description: 'OK' } } } },
    },
  });
});

// === Error handling ===
app.use((err: any, _req: Request, res: Response, _next: any) => {
  console.error('Request error:', err?.stack || err);
  if (res.headersSent) return;
  res.status(typeof err?.status === 'number' ? err.status : 500).type('application/json').send({ error: 'Internal Server Error' });
});

// === Server startup ===
const rawPort = process.env.PORT;
const isWindows = process.platform === 'win32';
const isAzure = !!process.env.WEBSITE_SITE_NAME;
const cleanedPort = rawPort?.trim().toLowerCase() === 'not required' ? '' : (rawPort ?? '');
const defaultPort = !isWindows && isAzure ? 8080 : 3000;
const numericEnvPort = cleanedPort && /^\d+$/.test(cleanedPort) ? parseInt(cleanedPort, 10) : undefined;
const portOrPipe = !isWindows
  ? numericEnvPort ?? defaultPort
  : cleanedPort && !/^\d+$/.test(cleanedPort) ? cleanedPort : numericEnvPort ?? defaultPort;

console.log(`Node version: ${process.version}`);
console.log(`Resolved PORT: ${rawPort ?? '(undefined)'} | platform=${process.platform} | azure=${isAzure} -> using ${typeof portOrPipe === 'string' ? portOrPipe : `port ${portOrPipe}`}`);

process.on('unhandledRejection', (reason) => console.error('UnhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));

if (typeof portOrPipe === 'string') {
  app.listen(portOrPipe, () => console.log(`MCP server listening on ${portOrPipe}`));
} else {
  app.listen(portOrPipe, '0.0.0.0', () => console.log(`MCP server listening on port ${portOrPipe}`));
}
