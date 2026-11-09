/**
 * Focused behavioral tests for the backend foundation (task 2.4).
 *
 * These tests exercise the TypeScript application (`createApp` from
 * `src/server/index.ts`) over real HTTP on ephemeral ports, running under
 * vitest (tsx-transformed sources). They do NOT run the compiled server:
 * execution of the emitted `dist-server/` output (`npm run build:server`
 * followed by `npm start` / `node dist-server/server/index.js`) is verified
 * separately by smoke testing the compiled binary, including a clean SIGTERM
 * shutdown. Browser integration is out of scope (task 2.7).
 */

import http from 'node:http';
import net from 'node:net';
import type { Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, resolvePort } from '../../../src/server/index.js';
import { createLogger, resolveLogLevel } from '../../../src/server/middleware/logging.js';
import { sendUnexpectedError } from '../../../src/server/middleware/errorHandling.js';
import type { LogLevel } from '../../../src/server/middleware/logging.js';

let servers: Server[] = [];

async function startServer(logLevel?: LogLevel): Promise<Server> {
  const server = createApp(logLevel === undefined ? {} : { logLevel });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(server);
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server has no port');
  }
  return address.port;
}

interface ResponseInfo {
  status: number;
  body: string;
  contentType: string;
}

function request(
  port: number,
  path: string,
  method: 'GET' | 'POST' = 'GET',
): Promise<ResponseInfo> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { Connection: 'close' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: res.headers['content-type'] ?? '',
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Decode a chunked transfer-encoding body (the server sends chunked). */
function decodeChunked(raw: string): string {
  let rest = raw;
  let out = '';
  for (;;) {
    const lineEnd = rest.indexOf('\r\n');
    if (lineEnd === -1) break;
    const size = Number.parseInt(rest.slice(0, lineEnd), 16);
    if (Number.isNaN(size) || size === 0) break;
    const start = lineEnd + 2;
    out += rest.slice(start, start + size);
    rest = rest.slice(start + size + 2); // skip trailing CRLF of the chunk
  }
  return out;
}

/**
 * Send a raw HTTP request line, bypassing the client's own URL construction,
 * so genuinely malformed absolute-form targets reach the server handler.
 */
function rawRequest(port: number, target: string): Promise<ResponseInfo> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const fail = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    socket.on('error', fail);
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('latin1');
    });
    socket.on('close', () => {
      const headerEnd = data.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        reject(new Error('no response headers received'));
        return;
      }
      const head = data.slice(0, headerEnd);
      const status = Number(head.split('\r\n')[0].split(' ')[1]);
      const contentType = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? '';
      let body = data.slice(headerEnd + 4);
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        body = decodeChunked(body);
      }
      resolve({ status, body, contentType });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers = [];
  vi.restoreAllMocks();
});

describe('GET /api/health', () => {
  it('returns 200 with the exact { "status": "ok" } JSON body', async () => {
    const server = await startServer();
    const res = await request(portOf(server), '/api/health');
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('application/json');
    expect(res.body).toBe(JSON.stringify({ status: 'ok' }));
  });

  it('rejects state-changing methods on the health route with fail-closed 401', async () => {
    // Task 3.3 corrected boundary: every state-changing /api request makes
    // its authorization decision at the centralized boundary before route
    // dispatch. This harness runs without session storage, so POST
    // /api/health fails closed with the established 401 (previously it fell
    // through to the safe 404).
    const server = await startServer();
    const res = await request(portOf(server), '/api/health', 'POST');
    expect(res.status).toBe(401);
    expect(res.contentType).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Your session is no longer valid. Please sign in again.',
      retryable: false,
      status: 401,
    });
  });
});

describe('unknown routes', () => {
  it('returns the standard JSON 404 envelope for unknown /api/* routes', async () => {
    const server = await startServer();
    const res = await request(portOf(server), '/api/definitely/not/a/route');
    expect(res.status).toBe(404);
    expect(res.contentType).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: 'FILE_NOT_FOUND',
        message: 'The requested API route was not found.',
        retryable: false,
        status: 404,
      },
    });
  });

  it('returns a plain-text 404 for non-API paths', async () => {
    const server = await startServer();
    const res = await request(portOf(server), '/');
    expect(res.status).toBe(404);
    expect(res.contentType).toContain('text/plain');
    expect(res.body).toBe('Not Found');
  });
});

describe('malformed request target (URL parse failure)', () => {
  it('answers with the safe PATH_INVALID envelope and stays operational', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = await startServer();

    // Absolute-form target with an out-of-range port: a legal HTTP request
    // line that `new URL()` genuinely rejects (TypeError: Invalid URL).
    // Without the parse boundary this crashes the handler with an uncaught
    // exception; with it, the client gets the shared safe 422 envelope.
    const res = await rawRequest(portOf(server), 'http://x:99999/');
    expect(res.status).toBe(422);
    expect(res.contentType).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: 'PATH_INVALID',
        message: 'The requested path is not valid.',
        retryable: false,
        status: 422,
      },
    });
    expect(res.body).not.toContain('http://x:99999');
    expect(res.body).not.toContain('99999');

    // The server must remain fully operational after the parse failure.
    const health = await request(portOf(server), '/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toBe(JSON.stringify({ status: 'ok' }));

    // The request log line for the malformed target carries the fixed safe
    // marker — never the raw target, and no unhandled-error event.
    const lines = [...logSpy.mock.calls, ...errorSpy.mock.calls].map(
      (call) => String(call[0]),
    );
    const requestLine = lines.find((line) => line.includes('"event":"request"'));
    expect(requestLine).toBeDefined();
    const entry = JSON.parse(requestLine as string);
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('(unparseable)');
    expect(entry.status).toBe(422);
    const allLogged = lines.join('\n');
    expect(allLogged).not.toContain('http://x:99999');
    expect(allLogged).not.toContain('99999');
    expect(allLogged).not.toContain('unhandled_error');
  });
});

describe('PORT validation (resolvePort)', () => {
  it('accepts valid ports and rejects malformed values with null', () => {
    expect(resolvePort({})).toBe(3000);
    expect(resolvePort({ PORT: undefined })).toBe(3000);
    expect(resolvePort({ PORT: '' })).toBe(3000);
    expect(resolvePort({ PORT: '3999' })).toBe(3999);
    expect(resolvePort({ PORT: '1' })).toBe(1);
    expect(resolvePort({ PORT: '65535' })).toBe(65535);
    expect(resolvePort({ PORT: '3999abc' })).toBeNull();
    expect(resolvePort({ PORT: '0' })).toBeNull();
    expect(resolvePort({ PORT: '65536' })).toBeNull();
    expect(resolvePort({ PORT: '-1' })).toBeNull();
    expect(resolvePort({ PORT: '1e3' })).toBeNull();
    expect(resolvePort({ PORT: '+5' })).toBeNull();
    expect(resolvePort({ PORT: '1_000' })).toBeNull();
    expect(resolvePort({ PORT: 'abc' })).toBeNull();
  });
});

describe('request logging', () => {
  it('logs method, path, status, and duration — never the query string', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = await startServer();
    const res = await request(portOf(server), '/api/health?token=super-secret-value');
    expect(res.status).toBe(200);

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    const requestLine = lines.find((line) => line.includes('"event":"request"'));
    expect(requestLine).toBeDefined();
    const entry = JSON.parse(requestLine as string);
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/api/health');
    expect(entry.status).toBe(200);
    expect(typeof entry.durationMs).toBe('number');
    const allLogged = lines.join('\n');
    expect(allLogged).not.toContain('super-secret-value');
    expect(allLogged).not.toContain('token=');
  });

  it('emits no request logs when the log level is error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = await startServer('error');
    const res = await request(portOf(server), '/api/health');
    expect(res.status).toBe(200);
    const requestLines = logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('"event":"request"'));
    expect(requestLines).toHaveLength(0);
  });

  it('resolves LOG_LEVEL from the environment, defaulting to info', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'DEBUG' })).toBe('debug');
    expect(resolveLogLevel({ LOG_LEVEL: ' warn ' })).toBe('warn');
    expect(resolveLogLevel({ LOG_LEVEL: 'bogus' })).toBe('info');
    expect(resolveLogLevel({})).toBe('info');
  });
});

describe('unexpected error boundary', () => {
  it('responds with the safe INTERNAL_ERROR envelope without leaking details', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeHead = vi.fn();
    const end = vi.fn();
    const destroy = vi.fn();
    const res = {
      headersSent: false,
      statusCode: 0,
      writeHead,
      end,
      destroy,
    } as unknown as ServerResponse;

    sendUnexpectedError(res, createLogger('info'), new Error('secret token abc123'));

    expect(writeHead).toHaveBeenCalledWith(500, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    const body = JSON.parse(end.mock.calls[0]?.[0] as string);
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        retryable: false,
        status: 500,
      },
    });
    const clientVisible = end.mock.calls.map((call) => String(call[0])).join('\n');
    expect(clientVisible).not.toContain('secret token abc123');
    const serverVisible = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(serverVisible).not.toContain('secret token abc123');
    expect(serverVisible).toContain('"event":"unhandled_error"');
  });
});

describe('shutdown', () => {
  it('shuts down cleanly with no open connections', async () => {
    const server = await startServer();
    await request(portOf(server), '/api/health');
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    expect(server.listening).toBe(false);
  });
});
