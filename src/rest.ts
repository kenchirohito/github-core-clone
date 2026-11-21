// GitHub REST v3 surface: repositories, contents, branches, commits, issues, comments,
// labels, pull requests, files and merges.

import { Repo, Forge, VIEWER, VIEWER_NAME, VIEWER_EMAIL } from './store.ts';
import {
  commentObject,
  issueObject,
  makeCommentId,
  makeIssueId,
  makePullId,
  pullObject,
  repoObject,
} from './store.ts';
import { parseCommit, parseTag, parseTree, buildCommit, hashObject } from './gitobj.ts';

export interface Resp {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface RestContext {
  forge: Forge;
  baseUrl: string;
  path: string;
  query: URLSearchParams;
  method: string;
  body: unknown;
  bodyText: string;
  requestId: string;
}

const JSON_TYPE = 'application/json';

function reply(context: RestContext, status: number, body: unknown, headers: Record<string, string> = {}): Resp {
  return {
    status,
    headers: {
      'content-type': JSON_TYPE,
      'x-github-request-id': context.requestId,
      ...headers,
    },
    body,
  };
}

function error(context: RestContext, status: number, message: string): Resp {
  return reply(context, status, { message });
}

function empty(context: RestContext, status: number): Resp {
  return { status, headers: { 'x-github-request-id': context.requestId }, body: undefined };
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function b64encode(buffer: Buffer): string {
  return buffer.toString('base64');
}

/** The repository a path names, or an error response (404 for a foreign owner too). */
function repoOf(context: RestContext, owner: string, name: string): { repo: Repo } | { error: Resp } {
  const repo = context.forge.get(owner, name);
  if (repo === null) return { error: error(context, 404, 'Not Found') };
  return { repo };
}

function pagination(context: RestContext, items: unknown[]): Resp {
  const perPage = Number(context.query.get('per_page') ?? '30');
  const page = Number(context.query.get('page') ?? '1');
  const size = Number.isFinite(perPage) && perPage > 0 ? Math.min(Math.trunc(perPage), 100) : 30;
  const current = Number.isFinite(page) && page > 0 ? Math.trunc(page) : 1;
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const links: string[] = [];
  const build = (pageNumber: number): string => {
    const url = new URL(context.baseUrl + context.path);
    for (const [key, value] of context.query.entries()) url.searchParams.set(key, value);
    url.searchParams.set('per_page', String(size));
    url.searchParams.set('page', String(pageNumber));
    return url.toString();
  };
  if (current < totalPages) links.push(`<${build(current + 1)}>; rel="next"`);
  if (current < totalPages) links.push(`<${build(totalPages)}>; rel="last"`);
  if (current > 1) links.push(`<${build(1)}>; rel="first"`);
  if (current > 1) links.push(`<${build(current - 1)}>; rel="prev"`);
  const headers: Record<string, string> = {};
  if (links.length > 0) headers.link = links.join(', ');
  return reply(context, 200, slice, headers);
}

interface DirEntry {
  type: string;
  name: string;
  path: string;
  sha: string;
}

function listDirectory(repo: Repo, ref: string, path: string): DirEntry[] | null {
  const tip = repo.resolveBranch(ref);
  if (!tip) return null;
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  const segments = path === '' ? [] : path.split('/').filter((segment) => segment !== '');
  for (const segment of segments) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
    if (!entry) return null;
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return null;
  const entries: DirEntry[] = [];
  for (const entry of parseTree(tree.data)) {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    entries.push({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: childPath,
      sha: entry.oid,
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

function pullFiles(repo: Repo, baseOid: string, headOid: string): Record<string, unknown>[] {
  const changes = repo.changedPaths(baseOid, headOid);
  const files: Record<string, unknown>[] = [];
  for (const [path, status] of [...changes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const before = repo.objects.get(repo.contentAtCommit(baseOid, path)) as { data: Buffer } | undefined;
    const after = repo.objects.get(repo.contentAtCommit(headOid, path)) as { data: Buffer } | undefined;
    const beforeText = before ? before.data.toString('utf8') : '';
    const afterText = after ? after.data.toString('utf8') : '';
    const beforeLines = beforeText === '' ? [] : beforeText.split('\n');
    const afterLines = afterText === '' ? [] : afterText.split('\n');
    let additions = 0;
    let deletions = 0;
    if (status === 'added') additions = afterLines.length;
    else if (status === 'removed') deletions = beforeLines.length;
    else {
      const counts = new Map<string, number>();
      for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
      for (const line of afterLines) {
        const left = counts.get(line) ?? 0;
        if (left > 0) counts.set(line, left - 1);
        else additions += 1;
      }
      for (const left of counts.values()) deletions += left;
    }
    files.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return files;
}

function mergePull(context: RestContext, repo: Repo, number: number): Resp {
  const pull = repo.pulls.get(number);
  if (!pull) return error(context, 404, 'Not Found');
  const baseTip = repo.resolveBranch(pull.baseRef);
  const headTip = repo.resolveBranch(pull.headRef);
  if (!baseTip || !headTip) return error(context, 405, 'Pull Request is not mergeable');
  const base = repo.objects.get(baseTip);
  const head = repo.objects.get(headTip);
  if (!base || !head) return error(context, 405, 'Pull Request is not mergeable');
  const mergeBase = repo.mergeBase(headTip, baseTip);
  if (mergeBase !== null && mergeBase !== baseTip) {
    const headChanged = repo.changedPaths(mergeBase, headTip);
    const baseChanged = repo.changedPaths(mergeBase, baseTip);
    for (const path of headChanged.keys()) {
      if (baseChanged.has(path)) return error(context, 405, 'Pull Request is not mergeable');
    }
  }
  const files = repo.filesAt(pull.headRef);
  const treeFiles = new Map(files);
  const tree = repo.buildTreeFromFiles(treeFiles);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const data = buildCommit({
    tree,
    parents: [baseTip],
    message,
    timestamp: repo.stamp(),
  });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = new Date((repo.createdAt + pull.seq) * 1000).toISOString();
  pull.mergeCommitSha = oid;
  return reply(context, 200, { sha: oid, merged: true, message: 'Pull Request successfully merged' });
}

/** The REST v3 router. `context.body` is the parsed JSON body (undefined when none). */
export function handleRest(context: RestContext): Resp {
  const segments = context.path.replace(/^\/+|\/+$/g, '').split('/').filter((segment) => segment !== '');
  // /api/v3/...
  if (segments[0] !== 'api' || segments[1] !== 'v3') return error(context, 404, 'Not Found');
  const parts = segments.slice(2);
  const method = context.method;

  if (parts.length === 0) {
    if (method !== 'GET') return error(context, 405, 'Method Not Allowed');
    return reply(
      context,
      200,
      {
        current_user_url: `${context.baseUrl}/api/v3/user`,
        repository_url: `${context.baseUrl}/api/v3/repos/{owner}/{repo}`,
        user_url: `${context.baseUrl}/api/v3/users/{user}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (parts[0] === 'meta' && parts.length === 1) {
    if (method !== 'GET') return error(context, 405, 'Method Not Allowed');
    return reply(context, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  if (parts[0] === 'user') {
    if (parts.length === 1) {
      if (method !== 'GET') return error(context, 405, 'Method Not Allowed');
      return reply(context, 200, {
        login: VIEWER,
        id: 1000,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
      });
    }
    if (parts[1] === 'repos' && parts.length === 2) {
      if (method === 'POST') {
        const body = (context.body ?? {}) as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return error(context, 422, 'Validation Failed');
        if (context.forge.get(VIEWER, name) !== null) {
          return error(context, 422, 'name already exists on this account');
        }
        const repo = context.forge.createRepo(
          name,
          body.private === true,
          typeof body.description === 'string' ? body.description : '',
        );
        return reply(context, 201, repoObject(repo));
      }
      if (method === 'GET') {
        return pagination(context, context.forge.all().map(repoObject));
      }
      return error(context, 405, 'Method Not Allowed');
    }
    return error(context, 404, 'Not Found');
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = decodeURIComponent(parts[1]);
    const name = decodeURIComponent(parts[2]);
    const rest = parts.slice(3);
    const found = repoOf(context, owner, name);
    if ('error' in found) return found.error;
    const repo = found.repo;

    if (rest.length === 0) {
      if (method === 'GET') return reply(context, 200, repoObject(repo));
      if (method === 'PATCH') {
        const body = (context.body ?? {}) as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return reply(context, 200, repoObject(repo));
      }
      if (method === 'DELETE') {
        context.forge.repos.delete(context.forge.key(owner, name));
        return empty(context, 204);
      }
      return error(context, 405, 'Method Not Allowed');
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const body = (context.body ?? {}) as Record<string, unknown>;
        const refName = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (refName === '' || !/^[0-9a-f]{40}$/.test(sha)) return error(context, 422, 'Validation Failed');
        repo.refs.set(refName, sha);
        return reply(context, 201, { ref: refName, object: { sha, type: 'commit', url: '' } });
      }
      if (rest.length >= 3 && method === 'GET') {
        const refName = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(refName);
        if (!oid) return error(context, 404, 'Not Found');
        return reply(context, 200, { ref: refName, object: { sha: oid, type: 'commit', url: '' } });
      }
      return error(context, 404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        return reply(
          context,
          200,
          repo.heads().map((head) => ({
            name: head.name,
            commit: { sha: head.oid, url: '' },
            protected: false,
          })),
        );
      }
      if (rest.length === 2 && method === 'GET') {
        const oid = repo.resolveBranch(decodeURIComponent(rest[1]));
        if (!oid) return error(context, 404, 'Not Found');
        return reply(context, 200, {
          name: decodeURIComponent(rest[1]),
          commit: { sha: oid, url: '' },
          protected: false,
        });
      }
      return error(context, 404, 'Not Found');
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = context.query.get('sha') ?? repo.defaultBranch;
      const commits = repo.commits(ref);
      return reply(
        context,
        200,
        commits.map((commit) => ({
          sha: commit.sha,
          commit: {
            message: commit.message.replace(/\n$/, ''),
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(1700000000 * 1000).toISOString() },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(1700000000 * 1000).toISOString() },
          },
          author: { login: VIEWER, id: 1000 },
          committer: { login: VIEWER, id: 1000 },
        })),
      );
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'PUT') return putContents(context, repo, path);
      if (method === 'GET') {
        const ref = context.query.get('ref') ?? repo.defaultBranch;
        const entry = repo.contentAt(ref, path);
        if (entry !== null) {
          return reply(context, 200, {
            type: 'file',
            encoding: 'base64',
            content: b64encode(entry.data),
            sha: entry.oid,
            size: entry.data.length,
            name: path.split('/').pop() ?? path,
            path,
          });
        }
        const listing = listDirectory(repo, ref, path);
        if (listing !== null) return reply(context, 200, listing);
        return error(context, 404, 'Not Found');
      }
      if (method === 'DELETE') {
        const body = (context.body ?? {}) as Record<string, unknown>;
        const ref = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const files = repo.filesAt(ref);
        const current = files.get(path);
        if (!current) return error(context, 404, 'Not Found');
        if (typeof body.sha === 'string' && body.sha !== current.oid) {
          return error(context, 409, 'SHA mismatch');
        }
        files.delete(path);
        const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
        const oid = repo.writeCommit(ref, files, message, repo.resolveBranch(ref) ? [repo.resolveBranch(ref)!] : []);
        return reply(context, 200, { content: null, commit: { sha: oid } });
      }
      return error(context, 405, 'Method Not Allowed');
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') {
        const body = (context.body ?? {}) as Record<string, unknown>;
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') return error(context, 422, 'Validation Failed');
        repo.labels.set(labelName, { name: labelName, color: typeof body.color === 'string' ? body.color : 'ededed' });
        return reply(context, 201, { name: labelName, color: typeof body.color === 'string' ? body.color : 'ededed' });
      }
      if (rest.length === 1 && method === 'GET') {
        return reply(context, 200, [...repo.labels.values()]);
      }
      return error(context, 404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = (context.body ?? {}) as Record<string, unknown>;
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return error(context, 422, 'Validation Failed');
          const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) return error(context, 422, 'Validation Failed');
          }
          const number = repo.issueOrder.length + 1;
          const seq = repo.nextSeq();
          const issue = {
            id: makeIssueId(repo, number),
            number,
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open' as const,
            labels,
            seq,
          };
          repo.issues.set(number, issue);
          repo.issueOrder.push(number);
          return reply(context, 201, issueObject(repo, issue));
        }
        if (method === 'GET') {
          const state = context.query.get('state') ?? 'open';
          const direction = context.query.get('direction') ?? 'desc';
          let issues = repo.issueOrder.map((number) => repo.issues.get(number)!).filter((issue) => issue !== undefined);
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const sorted = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          return pagination(context, sorted.map((issue) => issueObject(repo, issue)));
        }
        return error(context, 405, 'Method Not Allowed');
      }
      const number = Number(rest[1]);
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (method === 'GET') {
          if (!issue) return error(context, 404, 'Not Found');
          return reply(context, 200, issueObject(repo, issue));
        }
        if (method === 'PATCH') {
          if (!issue) return error(context, 404, 'Not Found');
          const body = (context.body ?? {}) as Record<string, unknown>;
          if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return reply(context, 200, issueObject(repo, issue));
        }
        return error(context, 405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(number);
        if (!issue) return error(context, 404, 'Not Found');
        if (method === 'POST') {
          const body = (context.body ?? {}) as Record<string, unknown>;
          const seq = repo.nextSeq();
          const comment = {
            id: makeCommentId(repo, number, seq),
            body: typeof body.body === 'string' ? body.body : '',
            seq,
          };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          return reply(context, 201, commentObject(repo, number, comment));
        }
        if (method === 'GET') {
          const list = repo.comments.get(number) ?? [];
          return reply(context, 200, list.map((comment) => commentObject(repo, number, comment)));
        }
        return error(context, 405, 'Method Not Allowed');
      }
      return error(context, 404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = (context.body ?? {}) as Record<string, unknown>;
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : '';
          const headSha = repo.resolveBranch(head);
          const baseSha = repo.resolveBranch(base);
          if (!headSha || !baseSha) return error(context, 422, 'Validation Failed');
          const existing = repo.pullOrder
            .map((candidate) => repo.pulls.get(candidate)!)
            .find((candidate) => candidate.headRef === head && candidate.state === 'open');
          if (existing) return error(context, 422, 'A pull request already exists for this branch');
          const number = repo.pullOrder.length + 1;
          const seq = repo.nextSeq();
          const pull = {
            id: makePullId(repo, number),
            number,
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
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
          return reply(context, 201, pullObject(repo, pull));
        }
        if (method === 'GET') {
          const state = context.query.get('state') ?? 'open';
          let pulls = repo.pullOrder.map((candidate) => repo.pulls.get(candidate)!).filter((pull) => pull !== undefined);
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          return pagination(context, pulls.map((pull) => pullObject(repo, pull)));
        }
        return error(context, 405, 'Method Not Allowed');
      }
      const number = Number(rest[1]);
      const pull = repo.pulls.get(number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return error(context, 404, 'Not Found');
          return reply(context, 200, pullObject(repo, pull));
        }
        return error(context, 405, 'Method Not Allowed');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return error(context, 404, 'Not Found');
        return reply(context, 200, pullFiles(repo, pull.baseSha, pull.headSha));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        return mergePull(context, repo, number);
      }
      return error(context, 404, 'Not Found');
    }

    return error(context, 404, 'Not Found');
  }

  return error(context, 404, 'Not Found');
}

function putContents(context: RestContext, repo: Repo, path: string): Resp {
  const body = (context.body ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const ref = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const content = typeof body.content === 'string' ? b64decode(body.content) : Buffer.alloc(0);
  const files = repo.filesAt(ref);
  const existed = files.has(path);
  if (typeof body.sha === 'string') {
    const current = files.get(path);
    if (!current || current.oid !== body.sha) return error(context, 409, 'SHA mismatch');
  }
  const blobOid = repo.putBlob(content);
  files.set(path, { mode: '100644', oid: blobOid });
  const parent = repo.resolveBranch(ref);
  const oid = repo.writeCommit(ref, files, message, parent ? [parent] : []);
  return reply(context, existed || typeof body.sha === 'string' ? 200 : 201, {
    content: {
      type: 'file',
      encoding: 'base64',
      content: b64encode(content),
      sha: blobOid,
      size: content.length,
      name: path.split('/').pop() ?? path,
      path,
    },
    commit: { sha: oid },
  });
}
