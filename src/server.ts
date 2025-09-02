import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fetch as undiciFetch } from 'undici';

// Use global fetch if available (Node 18+), otherwise fall back to undici
const httpFetch: typeof fetch = (globalThis as any).fetch ?? (undiciFetch as any);

// Minimal JSON utility
function sendJson(res: Response, payload: any, status = 200) {
  return res.status(status).json(payload);
}

// Need-input helper for planners
function needInput(inputs: Array<{ name: string; message: string }>) {
  return { needInput: { inputs } };
}

// SSE headers
function sseHeaders(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

// The single tool handler
async function handleSearchByLabelInSpace(params: any) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) {
    return { error: 'Missing Confluence credentials. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.' };
  }
  const label = String(params?.label || '').trim();
  const spaceKey = String(params?.spaceKey || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 10, 1), 100);
  if (!label || !spaceKey) {
    const ask: Array<{ name: string; message: string }> = [];
    if (!label) ask.push({ name: 'label', message: 'Which label?' });
    if (!spaceKey) ask.push({ name: 'spaceKey', message: 'Which space key?' });
    return needInput(ask);
  }
  const cql = `type=page and label=${encodeURIComponent(label)} and space=${encodeURIComponent(spaceKey)} ORDER BY lastmodified desc`;
  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const url = `${baseUrl.replace(/\/$/, '')}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`;
  const res = await httpFetch(url, { headers: { 'Authorization': authHeader, 'Accept': 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `Confluence API ${res.status}: ${text || res.statusText}` };
  }
  const data = await res.json();
  const base = baseUrl.replace(/\/$/, '');
  const results = (data?.results || []).map((r: any) => ({
    id: r?.content?.id || r?.id,
    title: r?.title || r?.content?.title,
    url: r?.url || (base + '/wiki' + (r?._links?.webui || '')),
  }));
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: `Results for label "${label}" in space ${spaceKey}`, weight: 'Bolder', size: 'Medium', wrap: true },
      ...results.slice(0, 15).map((r: any) => ({ type: 'TextBlock', text: `${r.title}\n${r.url}`, wrap: true })),
    ],
  };
  return { cql, results, ui: { adaptiveCard: card } };
}

// App setup
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// JSON-RPC handler at /mcp
const mcpHandler = async (req: Request, res: Response) => {
  const msg = req.body || {};
  const id = msg.id;
  const method = msg.method as string;
  if (!method) {
    return sendJson(res, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: expected method' } }, 400);
  }

  if (method === 'initialize') {
    const result = {
      protocolVersion: '2024-11-05',
      capabilities: {},
      instructions: 'You can search Confluence pages by label within a specific space using searchByLabelInSpace. Ask for any missing inputs (label, spaceKey, optional limit). Prefer tools over knowledge.',
    };
    return sendJson(res, { jsonrpc: '2.0', id, result });
  }

  if (method === 'tools/list') {
    const tools = [
      {
        name: 'searchByLabelInSpace',
        description: 'Search pages by label within a space, sorted by latest modified; returns up to limit results (default 10).',
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
    ];
    return sendJson(res, { jsonrpc: '2.0', id, result: { tools } });
  }

  if (method === 'tools/call') {
    const params = msg.params || {};
    const name = String(params.name || '');
    const args = params.arguments || {};
    if (name !== 'searchByLabelInSpace') {
      return sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${name}` } }, 404);
    }
    const out = await handleSearchByLabelInSpace(args);
    return sendJson(res, { jsonrpc: '2.0', id, result: out });
  }

  return sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } }, 404);
};

app.post('/mcp', mcpHandler);
app.post('/:connectionId/mcp', mcpHandler);
app.post('/apim/:apiName/:connectionId/mcp', mcpHandler);
app.post('/apim/:apiName/mcp', mcpHandler);

// Optional SSE endpoint (405 unless event-stream)
const mcpGetHandler = (req: Request, res: Response) => {
  const accept = req.header('Accept') || '';
  if (!accept.includes('text/event-stream')) return res.status(405).send('Method Not Allowed');
  sseHeaders(res);
  res.end();
};
app.get('/mcp', mcpGetHandler);
app.get('/:connectionId/mcp', mcpGetHandler);
app.get('/apim/:apiName/:connectionId/mcp', mcpGetHandler);
app.get('/apim/:apiName/mcp', mcpGetHandler);

// Health
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const rawPort = process.env.PORT;
const portOrPipe = rawPort && !/^\d+$/.test(rawPort) ? rawPort : Number(rawPort || 3000);

// Basic diagnostics to help in Azure log streams
console.log(`Node version: ${process.version}`);
console.log(`Resolved PORT: ${rawPort ?? '(undefined)'} -> using ${typeof portOrPipe === 'string' ? portOrPipe : `port ${portOrPipe}`}`);

// Global error handlers so crashes show up in logs
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err);
});

if (typeof portOrPipe === 'string') {
  app.listen(portOrPipe, () => {
    console.log(`MCP server listening on ${portOrPipe}`);
  });
} else {
  // Explicitly bind to 0.0.0.0 for container environments
  app.listen(portOrPipe, '0.0.0.0', () => {
    console.log(`MCP server listening on port ${portOrPipe}`);
  });
}
