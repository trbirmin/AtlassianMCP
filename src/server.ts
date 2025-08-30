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
    return callback(new Error('Origin not allowed'));
  },
  credentials: false,
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));

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
app.post('/mcp', (req: Request, res: Response) => {
  const accept = req.header('Accept') || '';
  const sessionId = req.header('Mcp-Session-Id');

  // If only notifications/responses: accept and return 202 per spec
  const body = req.body;
  const isArray = Array.isArray(body);
  const items = isArray ? body : [body];
  const hasRequests = items.some((m: any) => m && typeof m === 'object' && 'method' in m && 'id' in m);
  const hasOnlyNoReq = items.every((m: any) => m && typeof m === 'object' && (!('method' in m) || !('id' in m)));

  if (hasOnlyNoReq && !hasRequests) {
    return res.status(202).end();
  }

  // Handle initialize request(s)
  let wantsSse = accept.includes('text/event-stream');

  const handleInitialize = (msg: any) => {
    const requestedVersion = msg?.params?.protocolVersion;
    const protocolVersion = '2025-03-26';
    const id = msg.id;

    // Create or reuse session
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
        const out = handleToolsCall(msg);
        const sid = assignedSession || sessionId || cryptoRandomId();
        writeSse(res, out, `${sid}:tools-call:${msg.id}`);
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
      return sendJson(res, out);
    }
  }

  // No supported request
  return res.status(400).json({
    error: 'Unsupported request(s). Ensure initialize is sent first and include Accept: application/json, text/event-stream',
  });
});

// Optional GET to open SSE-only stream (not used by default)
app.get('/mcp', (req: Request, res: Response) => {
  const accept = req.header('Accept') || '';
  if (!accept.includes('text/event-stream')) {
    return res.status(405).send('Method Not Allowed');
  }
  sseHeaders(res);
  // For simplicity, no unsolicited events; close immediately
  res.end();
});

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
