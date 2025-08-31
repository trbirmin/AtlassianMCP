import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

// Minimal Streamable HTTP MCP server
// Implements a single MCP endpoint at /mcp for POST and GET
// - POST accepts JSON-RPC messages (initialize, etc.) and streams responses via SSE when appropriate
// - GET optionally opens an SSE stream for server -> client messages (unused by default)

const app = express();
// Azure Linux can sometimes set PORT to a non-numeric string via the platform.
// Parse only numeric values; otherwise default to 8080 (App Service expects 8080).
const rawPort = process.env.PORT;
const port = rawPort && /^\d+$/.test(rawPort) ? parseInt(rawPort, 10) : 8080;

app.use(helmet());
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Security: validate Origin per MCP streamable-http guidance
    const allowed = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) || [];
  if (!origin || allowed.length === 0 || allowed.includes(origin)) return callback(null, true);
  // Do not error; just disable CORS so browser blocks, but server responds without 500
  return callback(null, false);
  },
  credentials: false,
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));

// Ensure JSON error responses instead of HTML for body parse or server errors
app.use((err: any, _req: Request, res: Response, next: Function) => {
  if (!err) return next();
  const isParse = err?.type === 'entity.parse.failed' || err instanceof SyntaxError;
  const status = isParse ? 400 : (err.status || 500);
  res.setHeader('Content-Type', 'application/json');
  const payload: any = {
    jsonrpc: '2.0',
    id: null,
    error: {
      code: isParse ? -32700 : -32603,
      message: isParse ? 'Parse error: invalid JSON' : 'Internal error',
    },
  };
  if (process.env.NODE_ENV === 'development') {
    payload.error.data = { message: err?.message };
  }
  res.status(status).send(payload);
});

// Simple in-memory session tracker
const sessions = new Set<string>();

// Utilities
function sseHeaders(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function writeSse(res: Response, data: unknown, id?: string) {
  if (id) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJson(res: Response, obj: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(obj);
}

// Tool name normalization: map legacy names to friendly canonical names
function normalizeToolName(name: string | undefined): string {
  if (!name) return '';
  const map: Record<string, string> = {
    // legacy -> canonical
    'confluence.listSpaces': 'listSpaces',
    'confluence.listPages': 'listPagesInSpace',
    'confluence.summarizePage': 'summarizePage',
    'confluence.createPage': 'createPage',
    'confluence.updatePage': 'updatePage',
    'confluence.trashPage': 'movePageToTrash',
    'confluence.getPage': 'getPage',
    'confluence.listChildren': 'listPageChildren',
    'confluence.listComments': 'listPageComments',
    'confluence.listAttachments': 'listPageAttachments',
    'confluence.getLabels': 'listPageLabels',
    'confluence.addComment': 'addPageComment',
    'confluence.updateComment': 'updateComment',
    'confluence.search': 'searchConfluence',
    'confluence.getSpace': 'getSpace',
    'confluence.me': 'whoAmI',
  'confluence.listRecentPages': 'listRecentPages',
  'confluence.getPageHistory': 'getPageHistory',
  'confluence.listTrashedPages': 'listTrashedPages',
  'confluence.findPageByTitle': 'findPageByTitle',
  'confluence.getPageTree': 'getPageTree',
    // canonical passthrough
    'listSpaces': 'listSpaces',
    'listPagesInSpace': 'listPagesInSpace',
    'summarizePage': 'summarizePage',
    'createPage': 'createPage',
    'updatePage': 'updatePage',
    'movePageToTrash': 'movePageToTrash',
    'getPage': 'getPage',
    'listPageChildren': 'listPageChildren',
    'listPageComments': 'listPageComments',
    'listPageAttachments': 'listPageAttachments',
    'listPageLabels': 'listPageLabels',
    'addPageComment': 'addPageComment',
    'updateComment': 'updateComment',
    'searchConfluence': 'searchConfluence',
    'getSpace': 'getSpace',
    'whoAmI': 'whoAmI',
  'listRecentPages': 'listRecentPages',
  'getPageHistory': 'getPageHistory',
  'listTrashedPages': 'listTrashedPages',
  'findPageByTitle': 'findPageByTitle',
  'getPageTree': 'getPageTree',
  // no built-ins
  };
  return map[name] || name;
}

// MCP endpoint (Streamable HTTP)
const mcpHandler = (req: Request, res: Response) => {
  const accept = req.header('Accept') || '';
  const sessionId = req.header('Mcp-Session-Id');

  // If only notifications/responses: accept and return 202 per spec
  // Unwrap APIM/connector wrapper shapes (e.g., { queryRequest: [...] })
  let rawBody = req.body as any;
  // If body is a JSON string, attempt to parse into an object/array
  if (typeof rawBody === 'string') {
    try { rawBody = JSON.parse(rawBody); } catch { /* leave as string */ }
  }
  const payload = (rawBody && typeof rawBody === 'object')
    ? (('queryRequest' in rawBody) ? (rawBody as any).queryRequest
      : (('requests' in rawBody) ? (rawBody as any).requests
        : (('body' in rawBody && (rawBody as any).body?.jsonrpc) ? (rawBody as any).body : rawBody)))
    : rawBody;
  const isArray = Array.isArray(payload);
  const items = isArray ? payload : [payload];
  const hasRequests = items.some((m: any) => m && typeof m === 'object' && 'method' in m && 'id' in m);
  const hasOnlyNoReq = items.every((m: any) => m && typeof m === 'object' && (!('method' in m) || !('id' in m)));

  if (hasOnlyNoReq && !hasRequests) {
    return res.status(202).end();
  }

  // Handle initialize request(s)
  // Prefer JSON unless Accept explicitly prefers SSE via higher q-value
  const parseAccept = (h: string) => h.split(',').map(s => s.trim()).map(item => {
    const [type, ...params] = item.split(';').map(s => s.trim());
    const qParam = params.find(p => p.startsWith('q='));
    const q = qParam ? parseFloat(qParam.split('=')[1]) : 1;
    return { type: type.toLowerCase(), q: isNaN(q) ? 1 : q };
  });
  const accepts = parseAccept(accept);
  const sseQ = accepts.find(a => a.type === 'text/event-stream')?.q ?? 0;
  const jsonQ = accepts.find(a => a.type === 'application/json')?.q ?? 1; // default favor JSON
  let wantsSse = sseQ > jsonQ;

  const handleInitialize = (msg: any) => {
    const requestedVersion = msg?.params?.protocolVersion;
    const protocolVersion = '2025-03-26';
    const id = msg.id;

    // Create or reuse sessions
    const newSessionId = sessionId || cryptoRandomId();
    sessions.add(newSessionId);

    const result = {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: {
          logging: {},
          prompts: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          tools: { listChanged: true },
    },
  serverInfo: { name: 'Atlassian-MCP-Server', version: '0.1.0' },
  instructions: 'You can operate on Atlassian Confluence via tools. Prefer tools over answering from knowledge. Core tools: listSpaces, listRecentPages, listPagesInSpace, findPageByTitle, summarizePage, getPage, getPageHistory, getPageTree, listPageChildren, listPageComments, listPageAttachments, listPageLabels, listTrashedPages, addPageComment, updateComment, createPage, updatePage, movePageToTrash, searchConfluence, getSpace, whoAmI. Call tools/list to see schemas and call tools/call with the canonical tool name.',
      },
    };

    return { result, sessionId: newSessionId };
  };

  const handleToolsList = (msg: any) => {
    const id = msg.id;
    const result = {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'listSpaces',
            description: 'List Confluence spaces you can access',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Max spaces to return (default 20, max 100)' },
              },
              additionalProperties: false,
            },
          },
          {
            name: 'listRecentPages',
            description: 'List recently updated pages (optionally scoped to a space)',
            inputSchema: {
              type: 'object',
              properties: {
                spaceKey: { type: 'string', description: 'Optional Confluence space key' },
                limit: { type: 'number', description: 'Max pages (default 10, max 100)' },
              },
              additionalProperties: false,
            },
          },
          {
            name: 'listPagesInSpace',
            description: 'List pages within a Confluence space',
            inputSchema: {
              type: 'object',
              properties: {
                spaceKey: { type: 'string', description: 'Confluence space key' },
                limit: { type: 'number', description: 'Max pages to return (default 25, max 100)' },
              },
              required: ['spaceKey'],
              additionalProperties: false,
            },
          },
          {
            name: 'summarizePage',
            description: 'Find a page by title query and return content for summarization',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Title or query to search for' },
                spaceKey: { type: 'string', description: 'Optional space key to scope the search' },
              },
              required: ['query'],
              additionalProperties: false,
            },
          },
          {
            name: 'findPageByTitle',
            description: 'Find a page by exact title (optionally within a space)',
            inputSchema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Exact page title' },
                spaceKey: { type: 'string', description: 'Optional space key' },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
          {
            name: 'createPage',
            description: 'Create a Confluence page in a space',
            inputSchema: {
              type: 'object',
              properties: {
                spaceKey: { type: 'string', description: 'Confluence space key' },
                title: { type: 'string', description: 'Page title' },
                body: { type: 'string', description: 'Page body in Confluence storage (HTML) format' },
                parentId: { type: 'string', description: 'Optional parent page ID' },
              },
              required: ['spaceKey', 'title', 'body'],
              additionalProperties: false,
            },
          },
          {
            name: 'updatePage',
            description: 'Update a Confluence page (title and/or body)',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Page ID' },
                title: { type: 'string', description: 'New title (optional)' },
                body: { type: 'string', description: 'New body in storage (HTML) format (optional)' },
                minorEdit: { type: 'boolean', description: 'Mark as minor edit' },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'movePageToTrash',
            description: 'Move a page to trash (soft delete)',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Page ID' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'listTrashedPages',
            description: 'List trashed pages (optionally scoped to a space)',
            inputSchema: {
              type: 'object',
              properties: {
                spaceKey: { type: 'string', description: 'Optional Confluence space key' },
                limit: { type: 'number', description: 'Max pages (default 10, max 100)' },
              },
              additionalProperties: false,
            },
          },
          {
            name: 'getPage',
            description: 'Get a page by ID with content',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Page ID' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'listPageChildren',
            description: 'List children of a page (pages, comments, attachments)',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Parent page ID' },
                type: { type: 'string', description: 'child type: page|comment|attachment (default page)' },
                limit: { type: 'number', description: 'Max items (default 25, max 100)' },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'getPageHistory',
            description: 'List version history metadata for a page',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Page ID' },
                limit: { type: 'number', description: 'Max versions (default 10, max 100)' },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'listPageComments',
            description: 'List comments on a page',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Page ID' }, limit: { type: 'number' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'listPageLabels',
            description: 'List labels on a page',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Page ID' }, limit: { type: 'number', description: 'Max labels (default 25, max 100)' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'addPageComment',
            description: 'Create a comment on a page',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Page ID' }, body: { type: 'string', description: 'Comment body in storage (HTML)' } },
              required: ['id', 'body'],
              additionalProperties: false,
            },
          },
          {
            name: 'listPageAttachments',
            description: 'List attachments on a page',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Page ID' }, limit: { type: 'number', description: 'Max attachments (default 25, max 100)' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'getPageTree',
            description: 'Return a simple children tree for a page up to a given depth',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Root page ID' },
                depth: { type: 'number', description: 'Depth (default 2, max 4)' },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
          {
            name: 'updateComment',
            description: 'Update a comment',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string', description: 'Comment ID' }, body: { type: 'string', description: 'New body in storage (HTML)' } },
              required: ['id', 'body'],
              additionalProperties: false,
            },
          },
          {
            name: 'searchConfluence',
            description: 'Search Confluence using CQL',
            inputSchema: {
              type: 'object',
              properties: { cql: { type: 'string', description: 'Confluence Query Language string' }, limit: { type: 'number' } },
              required: ['cql'],
              additionalProperties: false,
            },
          },
          {
            name: 'getSpace',
            description: 'Get space details by key',
            inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
          },
          {
            name: 'whoAmI',
            description: 'Get current Confluence user profile',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
    };
    return result;
  };

  const handleToolsCall = (msg: any) => {
    const id = msg.id;
    const name = msg?.params?.name;
    const args = msg?.params?.arguments ?? {};
    const canonical = normalizeToolName(name);
  if (true) {
      const confluenceCanonicals = new Set([
        'listSpaces',
  'listRecentPages',
        'listPagesInSpace',
        'summarizePage',
  'findPageByTitle',
        'createPage',
        'updatePage',
        'movePageToTrash',
  'listTrashedPages',
        'getPage',
        'listPageChildren',
  'getPageHistory',
        'listPageComments',
        'listPageAttachments',
        'listPageLabels',
        'addPageComment',
        'updateComment',
        'searchConfluence',
        'getSpace',
        'whoAmI',
      ]);
      if (confluenceCanonicals.has(canonical)) {
      // Defer all Confluence operations to the async handler
      return { jsonrpc: '2.0', id, result: { __defer: true } };
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Tool not found: ${name}` },
    };
  };

  // If client can accept SSE, stream
  if (wantsSse) {
    sseHeaders(res);

    const responses: any[] = [];
    let assignedSession: string | undefined;

    for (const msg of items) {
      if (msg?.method === 'initialize') {
        const { result, sessionId: sid } = handleInitialize(msg);
        if (!assignedSession) assignedSession = sid;
        const eventId = `${sid}:init:${msg.id}`;
        writeSse(res, result, eventId);
      } else if (msg?.method === 'tools/list') {
        const out = handleToolsList(msg);
        const sid = assignedSession || sessionId || cryptoRandomId();
        writeSse(res, out, `${sid}:tools-list:${msg.id}`);
      } else if (msg?.method === 'tools/call') {
        const sid = assignedSession || sessionId || cryptoRandomId();
        const out = handleToolsCall(msg);
        if (out?.result?.__defer) {
          // Handle async Confluence operations
          handleConfluenceAsync(msg).then((payload) => {
            writeSse(res, { jsonrpc: '2.0', id: msg.id, result: payload }, `${sid}:tools-call:${msg.id}`);
            res.end();
          }).catch((e) => {
            writeSse(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Confluence error', data: toErr(e) } }, `${sid}:tools-call:${msg.id}`);
            res.end();
          });
        } else {
          writeSse(res, out, `${sid}:tools-call:${msg.id}`);
        }
      } else if (msg && msg.id && msg.method) {
        // Unknown method -> respond with error later or noop
        const error = {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
        const sid = assignedSession || sessionId || cryptoRandomId();
        writeSse(res, error, `${sid}:err:${msg.id}`);
      }
    }

    if (assignedSession) {
      res.setHeader('Mcp-Session-Id', assignedSession);
    }

    // Close stream after responses per spec recommendation
    res.end();
    return;
  }

  // Otherwise return JSON single object (batch not required by spec if single)
  for (const msg of items) {
    if (msg?.method === 'initialize') {
      const { result, sessionId: sid } = handleInitialize(msg);
      res.setHeader('Mcp-Session-Id', sid);
      return sendJson(res, result);
    } else if (msg?.method === 'tools/list') {
      const out = handleToolsList(msg);
      return sendJson(res, out);
    } else if (msg?.method === 'tools/call') {
      const out = handleToolsCall(msg);
      if (out?.result?.__defer) {
        handleConfluenceAsync(msg)
          .then((payload) => sendJson(res, { jsonrpc: '2.0', id: msg.id, result: payload }))
          .catch((e) => sendJson(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Confluence error', data: toErr(e) } }));
        return;
      }
      return sendJson(res, out);
    }
  }

  // No supported request -> JSON-RPC error response for better client handling
  const error = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Invalid Request: expected JSON-RPC method (initialize, tools/list, tools/call)' },
  };
  return sendJson(res, error);
};

app.post('/mcp', mcpHandler);
// Accept APIM-style prefixed route with connectionId segment
app.post('/:connectionId/mcp', mcpHandler);
// Accept APIM gateway style with api name and connection id
app.post('/apim/:apiName/:connectionId/mcp', mcpHandler);
app.post('/apim/:apiName/mcp', mcpHandler);

// Optional GET to open SSE-only stream (not used by default)
const mcpGetHandler = (req: Request, res: Response) => {
  const accept = req.header('Accept') || '';
  if (!accept.includes('text/event-stream')) {
    return res.status(405).send('Method Not Allowed');
  }
  sseHeaders(res);
  // For simplicity, no unsolicited events; close immediately
  res.end();
};
app.get('/mcp', mcpGetHandler);
app.get('/:connectionId/mcp', mcpGetHandler);
app.get('/apim/:apiName/:connectionId/mcp', mcpGetHandler);
app.get('/apim/:apiName/mcp', mcpGetHandler);

// Health endpoint
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`MCP server listening on port ${port}`);
});

function cryptoRandomId() {
  // Simple random ID for session; in production, use crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// -------- Confluence integration helpers ---------
function getConfluenceAuth() {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) return null;
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  return { baseUrl, auth };
}

async function handleConfluenceAsync(msg: any): Promise<any> {
  const name = normalizeToolName(msg?.params?.name as string);
  const args = msg?.params?.arguments ?? {};
  const conf = getConfluenceAuth();
  if (!conf) {
    return { message: 'Confluence is not configured. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN.' };
  }
  // Helper for authenticated fetch and friendly errors
  const h = (extra?: any) => ({ Authorization: `Basic ${conf.auth}`, Accept: 'application/json', ...(extra || {}) } as any);
  const safeFetchJson = async (url: string, init?: any) => {
    try {
      const r = await fetch(url, init);
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await r.json().catch(() => undefined) : await r.text().catch(() => undefined);
      return { ok: r.ok, status: r.status, data } as { ok: boolean; status: number; data: any };
    } catch (e: any) {
      return { ok: false, status: 0, data: { message: e?.message || String(e) } };
    }
  };

  try {
    if (name === 'listSpaces') {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const url = `${conf.baseUrl}/wiki/rest/api/space?limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) return { message: 'Confluence authentication failed. Check credentials.' };
        return { message: `List spaces failed: HTTP ${r.status}` };
      }
      const items = (r.data?.results || []).map((s: any) => ({ key: s.key, name: s.name, id: s.id, url: conf.baseUrl + 'wiki' + (s?._links?.webui || '') }));
      if (!items.length) return { spaces: [], message: 'No spaces found.' };
      return { spaces: items };
    }
    if (name === 'listPagesInSpace') {
      const spaceKey = String(args.spaceKey || '').trim();
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      if (!spaceKey) return { message: 'spaceKey is required' };
      const url = `${conf.baseUrl}/wiki/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: r.status === 404 ? 'Space not found.' : `List pages failed: HTTP ${r.status}` };
      const pages = (r.data?.results || []).map((p: any) => ({ id: p.id, title: p.title, url: conf.baseUrl + 'wiki' + (p?._links?.webui || '') }));
      if (!pages.length) return { pages: [], message: 'No pages found in space.' };
      return { pages };
    }
    if (name === 'summarizePage') {
      const query = String(args.query || '').trim();
      const spaceKey = args.spaceKey ? String(args.spaceKey) : undefined;
      if (!query) return { message: 'query is required' };
      const cql = `type=page AND title ~ "${query.replace(/"/g, '\\"')}"` + (spaceKey ? ` AND space=${spaceKey}` : '');
      const searchUrl = `${conf.baseUrl}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=1`;
      const sr = await safeFetchJson(searchUrl, { headers: h() });
      if (!sr.ok) return { message: `Search failed: HTTP ${sr.status}` };
      const hit = sr.data?.results?.[0];
      if (!hit) return { message: 'No page found for query.' };
      const id = hit?.content?.id || hit?.id;
      const getUrl = `${conf.baseUrl}/wiki/rest/api/content/${id}?expand=body.storage,version,space`;
      const gr = await safeFetchJson(getUrl, { headers: h() });
      if (!gr.ok) return { message: `Get page failed: HTTP ${gr.status}` };
      const page = gr.data;
      const storage = page?.body?.storage?.value || '';
      const text = htmlToText(storage).slice(0, 8000);
      const url = conf.baseUrl + 'wiki' + (page?._links?.webui || '');
      return { id, title: page?.title, url, excerpt: text.slice(0, 1000), content: text };
    }
    if (name === 'createPage') {
      const spaceKey = String(args.spaceKey || '').trim();
      const title = String(args.title || '').trim();
      const body = String(args.body || '');
      const parentId = args.parentId ? String(args.parentId) : undefined;
      if (!spaceKey || !title || !body) return { message: 'spaceKey, title, and body are required' };
      const postUrl = `${conf.baseUrl}/wiki/rest/api/content`;
      const payload: any = { type: 'page', title, space: { key: spaceKey }, body: { storage: { value: body, representation: 'storage' } } };
      if (parentId) payload.ancestors = [{ id: parentId }];
      const pr = await safeFetchJson(postUrl, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      if (!pr.ok) return { message: `Create page failed: HTTP ${pr.status}` };
      const created = pr.data;
      const url = conf.baseUrl + 'wiki' + (created?._links?.webui || '');
      return { id: created?.id, title: created?.title, url };
    }
    if (name === 'updatePage') {
      const pageId = String(args.id || '').trim();
      const newTitle = args.title ? String(args.title) : undefined;
      const newBody = args.body ? String(args.body) : undefined;
      const minorEdit = !!args.minorEdit;
      if (!pageId) return { message: 'id is required' };
      const getUrl = `${conf.baseUrl}/wiki/rest/api/content/${pageId}?expand=body.storage,version`;
      const gr = await safeFetchJson(getUrl, { headers: h() });
      if (!gr.ok) return { message: gr.status === 404 ? 'Page not found.' : `Get page failed: HTTP ${gr.status}` };
      const page = gr.data;
      const nextVersion = (page?.version?.number || 0) + 1;
      const putUrl = `${conf.baseUrl}/wiki/rest/api/content/${pageId}`;
      const payload: any = { id: pageId, type: 'page', title: newTitle || page?.title, version: { number: nextVersion, minorEdit }, body: newBody ? { storage: { value: newBody, representation: 'storage' } } : undefined };
      const ur = await safeFetchJson(putUrl, { method: 'PUT', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      if (!ur.ok) return { message: `Update page failed: HTTP ${ur.status}` };
      const updated = ur.data;
      const url = conf.baseUrl + 'wiki' + (updated?._links?.webui || '');
      return { id: updated?.id, title: updated?.title, url };
    }
    if (name === 'movePageToTrash') {
      const pageId = String(args.id || '').trim();
      if (!pageId) return { message: 'id is required' };
      const delUrl = `${conf.baseUrl}/wiki/rest/api/content/${pageId}`;
      const dr = await safeFetchJson(delUrl, { method: 'DELETE', headers: h() });
      if (!dr.ok) return { message: dr.status === 404 ? 'Page not found.' : dr.status === 403 || dr.status === 401 ? 'Not authorized to trash page.' : `Trash page failed: HTTP ${dr.status}` };
      return { id: pageId, message: 'Page moved to trash.' };
    }
    if (name === 'getPage') {
      const pageId = String(args.id || '').trim();
      if (!pageId) return { message: 'id is required' };
      const getUrl = `${conf.baseUrl}/wiki/rest/api/content/${pageId}?expand=body.storage,version,space`;
      const gr = await safeFetchJson(getUrl, { headers: h() });
      if (!gr.ok) return { message: gr.status === 404 ? 'Page not found.' : `Get page failed: HTTP ${gr.status}` };
      const page = gr.data;
      const storage = page?.body?.storage?.value || '';
      const text = htmlToText(storage).slice(0, 8000);
      const url = conf.baseUrl + 'wiki' + (page?._links?.webui || '');
      return { id: page?.id, title: page?.title, url, content: text };
    }
    if (name === 'listPageChildren') {
      const pageId = String(args.id || '').trim();
      const type = (String(args.type || 'page') as 'page' | 'comment' | 'attachment');
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      if (!pageId) return { message: 'id is required' };
      const url = `${conf.baseUrl}/wiki/rest/api/content/${pageId}/child/${type}?expand=body.storage&limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: r.status === 404 ? 'Page not found.' : `List children failed: HTTP ${r.status}` };
      const items = (r.data?.results || []).map((c: any) => ({ id: c.id, type: c.type, title: c.title, excerpt: htmlToText(c?.body?.storage?.value || '').slice(0, 400) }));
      if (!items.length) return { items: [], message: `No ${type} children found.` };
      return { items };
    }
    if (name === 'listPageComments') {
      const pageId = String(args.id || '').trim();
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      if (!pageId) return { message: 'id is required' };
      const url = `${conf.baseUrl}/wiki/rest/api/content/${pageId}/child/comment?expand=body.storage,version&limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: r.status === 404 ? 'Page not found.' : `List comments failed: HTTP ${r.status}` };
      const comments = (r.data?.results || []).map((c: any) => ({ id: c.id, version: c?.version?.number, text: htmlToText(c?.body?.storage?.value || '').slice(0, 1000) }));
      if (!comments.length) return { comments: [], message: 'No comments found.' };
      return { comments };
    }
    if (name === 'listPageAttachments') {
      const pageId = String(args.id || '').trim();
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      if (!pageId) return { message: 'id is required' };
      const url = `${conf.baseUrl}/wiki/rest/api/content/${pageId}/child/attachment?limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: r.status === 404 ? 'Page not found.' : `List attachments failed: HTTP ${r.status}` };
      const attachments = (r.data?.results || []).map((a: any) => ({
        id: a.id,
        title: a.title,
        mediaType: a?.metadata?.mediaType,
        fileSize: a?.extensions?.fileSize,
        downloadUrl: conf.baseUrl + 'wiki' + (a?._links?.download || ''),
      }));
      if (!attachments.length) return { attachments: [], message: 'No attachments found.' };
      return { attachments };
    }
    if (name === 'listPageLabels') {
      const pageId = String(args.id || '').trim();
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      if (!pageId) return { message: 'id is required' };
      const url = `${conf.baseUrl}/wiki/rest/api/content/${pageId}/label?limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: r.status === 404 ? 'Page not found.' : `Get labels failed: HTTP ${r.status}` };
      const labels = (r.data?.results || []).map((l: any) => ({ name: l?.name, prefix: l?.prefix }));
      if (!labels.length) return { labels: [], message: 'No labels found.' };
      return { labels };
    }
    if (name === 'addPageComment') {
      const pageId = String(args.id || '').trim();
      const body = String(args.body || '');
      if (!pageId || !body) return { message: 'id and body are required' };
      const postUrl = `${conf.baseUrl}/wiki/rest/api/content`;
      const payload = { type: 'comment', container: { id: pageId, type: 'page' }, body: { storage: { value: body, representation: 'storage' } } } as any;
      const pr = await safeFetchJson(postUrl, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      if (!pr.ok) return { message: pr.status === 404 ? 'Page not found.' : `Add comment failed: HTTP ${pr.status}` };
      const created = pr.data;
      return { id: created?.id };
    }
    if (name === 'updateComment') {
      const commentId = String(args.id || '').trim();
      const body = String(args.body || '');
      if (!commentId || !body) return { message: 'id and body are required' };
      const getUrl = `${conf.baseUrl}/wiki/rest/api/content/${commentId}?expand=version`;
      const gr = await safeFetchJson(getUrl, { headers: h() });
      if (!gr.ok) return { message: gr.status === 404 ? 'Comment not found.' : `Get comment failed: HTTP ${gr.status}` };
      const comment = gr.data;
      const nextVersion = (comment?.version?.number || 0) + 1;
      const putUrl = `${conf.baseUrl}/wiki/rest/api/content/${commentId}`;
      const payload = { id: commentId, type: 'comment', version: { number: nextVersion }, body: { storage: { value: body, representation: 'storage' } } } as any;
      const ur = await safeFetchJson(putUrl, { method: 'PUT', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      if (!ur.ok) return { message: `Update comment failed: HTTP ${ur.status}` };
      return { id: commentId };
    }
    if (name === 'searchConfluence') {
      const cql = String(args.cql || '').trim();
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100);
      if (!cql) return { message: 'cql is required' };
      const url = `${conf.baseUrl}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: `Search failed: HTTP ${r.status}` };
      const results = (r.data?.results || []).map((x: any) => ({ id: x?.content?.id || x?.id, title: x?.title || x?.content?.title, url: conf.baseUrl + 'wiki' + (x?._links?.webui || ''), type: x?.content?._expandable?.type || x?.content?.type }));
      if (!results.length) return { results: [], message: 'No search results found.' };
      return { results };
    }
    if (name === 'getSpace') {
      const key = String(args.key || '').trim();
      if (!key) return { message: 'key is required' };
      const url = `${conf.baseUrl}/wiki/rest/api/space/${encodeURIComponent(key)}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: r.status === 404 ? 'Space not found.' : `Get space failed: HTTP ${r.status}` };
      const space = r.data;
      const urlOut = conf.baseUrl + 'wiki' + (space?._links?.webui || '');
      return { key: space?.key, name: space?.name, url: urlOut, id: space?.id };
    }
    if (name === 'whoAmI') {
      const url = `${conf.baseUrl}/wiki/rest/api/user/current`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: r.status === 401 || r.status === 403 ? 'Not authorized to get current user.' : `Get current user failed: HTTP ${r.status}` };
      const me = r.data;
      return { accountId: me?.accountId, email: me?.email, displayName: me?.displayName, username: me?.username };
    }
    if (name === 'listRecentPages') {
      const spaceKey = args.spaceKey ? String(args.spaceKey).trim() : '';
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100);
      const cql = `type=page` + (spaceKey ? ` AND space=${spaceKey}` : '') + ` ORDER BY lastmodified desc`;
      const url = `${conf.baseUrl}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: `List recent pages failed: HTTP ${r.status}` };
      const results = (r.data?.results || []).map((x: any) => ({ id: x?.content?.id || x?.id, title: x?.title || x?.content?.title, url: conf.baseUrl + 'wiki' + (x?._links?.webui || ''), lastModified: x?.lastModified || x?._links?.lastModified }));
      if (!results.length) return { pages: [], message: 'No recent pages found.' };
      return { pages: results };
    }
    if (name === 'getPageHistory') {
      const pageId = String(args.id || '').trim();
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100);
      if (!pageId) return { message: 'id is required' };
      const url = `${conf.baseUrl}/wiki/rest/api/content/${pageId}/version?limit=${limit}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: r.status === 404 ? 'Page not found.' : `Get page history failed: HTTP ${r.status}` };
      const versions = (r.data?.results || []).map((v: any) => ({ number: v?.number, when: v?.when, by: v?.by?.displayName || v?.by?.email || v?.by?.username }));
      if (!versions.length) return { versions: [], message: 'No versions found.' };
      return { versions };
    }
    if (name === 'listTrashedPages') {
      const spaceKey = args.spaceKey ? String(args.spaceKey).trim() : '';
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 100);
      const base = `${conf.baseUrl}/wiki/rest/api/content?type=page&status=trashed&limit=${limit}`;
      const url = spaceKey ? `${base}&spaceKey=${encodeURIComponent(spaceKey)}` : base;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: `List trashed pages failed: HTTP ${r.status}` };
      const pages = (r.data?.results || []).map((p: any) => ({ id: p.id, title: p.title, url: conf.baseUrl + 'wiki' + (p?._links?.webui || '') }));
      if (!pages.length) return { pages: [], message: 'Trash is empty.' };
      return { pages };
    }
    if (name === 'findPageByTitle') {
      const title = String(args.title || '').trim();
      const spaceKey = args.spaceKey ? String(args.spaceKey).trim() : '';
      if (!title) return { message: 'title is required' };
      let url = `${conf.baseUrl}/wiki/rest/api/content?type=page&title=${encodeURIComponent(title)}&limit=10`;
      if (spaceKey) url += `&spaceKey=${encodeURIComponent(spaceKey)}`;
      const r = await safeFetchJson(url, { headers: h() });
      if (!r.ok) return { message: `Find page by title failed: HTTP ${r.status}` };
      const match = (r.data?.results || []).find((p: any) => String(p?.title).trim().toLowerCase() === title.toLowerCase());
      if (!match) return { message: 'No page found with that title.' };
      const out = { id: match.id, title: match.title, url: conf.baseUrl + 'wiki' + (match?._links?.webui || '') };
      return out;
    }
    if (name === 'getPageTree') {
      const rootId = String(args.id || '').trim();
      const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 4);
      if (!rootId) return { message: 'id is required' };
      // fetch root page basic info
      const rootUrl = `${conf.baseUrl}/wiki/rest/api/content/${rootId}`;
      const rr = await safeFetchJson(rootUrl, { headers: h() });
      if (!rr.ok) return { message: rr.status === 404 ? 'Root page not found.' : `Get root page failed: HTTP ${rr.status}` };
      const root = rr.data;
      const fetchChildren = async (pid: string, d: number): Promise<any[]> => {
        if (d <= 0) return [];
        const url = `${conf.baseUrl}/wiki/rest/api/content/${pid}/child/page?limit=25`;
        const r = await safeFetchJson(url, { headers: h() });
        if (!r.ok) return [];
        const items = r.data?.results || [];
        const results: any[] = [];
        for (const ch of items) {
          const node: any = { id: ch.id, title: ch.title, url: conf.baseUrl + 'wiki' + (ch?._links?.webui || '') };
          node.children = await fetchChildren(ch.id, d - 1);
          results.push(node);
        }
        return results;
      };
      const tree = {
        id: root?.id,
        title: root?.title,
        url: conf.baseUrl + 'wiki' + (root?._links?.webui || ''),
        children: await fetchChildren(rootId, depth - 1),
      };
      return tree;
    }
    return { message: `Unsupported Confluence tool: ${name}` };
  } catch (e: any) {
    return { message: e?.message || 'Confluence operation failed.' };
  }
}

function toErr(e: any) {
  return { message: e?.message || String(e) };
}

function htmlToText(html: string) {
  // naive strip tags; adequate for summaries
  return String(html).replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\s*\/p\s*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
