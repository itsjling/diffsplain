#!/usr/bin/env node

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ReviewChatError,
  createCodingAgentChatProvider,
  createReviewChat,
} from './review-chat.mjs';
import { publicError } from './review-chat-context.mjs';
import {
  emptyUsageAccumulator,
  formatReviewUsage,
  recordUsage,
  reviewUsage,
  usageSummary,
} from './agent-usage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = resolve(root, 'dist');
const rawArgs = process.argv.slice(2);

function option(name, fallback) {
  const index = rawArgs.indexOf(name);
  if (index === -1) return fallback;
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

const output = resolve(option('--output', resolve(root, '.cache/diff-data.json')));
const project = option('--project', '');
const portValue = option('--port', '2299');
const host = option('--host', 'localhost').replace(/^\[|\]$/g, '');
const access = option('--access', randomBytes(32).toString('base64url'));
const previousAccess = option('--previous-access', '');
const chatSnapshot = resolve(option('--chat-snapshot', output));
const chatAgent = option('--chat-agent');
const chatBinary = option('--chat-binary', chatAgent);
const chatModel = option('--chat-model');
const chatReasoning = option('--chat-reasoning');
const chatAccessMode = option('--chat-access-mode', 'snapshot-only');
const chatAccessRoot = option('--chat-access-root');
if (!/^\d+$/.test(portValue) || Number(portValue) > 65_535) {
  throw new Error('--port must be a number from 0 to 65535');
}
if (!/^[A-Za-z0-9_-]{32,}$/.test(access)) {
  throw new Error('--access must be an unguessable URL-safe value');
}
if (previousAccess && !/^[A-Za-z0-9_-]{32,}$/.test(previousAccess)) {
  throw new Error('--previous-access must be an unguessable URL-safe value');
}
if (!['checkout-read-only', 'snapshot-only'].includes(chatAccessMode)) {
  throw new Error('--chat-access-mode must be checkout-read-only or snapshot-only');
}
if (chatAccessMode === 'checkout-read-only' && !chatAccessRoot) {
  throw new Error('--chat-access-root is required for checkout chat access');
}
const incrementPort =
  rawArgs.includes('--increment-port') || !rawArgs.includes('--port');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const restrictiveHeaders = {
  'content-security-policy':
    "base-uri 'none'; connect-src 'self'; default-src 'self'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; style-src 'self' 'unsafe-inline'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function webResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: { ...restrictiveHeaders, ...headers },
  });
}

function clientError() {
  return webResponse('Bad request', { status: 400 });
}

function notFound() {
  return webResponse('Not found', { status: 404 });
}

function isLoopback(address) {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function normalizedAddress(address) {
  return address.replace(/^\[|\]$/g, '').toLowerCase();
}

function cacheControl(file) {
  const extension = extname(file).toLowerCase();
  if (extension === '.html') return 'no-cache';
  if (/[-_][A-Za-z0-9_-]{8,}\.(?:css|js|woff2?)$/.test(file)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

async function fileResponse(file, { live = false } = {}) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return notFound();
    return webResponse(await readFile(file), {
      headers: {
        'cache-control': live ? 'no-store' : cacheControl(file),
        'content-type':
          contentTypes[extname(file).toLowerCase()] ||
          'application/octet-stream',
      },
    });
  } catch {
    return notFound();
  }
}

function decodeRequestPath(rawPath) {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
}

function unsafeRequestPath(rawPath, decodedPath) {
  if (!rawPath.startsWith('/')) return true;
  if (authorityPath(rawPath, decodedPath)) return true;
  if (decodedPath.includes('\\')) return true;
  return decodedPath.split('/').includes('..');
}

function authorityPath(rawPath, decodedPath) {
  return rawPath.startsWith('//') || decodedPath.startsWith('//');
}

function parseUrl(raw) {
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return undefined;
  }
}

function parseRequestUrl(request) {
  const raw = request.url || '/';
  const rawPath = raw.split(/[?#]/, 1)[0];
  const decodedPath = decodeRequestPath(rawPath);
  if (decodedPath === undefined) return undefined;
  if (unsafeRequestPath(rawPath, decodedPath)) return undefined;
  return parseUrl(raw);
}

function parseHttpHost(value) {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`);
  } catch {
    return undefined;
  }
}

function serverPort(url) {
  if (url.port) return url.port;
  return readyState?.port === 80 ? '80' : '';
}

function plainHost(url) {
  return ![
    url.username,
    url.password,
    url.pathname !== '/',
    url.search,
    url.hash,
  ].some(Boolean);
}

function matchesServerAddress(candidate, localAddress) {
  const local = normalizedAddress(localAddress);
  const accepted = new Set([normalizedAddress(host), local]);
  if (accepted.has(candidate)) return true;
  return isLoopback(candidate) && isLoopback(local);
}

function validHost(value, localAddress) {
  const url = parseHttpHost(value);
  if (!url) return false;
  if (!plainHost(url)) return false;
  if (serverPort(url) !== String(readyState.port)) return false;
  return matchesServerAddress(normalizedAddress(url.hostname), localAddress);
}

function parseOriginPair(value, requestHost) {
  if (value === 'null') return undefined;
  try {
    return {
      origin: new URL(value),
      requestUrl: new URL(`http://${requestHost}`),
    };
  } catch {
    return undefined;
  }
}

function matchingOrigin({ origin, requestUrl }) {
  const plainOrigin = ![
    origin.protocol !== 'http:',
    origin.username,
    origin.password,
    origin.pathname !== '/',
    origin.search,
    origin.hash,
  ].some(Boolean);
  if (!plainOrigin) return false;
  if (
    normalizedAddress(origin.hostname) !==
    normalizedAddress(requestUrl.hostname)
  ) {
    return false;
  }
  return serverPort(origin) === serverPort(requestUrl);
}

function validOrigin(value, requestHost, localAddress) {
  if (!value) return true;
  const pair = parseOriginPair(value, requestHost);
  if (!pair) return false;
  if (!matchingOrigin(pair)) return false;
  return validHost(pair.origin.host, localAddress);
}

function validAccess(value, { allowPrevious = false } = {}) {
  if (matchingAccess(value, access)) return true;
  return (
    allowPrevious &&
    Boolean(previousAccess) &&
    matchingAccess(value, previousAccess)
  );
}

function matchingAccess(value, expectedValue) {
  const received = Buffer.from(value || '');
  const expected = Buffer.from(expectedValue);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function fetchAsset(url) {
  if (url.pathname === '/diff-data.json') {
    return liveSnapshotResponse();
  }
  const pathname = decodeURIComponent(url.pathname);
  const file = resolve(
    clientRoot,
    pathname === '/' ? 'index.html' : `.${pathname}`,
  );
  if (file !== clientRoot && !file.startsWith(`${clientRoot}${sep}`)) {
    return clientError();
  }
  return fileResponse(file);
}

async function liveSnapshotResponse() {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(output, 'utf8'));
  } catch {
    return fileResponse(output, { live: true });
  }
  const fingerprint = snapshot?.notes?.reviewFingerprint;
  if (!fingerprint) {
    return fileResponse(output, { live: true });
  }
  const noteSummary = snapshot.usage?.agentNotes ||
    usageSummary(emptyUsageAccumulator());
  const chatSummary = currentChatUsage(fingerprint);
  const usage = reviewUsage(noteSummary, chatSummary);
  const version = createHash('sha256')
    .update(JSON.stringify({ version: snapshot.version, usage }))
    .digest('hex')
    .slice(0, 12);
  return jsonResponse({ ...snapshot, version, usage });
}

function jsonResponse(value, status = 200) {
  return webResponse(JSON.stringify(value), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

const chatBodyLimitBytes = 64 * 1024;

function chatJsonContentType(value) {
  return typeof value === 'string' &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value);
}

function chatRequestBody(request) {
  if (!chatJsonContentType(request.headers['content-type'])) {
    throw new ReviewChatError('Chat commands need application/json.', 415);
  }
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > chatBodyLimitBytes) {
    throw new ReviewChatError('Chat command body is too large.', 413);
  }
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.resume();
      reject(error);
    };
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > chatBodyLimitBytes) {
        fail(new ReviewChatError('Chat command body is too large.', 413));
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', fail);
    request.once('end', () => {
      if (settled) return;
      settled = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new ReviewChatError('Chat commands must be JSON objects.');
        }
        resolvePromise(value);
      } catch (error) {
        reject(
          error instanceof ReviewChatError
            ? error
            : new ReviewChatError('Chat command JSON is not valid.'),
        );
      }
    });
  });
}

async function send(nodeResponse, webResponse) {
  nodeResponse.writeHead(
    webResponse.status,
    Object.fromEntries(webResponse.headers),
  );
  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }
  nodeResponse.end(Buffer.from(await webResponse.arrayBuffer()));
}

const eventClients = new Set();
let selectedPort = Number(portValue);
let readyState;
let closing = false;

function broadcastEvent(name, data = {}) {
  const payload = JSON.stringify(data);
  for (const client of eventClients) {
    if (!client.destroyed) client.write(`event: ${name}\ndata: ${payload}\n\n`);
  }
}

function lifecycleKind(kind) {
  return kind === 'compact' ? 'history compaction' : 'answer';
}

function lifecycleStatus(type) {
  return {
    start: 'started',
    progress: 'still running',
    complete: 'completed',
    failure: 'failed',
    timeout: 'timed out',
    cancel: 'cancelled',
  }[type] || type;
}

function elapsedText(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${Math.round(milliseconds / 1_000)}s`;
}

function logChatLifecycle(event) {
  const elapsed = event.type === 'start' ? '' : ` (${elapsedText(event.elapsedMs)})`;
  const error = event.error ? `: ${event.error}` : '';
  console.log(
    `Diffsplain chat #${event.runId}: ${lifecycleKind(event.kind)} ${lifecycleStatus(event.type)}${elapsed}${error}`,
  );
}

function logObservedError(area, error) {
  console.log(`Diffsplain ${area.replaceAll('-', ' ')} error: ${publicError(error)}`);
}

let chatUsageFingerprint;
let chatUsage = emptyUsageAccumulator();
let reviewChat;

function snapshotNoteUsage() {
  try {
    return JSON.parse(readFileSync(output, 'utf8')).usage?.agentNotes;
  } catch {
    return undefined;
  }
}

function currentChatUsage(fingerprint) {
  if (fingerprint !== chatUsageFingerprint) {
    chatUsageFingerprint = fingerprint;
    chatUsage = emptyUsageAccumulator();
  }
  return usageSummary(chatUsage);
}

function recordChatUsage({ reviewFingerprint, usage }) {
  if (
    !reviewFingerprint ||
    reviewChat?.getState().fingerprint !== reviewFingerprint
  ) {
    return;
  }
  currentChatUsage(reviewFingerprint);
  chatUsage = recordUsage(chatUsage, usage);
  const totals = reviewUsage(
    snapshotNoteUsage() || usageSummary(emptyUsageAccumulator()),
    usageSummary(chatUsage),
  );
  console.log(formatReviewUsage(totals));
  broadcastEvent('update');
}

const chatProviderAccess = chatAccessMode === 'checkout-read-only'
  ? { mode: chatAccessMode, root: resolve(chatAccessRoot) }
  : { mode: chatAccessMode, reason: 'target-mismatch' };
const chatProvider = chatAgent
  ? createCodingAgentChatProvider({
      agent: chatAgent,
      binary: chatBinary,
      model: chatModel,
      reasoning: chatReasoning,
      accessMode: chatProviderAccess,
      onUsage: recordChatUsage,
    })
  : undefined;
reviewChat = createReviewChat({
  snapshotPath: chatSnapshot,
  provider: chatProvider,
  accessMode: chatProviderAccess,
  onChange: () => broadcastEvent('chat'),
  onLifecycle: logChatLifecycle,
});

function requestAuthorityError(request) {
  const localAddress = request.socket.localAddress || '';
  if (!validHost(request.headers.host, localAddress)) {
    return clientError();
  }
  if (!validOrigin(request.headers.origin, request.headers.host, localAddress)) {
    return webResponse('Forbidden', { status: 403 });
  }
  return undefined;
}

function allowedMethods(url) {
  return url.pathname === '/api/chat' ? ['GET', 'POST'] : ['GET', 'HEAD'];
}

function methodError(request, url) {
  if (allowedMethods(url).includes(request.method)) return undefined;
  return webResponse('Method not allowed', { status: 405 });
}

function requestContext(request) {
  const url = parseRequestUrl(request);
  if (!url) return { error: clientError() };
  const authorityError = requestAuthorityError(request);
  if (authorityError) return { error: authorityError };
  const error = methodError(request, url);
  if (error) return { error };
  return { url };
}

function forcedHandlerFailure(url) {
  return (
    process.env.DIFFSPLAIN_TEST_HANDLER_FAILURE &&
    url.pathname === '/__test/fail'
  );
}

async function sendEvents(response, url) {
  if (
    !validAccess(url.searchParams.get('access'), { allowPrevious: true })
  ) {
    await send(response, webResponse('Forbidden', { status: 403 }));
    return;
  }
  response.writeHead(200, {
    ...restrictiveHeaders,
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  response.write('retry: 250\nevent: ready\ndata: {}\n\n');
  response.write(`event: access\ndata: ${access}\n\n`);
  eventClients.add(response);
  const requestProject = url.searchParams.get('project');
  if (project && requestProject === project) {
    console.log('Diffsplain tab: connected');
  }
  response.once('close', () => eventClients.delete(response));
}

async function routeResponse(url) {
  if (url.pathname === '/health') return jsonResponse(readyState);
  if (url.pathname === '/diff-data.json') {
    if (!validAccess(url.searchParams.get('access'))) {
      return webResponse('Forbidden', { status: 403 });
    }
  }
  return fetchAsset(url);
}

function chatAccessError(url) {
  if (validAccess(url.searchParams.get('access'))) return undefined;
  return webResponse('Forbidden', { status: 403 });
}

function chatCommandError(error) {
  if (error instanceof ReviewChatError) {
    return { status: error.status, message: error.message };
  }
  return { status: 400, message: 'Chat command failed.' };
}

async function sendChatCommand(request, response) {
  try {
    const result = reviewChat.command(await chatRequestBody(request));
    const status = result.accepted ? 202 : 200;
    await send(response, jsonResponse(result.state, status));
  } catch (error) {
    logObservedError('chat-command', error);
    const failure = chatCommandError(error);
    await send(response, jsonResponse({ error: failure.message }, failure.status));
  }
}

async function handleChatRequest(request, response, url) {
  const accessError = chatAccessError(url);
  if (accessError) {
    await send(response, accessError);
    return;
  }
  if (request.method === 'GET') {
    await send(response, jsonResponse(reviewChat.getState()));
    return;
  }
  await sendChatCommand(request, response);
}

async function handleEventsRequest(_request, response, url) {
  await sendEvents(response, url);
}

function handlerFor(url) {
  return {
    '/events': handleEventsRequest,
    '/api/chat': handleChatRequest,
  }[url.pathname];
}

function throwForcedHandlerFailure(url) {
  if (forcedHandlerFailure(url)) throw new Error('forced request handler failure');
}

async function handleRoutedRequest(request, response, url) {
  const handler = handlerFor(url);
  if (handler) {
    await handler(request, response, url);
    return;
  }
  await send(response, await routeResponse(url));
}

async function handleRequest(request, response) {
  const context = requestContext(request);
  if (context.error) {
    await send(response, context.error);
    return;
  }
  throwForcedHandlerFailure(context.url);
  await handleRoutedRequest(request, response, context.url);
}

function stopWatchers() {
  unwatchFile(output);
  if (chatSnapshot !== output) unwatchFile(chatSnapshot);
}

function closeEventClients() {
  for (const client of eventClients) client.end();
  eventClients.clear();
}

function closeServer() {
  if (server.listening) server.close();
}

function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  process.exitCode = exitCode;
  stopWatchers();
  reviewChat.close();
  closeEventClients();
  closeServer();
}

async function containHandlerFailure(response) {
  try {
    if (response.headersSent) {
      response.end();
      return;
    }
    await send(
      response,
      webResponse('Internal server error', { status: 500 }),
    );
  } catch {
    response.destroy();
  }
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    logObservedError('request-handler', error);
    return containHandlerFailure(response);
  });
});

watchFile(output, { interval: 100 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
    return;
  }
  reviewChat.refresh();
  currentChatUsage(reviewChat.getState().fingerprint);
  broadcastEvent('update');
});

if (chatSnapshot !== output) {
  watchFile(chatSnapshot, { interval: 100 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
      return;
    }
    reviewChat.refresh();
  });
}

function urlFor(address, port) {
  const formattedAddress = address.includes(':') ? `[${address}]` : address;
  return `http://${formattedAddress}:${port}`;
}

function listen() {
  server.listen(selectedPort, host);
}

server.on('listening', () => {
  if (closing) {
    server.close();
    return;
  }
  const address = server.address();
  const readyAddress =
    address && typeof address === 'object' ? address.address : host;
  const readyPort =
    address && typeof address === 'object' ? address.port : selectedPort;
  const url = urlFor(host, readyPort);
  const fragment = new URLSearchParams({
    ...(project ? { project } : {}),
    access,
  });
  readyState = {
    status: 'ok',
    address: readyAddress,
    port: readyPort,
  };
  if (!isLoopback(readyAddress)) {
    console.warn(
      `Warning: Diffsplain is listening on ${readyAddress}. Review data still requires the per-run access value.`,
    );
  }
  console.log(`Diffsplain: ${url}#${fragment}`);
  console.log(JSON.stringify({ event: 'ready', ...readyState, url, access }));
});

server.on('error', (error) => {
  if (
    error.code === 'EADDRINUSE' &&
    incrementPort &&
    selectedPort > 0 &&
    selectedPort < 65_535
  ) {
    selectedPort += 1;
    listen();
    return;
  }
  const message =
    error.code === 'EADDRINUSE'
      ? `port ${selectedPort} is already in use`
      : error.message;
  console.error(`Could not start Diffsplain: ${message}`);
  close(1);
});

listen();

process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
