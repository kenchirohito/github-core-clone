// git smart HTTP: info/refs, upload-pack (protocol v2 and v0) and receive-pack (v0),
// with packfile generation and sideband framing. Node built-ins only.

import { Repo, Forge, VIEWER } from './store.ts';
import {
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
} from './gitobj.ts';
import type { GitObject } from './gitobj.ts';

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface GitContext {
  forge: Forge;
  baseUrl: string;
  /** The request path, e.g. /owner/repo.git/info/refs */
  path: string;
  method: string;
  /** Lower-cased request headers. */
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  requestId: string;
}

const PKT_MAX_PAYLOAD = 65520 - 4;

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function flush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function delim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function decodePktLines(buffer: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (length === 0 || length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    out.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return out;
}

function text(buffer: Buffer): string {
  return buffer.toString('utf8');
}

function jsonResponse(context: GitContext, status: number, body: unknown): GitResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-github-request-id': context.requestId },
    body: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

function advertisedRefs(repo: Repo): { name: string; oid: string; peeled?: string }[] {
  const refs: { name: string; oid: string; peeled?: string }[] = [];
  const heads = repo.heads();
  const main = heads.find((head) => head.name === repo.defaultBranch);
  if (main) refs.push({ name: 'HEAD', oid: main.oid });
  for (const head of heads) refs.push({ name: `refs/heads/${head.name}`, oid: head.oid });
  for (const tag of repo.tags()) refs.push({ name: `refs/tags/${tag.name}`, oid: tag.oid, peeled: tag.peeled });
  return refs;
}

function v0Advertisement(context: GitContext, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(pkt(`# service=${service}\n`));
  parts.push(flush());
  const refs = advertisedRefs(repo);
  const capabilities =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack ofs-delta multi_ack_detailed no-progress shallow symref=HEAD:refs/heads/main agent=forge/1.0'
      : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  if (refs.length === 0) {
    parts.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${capabilities}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = `${ref.oid} ${ref.name}`;
      if (index === 0) parts.push(pkt(`${line}\0${capabilities}\n`));
      else parts.push(pkt(`${line}\n`));
      if (ref.peeled && ref.peeled !== ref.oid) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(flush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [];
  parts.push(pkt('version 2\n'));
  parts.push(pkt('agent=forge/1.0\n'));
  parts.push(pkt('ls-refs\n'));
  parts.push(pkt('fetch=shallow filter\n'));
  parts.push(pkt('object-format=sha1\n'));
  parts.push(flush());
  return Buffer.concat(parts);
}

function refLines(repo: Repo, prefixes: string[]): Buffer[] {
  const refs = advertisedRefs(repo);
  const out: Buffer[] = [];
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (ref.peeled && ref.peeled !== ref.oid) line += ` peeled:${ref.peeled}`;
    out.push(pkt(`${line}\n`));
  }
  return out;
}

function sidebandChunk(data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([1]), data]);
  const header = Buffer.allocUnsafe(4);
  header.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function addTreeWithChildren(repo: Repo, treeOid: string, included: Set<string>): void {
  if (included.has(treeOid)) return;
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return;
  included.add(treeOid);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') addTreeWithChildren(repo, entry.oid, included);
    else if (entry.mode !== '160000') included.add(entry.oid);
  }
}

function objectsFor(repo: Repo, wants: string[], haves: string[], depth: number | null): { objects: GitObject[]; boundary: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const included = new Set<string>();
  const boundary: string[] = [];

  if (depth !== null) {
    let frontier = [...new Set(wants)].filter((oid) => repo.objects.get(oid)?.type === 'commit');
    const visited = new Set<string>();
    for (let generation = 0; generation < depth; generation += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (visited.has(oid)) continue;
        visited.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const commit = parseCommit(object.data);
        addTreeWithChildren(repo, commit.tree, included);
        for (const parent of commit.parents) {
          if (!visited.has(parent)) next.push(parent);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    for (const oid of visited) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit.parents.length === 0) continue;
      if (commit.parents.some((parent) => !visited.has(parent))) boundary.push(oid);
    }
    for (const oid of visited) included.add(oid);
  } else {
    const haveSet = haves.length > 0 ? collectReachable(haves, lookup) : new Set<string>();
    const wantSet = collectReachable(wants, lookup);
    for (const oid of wantSet) {
      if (haveSet.has(oid)) continue;
      included.add(oid);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, boundary };
}

function fetchV2(context: GitContext, repo: Repo, request: Buffer): Buffer {
  const lines = decodePktLines(request).map((line) => text(line).replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = '';
  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith('command=') || line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line.startsWith('filter ')) continue;
    else if (line === 'done') section = 'done';
    else if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    else if (line === 'deepen-since' || line === 'deepen-not') continue;
  }
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  parts.push(pkt('NAK\n'));
  parts.push(flush());
  const { objects, boundary } = objectsFor(repo, wants, haves, depth);
  if (depth !== null && boundary.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of boundary) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of shallow) {
      if (objects.some((object) => hashObject(object.type, object.data) === oid)) parts.push(pkt(`unshallow ${oid}\n`));
    }
    parts.push(flush());
  }
  if (objects.length > 0) {
    parts.push(pkt('packfile\n'));
    const pack = writePack(objects);
    for (let offset = 0; offset < pack.length; offset += PKT_MAX_PAYLOAD - 1) {
      parts.push(sidebandChunk(pack.subarray(offset, offset + PKT_MAX_PAYLOAD - 1)));
    }
    parts.push(flush());
  }
  return Buffer.concat(parts);
}

function fetchV0(context: GitContext, repo: Repo, request: Buffer): Buffer {
  const lines = decodePktLines(request).map((line) => text(line).replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const { objects, boundary } = objectsFor(repo, wants, haves, depth);
  const parts: Buffer[] = [];
  parts.push(pkt('NAK\n'));
  if (depth !== null) {
    for (const oid of boundary) parts.push(pkt(`shallow ${oid}\n`));
  }
  if (objects.length > 0) {
    const pack = writePack(objects);
    for (let offset = 0; offset < pack.length; offset += PKT_MAX_PAYLOAD - 1) {
      parts.push(sidebandChunk(pack.subarray(offset, offset + PKT_MAX_PAYLOAD - 1)));
    }
  }
  parts.push(flush());
  return Buffer.concat(parts);
}

interface Command {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isDescendant(repo: Repo, ancestor: string, candidate: string): boolean {
  const queue = [candidate];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

function receivePack(context: GitContext, repo: Repo, request: Buffer): Buffer {
  const lines = decodePktLines(request);
  const commands: Command[] = [];
  let sideband = false;
  for (const line of lines) {
    const raw = text(line);
    if (raw.includes('\0')) {
      const caps = raw.slice(raw.indexOf('\0') + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
    }
    if (raw === '') continue;
    const withoutCaps = raw.includes('\0') ? raw.slice(0, raw.indexOf('\0')) : raw;
    const cleaned = withoutCaps.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(cleaned);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  // Anything after the command-list flush is the packfile.
  let packStart = 0;
  let offset = 0;
  let flushes = 0;
  while (offset + 4 <= request.length && flushes < 1) {
    const length = Number.parseInt(request.subarray(offset, offset + 4).toString('ascii'), 16);
    if (length === 0) {
      flushes += 1;
      offset += 4;
      packStart = offset;
      break;
    }
    if (length < 4 || offset + length > request.length) break;
    offset += length;
  }
  const pack = request.subarray(packStart);
  if (pack.length > 0) {
    try {
      for (const object of readPack(pack).values()) repo.objects.set(hashObject(object.type, object.data), object);
    } catch {
      // A malformed pack is reported as an unpack failure below.
    }
  }
  const results: { command: Command; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = false;
    let reason = 'non-fast-forward';
    if (command.newOid === '0'.repeat(40)) {
      ok = current !== undefined && (command.oldOid === '0'.repeat(40) || current === command.oldOid);
      reason = ok ? '' : 'ref not found';
    } else if (command.oldOid === '0'.repeat(40)) {
      ok = current === undefined;
      reason = ok ? '' : 'ref already exists';
    } else if (current === command.oldOid && (command.newOid === command.oldOid || isDescendant(repo, command.oldOid, command.newOid))) {
      ok = true;
    }
    results.push({ command, ok, reason: ok ? '' : reason });
  }
  for (const result of results) {
    if (!result.ok) continue;
    if (result.command.newOid === '0'.repeat(40)) repo.refs.delete(result.command.ref);
    else repo.refs.set(result.command.ref, result.command.newOid);
  }
  const report: Buffer[] = [];
  report.push(pkt('unpack ok\n'));
  for (const result of results) {
    if (result.ok) report.push(pkt(`ok ${result.command.ref}\n`));
    else report.push(pkt(`ng ${result.command.ref} ${result.reason}\n`));
  }
  report.push(flush());
  const reportBytes = Buffer.concat(report);
  if (sideband) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < reportBytes.length; offset += PKT_MAX_PAYLOAD - 1) {
      parts.push(sidebandChunk(reportBytes.subarray(offset, offset + PKT_MAX_PAYLOAD - 1)));
    }
    return Buffer.concat(parts);
  }
  return reportBytes;
}

export function handleGit(context: GitContext): GitResponse {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(context.path);
  if (match === null) return jsonResponse(context, 404, { message: 'Not Found' });
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const service = match[3];
  const repo = context.forge.get(owner, name);
  if (repo === null) return jsonResponse(context, 404, { message: 'Not Found' });

  if (service === 'info/refs') {
    if (context.method !== 'GET') return jsonResponse(context, 405, { message: 'Method Not Allowed' });
    const wanted = service === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
    const protocol = String(context.headers['git-protocol'] ?? '');
    const isV2 = wanted === 'git-upload-pack' && /version=2/.test(protocol);
    const body = isV2 ? v2Advertisement() : v0Advertisement(context, repo, wanted as 'git-upload-pack' | 'git-receive-pack');
    return {
      status: 200,
      headers: {
        'content-type': `application/x-${wanted}-advertisement`,
        'cache-control': 'no-cache',
        'x-github-request-id': context.requestId,
      },
      body,
    };
  }

  if (context.method !== 'POST') return jsonResponse(context, 405, { message: 'Method Not Allowed' });

  if (service === 'git-upload-pack') {
    const body = fetchV2(context, repo, context.body);
    return {
      status: 200,
      headers: {
        'content-type': 'application/x-git-upload-pack-result',
        'cache-control': 'no-cache',
        'x-github-request-id': context.requestId,
      },
      body,
    };
  }

  const body = receivePack(context, repo, context.body);
  return {
    status: 200,
    headers: {
      'content-type': 'application/x-git-receive-pack-result',
      'cache-control': 'no-cache',
      'x-github-request-id': context.requestId,
    },
    body,
  };
}

export { VIEWER };
