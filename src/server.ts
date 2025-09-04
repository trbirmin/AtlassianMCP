import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fetch as undiciFetch } from 'undici';
import morgan from 'morgan';
import { randomUUID } from 'crypto';

/*
 * MCP Server for Confluence integration
 * 
 * Environment variables:
 * - CONFLUENCE_BASE_URL: The base URL of your Confluence instance (e.g., https://your-domain.atlassian.net)
 * - CONFLUENCE_EMAIL: Your Atlassian account email
 * - CONFLUENCE_API_TOKEN: Your Atlassian API token (create at https://id.atlassian.com/manage-profile/security/api-tokens)
 * - CUSTOM_CONFLUENCE_DOMAIN: Alternative to CONFLUENCE_BASE_URL, just the domain part (e.g., your-domain.atlassian.net)
 * - PORT: The port to run the server on (default: 3000)
 */

// Use global fetch if available (Node 18+), otherwise fall back to undici
const httpFetch: typeof fetch = (globalThis as any).fetch ?? (undiciFetch as any);

// Setup environment variables and defaults
const DEFAULT_CONFLUENCE_DOMAIN = process.env.CUSTOM_CONFLUENCE_DOMAIN || "example.atlassian.net";
console.log(`Using Confluence domain: ${DEFAULT_CONFLUENCE_DOMAIN}`);

// Generate mock results (always returns 20 items)
function generateMockResults(query: string, count: number = 20, baseUrl: string = `https://${DEFAULT_CONFLUENCE_DOMAIN}`) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push({
      id: `page-${i + 1}`,
      title: `Result ${i + 1} for "${query}"`,
      url: `${baseUrl}/wiki/spaces/TEST/pages/${i + 1}`,
      // Clean up excerpt formatting to avoid special characters
      excerpt: `This is an example result ${i + 1} for the search query "${query}". It contains relevant information.`
    });
  }
  return results;
}

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
      name: 'searchPages',
      description:
        'Full-text search across all Confluence pages. Use this whenever the user asks a question or requests information. Optionally restrict by spaceKey.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text query to search in page titles and content' },
          spaceKey: { type: 'string', description: 'Optional Confluence space key to restrict the search' },
          limit: { type: 'number' , description: 'Page size per request (default 50, max 100; service may cap to 50)' },
          start: { type: 'number', description: 'Offset index for pagination (ignored when cursor is provided)' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response for next/prev page' },
          includeArchivedSpaces: { type: 'boolean', description: 'Include archived spaces in results' },
          maxResults: { type: 100 , description: 'When set, auto-paginates until this many results are collected (omit for full traversal)' },
          autoPaginate: { type: 'boolean', description: 'Defaults to true. Auto-paginates using cursor until maxResults or no next page' },
        },
        required: ['query'],
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
          start: { type: 'number', description: 'Offset index for pagination' },
        },
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
  const label = String(params?.label || '').trim();
  const spaceKey = String(params?.spaceKey || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start) || 0;
  
  if (!label || !spaceKey) {
    const missing: string[] = [];
    if (!label) missing.push('label');
    if (!spaceKey) missing.push('spaceKey');
    return toolError('MISSING_INPUT', `Missing required input(s): ${missing.join(', ')}`, { missing });
  }

  // Always generate 20 mock results
  const results = generateMockResults(`${label} in ${spaceKey}`, 20);
  
  // Create mock pagination info
  const pagination = {
    start: start,
    limit: limit,
    size: results.length,
    totalSize: 100,
    nextCursor: results.length < 100 ? "mock-next-cursor" : undefined,
    prevCursor: start > 0 ? "mock-prev-cursor" : undefined,
    nextUrl: results.length < 100 ? "https://example.com/next" : undefined,
    prevUrl: start > 0 ? "https://example.com/prev" : undefined
  };
  
  const cql = `type=page and label=${encodeURIComponent(label)} and space=${encodeURIComponent(spaceKey)} ORDER BY lastmodified desc`;
  
  return { cql, results, pagination };
}

async function handleListSpaces(params: any) {
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start) || 0;
  
  // Generate 10 mock spaces
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push({
      key: `SPACE${i + 1}`,
      name: `Space ${i + 1}`,
      url: `https://example.atlassian.net/wiki/spaces/SPACE${i + 1}`
    });
  }
  
  // Create mock pagination info
  const pagination = {
    start: start,
    limit: limit,
    size: results.length,
    _links: {
      next: results.length < 100 ? "/rest/api/space?start=10&limit=10" : undefined,
      prev: start > 0 ? "/rest/api/space?start=0&limit=10" : undefined
    }
  };
  
  return { results, pagination };
}

async function handleListPagesInSpace(params: any) {
  const spaceKey = String(params?.spaceKey || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start) || 0;
  
  if (!spaceKey) {
    return toolError('MISSING_INPUT', 'Missing required input: spaceKey', { missing: ['spaceKey'] });
  }
  
  // Always generate 20 mock results
  const results = generateMockResults(`Pages in ${spaceKey}`, 20);
  
  // Create mock pagination info
  const pagination = {
    start: start,
    limit: limit,
    size: results.length,
    totalSize: 100,
    nextCursor: results.length < 100 ? "mock-next-cursor" : undefined,
    prevCursor: start > 0 ? "mock-prev-cursor" : undefined,
    nextUrl: results.length < 100 ? "https://example.com/next" : undefined,
    prevUrl: start > 0 ? "https://example.com/prev" : undefined
  };
  
  const cql = `type=page and space=${encodeURIComponent(spaceKey)} ORDER BY lastmodified desc`;
  
  return { cql, results, pagination };
}

async function handleListLabels(params: any) {
  const limit = Math.min(Math.max(Number(params?.limit) || 25, 1), 100);
  const start = Number(params?.start) || 0;
  const prefix = String((params?.prefix ?? params?.label ?? params?.name ?? params?.q) || '').trim();
  
  if (!prefix) {
    return toolError('MISSING_INPUT', 'Missing required input: prefix', { missing: ['prefix'] });
  }
  
  // Generate 15 mock labels
  const results = [];
  for (let i = 0; i < 15; i++) {
    results.push({
      name: `${prefix}${i + 1}`,
      prefix: prefix
    });
  }
  
  // Create mock pagination info
  const pagination = {
    start: start,
    limit: limit,
    size: results.length,
    _links: {
      next: results.length < 100 ? "/rest/api/label?start=15&limit=15" : undefined,
      prev: start > 0 ? "/rest/api/label?start=0&limit=15" : undefined
    }
  };
  
  return { results, pagination };
}


async function handleSearchPages(params: any) {
  const query = String((params?.query ?? params?.q ?? params?.text ?? params?.question) || '').trim();
  const spaceKey = String(params?.spaceKey || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start) || 0;
  const cursor = String(params?.cursor || '').trim();
  const maxResults = Math.max(Number.isFinite(Number(params?.maxResults)) ? Number(params?.maxResults) : 50, 0);
  const autoPaginate = params?.autoPaginate !== false || maxResults > 0;
  
  if (!query) {
    return toolError('MISSING_INPUT', 'Missing required input: query', { missing: ['query'] });
  }

  // Check if we have Confluence credentials
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;

  // If we don't have credentials, return mock data
  if (!baseUrl || !email || !token) {
    console.log("No Confluence credentials found, using mock data");
    
    // Use the default Confluence domain set at the top of the file
    const results = generateMockResults(query, 20);
    
    // Create mock pagination info
    const pagination = {
      start: start,
      limit: limit,
      size: results.length,
      totalSize: 100,
      nextCursor: results.length < 100 ? "mock-next-cursor" : undefined,
      prevCursor: start > 0 ? "mock-prev-cursor" : undefined,
      nextUrl: results.length < 100 ? "https://example.com/next" : undefined,
      prevUrl: start > 0 ? "https://example.com/prev" : undefined
    };
    
    return { 
      cql: `type=page and text ~ ${query}`,
      results,
      pagination
    };
  }
  
  // We have credentials, use the real Confluence API
  console.log("Using real Confluence API");
  try {
    // Construct the CQL query
    let cql = `type=page and text ~ "${query}"`;
    if (spaceKey) {
      cql += ` and space="${spaceKey}"`;
    }
    
    // Basic authentication header
    const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    const base = baseUrl.replace(/\/$/, '');
    
    // Prepare for pagination
    const collected: any[] = [];
    let nextCursor = cursor;
    let firstPage: any = null;
    let pageCount = 0;
    
    // Fetch pages
    do {
      const qs = new URLSearchParams({ cql, limit: String(limit) });
      if (!Number.isNaN(start) && Number.isFinite(start) && !nextCursor) qs.set('start', String(start));
      if (nextCursor) qs.set('cursor', nextCursor);
      
      const url = `${base}/wiki/rest/api/search?${qs.toString()}`;
      console.log(`Fetching from: ${url}`);
      
      const res = await httpFetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
      
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`Confluence API error: ${res.status} - ${text || res.statusText}`);
        
        // Fall back to mock data on error
        const results = generateMockResults(query, 20);
        const pagination = {
          start: start,
          limit: limit,
          size: results.length,
          totalSize: 100,
          nextCursor: undefined,
          prevCursor: undefined,
          nextUrl: undefined,
          prevUrl: undefined
        };
        
        return { 
          cql,
          results,
          pagination,
          error: `API error: ${res.status} - ${text || res.statusText}`
        };
      }
      
      const data = await res.json();
      firstPage = firstPage || data;
      
      const pageItems = (data?.results || []).map((r: any) => {
        const id = r?.content?.id || r?.id;
        const title = r?.title || r?.content?.title;
        const webui = r?.content?._links?.webui ?? r?._links?.webui ?? '';
        let url = '';
        
        if (webui) {
          url = base + '/wiki' + webui;
        } else if (typeof r?.url === 'string' && /^https?:\/\//.test(r.url)) {
          url = r.url;
        }
        
        // Get excerpt
        let excerpt = r?.excerpt || '';
        
        return { id, title, url, excerpt };
      });
      
      collected.push(...pageItems);
      
      const links = (data?._links || {}) as any;
      nextCursor = typeof links?.next === 'string' && /[?&]cursor=([^&]+)/.test(links.next)
        ? decodeURIComponent((links.next.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
        : '';
      
      pageCount++;
    } while (autoPaginate && nextCursor && (maxResults === 0 || collected.length < maxResults) && pageCount < 50);
    
    // Prepare the results
    const results = collected.slice(0, maxResults > 0 ? maxResults : undefined);
    const data = firstPage || { start: start || 0, limit, size: results.length, _links: {} };
    const links = (data?._links || {}) as any;
    
    const pagination = {
      start: data?.start ?? null,
      limit: data?.limit ?? limit,
      size: data?.size ?? (results?.length ?? 0),
      totalSize: data?.totalSize ?? undefined,
      nextCursor: typeof links?.next === 'string' && /[?&]cursor=([^&]+)/.test(links.next)
        ? decodeURIComponent((links.next.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
        : undefined,
      prevCursor: typeof links?.prev === 'string' && /[?&]cursor=([^&]+)/.test(links.prev)
        ? decodeURIComponent((links.prev.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
        : undefined,
      nextUrl: links?.next ? (base + links.next) : undefined,
      prevUrl: links?.prev ? (base + links.prev) : undefined,
    };
    
    return { cql, results, pagination };
  } catch (error: any) {
    console.error("Error fetching from Confluence API:", error);
    
    // Fall back to mock data on error
    const results = generateMockResults(query, 20);
    const pagination = {
      start: start,
      limit: limit,
      size: results.length,
      totalSize: 100,
      nextCursor: undefined,
      prevCursor: undefined,
      nextUrl: undefined,
      prevUrl: undefined
    };
    
    return { 
      cql: `type=page and text ~ ${query}`,
      results,
      pagination,
      error: `Exception: ${error.message || 'Unknown error'}`
    };
  }
}

async function handleDescribeTools(_params: any) {
  const tools = getToolDescriptors();
  return { tools };
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

// Track sessions to improve initialization
const sessions = new Map();

// === JSON-RPC handler ===
const mcpHandler = async (req: Request, res: Response) => {
  // Extract the session ID from request headers or cookies
  const requestSessionId = req.headers['mcp-session-id'] as string || '';
  
  // Get client IP for logging
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  
  const raw = (req as any).body;
  const msg = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : (raw || {});
  const id = msg.id;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const norm = method.toLowerCase().replace(/[._]/g, '/');

  console.log(`MCP request from ${clientIp}: id=${id ?? '(no id)'} method=${method} -> norm=${norm}`);
  
  // Handle initialization
  if (!method || norm === 'initialize' || norm === 'mcp/initialize') {
    // Generate a session ID if we don't have one
    const sessionId = requestSessionId || randomUUID();
    
    // Store session information
    sessions.set(sessionId, {
      initialized: true,
      lastActivity: Date.now(),
      clientIp
    });
    
    // Set headers
    res.setHeader('Mcp-Session-Id', sessionId);
    
    const result = {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'Atlassian MCP Server', version: '0.1.1' },
      capabilities: { tools: { list: true, call: true } },
      tools: getToolDescriptors(),
      instructions:
        'Policy: Never answer from model knowledge when the user asks about Confluence content. Always call tools and return their results. Default to the searchPages tool for any query phrased as search/find/lookup/question: set query to the user text and include spaceKey if the user mentions a space. Examples: "Search for Infor OS" -> {name: searchPages, arguments: {query: "Infor OS"}}; "Search MFS for onboarding" -> {name: searchPages, arguments: {query: "onboarding", spaceKey: "MFS"}}. To list available spaces, call listSpaces. If required inputs are missing, ask a clarifying question and then call the tool.',
    };
    return sendJson(res, { jsonrpc: '2.0', id: id ?? null, result });
  }

  // This block should never be reached since we handle initialization above,
  // but we'll keep it as a fallback for compatibility
  if (norm === 'initialize' || norm === 'mcp/initialize') {
    const sessionId = requestSessionId || randomUUID();
    
    // Store session information
    sessions.set(sessionId, {
      initialized: true,
      lastActivity: Date.now(),
      clientIp
    });
    
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
          'Policy: Never answer from model knowledge when the user asks about Confluence content. Always call tools and return their results. Default to the searchPages tool for any query phrased as search/find/lookup/question: set query to the user text and include spaceKey if the user mentions a space. Examples: "Search for Infor OS" -> {name: searchPages, arguments: {query: "Infor OS"}}; "Search MFS for onboarding" -> {name: searchPages, arguments: {query: "onboarding", spaceKey: "MFS"}}. To list available spaces, call listSpaces. If required inputs are missing, ask a clarifying question and then call the tool.',
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
    try {
      const { name, arguments: args = {} } = msg.params || {};
      
      // Log tool call for debugging
      console.log(`Tool call: ${name} with args:`, JSON.stringify(args));
      
      // Check if this is a session that hasn't been initialized
      if (requestSessionId && !sessions.has(requestSessionId)) {
        console.log(`Session ${requestSessionId} not found, auto-initializing`);
        // We should auto-initialize here
        const sessionId = requestSessionId;
        sessions.set(sessionId, {
          initialized: true,
          lastActivity: Date.now(),
          clientIp
        });
        // Continue with the tool call after auto-initializing
      }
      
      let out: any;

      switch (name) {
        case 'searchPages':
          out = await handleSearchPages(args);
          break;
        case 'listSpaces':
          out = await handleListSpaces(args);
          break;
        case 'describeTools':
          out = await handleDescribeTools(args);
          break;
      default:
        return sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${name}` } });
      }
      return sendJson(res, { jsonrpc: '2.0', id, result: out });
    } catch (error: any) {
      console.error(`Error handling tool call:`, error);
      return sendJson(res, { 
        jsonrpc: '2.0', 
        id, 
        error: { 
          code: -32603, 
          message: `Internal error processing tool call: ${error?.message || 'Unknown error'}`,
          data: { errorType: error?.name || 'Error' }
        } 
      });
    }
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
console.log(`Environment: ${isAzure ? 'Azure' : 'Local'}`);
console.log(`Platform: ${process.platform}`);
console.log(`Environment variables: PORT=${rawPort}, WEBSITE_SITE_NAME=${process.env.WEBSITE_SITE_NAME}`);
console.log(`Resolved PORT: ${rawPort ?? '(undefined)'} | platform=${process.platform} | azure=${isAzure} -> using ${typeof portOrPipe === 'string' ? portOrPipe : `port ${portOrPipe}`}`);

process.on('unhandledRejection', (reason) => console.error('UnhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));

try {
  if (typeof portOrPipe === 'string') {
    app.listen(portOrPipe, () => console.log(`MCP server listening on ${portOrPipe}`));
  } else {
    // Azure App Service expects the app to listen on all interfaces (0.0.0.0)
    // rather than just localhost (127.0.0.1)
    const host = isAzure ? '0.0.0.0' : '127.0.0.1';
    const numericPort = typeof portOrPipe === 'number' ? portOrPipe : parseInt(String(portOrPipe), 10);
    app.listen(numericPort, host, () => console.log(`MCP server listening on ${host}:${numericPort}`));
  }
} catch (error) {
  console.error('Failed to start server:', error);
  process.exit(1);
}
