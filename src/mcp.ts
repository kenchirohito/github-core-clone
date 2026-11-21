// Model Context Protocol over streamable HTTP: server/discover, initialize, tools/list, tools/call.
// The tools act on the same store as REST.

import { Forge, VIEWER } from './store.ts';
import { issueObject, pullObject, repoObject } from './store.ts';

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface McpContext {
  forge: Forge;
  token: string;
  bodyText: string;
  requestId: string;
}

const JSON_TYPE = 'application/json';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolSchema[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function reply(context: McpContext, status: number, body: unknown): McpResponse {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, 'x-github-request-id': context.requestId },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

function rpcResult(context: McpContext, id: string | number | null, result: unknown): McpResponse {
  return reply(context, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(context: McpContext, id: string | number | null, code: number, message: string): McpResponse {
  return reply(context, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function callTool(context: McpContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const forge = context.forge;
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repo = forge.get(owner, repoName);
  switch (name) {
    case 'create_repo': {
      const repoNameValue = typeof args.name === 'string' ? args.name : '';
      if (repoNameValue === '') throw new Error('name is required');
      const existing = forge.get(owner, repoNameValue);
      if (existing) throw new Error('repository already exists');
      const created = forge.createRepo(
        repoNameValue,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return {
        id: created.id,
        name: created.name,
        full_name: `${created.owner}/${created.name}`,
        owner: created.owner,
        private: created.private,
        description: created.description,
        default_branch: created.defaultBranch,
      };
    }
    case 'get_repo': {
      if (!repo) throw new Error('Not Found');
      return repoObject(repo);
    }
    case 'create_issue': {
      if (!repo) throw new Error('Not Found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') throw new Error('title is required');
      const number = repo.issueOrder.length + 1;
      const seq = repo.nextSeq();
      const issue = {
        id: `OID_I_${repo.id}_${number}`,
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [],
        seq,
      };
      repo.issues.set(number, issue);
      repo.issueOrder.push(number);
      return issueObject(repo, issue);
    }
    case 'list_issues': {
      if (!repo) throw new Error('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issueOrder
        .map((number) => repo.issues.get(number)!)
        .filter((issue) => issue !== undefined)
        .filter((issue) => state === 'all' || issue.state === state);
      return { issues: issues.map((issue) => issueObject(repo, issue)) };
    }
    case 'create_pull_request': {
      if (!repo) throw new Error('Not Found');
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headSha = repo.resolveBranch(head);
      const baseSha = repo.resolveBranch(base);
      if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
      const number = repo.pullOrder.length + 1;
      const seq = repo.nextSeq();
      const pull = {
        id: `OID_P_${repo.id}_${number}`,
        number,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        merged_at: null as string,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        mergeCommitSha: '',
        seq,
      };
      repo.pulls.set(number, pull);
      repo.pullOrder.push(number);
      return pullObject(repo, pull);
    }
    case 'merge_pull_request': {
      if (!repo) throw new Error('Not Found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error('Not Found');
      const baseTip = repo.resolveBranch(pull.baseRef) ?? pull.baseSha;
      const tree = repo.buildTreeFromFiles(repo.filesAt(pull.headRef));
      const { buildCommit, hashObject } = await import('./gitobj.ts') as typeof import('./gitobj.ts');
      const data = buildCommit({
        tree,
        parents: [baseTip],
        message: `Merge pull request #${pull.number} from ${pull.headRef}`,
        timestamp: repo.stamp(),
      });
      const oid = hashObject('commit', data);
      repo.objects.set(oid, { type: 'commit', data });
      repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = new Date((repo.createdAt + pull.seq) * 1000).toISOString();
      pull.mergeCommitSha = oid;
      return pullObject(repo, pull);
    }
    default:
      throw new Error('unknown tool');
  }
}

const REQUIRED: Record<string, string[]> = TOOLS.reduce<Record<string, string[]>>((acc, tool) => {
  acc[tool.name] = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
  return acc;
}, {});

export async function handleMcp(context: McpContext): Promise<McpResponse> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(context.bodyText) as JsonRpcRequest;
  } catch {
    return reply(context, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const method = request.method ?? '';
  const id = request.id ?? null;
  const params = request.params ?? {};

  if (method === 'server/discover') {
    return rpcResult(context, id, {
      resultType: 'discover',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
      instructions: 'A standalone GitHub-compatible forge.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const accepted = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(offered) ? offered : '2025-11-25';
    return rpcResult(context, id, {
      protocolVersion: accepted,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { status: 202, headers: { 'x-github-request-id': context.requestId }, body: Buffer.alloc(0) };
  }

  if (method === 'tools/list') {
    return rpcResult(context, id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      return rpcError(context, id, -32602, `Unknown tool: ${name}`);
    }
    const missing = (REQUIRED[tool.name] ?? []).filter((key) => args[key] === undefined || args[key] === null);
    if (missing.length > 0) {
      return rpcError(context, id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
    }
    try {
      const value = await callTool(context, name, args);
      return rpcResult(context, id, toolResult(value));
    } catch (error) {
      return rpcResult(context, id, {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      });
    }
  }

  return rpcError(context, id, -32601, `Method not found: ${method}`);
}
