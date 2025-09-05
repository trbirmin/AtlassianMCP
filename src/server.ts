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
 * - PORT: The port to run the server on (default: 3000)
 */

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
          maxResults: { type: 'number' , description: 'Maximum number of results to return (default 50)' },
        },
        required: ['query'],
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
// Remaining Confluence API handler


async function handleSearchPages(params: any) {
  const query = String((params?.query ?? params?.q ?? params?.text ?? params?.question) || '').trim();
  const spaceKey = String(params?.spaceKey || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start) || 0;
  const cursor = String(params?.cursor || '').trim();
  
  // Always use 50 for maximum results - no special case needed for "all results" phrases
  const defaultMaxResults = 50;
  
  // Set maxResults with appropriate limits to avoid token overflow
  const maxResults = Math.max(Number.isFinite(Number(params?.maxResults)) ? Number(params?.maxResults) : defaultMaxResults, 0);
  
  // Always auto-paginate, but respect the maxResults limit
  const autoPaginate = true;
  
  console.log(`Search query: "${query}", maxResults: ${maxResults}`);
  
  if (!query) {
    return toolError('MISSING_INPUT', 'Missing required input: query', { missing: ['query'] });
  }

  // Check if we have Confluence credentials
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;

  // Require Confluence credentials
  if (!baseUrl || !email || !token) {
    console.error("No Confluence credentials found. Please set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN environment variables.");
    return toolError('CONFIGURATION_ERROR', 'Confluence credentials not configured', { 
      missing: [
        !baseUrl ? 'CONFLUENCE_BASE_URL' : null,
        !email ? 'CONFLUENCE_EMAIL' : null, 
        !token ? 'CONFLUENCE_API_TOKEN' : null
      ].filter(Boolean)
    });
  }
  
  // Use the real Confluence API
  console.log("Using Confluence API");
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
        
        return { 
          cql,
          results: [],
          pagination: {
            start: start,
            limit: limit,
            size: 0,
            totalSize: 0
          },
          error: `API error: ${res.status} - ${text || res.statusText}`
        };
      }
      
      const data = await res.json();
      firstPage = firstPage || data;
      
      const pageItems = (data?.results || []).map((r: any, index: number) => {
        const id = r?.content?.id || r?.id;
        const title = r?.title || r?.content?.title;
        const webui = r?.content?._links?.webui ?? r?._links?.webui ?? '';
        let url = '';
        
        if (webui) {
          url = base + '/wiki' + webui;
        } else if (typeof r?.url === 'string' && /^https?:\/\//.test(r.url)) {
          url = r.url;
        }
        
        // Add result number to title to help bot display more results
        const enhancedTitle = `[${index + 1}] ${title}`;
        
        // Excerpt removed as requested
        return { id, title: enhancedTitle, url };
      });
      
      collected.push(...pageItems);
      
      const links = (data?._links || {}) as any;
      nextCursor = typeof links?.next === 'string' && /[?&]cursor=([^&]+)/.test(links.next)
        ? decodeURIComponent((links.next.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
        : '';
      
      pageCount++;
      
      // Log current progress
      console.log(`Fetched page ${pageCount}, total results so far: ${collected.length}, maxResults: ${maxResults}`);
      
      // If we already have a significant number of results, we should stop to avoid token limit errors
      if (collected.length >= maxResults) {
        console.log(`Reached maxResults limit (${maxResults}), stopping pagination`);
        break;
      }
    } while (autoPaginate && nextCursor && pageCount < 10); // Increased from 5 to 10 pages for more results
    
    console.log(`Search complete. Total results: ${collected.length}, pages fetched: ${pageCount}`);
    
    // Prepare the results - strictly enforce the maxResults limit
    const results = collected.slice(0, maxResults);
    
    // Log the exact number of results being returned
    console.log(`Returning ${results.length} results to the client`);
    
    // If we have results, add a summary to the first result's title
    if (results.length > 0) {
      results[0].title = `DISPLAY ALL ${results.length} RESULTS BELOW - DO NOT STOP AT 10 - ${results[0].title}`;
    }
    
    // Force include total count in the results object itself so the client knows how many results we're returning
    const resultWithCount = {
      items: results,
      count: results.length,
      totalAvailable: collected.length,
      displayInstructions: `CRITICAL: Display all ${results.length} results. Do not truncate to 10. Show every single result with its title and URL.`
    };
    
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
    
    return { 
      cql, 
      resultSummary: `Found ${resultWithCount.count} results out of ${resultWithCount.totalAvailable} total matches for "${query}" - DISPLAY ALL ${resultWithCount.count} RESULTS BELOW`,
      results: resultWithCount.items, 
      resultCount: resultWithCount.count, 
      totalAvailable: resultWithCount.totalAvailable, 
      displayInstructions: resultWithCount.displayInstructions,
      pagination 
    };
  } catch (error: any) {
    console.error("Error fetching from Confluence API:", error);
    
    return { 
      cql: `type=page and text ~ "${query}"`,
      resultSummary: `Found 0 results for "${query}"`,
      results: [],
      resultCount: 0,
      totalAvailable: 0,
      pagination: {
        start: start,
        limit: limit,
        size: 0,
        totalSize: 0
      },
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
  
  // Always create a session ID to ensure session tracking
  const sessionId = requestSessionId || randomUUID();
  if (!requestSessionId) {
    console.log(`No session ID provided, creating new session: ${sessionId}`);
    res.setHeader('Mcp-Session-Id', sessionId);
    sessions.set(sessionId, {
      initialized: false,
      lastActivity: Date.now(),
      clientIp
    });
  } else if (!sessions.has(requestSessionId)) {
    console.log(`Session ${requestSessionId} not found, creating it`);
    sessions.set(sessionId, {
      initialized: false,
      lastActivity: Date.now(),
      clientIp
    });
  } else {
    // Update last activity
    const session = sessions.get(requestSessionId);
    session.lastActivity = Date.now();
    sessions.set(requestSessionId, session);
  }
  
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
    
    console.log(`Initializing session ${sessionId} for client ${clientIp}`);
    
    const result = {
      protocolVersion: '2023-07-01',  // Use an older protocol version for better compatibility
      serverInfo: { name: 'Atlassian MCP Server', version: '0.1.1' },
      capabilities: { tools: { list: true, call: true } },
      tools: getToolDescriptors(),
      instructions:
        'Policy: When the user asks about Confluence content, always call the searchPages tool and return the results. Default to the searchPages tool for any query: set query to the user text. CRITICAL REQUIREMENT: You MUST display EVERY SINGLE result returned by the tool - do not stop at 10, do not summarize, do not truncate. Show ALL results (up to 50) with each result on its own numbered line showing the title and URL. Never say "here are some of the results" - show them ALL.',
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
    
    console.log(`Fallback: Initializing session ${sessionId} for client ${clientIp}`);
    
    res.setHeader('Mcp-Session-Id', sessionId);
    return sendJson(res, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2023-07-01',  // Use an older protocol version for better compatibility
        serverInfo: { name: 'Atlassian MCP Server', version: '0.1.1' },
        capabilities: { tools: { list: true, call: true } },
        tools: getToolDescriptors(),
        instructions:
          'Policy: When the user asks about Confluence content, always call the searchPages tool and return the results. Default to the searchPages tool for any query: set query to the user text. CRITICAL REQUIREMENT: You MUST display EVERY SINGLE result returned by the tool - do not stop at 10, do not summarize, do not truncate. Show ALL results (up to 50) with each result on its own numbered line showing the title and URL. Never say "here are some of the results" - show them ALL.',
      },
    });
  }

  if (norm === 'notifications/initialized' || norm === 'mcp/notifications/initialized') {
    console.log(`Received notification acknowledgment for session ${requestSessionId}`);
    
    // Always return a proper response with id:null if no id provided
    if (id === undefined || id === null) {
      console.log(`No ID in notification request, returning structured acknowledgment`);
      return sendJson(res, { 
        jsonrpc: '2.0', 
        id: null, 
        result: { 
          acknowledged: true,
          message: "Notification acknowledged" 
        } 
      });
    }
    
    console.log(`Acknowledging notification with ID ${id}`);
    return sendJson(res, { 
      jsonrpc: '2.0', 
      id, 
      result: { 
        acknowledged: true,
        message: "Notification acknowledged" 
      } 
    });
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
