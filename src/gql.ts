// A small GraphQL v4 executor for the documents gh and github-mcp-server send:
// a hand-written parser (operations, variables, arguments, aliases, inline fragments)
// over a resolver map. Unknown fields are GraphQL errors, not HTTP errors.

import { Forge, Repo, VIEWER } from './store.ts';
import {
  globalIssueId,
  globalPullId,
  globalRepoId,
  issueObject,
  makeIssueId,
  makePullId,
  pullObject,
} from './store.ts';
import { buildCommit, hashObject } from './gitobj.ts';

// ---------------------------------------------------------------- parser

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface ValueNode {
  kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  value?: unknown;
  values?: ValueNode[];
  fields?: { name: string; value: ValueNode }[];
}

interface FieldNode {
  alias?: string;
  name: string;
  args: ArgumentNode[];
  selections: SelectionNode[];
}

type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; type?: string; selections: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; type: string }[];
  selections: SelectionNode[];
}

class Parser {
  private offset = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private peek(): string {
    return this.text[this.offset] ?? '';
  }

  private skip(): void {
    while (this.offset < this.text.length) {
      const character = this.text[this.offset];
      if (character === undefined) return;
      if (/\s|,/.test(character)) {
        this.offset += 1;
        continue;
      }
      if (character === '#') {
        while (this.offset < this.text.length && this.text[this.offset] !== '\n') this.offset += 1;
        continue;
      }
      return;
    }
  }

  private expect(character: string): void {
    this.skip();
    if (this.peek() !== character) throw new Error(`expected ${character} at ${this.offset}`);
    this.offset += 1;
  }

  private name(): string {
    this.skip();
    const start = this.offset;
    while (this.offset < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.offset] ?? '')) this.offset += 1;
    if (this.offset === start) throw new Error(`expected a name at ${this.offset}`);
    return this.text.slice(start, this.offset);
  }

  private isName(token: string): boolean {
    this.skip();
    if (!/^[A-Za-z_]/.test(this.peek())) return false;
    const start = this.offset;
    let end = start;
    while (end < this.text.length && /[A-Za-z0-9_]/.test(this.text[end] ?? '')) end += 1;
    return this.text.slice(start, end) === token;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    for (;;) {
      this.skip();
      if (this.offset >= this.text.length) break;
      if (this.isName('query') || this.isName('mutation')) {
        const kind = this.isName('mutation') ? 'mutation' : 'query';
        this.name();
        let operationName: string | undefined;
        this.skip();
        if (/^[A-Za-z_]/.test(this.peek())) operationName = this.name();
        const variables: { name: string; type: string }[] = [];
        this.skip();
        if (this.peek() === '(') {
          this.expect('(');
          for (;;) {
            this.skip();
            if (this.peek() === ')') {
              this.offset += 1;
              break;
            }
            this.expect('$');
            const variableName = this.name();
            this.expect(':');
            const type = this.typeRef();
            this.skip();
            if (this.peek() === '=') {
              this.offset += 1;
              this.value();
            }
            variables.push({ name: variableName, type });
            this.skip();
            if (this.peek() === ',') this.offset += 1;
          }
        }
        const selections = this.selectionSet();
        operations.push({ kind, name: operationName, variables, selections });
      } else {
        const selections = this.selectionSet();
        operations.push({ kind: 'query', variables: [], selections });
      }
    }
    return operations;
  }

  private typeRef(): string {
    this.skip();
    let out = '';
    if (this.peek() === '[') {
      this.offset += 1;
      out = `[${this.typeRef()}]`;
      this.skip();
      if (this.peek() === ']') this.offset += 1;
    } else {
      out = this.name();
    }
    this.skip();
    if (this.peek() === '!') {
      this.offset += 1;
      out += '!';
    }
    return out;
  }

  private selectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      this.skip();
      const character = this.peek();
      if (character === '}') {
        this.offset += 1;
        break;
      }
      if (character === '') throw new Error('unterminated selection set');
      if (this.text.startsWith('...', this.offset)) {
        this.offset += 3;
        this.skip();
        let type: string | undefined;
        if (this.isName('on')) {
          this.name();
          type = this.name();
          this.skip();
        }
        const fragmentSelections = this.selectionSet();
        selections.push({ kind: 'fragment', type, selections: fragmentSelections });
        continue;
      }
      const first = this.name();
      this.skip();
      let alias: string | undefined;
      let fieldName = first;
      if (this.peek() === ':') {
        this.offset += 1;
        alias = first;
        fieldName = this.name();
      }
      const args: ArgumentNode[] = [];
      this.skip();
      if (this.peek() === '(') {
        this.expect('(');
        for (;;) {
          this.skip();
          if (this.peek() === ')') {
            this.offset += 1;
            break;
          }
          const argumentName = this.name();
          this.expect(':');
          args.push({ name: argumentName, value: this.value() });
          this.skip();
          if (this.peek() === ',') this.offset += 1;
        }
      }
      this.skip();
      let fieldSelections: SelectionNode[] = [];
      if (this.peek() === '{') fieldSelections = this.selectionSet();
      selections.push({ kind: 'field', field: { alias, name: fieldName, args, selections: fieldSelections } });
    }
    return selections;
  }

  private value(): ValueNode {
    this.skip();
    const character = this.peek();
    if (character === '$') {
      this.offset += 1;
      return { kind: 'variable', value: this.name() };
    }
    if (character === '"') {
      return { kind: 'string', value: this.string() };
    }
    if (character === '[') {
      this.offset += 1;
      const values: ValueNode[] = [];
      for (;;) {
        this.skip();
        if (this.peek() === ']') {
          this.offset += 1;
          break;
        }
        if (this.peek() === '') throw new Error('unterminated list');
        values.push(this.value());
      }
      return { kind: 'list', values };
    }
    if (character === '{') {
      this.offset += 1;
      const fields: { name: string; value: ValueNode }[] = [];
      for (;;) {
        this.skip();
        if (this.peek() === '}') {
          this.offset += 1;
          break;
        }
        if (this.peek() === '') throw new Error('unterminated object');
        const fieldName = this.name();
        this.expect(':');
        fields.push({ name: fieldName, value: this.value() });
      }
      return { kind: 'object', fields };
    }
    const start = this.offset;
    while (this.offset < this.text.length && /[0-9.eE+-]/.test(this.text[this.offset] ?? '')) this.offset += 1;
    if (this.offset > start) {
      const text = this.text.slice(start, this.offset);
      return text.includes('.') || text.includes('e') || text.includes('E')
        ? { kind: 'float', value: Number(text) }
        : { kind: 'int', value: Number(text) };
    }
    const word = this.name();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null', value: null };
    return { kind: 'enum', value: word };
  }

  private string(): string {
    this.expect('"');
    let out = '';
    while (this.offset < this.text.length) {
      const character = this.text[this.offset];
      this.offset += 1;
      if (character === '"') break;
      if (character === '\\') {
        const escaped = this.text[this.offset];
        this.offset += 1;
        if (escaped === 'n') out += '\n';
        else if (escaped === 't') out += '\t';
        else if (escaped === '"') out += '"';
        else if (escaped === '\\') out += '\\';
        else out += escaped ?? '';
        continue;
      }
      out += character ?? '';
    }
    return out;
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.value as string];
    case 'list':
      return (node.values ?? []).map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    case 'null':
      return null;
    default:
      return node.value;
  }
}

// ---------------------------------------------------------------- schema metadata

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments', 'createdAt', 'updatedAt',
    'closedAt', 'assignees', 'reactionGroups', 'projectCards', 'milestone', 'repository',
  ],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body',
    'url', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'headRefOid', 'baseRefOid', 'isDraft', 'author',
    'labels', 'comments', 'reviews', 'commits', 'timelineItems', 'repository', 'viewerCanUpdate',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate',
    'isEmpty', 'isFork', 'isArchived', 'isTemplate', 'createdAt', 'updatedAt', 'pushedAt', 'licenseInfo',
    'primaryLanguage', 'stargazerCount', 'watcherCount', 'forkCount', 'openGraphImageUrl',
    'usesCustomOpenGraphImage', 'interactionAbility', 'viewerCanAdminister', 'viewerCanCreateProjects',
    'viewerCanSubscribe', 'viewerHasStarred', 'viewerSubscription',
  ],
  User: ['login', 'id', 'name', 'email', 'url', 'avatarUrl', 'bio', 'company', 'location', 'websiteUrl'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  Ref: ['name', 'prefix'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'PULL_REQUEST', 'CODE', 'COMMIT', 'TOPIC', 'ORGANIZATION', 'MARKETPLACE_LISTING', 'PACKAGE', 'PROJECT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

// ---------------------------------------------------------------- resolvers

class GraphQLError extends Error {}

interface ResolveCtx {
  forge: Forge;
  variables: Record<string, unknown>;
}

type Resolver = (ctx: ResolveCtx, args: Record<string, unknown>, sub: unknown) => unknown;

function repoNode(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', __repo: repo };
}

function issueNode(repo: Repo, number: number): Record<string, unknown> | null {
  const issue = repo.issues.get(number);
  if (!issue) return null;
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullNode(repo: Repo, number: number): Record<string, unknown> | null {
  const pull = repo.pulls.get(number);
  if (!pull) return null;
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function findRepoByGlobalId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const match = /^OID_R_(\d+)$/.exec(id);
  if (!match) return null;
  for (const repo of forge.all()) if (repo.id === Number(match[1])) return repo;
  return null;
}

function findIssueByGlobalId(forge: Forge, id: unknown): { repo: Repo; issue: { number: number } } | null {
  if (typeof id !== 'string') return null;
  const match = /^OID_I_(\d+)_(\d+)$/.exec(id);
  if (!match) return null;
  for (const repo of forge.all()) {
    if (repo.id !== Number(match[1])) continue;
    const issue = repo.issues.get(Number(match[2]));
    if (issue) return { repo, issue };
  }
  return null;
}

function cursorEncode(repo: Repo, number: number): string {
  return Buffer.from(`cursor:${repo.id}:${number}`).toString('base64');
}

function cursorDecode(repo: Repo, cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+):(\d+)$/.exec(text);
    if (!match) return null;
    if (Number(match[1]) !== repo.id) return null;
    return Number(match[2]);
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : 20;
  let issues = repo.issueOrder.map((number) => repo.issues.get(number)!).filter((issue) => issue !== undefined);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states) issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
  const after = cursorDecode(repo, args.after);
  let start = 0;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    start = index >= 0 ? index + 1 : 0;
  }
  const slice = issues.slice(start, start + first);
  const hasNextPage = start + first < issues.length;
  const last = slice[slice.length - 1];
  return {
    __typename: 'IssueConnection',
    nodes: slice.map((issue) => issueNode(repo, issue.number)!),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorEncode(repo, slice[0]!.number) : null,
      endCursor: last ? cursorEncode(repo, last.number) : null,
    },
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : 20;
  let pulls = repo.pullOrder.map((number) => repo.pulls.get(number)!).filter((pull) => pull !== undefined);
  pulls = pulls.filter((pull) => pull.state === 'open');
  const slice = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: slice.map((pull) => pullNode(repo, pull.number)!),
    pageInfo: { __typename: 'PageInfo', hasNextPage: first < pulls.length, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

function typeNode(name: string): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[name];
  if (fields) {
    return {
      __typename: '__Type',
      name,
      kind: name.startsWith('__') ? 'OBJECT' : 'OBJECT',
      fields: fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
      enumValues: null,
    };
  }
  const enumValues = TYPE_ENUMS[name];
  if (enumValues) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: enumValues.map((value) => ({ __typename: '__EnumValue', name: value })),
    };
  }
  return null;
}

const RESOLVERS: Record<string, Resolver> = {
  'Query.viewer': (ctx) => ({ __typename: 'User', __login: VIEWER }),
  'Query.repository': (ctx, args) => {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const name = typeof args.name === 'string' ? args.name : '';
    const repo = ctx.forge.get(owner, name);
    return repo ? repoNode(repo) : null;
  },
  'Query.node': (ctx, args) => {
    const repo = findRepoByGlobalId(ctx.forge, args.id);
    if (repo) return repoNode(repo);
    const issue = findIssueByGlobalId(ctx.forge, args.id);
    if (issue) return issueNode(issue.repo, issue.issue.number);
    if (typeof args.id === 'string' && /^OID_P_/.test(args.id)) {
      const match = /^OID_P_(\d+)_(\d+)$/.exec(args.id);
      if (match) {
        for (const candidate of ctx.forge.all()) {
          if (candidate.id !== Number(match[1])) continue;
          const pull = candidate.pulls.get(Number(match[2]));
          if (pull) return pullNode(candidate, pull.number);
        }
      }
    }
    return null;
  },
  'Query.__type': (_ctx, args) => (typeof args.name === 'string' ? typeNode(args.name) : null),
  '__Type.name': (_ctx, args, sub) => {
    const node = sub as Record<string, unknown>;
    return node?.name ?? null;
  },
  '__Type.fields': (_ctx, args, sub) => {
    const node = sub as Record<string, unknown>;
    const includeDeprecated = args.includeDeprecated !== false;
    if (!node || !Array.isArray(node.fields)) return null;
    return includeDeprecated ? node.fields : node.fields;
  },
  '__Type.enumValues': (_ctx, args, sub) => {
    const node = sub as Record<string, unknown>;
    const includeDeprecated = args.includeDeprecated !== false;
    if (!node || !Array.isArray(node.enumValues)) return null;
    return includeDeprecated ? node.enumValues : node.enumValues;
  },
  '__Field.name': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.name ?? null,
  '__EnumValue.name': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.name ?? null,
  'User.login': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.__login ?? VIEWER,
  'User.id': () => 1000,
  'User.name': () => 'ada iversen',
  'User.email': () => 'adaiversen@example.invalid',
  'User.url': () => '',
  'User.avatarUrl': () => '',
  'User.bio': () => null,
  'User.company': () => null,
  'User.location': () => null,
  'User.websiteUrl': () => null,

  'Repository.id': (_ctx, _args, sub) => {
    const repo = (sub as Record<string, unknown>).__repo as Repo;
    return globalRepoId(repo);
  },
  'Repository.databaseId': (_ctx, _args, sub) => ((sub as Record<string, unknown>).__repo as Repo).id,
  'Repository.name': (_ctx, _args, sub) => ((sub as Record<string, unknown>).__repo as Repo).name,
  'Repository.nameWithOwner': (_ctx, _args, sub) => {
    const repo = (sub as Record<string, unknown>).__repo as Repo;
    return `${repo.owner}/${repo.name}`;
  },
  'Repository.owner': (_ctx, _args, sub) => ({ __typename: 'User', __login: ((sub as Record<string, unknown>).__repo as Repo).owner }),
  'Repository.defaultBranchRef': (_ctx, _args, sub) => {
    const repo = (sub as Record<string, unknown>).__repo as Repo;
    if (!repo.resolveBranch(repo.defaultBranch)) return null;
    return { __typename: 'Ref', name: repo.defaultBranch };
  },
  'Ref.name': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.name ?? null,
  'Repository.viewerPermission': () => 'ADMIN',
  'Repository.hasIssuesEnabled': () => true,
  'Repository.issue': (_ctx, args, sub) => {
    const repo = (sub as Record<string, unknown>).__repo as Repo;
    return issueNode(repo, Number(args.number));
  },
  'Repository.issues': (_ctx, args, sub) => issueConnection((sub as Record<string, unknown>).__repo as Repo, args),
  'IssueConnection.nodes': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.nodes ?? [],
  'IssueConnection.pageInfo': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.pageInfo ?? null,
  'IssueConnection.totalCount': (_ctx, _args, sub) => {
    const node = sub as Record<string, unknown>;
    return Array.isArray(node?.nodes) ? node.nodes.length : 0;
  },
  'PullRequestConnection.nodes': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.nodes ?? [],
  'PullRequestConnection.pageInfo': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.pageInfo ?? null,
  'PullRequestConnection.totalCount': (_ctx, _args, sub) => {
    const node = sub as Record<string, unknown>;
    return Array.isArray(node?.nodes) ? node.nodes.length : 0;
  },
  'PullRequestFilesConnection.nodes': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.nodes ?? [],
  'PullRequestFilesConnection.pageInfo': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.pageInfo ?? null,
  'PullRequestFilesConnection.totalCount': (_ctx, _args, sub) => {
    const node = sub as Record<string, unknown>;
    return Array.isArray(node?.nodes) ? node.nodes.length : 0;
  },
  'PageInfo.hasNextPage': (_ctx, _args, sub) => Boolean((sub as Record<string, unknown>)?.hasNextPage),
  'PageInfo.hasPreviousPage': (_ctx, _args, sub) => Boolean((sub as Record<string, unknown>)?.hasPreviousPage),
  'PageInfo.startCursor': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.startCursor ?? null,
  'PageInfo.endCursor': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.endCursor ?? null,
  'Repository.pullRequests': (_ctx, args, sub) => pullConnection((sub as Record<string, unknown>).__repo as Repo, args),
  'Repository.pullRequest': (_ctx, args, sub) => pullNode((sub as Record<string, unknown>).__repo as Repo, Number(args.number)),
  'Repository.url': () => '',
  'Repository.description': (_ctx, _args, sub) => ((sub as Record<string, unknown>).__repo as Repo).description,
  'Repository.isPrivate': (_ctx, _args, sub) => ((sub as Record<string, unknown>).__repo as Repo).private,
  'Repository.isEmpty': (_ctx, _args, sub) => ((sub as Record<string, unknown>).__repo as Repo).heads().length === 0,
  'Repository.isFork': () => false,
  'Repository.isArchived': () => false,
  'Repository.isTemplate': () => false,
  'Repository.createdAt': () => null,
  'Repository.updatedAt': () => null,
  'Repository.pushedAt': () => null,
  'Repository.licenseInfo': () => null,
  'Repository.primaryLanguage': () => null,
  'Repository.stargazerCount': () => 0,
  'Repository.watcherCount': () => 0,
  'Repository.forkCount': () => 0,
  'Repository.openGraphImageUrl': () => '',
  'Repository.usesCustomOpenGraphImage': () => false,
  'Repository.interactionAbility': () => null,
  'Repository.viewerCanAdminister': () => true,
  'Repository.viewerCanCreateProjects': () => true,
  'Repository.viewerCanSubscribe': () => true,
  'Repository.viewerHasStarred': () => false,
  'Repository.viewerSubscription': () => null,

  'Issue.id': (_ctx, _args, sub) => {
    const node = sub as Record<string, unknown>;
    return globalIssueId(node.__repo as Repo, node.__issue as { number: number });
  },
  'Issue.number': (_ctx, _args, sub) => (sub as Record<string, unknown>).__issue.number,
  'Issue.title': (_ctx, _args, sub) => (sub as Record<string, unknown>).__issue.title,
  'Issue.body': (_ctx, _args, sub) => (sub as Record<string, unknown>).__issue.body,
  'Issue.state': (_ctx, _args, sub) => ((sub as Record<string, unknown>).__issue.state === 'open' ? 'OPEN' : 'CLOSED'),
  'Issue.url': () => '',
  'Issue.author': () => ({ __typename: 'User', __login: VIEWER }),
  'Issue.labels': () => [],
  'Issue.comments': () => [],
  'Issue.createdAt': () => null,
  'Issue.updatedAt': () => null,
  'Issue.closedAt': () => null,
  'Issue.assignees': () => [],
  'Issue.reactionGroups': () => [],
  'Issue.projectCards': () => [],
  'Issue.milestone': () => null,
  'Issue.repository': (_ctx, _args, sub) => repoNode((sub as Record<string, unknown>).__repo as Repo),

  'PullRequest.id': (_ctx, _args, sub) => globalPullId((sub as Record<string, unknown>).__repo as Repo, (sub as Record<string, unknown>).__pull as { number: number }),
  'PullRequest.number': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.number,
  'PullRequest.title': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.title,
  'PullRequest.body': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.body,
  'PullRequest.state': (_ctx, _args, sub) => {
    const pull = (sub as Record<string, unknown>).__pull as { state: string; merged: boolean };
    if (pull.merged) return 'MERGED';
    return pull.state === 'open' ? 'OPEN' : 'CLOSED';
  },
  'PullRequest.merged': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.merged,
  'PullRequest.headRefName': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.headRef,
  'PullRequest.baseRefName': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.baseRef,
  'PullRequest.mergeable': (_ctx, _args, sub) => {
    const node = sub as Record<string, unknown>;
    const repo = node.__repo as Repo;
    const pull = node.__pull as { merged: boolean; headSha: string; baseSha: string };
    if (pull.merged) return 'MERGEABLE';
    const baseTip = repo.resolveBranch(pull.baseRef) ?? pull.baseSha;
    const mergeBase = repo.mergeBase(pull.headSha, baseTip);
    if (mergeBase !== null && mergeBase !== baseTip) {
      const headChanged = repo.changedPaths(mergeBase, pull.headSha);
      const baseChanged = repo.changedPaths(mergeBase, baseTip);
      for (const path of headChanged.keys()) if (baseChanged.has(path)) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  },
  'PullRequest.files': (_ctx, _args, sub) => {
    const node = sub as Record<string, unknown>;
    const repo = node.__repo as Repo;
    const pull = node.__pull as { baseSha: string; headSha: string };
    const changes = repo.changedPaths(pull.baseSha, pull.headSha);
    const files = [...changes.keys()].sort().map((path) => ({ __typename: 'PullRequestChangedFile', path }));
    return {
      __typename: 'PullRequestFilesConnection',
      nodes: files,
      pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    };
  },
  'PullRequestChangedFile.path': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.path ?? null,
  'PullRequestChangedFile.additions': () => 0,
  'PullRequestChangedFile.deletions': () => 0,
  'PullRequestChangedFile.changes': () => 0,
  'PullRequest.url': () => '',
  'PullRequest.createdAt': () => null,
  'PullRequest.updatedAt': () => null,
  'PullRequest.mergedAt': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.merged_at,
  'PullRequest.closedAt': () => null,
  'PullRequest.headRefOid': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.headSha,
  'PullRequest.baseRefOid': (_ctx, _args, sub) => (sub as Record<string, unknown>).__pull.baseSha,
  'PullRequest.isDraft': () => false,
  'PullRequest.author': () => ({ __typename: 'User', __login: VIEWER }),
  'PullRequest.labels': () => [],
  'PullRequest.comments': () => [],
  'PullRequest.reviews': () => [],
  'PullRequest.commits': () => [],
  'PullRequest.timelineItems': () => [],
  'PullRequest.repository': (_ctx, _args, sub) => repoNode((sub as Record<string, unknown>).__repo as Repo),
  'PullRequest.viewerCanUpdate': () => true,
  'PullRequest.filesConnection': () => null,

  'Mutation.createIssue': (ctx, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = findRepoByGlobalId(ctx.forge, input.repositoryId);
    if (!repo) throw new GraphQLError('Could not resolve to a Repository.');
    const number = repo.issueOrder.length + 1;
    const seq = repo.nextSeq();
    const issue = {
      id: makeIssueId(repo, number),
      number,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open' as const,
      labels: [],
      seq,
    };
    repo.issues.set(number, issue);
    repo.issueOrder.push(number);
    return { __typename: 'CreateIssuePayload', issue: issueNode(repo, number) };
  },
  'CreateIssuePayload.issue': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.issue ?? null,
  'CreateIssuePayload.clientMutationId': () => null,
  'Mutation.closeIssue': (ctx, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = findIssueByGlobalId(ctx.forge, input.issueId);
    if (!found) throw new GraphQLError('Could not resolve to an Issue.');
    found.issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue.number) };
  },
  'CloseIssuePayload.issue': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.issue ?? null,
  'CloseIssuePayload.clientMutationId': () => null,
  'Mutation.createPullRequest': (ctx, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = findRepoByGlobalId(ctx.forge, input.repositoryId);
    if (!repo) throw new GraphQLError('Could not resolve to a Repository.');
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headSha = repo.resolveBranch(head);
    const baseSha = repo.resolveBranch(base);
    if (!headSha || !baseSha) throw new GraphQLError('Could not resolve to a Ref.');
    const number = repo.pullOrder.length + 1;
    const seq = repo.nextSeq();
    const pull = {
      id: makePullId(repo, number),
      number,
      title: typeof input.title === 'string' ? input.title : '',
      body: '',
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
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, number) };
  },
  'CreatePullRequestPayload.pullRequest': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.pullRequest ?? null,
  'CreatePullRequestPayload.clientMutationId': () => null,
  'Mutation.mergePullRequest': (ctx, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const match = typeof input.pullRequestId === 'string' ? /^OID_P_(\d+)_(\d+)$/.exec(input.pullRequestId) : null;
    if (!match) throw new GraphQLError('Could not resolve to a PullRequest.');
    let found: { repo: Repo; pull: { number: number } } | null = null;
    for (const repo of ctx.forge.all()) {
      if (repo.id !== Number(match[1])) continue;
      const pull = repo.pulls.get(Number(match[2]));
      if (pull) found = { repo, pull };
    }
    if (!found) throw new GraphQLError('Could not resolve to a PullRequest.');
    const repo = found.repo;
    const pull = repo.pulls.get(found.pull.number)!;
    const baseTip = repo.resolveBranch(pull.baseRef) ?? pull.baseSha;
    const tree = repo.buildTreeFromFiles(repo.filesAt(pull.headRef));
    const data = buildCommit({ tree, parents: [baseTip], message: `Merge pull request #${pull.number} from ${pull.headRef}`, timestamp: repo.stamp() });
    const oid = hashObject('commit', data);
    repo.objects.set(oid, { type: 'commit', data });
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = new Date((repo.createdAt + pull.seq) * 1000).toISOString();
    pull.mergeCommitSha = oid;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull.number) };
  },
  'MergePullRequestPayload.pullRequest': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.pullRequest ?? null,
  'MergePullRequestPayload.clientMutationId': () => null,
  'Mutation.addComment': (ctx, args) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const found = findIssueByGlobalId(ctx.forge, input.subjectId);
    if (!found) throw new GraphQLError('Could not resolve to an Issue.');
    const seq = found.repo.nextSeq();
    const comment = {
      id: `OID_C_${found.repo.id}_${found.issue.number}_${seq}`,
      body: typeof input.body === 'string' ? input.body : '',
      seq,
    };
    const list = found.repo.comments.get(found.issue.number) ?? [];
    list.push(comment);
    found.repo.comments.set(found.issue.number, list);
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: { __typename: 'Comment', ...comment } } };
  },
  'AddCommentPayload.commentEdge': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.commentEdge ?? null,
  'AddCommentPayload.clientMutationId': () => null,
  'CommentEdge.node': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.node ?? null,
  'CommentEdge.cursor': () => null,
  'Comment.id': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.id ?? null,
  'Comment.body': (_ctx, _args, sub) => (sub as Record<string, unknown>)?.body ?? null,
};

// ---------------------------------------------------------------- execution

function executeValue(value: unknown, selections: SelectionNode[], ctx: ResolveCtx, typeName: string): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => executeValue(entry, selections, ctx, typeName));
  const node = value as Record<string, unknown>;
  const resolvedType = (node.__typename as string) ?? typeName;
  return executeSelectionSet(selections, resolvedType, node, ctx);
}

function executeSelectionSet(selections: SelectionNode[], typeName: string, node: Record<string, unknown>, ctx: ResolveCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.type === undefined || selection.type === typeName || matchesInterface(typeName, selection.type)) {
        Object.assign(out, executeSelectionSet(selection.selections, typeName, node, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[`${typeName}.${field.name}`];
    if (!resolver) {
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
    }
    const args: Record<string, unknown> = {};
    for (const argument of field.args) args[argument.name] = valueOf(argument.value, ctx.variables);
    let value: unknown;
    try {
      value = resolver(ctx, args, node);
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError(error instanceof Error ? error.message : String(error));
    }
    if (field.selections.length > 0) {
      out[key] = executeValue(value, field.selections, ctx, typeName);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function matchesInterface(typeName: string, fragmentType: string): boolean {
  if (typeName === fragmentType) return true;
  // Node interface: every object type is a Node.
  if (fragmentType === 'Node') return true;
  return false;
}

export interface GqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function executeGraphql(forge: Forge, request: GqlRequest): { data?: Record<string, unknown>; errors?: { message: string }[] } {
  const ctx: ResolveCtx = { forge, variables: request.variables ?? {} };
  let operations: Operation[];
  try {
    operations = new Parser(request.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  let operation = operations[0];
  if (request.operationName !== undefined) operation = operations.find((candidate) => candidate.name === request.operationName) ?? operation;
  if (!operation) return { errors: [{ message: 'no operation found' }] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeSelectionSet(operation.selections, rootType, {}, ctx);
    return { data };
  } catch (error) {
    if (error instanceof GraphQLError) return { errors: [{ message: error.message }] };
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}
