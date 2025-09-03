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
          limit: { type: 'number', description: 'Page size per request (default 50, max 100; service may cap to 50)' },
          start: { type: 'number', description: 'Offset index for pagination (ignored when cursor is provided)' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response for next/prev page' },
          includeArchivedSpaces: { type: 'boolean', description: 'Include archived spaces in results' },
          maxResults: { type: 'number', description: 'When set, auto-paginates until this many results are collected (omit for full traversal)' },
          autoPaginate: { type: 'boolean', description: 'Defaults to true. Auto-paginates using cursor until maxResults or no next page' },
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
          limit: { type: 'number', description: 'Page size per request (default 50, max 100; service may cap to 50)' },
          start: { type: 'number', description: 'Offset index for pagination (ignored when cursor is provided)' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response for next/prev page' },
          includeArchivedSpaces: { type: 'boolean', description: 'Include archived spaces in results' },
          maxResults: { type: 'number', description: 'When set, auto-paginates until this many results are collected (omit for full traversal)' },
          autoPaginate: { type: 'boolean', description: 'Defaults to true. Auto-paginates using cursor until maxResults or no next page' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'searchByLabelInSpace',
      description:
  'Search pages by label within a space, sorted by latest modified; returns up to limit results (default 50).',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Confluence label (e.g., administration)' },
          spaceKey: { type: 'string', description: 'Space key (e.g., DOC)' },
          limit: { type: 'number', description: 'Page size per request (default 50, max 100; service may cap to 50)' },
          start: { type: 'number', description: 'Offset index for pagination (ignored when cursor is provided)' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response for next/prev page' },
          maxResults: { type: 'number', description: 'When set, auto-paginates until this many results are collected (omit for full traversal)' },
          autoPaginate: { type: 'boolean', description: 'Defaults to true. Auto-paginates using cursor until maxResults or no next page' },
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
          start: { type: 'number', description: 'Offset index for pagination' },
        },
        required: ['prefix'],
        additionalProperties: false,
      },
    },
    {
      name: 'listSpaces',
    description: 'List Confluence spaces (global). Returns up to limit spaces (default 50).',
      inputSchema: {
        type: 'object',
        properties: {
      limit: { type: 'number', description: 'Max spaces to return (default 50, max 100)' },
          start: { type: 'number', description: 'Offset index for pagination' },
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
          limit: { type: 'number', description: 'Page size per request (default 50, max 100; service may cap to 50)' },
          start: { type: 'number', description: 'Offset index for pagination (ignored when cursor is provided)' },
          cursor: { type: 'string', description: 'Opaque cursor from a previous response for next/prev page' },
          maxResults: { type: 'number', description: 'When set, auto-paginates until this many results are collected (omit for full traversal)' },
          autoPaginate: { type: 'boolean', description: 'Defaults to true. Auto-paginates using cursor until maxResults or no next page' },
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
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) {
    return toolError(
      'MISSING_CREDENTIALS',
      'Missing Confluence credentials. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.'
    );
  }

  const label = String(params?.label || '').trim();
  const spaceKey = String(params?.spaceKey || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start);
  const cursor = String(params?.cursor || '').trim();
  const maxResults = Math.max(Number.isFinite(Number(params?.maxResults)) ? Number(params?.maxResults) : 0, 0);
  const autoPaginate = params?.autoPaginate !== false || maxResults > 0;
  if (!label || !spaceKey) {
    const missing: string[] = [];
    if (!label) missing.push('label');
    if (!spaceKey) missing.push('spaceKey');
    return toolError('MISSING_INPUT', `Missing required input(s): ${missing.join(', ')}`, { missing });
  }

  const cql = `type=page and label=${encodeURIComponent(label)} and space=${encodeURIComponent(
    spaceKey
  )} ORDER BY lastmodified desc`;
  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const base = baseUrl.replace(/\/$/, '');
  const collected: any[] = [];
  let nextCursor = cursor;
  let firstPage: any = null;
  let pageCount = 0;
  do {
    const qs = new URLSearchParams({ cql, limit: String(limit) });
    if (!Number.isNaN(start) && Number.isFinite(start) && !nextCursor) qs.set('start', String(start));
    if (nextCursor) qs.set('cursor', nextCursor);
    const url = `${base}/wiki/rest/api/search?${qs.toString()}`;
    const res = await httpFetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return toolError('UPSTREAM_ERROR', `Confluence API ${res.status}: ${text || res.statusText}`);
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
      return { id, title, url };
    });
    collected.push(...pageItems);
    const links = (data?._links || {}) as any;
    nextCursor = typeof links?.next === 'string' && /[?&]cursor=([^&]+)/.test(links.next)
      ? decodeURIComponent((links.next.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
      : '';
    pageCount++;
  } while (autoPaginate && nextCursor && (maxResults === 0 || collected.length < maxResults) && pageCount < 20);
  const results = maxResults > 0 ? collected.slice(0, maxResults) : collected;
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
  } as const;
  const labelBody: any[] = [
      { type: 'TextBlock', text: `Results for label "${label}" in space ${spaceKey}`, weight: 'Bolder', size: 'Medium', wrap: true },
      ...results.slice(0, 50).map((r: any) => ({ type: 'TextBlock', text: `${r.title}\n${r.url}`, wrap: true })),
  ];
  if (pagination.nextCursor) {
    labelBody.push({ type: 'TextBlock', text: `More results available. nextCursor: ${pagination.nextCursor}`, wrap: true, size: 'Small', isSubtle: true });
  }
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: labelBody,
  } as const;
  return { cql, results, pagination, ui: { adaptiveCard: card } };
}

async function handleListSpaces(params: any) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) {
    return toolError(
      'MISSING_CREDENTIALS',
      'Missing Confluence credentials. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.'
    );
  }
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start);
  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const qs = new URLSearchParams({ limit: String(limit) });
  if (!Number.isNaN(start) && Number.isFinite(start)) qs.set('start', String(start));
  const url = `${baseUrl.replace(/\/$/, '')}/wiki/rest/api/space?${qs.toString()}`;
  const res = await httpFetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return toolError('UPSTREAM_ERROR', `Confluence API ${res.status}: ${text || res.statusText}`);
  }
  const data = await res.json();
  const base = baseUrl.replace(/\/$/, '');
  const results = (data?.results || []).map((s: any) => ({
    key: s?.key,
    name: s?.name,
    url: base + '/wiki' + (s?._links?.webui || ''),
  }));
  const pagination = {
    start: data?.start ?? null,
    limit: data?.limit ?? limit,
    size: data?.size ?? (results?.length ?? 0),
    _links: data?._links,
  } as const;
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: `Spaces (max ${limit})`, weight: 'Bolder', size: 'Medium', wrap: true },
  ...results.slice(0, 50).map((r: any) => ({ type: 'TextBlock', text: `${r.key} — ${r.name}\n${r.url}`, wrap: true })),
    ],
  } as const;
  return { results, pagination, ui: { adaptiveCard: card } };
}

async function handleListPagesInSpace(params: any) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) {
    return toolError(
      'MISSING_CREDENTIALS',
      'Missing Confluence credentials. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.'
    );
  }
  const spaceKey = String(params?.spaceKey || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start);
  const cursor = String(params?.cursor || '').trim();
  const maxResults = Math.max(Number.isFinite(Number(params?.maxResults)) ? Number(params?.maxResults) : 0, 0);
  const autoPaginate = params?.autoPaginate !== false || maxResults > 0;
  if (!spaceKey) {
    return toolError('MISSING_INPUT', 'Missing required input: spaceKey', { missing: ['spaceKey'] });
  }
  const cql = `type=page and space=${encodeURIComponent(spaceKey)} ORDER BY lastmodified desc`;
  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const base = baseUrl.replace(/\/$/, '');
  const collected: any[] = [];
  let nextCursor = cursor;
  let firstPage: any = null;
  let pageCount = 0;
  do {
    const qs2 = new URLSearchParams({ cql, limit: String(limit) });
    if (!Number.isNaN(start) && Number.isFinite(start) && !nextCursor) qs2.set('start', String(start));
    if (nextCursor) qs2.set('cursor', nextCursor);
    const url = `${base}/wiki/rest/api/search?${qs2.toString()}`;
    const res = await httpFetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return toolError('UPSTREAM_ERROR', `Confluence API ${res.status}: ${text || res.statusText}`);
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
      return { id, title, url };
    });
    collected.push(...pageItems);
    const links2 = (data?._links || {}) as any;
    nextCursor = typeof links2?.next === 'string' && /[?&]cursor=([^&]+)/.test(links2.next)
      ? decodeURIComponent((links2.next.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
      : '';
    pageCount++;
  } while (autoPaginate && nextCursor && (maxResults === 0 || collected.length < maxResults) && pageCount < 20);
  const results = maxResults > 0 ? collected.slice(0, maxResults) : collected;
  const data = firstPage || { start: start || 0, limit, size: results.length, _links: {} };
  const links2 = (data?._links || {}) as any;
  const pagination2 = {
    start: data?.start ?? null,
    limit: data?.limit ?? limit,
    size: data?.size ?? (results?.length ?? 0),
    totalSize: data?.totalSize ?? undefined,
    nextCursor: typeof links2?.next === 'string' && /[?&]cursor=([^&]+)/.test(links2.next)
      ? decodeURIComponent((links2.next.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
      : undefined,
    prevCursor: typeof links2?.prev === 'string' && /[?&]cursor=([^&]+)/.test(links2.prev)
      ? decodeURIComponent((links2.prev.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
      : undefined,
    nextUrl: links2?.next ? (base + links2.next) : undefined,
    prevUrl: links2?.prev ? (base + links2.prev) : undefined,
  } as const;
  const listBody: any[] = [
      { type: 'TextBlock', text: `Pages in ${spaceKey} (max ${limit})`, weight: 'Bolder', size: 'Medium', wrap: true },
      ...results.slice(0, 50).map((r: any) => ({ type: 'TextBlock', text: `${r.title}\n${r.url}`, wrap: true })),
  ];
  if (pagination2.nextCursor) {
    listBody.push({ type: 'TextBlock', text: `More results available. nextCursor: ${pagination2.nextCursor}`, wrap: true, size: 'Small', isSubtle: true });
  }
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: listBody,
  } as const;
  return { cql, results, pagination: pagination2, ui: { adaptiveCard: card } };
}

async function handleListLabels(params: any) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) {
    return toolError(
      'MISSING_CREDENTIALS',
      'Missing Confluence credentials. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.'
    );
  }
  const limit = Math.min(Math.max(Number(params?.limit) || 25, 1), 100);
  const start = Number(params?.start);
  const prefix = String((params?.prefix ?? params?.label ?? params?.name ?? params?.q) || '').trim();
  if (!prefix) {
    return toolError('MISSING_INPUT', 'Missing required input: prefix', { missing: ['prefix'] });
  }
  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const qs = new URLSearchParams({ limit: String(limit) });
  if (prefix) qs.set('prefix', prefix);
  if (!Number.isNaN(start) && Number.isFinite(start)) qs.set('start', String(start));
  const url = `${baseUrl.replace(/\/$/, '')}/wiki/rest/api/label?${qs.toString()}`;
  const res = await httpFetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return toolError('UPSTREAM_ERROR', `Confluence API ${res.status}: ${text || res.statusText}`);
  }
  const data = await res.json();
  const results = ((data as any)?.results || (data as any)?.labels || (data as any) || []).map((l: any) => ({
    name: typeof l === 'string' ? l : l?.name || '',
    prefix: l?.prefix,
  })).filter((x: any) => x.name);
  const pagination = {
    start: data?.start ?? null,
    limit: data?.limit ?? limit,
    size: data?.size ?? (results?.length ?? 0),
    _links: data?._links,
  } as const;
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: `Labels${prefix ? ` with prefix "${prefix}"` : ''} (max ${limit})`, weight: 'Bolder', size: 'Medium', wrap: true },
  ...results.slice(0, 50).map((r: any) => ({ type: 'TextBlock', text: r.name, wrap: true })),
    ],
  } as const;
  return { results, pagination, ui: { adaptiveCard: card } };
}

async function handleSearchPages(params: any) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) {
    return toolError(
      'MISSING_CREDENTIALS',
      'Missing Confluence credentials. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN.'
    );
  }
  const query = String((params?.query ?? params?.q ?? params?.text ?? params?.question) || '').trim();
  const spaceKey = String(params?.spaceKey || '').trim();
  const limit = Math.min(Math.max(Number(params?.limit) || 50, 1), 100);
  const start = Number(params?.start);
  const cursor = String(params?.cursor || '').trim();
  const includeArchivedSpaces = Boolean(params?.includeArchivedSpaces);
  const maxResults = Math.max(Number.isFinite(Number(params?.maxResults)) ? Number(params?.maxResults) : 0, 0);
  const autoPaginate = params?.autoPaginate !== false || maxResults > 0;
  if (!query) {
    return toolError('MISSING_INPUT', 'Missing required input: query', { missing: ['query'] });
  }
  let esc = query.replace(/[\x00-\x1F]/g, '');
  if (!esc || !esc.replace(/\s+/g, '')) esc = 'search';
  // Build CQL for text search per Atlassian docs:
  // - exact phrase requires escaping quotes inside the CQL value: text ~ "\"advanced search\""
  // - single word fuzzy search can omit quotes: text ~ word
  let cqlText: string;
  const trimmed = esc.trim();
  if (/^".+"$/.test(trimmed)) {
    // User already provided quotes -> treat as phrase, strip outer quotes and escape inner quotes
    const inner = trimmed.slice(1, -1).replace(/"/g, '\\"');
    cqlText = `text ~ "\\\"${inner}\\\""`;
  } else if (/\s/.test(trimmed)) {
    // Phrase without surrounding quotes -> make an exact phrase
    const inner = trimmed.replace(/"/g, '\\"');
    cqlText = `text ~ "\\\"${inner}\\\""`;
  } else {
    // Single word fuzzy
    cqlText = `text ~ ${trimmed}`;
  }
  const parts = ['type=page', cqlText];
  if (spaceKey) parts.push(`space=${encodeURIComponent(spaceKey)}`);
  // Avoid unsupported ORDER BY fields like 'score'; prefer lastmodified for stability
  const cql = parts.join(' and ') + ' ORDER BY lastmodified desc';
  const authHeader = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const base = baseUrl.replace(/\/$/, '');
  const collected: any[] = [];
  let nextCursor = cursor;
  let firstPage: any = null;
  let pageCount = 0;
  do {
    const qs = new URLSearchParams({ cql, limit: String(limit) });
    if (!Number.isNaN(start) && Number.isFinite(start) && !nextCursor) qs.set('start', String(start));
    if (nextCursor) qs.set('cursor', nextCursor);
    if (includeArchivedSpaces) qs.set('includeArchivedSpaces', 'true');
    const url = `${base}/wiki/rest/api/search?${qs.toString()}`;
    const res = await httpFetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return toolError('UPSTREAM_ERROR', `Confluence API ${res.status}: ${text || res.statusText}`, { cql });
    }
    const data = await res.json();
    firstPage = firstPage || data;
    const pageItems = (data?.results || []).map((r: any) => {
    const id = r?.content?.id || r?.id;
    const title = r?.title || r?.content?.title;
    const webui = r?.content?._links?.webui ?? r?._links?.webui ?? '';
    const excerpt = (r?.excerpt || '').toString();
    let url = '';
    if (webui) {
      url = base + '/wiki' + webui;
    } else if (typeof r?.url === 'string' && /^https?:\/\//.test(r.url)) {
      url = r.url;
    }
      return { id, title, url, excerpt };
    });
    collected.push(...pageItems);
    const links = (data?._links || {}) as any;
    nextCursor = typeof links?.next === 'string' && /[?&]cursor=([^&]+)/.test(links.next)
      ? decodeURIComponent((links.next.match(/[?&]cursor=([^&]+)/) || [])[1] || '')
      : '';
    pageCount++;
  } while (autoPaginate && nextCursor && (maxResults === 0 || collected.length < maxResults) && pageCount < 20);
  const results = maxResults > 0 ? collected.slice(0, maxResults) : collected;
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
  } as const;
  const searchBody: any[] = [
      { type: 'TextBlock', text: `Search results for "${query}"${spaceKey ? ` in space ${spaceKey}` : ''}` as string, weight: 'Bolder', size: 'Medium', wrap: true },
      ...results
        .slice(0, 50)
        .map((r: any) => ({ type: 'TextBlock', text: `${r.title}\n${r.url}${r.excerpt ? `\n${r.excerpt}` : ''}`, wrap: true })),
  ];
  if (pagination.nextCursor) {
    searchBody.push({ type: 'TextBlock', text: `More results available. nextCursor: ${pagination.nextCursor}`, wrap: true, size: 'Small', isSubtle: true });
  }
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
    body: searchBody,
    actions: results.slice(0, 10).map((r: any) => ({ type: 'Action.OpenUrl', title: r.title, url: r.url })),
  } as const;
  return { cql, results, pagination, ui: { adaptiveCard: card } };
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

// Handle raw text for MCP clients (accept both JSON and text)
const mcpPaths = ['/mcp', '/:connectionId/mcp', '/apim/:apiName/:connectionId/mcp', '/apim/:apiName/mcp'];
app.use(mcpPaths, express.text({ type: ['text/*', 'application/json', 'application/*+json'], limit: '1mb' }));

// Access log
app.use(morgan('combined'));

// === JSON-RPC handler ===
const mcpHandler = async (req: Request, res: Response) => {
  const raw = (req as any).body;
  let msg: any;
  if (typeof raw === 'string') {
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON' } });
    }
  } else {
    msg = raw || {};
  }
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
  const wantsSse = (req.header('Accept') || '').includes('text/event-stream');
  if (!wantsSse) {
    // Gracefully acknowledge non-SSE probes instead of 405 to avoid host errors
    return res.status(200).json({ ok: true, message: 'MCP endpoint. Use POST /mcp for JSON-RPC.' });
  }
  // Minimal SSE: open stream and send periodic keep-alives
  sseHeaders(res);
  try {
    res.write(': connected\n\n');
  } catch {}
  const interval = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 25000);
  req.on('close', () => clearInterval(interval));
  // Keep the connection open
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
