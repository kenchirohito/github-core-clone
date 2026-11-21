// The forge's own store: repositories, refs, git objects, issues, pull requests.
// In-memory, deterministic: no clock, no randomness.

import {
  buildCommit,
  buildTag,
  buildTreeFromFiles,
  collectReachable,
  flattenTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
} from './gitobj.ts';
import type { GitObject, ObjType, TreeFiles } from './gitobj.ts';

/** The login the trial's bearer token names (the kit's seeded scenario viewer). */
export const VIEWER = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface Comment {
  id: string;
  body: string;
  seq: number;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeCommitSha: string;
  seq: number;
}

export class Repo {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
  private: boolean;
  description: string;
  readonly createdAt: number;
  defaultBranch = 'main';
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, { name: string; color: string }>();
  readonly issues = new Map<number, Issue>();
  readonly issueOrder: number[] = [];
  readonly pulls = new Map<number, Pull>();
  readonly pullOrder: number[] = [];
  readonly comments = new Map<number, Comment[]>();
  private seq = 0;

  constructor(owner: string, name: string, id: number, private_: boolean, description: string) {
    this.owner = owner;
    this.name = name;
    this.id = id;
    this.private = private_;
    this.description = description;
    this.createdAt = 1700000000 + id;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Deterministic commit timestamp: a fixed base plus this repository's sequence. */
  stamp(): number {
    return 1700000000 + this.seq;
  }

  lookup(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  ref(name: string): string | undefined {
    return this.refs.get(name);
  }

  resolveBranch(branch: string): string | undefined {
    const direct = this.refs.get(branch);
    if (direct) return direct;
    return this.refs.get(`refs/heads/${branch}`);
  }

  heads(): { name: string; oid: string }[] {
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of [...this.refs.entries()].sort()) {
      if (name.startsWith('refs/heads/')) out.push({ name: name.slice('refs/heads/'.length), oid });
    }
    return out;
  }

  tags(): { name: string; oid: string; peeled: string }[] {
    const out: { name: string; oid: string; peeled: string }[] = [];
    for (const [name, oid] of [...this.refs.entries()].sort()) {
      if (!name.startsWith('refs/tags/')) continue;
      const object = this.objects.get(oid);
      let peeled = oid;
      if (object && object.type === 'tag') peeled = parseTag(object.data).object;
      out.push({ name: name.slice('refs/tags/'.length), oid, peeled });
    }
    return out;
  }

  /** Commits reachable from a ref tip, newest first. */
  commits(from: string): { sha: string; message: string; author: string; committer: string }[] {
    const tip = this.resolveBranch(from);
    if (!tip) return [];
    const out: { sha: string; message: string; author: string; committer: string }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  filesAt(ref: string): TreeFiles {
    const tip = this.resolveBranch(ref);
    if (!tip) return new Map();
    const commit = this.objects.get(tip);
    if (!commit || commit.type !== 'commit') return new Map();
    return flattenTree((oid) => this.objects.get(oid), parseCommit(commit.data).tree);
  }

  /** Write a commit on a branch from a full file map; returns the commit id. */
  writeCommit(branch: string, files: TreeFiles, message: string, parents?: string[]): string {
    const tree = this.buildTreeFromFiles(files);
    const parentList = parents ?? [];
    const data = buildCommit({ tree, parents: parentList, message, timestamp: this.stamp() });
    const oid = hashObject('commit', data);
    this.objects.set(oid, { type: 'commit', data });
    const refName = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    this.refs.set(refName, oid);
    return oid;
  }

  /** Build (and store) a root tree from a flat path -> entry map. */
  buildTreeFromFiles(files: TreeFiles): string {
    return buildTreeFromFiles(files, this.objects);
  }

  /** The blob oid a path holds at a commit, or null. */
  contentAtCommit(commitOid: string, path: string): string | null {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    const files = flattenTree((oid) => this.objects.get(oid), parseCommit(object.data).tree);
    return files.get(path)?.oid ?? null;
  }

  /** The content blob for a path on a ref, or null. */
  contentAt(ref: string, path: string): { oid: string; data: Buffer } | null {
    const files = this.filesAt(ref);
    const entry = files.get(path);
    if (!entry) return null;
    const object = this.objects.get(entry.oid);
    if (!object || object.type !== 'blob') return null;
    return { oid: entry.oid, data: object.data };
  }

  putBlob(data: Buffer): string {
    const oid = hashObject('blob', data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type: 'blob', data });
    return oid;
  }

  /** Paths changed between two commits, with a coarse status. */
  changedPaths(fromOid: string, toOid: string): Map<string, 'added' | 'modified' | 'removed'> {
    const from = this.treeFilesAtCommit(fromOid);
    const to = this.treeFilesAtCommit(toOid);
    const out = new Map<string, 'added' | 'modified' | 'removed'>();
    for (const [path, entry] of to) {
      const before = from.get(path);
      if (!before) out.set(path, 'added');
      else if (before !== entry.oid) out.set(path, 'modified');
    }
    for (const path of from.keys()) {
      if (!to.has(path)) out.set(path, 'removed');
    }
    return out;
  }

  private treeFilesAtCommit(oid: string): TreeFiles {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return new Map();
    return flattenTree((candidate) => this.objects.get(candidate), parseCommit(object.data).tree);
  }

  /** The common ancestor of two commits, or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const queue = [a];
    while (queue.length) {
      const oid = queue.shift()!;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** Every object reachable from the given refs (for clone/pack). */
  reachable(tips: Iterable<string>): Set<string> {
    return collectReachable(tips, (oid) => this.objects.get(oid));
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, private_: boolean, description: string): Repo {
    const repo = new Repo(VIEWER, name, this.nextRepoId, private_, description);
    this.nextRepoId += 1;
    this.repos.set(this.key(VIEWER, name), repo);
    return repo;
  }

  get(owner: string, name: string): Repo | null {
    if (owner !== VIEWER) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  all(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

export function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date(repo.createdAt * 1000).toISOString(),
    updated_at: new Date(repo.createdAt * 1000).toISOString(),
    pushed_at: new Date(repo.createdAt * 1000).toISOString(),
    html_url: `/repos/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    archived: false,
    disabled: false,
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: Number(issue.id.replace(/[^0-9]/g, '').slice(-9)) || issue.number,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
    user: { login: VIEWER, id: 1000 },
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: new Date((repo.createdAt + issue.seq) * 1000).toISOString(),
    updated_at: new Date((repo.createdAt + issue.seq) * 1000).toISOString(),
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: Number(pull.id.replace(/[^0-9]/g, '').slice(-9)) || pull.number,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, repo: { name: repo.name, owner: { login: repo.owner } } },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: { name: repo.name, owner: { login: repo.owner } } },
    user: { login: VIEWER, id: 1000 },
    created_at: new Date((repo.createdAt + pull.seq) * 1000).toISOString(),
    updated_at: new Date((repo.createdAt + pull.seq) * 1000).toISOString(),
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentObject(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: Number(comment.id.replace(/[^0-9]/g, '').slice(-9)) || comment.seq,
    node_id: comment.id,
    body: comment.body,
    user: { login: VIEWER, id: 1000 },
    created_at: new Date((repo.createdAt + comment.seq) * 1000).toISOString(),
    updated_at: new Date((repo.createdAt + comment.seq) * 1000).toISOString(),
  };
}

export function globalRepoId(repo: Repo): string {
  return `OID_R_${repo.id}`;
}

export function globalIssueId(repo: Repo, issue: Issue): string {
  return `OID_I_${repo.id}_${issue.number}`;
}

export function globalPullId(repo: Repo, pull: Pull): string {
  return `OID_P_${repo.id}_${pull.number}`;
}

export function globalCommentId(repo: Repo, issueNumber: number, comment: Comment): string {
  return `OID_C_${repo.id}_${issueNumber}_${comment.seq}`;
}

export function makeIssueId(repo: Repo, number: number): string {
  return `OID_I_${repo.id}_${number}`;
}

export function makePullId(repo: Repo, number: number): string {
  return `OID_P_${repo.id}_${number}`;
}

export function makeCommentId(repo: Repo, issueNumber: number, seq: number): string {
  return `OID_C_${repo.id}_${issueNumber}_${seq}`;
}

export function isOid(value: string): boolean {
  return isObjectId(value);
}

export type { ObjType };
