/**
 * Focused behavioral tests for the backend foundation (task 2.4).
 *
 * Exercises the compiled application over real HTTP on an ephemeral port:
 * health endpoint, unknown-route JSON behavior, request logging (and its
 * security guarantees), the unexpected-error boundary, and clean shutdown.
 * Browser integration is out of scope (task 2.7).
 */

import http from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/server/index.js';
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

  it('rejects non-GET methods on the health route with the standard JSON 404', async () => {
    const server = await startServer();
    const res = await request(portOf(server), '/api/health', 'POST');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        code: 'FILE_NOT_FOUND',
        message: 'The requested API route was not found.',
        retryable: false,
        status: 404,
      },
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
