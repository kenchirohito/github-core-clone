// The forge's HTTP server: routing, bearer-token auth, JSON discipline and the four surfaces
// (git smart HTTP, REST v3, GraphQL v4, MCP).

import http from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest, type RestContext } from './src/rest.ts';
import { handleGit, type GitContext } from './src/githttp.ts';
import { handleMcp, type McpContext } from './src/mcp.ts';
import { executeGraphql } from './src/gql.ts';

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: http.ServerResponse, status: number, headers: Record<string, string>, body: Buffer | undefined, close = true): void {
  response.writeHead(status, close ? { connection: 'close', ...headers } : headers);
  if (body === undefined || body.length === 0) response.end();
  else response.end(body);
}

export function createApp(): http.Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let counter = 0;
  const nextRequestId = (): string => {
    counter += 1;
    return `forge-${counter.toString(36)}`;
  };

  return http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = (request.method ?? 'GET').toUpperCase();
      const requestId = nextRequestId();

      if (path === '/healthz') {
        send(response, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
        return;
      }

      const authorization = request.headers.authorization ?? '';
      if (token !== '' && authorization !== `Bearer ${token}`) {
        send(
          response,
          401,
          { 'content-type': 'application/json', 'x-github-request-id': requestId },
          Buffer.from(JSON.stringify({ message: 'Bad credentials' }), 'utf8'),
        );
        return;
      }

      const host = request.headers.host ?? 'localhost';
      const baseUrl = `http://${host}`;
      const body = await readBody(request);

      if (path === '/api/graphql') {
        let payload: unknown;
        try {
          payload = body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
        } catch {
          send(response, 400, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ message: 'Bad Request' })));
          return;
        }
        let result: unknown;
        if (Array.isArray(payload)) {
          result = payload.map((operation) => executeGraphql(forge, operation as { query: string; variables?: Record<string, unknown> }));
        } else {
          result = executeGraphql(forge, (payload ?? {}) as { query: string; variables?: Record<string, unknown> });
        }
        send(response, 200, { 'content-type': 'application/json', 'x-github-request-id': requestId }, Buffer.from(JSON.stringify(result), 'utf8'));
        return;
      }

      if (path === '/mcp') {
        const mcpContext: McpContext = { forge, token, bodyText: body.toString('utf8'), requestId };
        const result = await handleMcp(mcpContext);
        send(response, result.status, result.headers, result.body);
        return;
      }

      if (path.startsWith('/api/v3')) {
        let parsed: unknown;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            send(
              response,
              400,
              { 'content-type': 'application/json', 'x-github-request-id': requestId },
              Buffer.from(JSON.stringify({ message: 'Bad Request' }), 'utf8'),
            );
            return;
          }
        }
        const context: RestContext = {
          forge,
          baseUrl,
          path,
          query: url.searchParams,
          method,
          body: parsed,
          bodyText: body.toString('utf8'),
          requestId,
        };
        const result = handleRest(context);
        const headers = { ...result.headers };
        const payload = result.body === undefined ? undefined : Buffer.from(JSON.stringify(result.body), 'utf8');
        send(response, result.status, headers, payload);
        return;
      }

      const gitContext: GitContext = {
        forge,
        baseUrl,
        path,
        query: url.searchParams,
        method,
        headers: request.headers,
        body,
        requestId,
      };
      const result = handleGit(gitContext);
      // A sequential push is faster on a fresh socket; a concurrent clone benefits from a pooled one.
      const service = url.searchParams.get('service') ?? '';
      const close = service === 'git-receive-pack' || path.includes('git-receive-pack');
      send(response, result.status, result.headers, result.body, close);
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      send(
        response,
        500,
        { 'content-type': 'application/json', 'x-github-request-id': requestId },
        Buffer.from(JSON.stringify({ message }), 'utf8'),
      );
    });
  });
}
