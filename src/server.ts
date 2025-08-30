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
        serverInfo: { name: 'Atlassin-MCP-Server', version: '0.1.0' },
        instructions: 'Welcome to the Atlassin MCP server (Streamable HTTP).',
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
            name: 'help',
            description: 'Describe available MCP tools and how to use them',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: 'echo',
            description: 'Echo back the provided text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string', description: 'Text to echo' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
          {
            name: 'confluence.listSpaces',
            description: 'List Confluence spaces available to the configured user',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Max spaces to return (default 20, max 100)' },
              },
              additionalProperties: false,
            },
          },
          {
            name: 'confluence.summarizePage',
            description: 'Find a Confluence page by title query and return its content for summarization',
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
            name: 'confluence.createPage',
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
        ],
      },
    };
    return result;
  };

  const handleToolsCall = (msg: any) => {
    const id = msg.id;
    const name = msg?.params?.name;
    const args = msg?.params?.arguments ?? {};
    if (name === 'help') {
      const text = [
        'Available tools:',
        '- help: Show this help.',
        "- echo: Echo back text. Usage: name='echo', arguments: { text: 'Hello' }",
        "- confluence.listSpaces: List spaces (optional: limit)",
        "- confluence.summarizePage: Find a page by title and return content (query, optional spaceKey)",
        "- confluence.createPage: Create a page (spaceKey, title, body, optional parentId)",
      ].join('\n');
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }] },
      };
    } else if (name === 'echo') {
      const text = typeof args.text === 'string' ? args.text : JSON.stringify(args);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text },
          ],
        },
      };
    } else if (name === 'confluence.listSpaces') {
      return { jsonrpc: '2.0', id, result: { __defer: true } }; // will be replaced below by async handler
    } else if (name === 'confluence.summarizePage') {
      return { jsonrpc: '2.0', id, result: { __defer: true } };
    } else if (name === 'confluence.createPage') {
      return { jsonrpc: '2.0', id, result: { __defer: true } };
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
  const name = msg?.params?.name as string;
  const args = msg?.params?.arguments ?? {};
  const conf = getConfluenceAuth();
  if (!conf) {
    return { message: 'Confluence is not configured. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN.' };
  }
  if (name === 'confluence.listSpaces') {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const url = `${conf.baseUrl}/wiki/rest/api/space?limit=${limit}`;
    const r = await fetch(url, { headers: { Authorization: `Basic ${conf.auth}`, Accept: 'application/json' } as any });
    if (!r.ok) throw new Error(`List spaces failed: ${r.status}`);
    const data = await r.json();
    const items = (data?.results || []).map((s: any) => ({ key: s.key, name: s.name, id: s.id, url: conf.baseUrl + (s?._links?.webui || '') }));
    return { spaces: items };
  }
  if (name === 'confluence.summarizePage') {
    const query = String(args.query || '').trim();
    const spaceKey = args.spaceKey ? String(args.spaceKey) : undefined;
    if (!query) throw new Error('query is required');
    const cql = `type=page AND title ~ "${query.replace(/"/g, '\\"')}"` + (spaceKey ? ` AND space=${spaceKey}` : '');
    const searchUrl = `${conf.baseUrl}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=1`;
    const sr = await fetch(searchUrl, { headers: { Authorization: `Basic ${conf.auth}`, Accept: 'application/json' } as any });
    if (!sr.ok) throw new Error(`Search failed: ${sr.status}`);
    const sdata = await sr.json();
    const hit = sdata?.results?.[0];
    if (!hit) return { message: 'No page found for query.' };
    // Retrieve content by id
    const id = hit?.content?.id || hit?.id;
    const getUrl = `${conf.baseUrl}/wiki/rest/api/content/${id}?expand=body.storage,version,space`;
    const gr = await fetch(getUrl, { headers: { Authorization: `Basic ${conf.auth}`, Accept: 'application/json' } as any });
    if (!gr.ok) throw new Error(`Get page failed: ${gr.status}`);
    const page = await gr.json();
    const storage = page?.body?.storage?.value || '';
    const text = htmlToText(storage).slice(0, 8000);
    const url = conf.baseUrl + (page?._links?.webui || '');
    return { id, title: page?.title, url, excerpt: text.slice(0, 1000), content: text };
  }
  if (name === 'confluence.createPage') {
    const spaceKey = String(args.spaceKey || '').trim();
    const title = String(args.title || '').trim();
    const body = String(args.body || '');
    const parentId = args.parentId ? String(args.parentId) : undefined;
    if (!spaceKey || !title || !body) throw new Error('spaceKey, title, and body are required');
    const postUrl = `${conf.baseUrl}/wiki/rest/api/content`;
    const payload: any = {
      type: 'page',
      title,
      space: { key: spaceKey },
      body: { storage: { value: body, representation: 'storage' } },
    };
    if (parentId) {
      payload.ancestors = [{ id: parentId }];
    }
    const pr = await fetch(postUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${conf.auth}`, 'Content-Type': 'application/json', Accept: 'application/json' } as any,
      body: JSON.stringify(payload),
    });
    if (!pr.ok) throw new Error(`Create page failed: ${pr.status}`);
    const created = await pr.json();
    const url = conf.baseUrl +'wiki' + (created?._links?.webui || '');
    return { id: created?.id, title: created?.title, url };
  }
  throw new Error(`Unsupported Confluence tool: ${name}`);
}

function toErr(e: any) {
  return { message: e?.message || String(e) };
}

function htmlToText(html: string) {
  // naive strip tags; adequate for summaries
  return String(html).replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\s*\/p\s*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
