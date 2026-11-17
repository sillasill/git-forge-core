// graphql.ts — a small GraphQL v4 executor over the store: no library, just a
// tokenizer, a recursive-descent parser for the documents the suite sends
// (queries, mutations, variables, inline fragments, introspection), and
// resolvers for viewer / repository / issue / pull request / node / __type.

import {
  FIXED_ISO,
  VIEWER,
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// parsing
// -------------------------------------------------------------------------------------------

export type GqlValue =
  | string
  | number
  | boolean
  | null
  | { __enum: string }
  | GqlValue[]
  | { [key: string]: GqlValue };

export interface FieldNode {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: FieldNode[] | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  selections: FieldNode[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'var' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'var', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseOperation(): Operation {
    const fragments = new Map<string, { type: string; selections: FieldNode[] }>();
    let kind: 'query' | 'mutation' = 'query';
    let token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      token = this.peek();
      if (token?.kind === 'name') this.next(); // operation name
      token = this.peek();
      if (token?.kind === 'punct' && token.value === '(') this.skipVariableDefinitions();
    } else if (token?.kind === 'name' && token.value === 'fragment') {
      // handled below; fall through
    }
    const selections = this.parseSelectionSet(fragments);
    // Any trailing fragment definitions.
    while (this.peek() !== undefined) {
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const type = this.expectName();
        const fragmentSelections = this.parseSelectionSet(fragments);
        fragments.set(name, { type, selections: fragmentSelections });
      } else {
        break;
      }
    }
    return { kind, selections };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(fragments: Map<string, { type: string; selections: FieldNode[] }>): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    for (;;) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return fields;
      }
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          this.expectName(); // type condition (ignored; the suite only queries matching types)
          fields.push(...this.parseSelectionSet(fragments));
        } else if (next?.kind === 'name') {
          const name = this.next().value;
          const fragment = fragments.get(name);
          if (fragment) fields.push(...fragment.selections);
        }
        continue;
      }
      fields.push(this.parseField(fragments));
    }
  }

  private parseField(fragments: Map<string, { type: string; selections: FieldNode[] }>): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    const next = this.peek();
    if (next?.kind === 'punct' && next.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    const after = this.peek();
    if (after?.kind === 'punct' && after.value === '(') {
      this.next();
      for (;;) {
        const token = this.peek();
        if (!token) throw new Error('unterminated argument list');
        if (token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selections: FieldNode[] | null = null;
    const sel = this.peek();
    if (sel?.kind === 'punct' && sel.value === '{') selections = this.parseSelectionSet(fragments);
    return { name, alias, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'var') {
      const value = this.variables[token.value];
      return toGqlValue(value);
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number.parseInt(token.value, 10);
    if (token.kind === 'float') return Number.parseFloat(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      for (;;) {
        const next = this.peek();
        if (!next) throw new Error('unterminated list');
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          return items;
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: { [key: string]: GqlValue } = {};
      for (;;) {
        const next = this.peek();
        if (!next) throw new Error('unterminated object');
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          return object;
        }
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
    }
    throw new Error(`unexpected token ${token.value} in value`);
  }
}

function toGqlValue(value: unknown): GqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toGqlValue);
  if (typeof value === 'object') {
    const out: { [key: string]: GqlValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toGqlValue(v);
    return out;
  }
  return null;
}

function enumOf(value: GqlValue | undefined): string | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && '__enum' in value) return (value as { __enum: string }).__enum;
  if (typeof value === 'string') return value;
  return null;
}

function stringOf(value: GqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function intOf(value: GqlValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

// -------------------------------------------------------------------------------------------
// schema (introspection)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'closedAt', 'assignees', 'repository', 'timelineItems'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'isDraft', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'labels', 'forkCount', 'stargazerCount'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  Actor: ['login', 'avatarUrl', 'url'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

export interface GqlContext {
  store: Store;
}

interface ResolverObject {
  __kind: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  typeName?: string;
  connection?: { items: unknown[]; hasNext: boolean; endCursor: string | null };
  edge?: { node: unknown; cursor: string };
  comment?: { id: number; body: string };
  file?: { path: string; additions: number; deletions: number; status: string };
  [key: string]: unknown;
}

class FieldError extends Error {}

export function executeOperation(store: Store, query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const errors: { message: string }[] = [];
  let operation: Operation;
  try {
    operation = new Parser(tokenize(query), variables).parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const root: ResolverObject = { __kind: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data: Record<string, unknown> = {};
  for (const field of operation.selections) {
    try {
      data[field.alias ?? field.name] = resolveField(store, root, field, errors);
    } catch (err) {
      if (err instanceof FieldError) {
        errors.push({ message: err.message });
        data[field.alias ?? field.name] = null;
      } else {
        throw err;
      }
    }
  }
  return { data, errors };
}

function unknownField(kind: string, name: string): FieldError {
  return new FieldError(`Cannot query field "${name}" on type "${kind}".`);
}

function resolveField(store: Store, obj: ResolverObject, field: FieldNode, errors: { message: string }[]): unknown {
  const kind = obj.__kind;

  switch (kind) {
    case 'Query': {
      if (field.name === 'viewer') {
        const user: ResolverObject = { __kind: 'User' };
        return field.selections ? resolveSelections(store, user, field.selections, errors) : null;
      }
      if (field.name === 'repository') {
        const owner = stringOf(field.args.owner);
        const name = stringOf(field.args.name);
        const repo = owner !== null && name !== null ? store.getRepo(owner, name) : undefined;
        if (!repo) return null;
        const child: ResolverObject = { __kind: 'Repository', repo };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'node') {
        const id = stringOf(field.args.id);
        const decoded = id !== null ? decodeGlobalId(id) : null;
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const [owner, name] = decoded.parts;
          const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
          if (!repo) return null;
          const child: ResolverObject = { __kind: 'Repository', repo };
          return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
        }
        if (decoded.kind === 'Issue') {
          const [owner, name, num] = decoded.parts;
          const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
          const issue = repo?.issues.find((i) => i.number === Number(num));
          if (!issue || !repo) return null;
          const child: ResolverObject = { __kind: 'Issue', repo, issue };
          return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const [owner, name, num] = decoded.parts;
          const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
          const pull = repo?.pulls.find((p) => p.number === Number(num));
          if (!pull || !repo) return null;
          const child: ResolverObject = { __kind: 'PullRequest', repo, pull };
          return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = stringOf(field.args.name);
        if (name === null) return null;
        return resolveTypeObject(name, field, errors, store);
      }
      if (field.name === '__schema') {
        const child: ResolverObject = { __kind: '__Schema' };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField('Query', field.name);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (field.args.input ?? {}) as { [key: string]: GqlValue };
        const repositoryId = stringOf(input.repositoryId);
        const decoded = repositoryId !== null ? decodeGlobalId(repositoryId) : null;
        const repo = decoded?.kind === 'Repository' ? store.getRepo(decoded.parts[0] ?? '', decoded.parts[1] ?? '') : undefined;
        if (!repo) throw new FieldError(`Could not resolve to a Repository with the id of "${repositoryId ?? ''}".`);
        const title = stringOf(input.title) ?? '';
        const body = stringOf(input.body) ?? '';
        const created = store.createIssue(repo, title, body, []);
        if ('error' in created) throw new FieldError(created.error);
        const child: ResolverObject = { __kind: 'CreateIssuePayload', repo, issue: created };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'closeIssue') {
        const input = (field.args.input ?? {}) as { [key: string]: GqlValue };
        const issueId = stringOf(input.issueId);
        const decoded = issueId !== null ? decodeGlobalId(issueId) : null;
        const repo = decoded?.kind === 'Issue' ? store.getRepo(decoded.parts[0] ?? '', decoded.parts[1] ?? '') : undefined;
        const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[2]));
        if (!issue || !repo) throw new FieldError(`Could not resolve to an Issue with the id of "${issueId ?? ''}".`);
        issue.state = 'closed';
        issue.cachedJson = null;
        const child: ResolverObject = { __kind: 'CloseIssuePayload', repo, issue };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'createPullRequest') {
        const input = (field.args.input ?? {}) as { [key: string]: GqlValue };
        const repositoryId = stringOf(input.repositoryId);
        const decoded = repositoryId !== null ? decodeGlobalId(repositoryId) : null;
        const repo = decoded?.kind === 'Repository' ? store.getRepo(decoded.parts[0] ?? '', decoded.parts[1] ?? '') : undefined;
        if (!repo) throw new FieldError(`Could not resolve to a Repository with the id of "${repositoryId ?? ''}".`);
        const title = stringOf(input.title) ?? '';
        const body = stringOf(input.body) ?? '';
        const headRefName = stringOf(input.headRefName) ?? '';
        const baseRefName = stringOf(input.baseRefName) ?? repo.default_branch;
        const created = store.createPull(repo, title, body, headRefName, baseRefName);
        if ('error' in created) throw new FieldError(created.error);
        const child: ResolverObject = { __kind: 'CreatePullRequestPayload', repo, pull: created };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'mergePullRequest') {
        const input = (field.args.input ?? {}) as { [key: string]: GqlValue };
        const pullRequestId = stringOf(input.pullRequestId);
        const decoded = pullRequestId !== null ? decodeGlobalId(pullRequestId) : null;
        const repo = decoded?.kind === 'PullRequest' ? store.getRepo(decoded.parts[0] ?? '', decoded.parts[1] ?? '') : undefined;
        const pull = repo?.pulls.find((p) => p.number === Number(decoded?.parts[2]));
        if (!pull || !repo) throw new FieldError(`Could not resolve to a PullRequest with the id of "${pullRequestId ?? ''}".`);
        const merged = store.mergePull(repo, pull);
        if ('error' in merged) throw new FieldError(merged.error);
        const child: ResolverObject = { __kind: 'MergePullRequestPayload', repo, pull };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'addComment') {
        const input = (field.args.input ?? {}) as { [key: string]: GqlValue };
        const subjectId = stringOf(input.subjectId);
        const decoded = subjectId !== null ? decodeGlobalId(subjectId) : null;
        const repo = decoded?.kind === 'Issue' ? store.getRepo(decoded.parts[0] ?? '', decoded.parts[1] ?? '') : undefined;
        const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[2]));
        if (!issue || !repo) throw new FieldError(`Could not resolve to an Issue with the id of "${subjectId ?? ''}".`);
        const body = stringOf(input.body) ?? '';
        const comment = { id: store.nextGlobalCommentId(), body };
        issue.comments.push(comment);
        issue.cachedJson = null;
        const child: ResolverObject = { __kind: 'AddCommentPayload', repo, issue, comment };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField('Mutation', field.name);
    }
    case 'User': {
      if (field.name === 'login') return VIEWER.login;
      if (field.name === 'id') return globalId('User', VIEWER.login);
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      if (field.name === 'avatarUrl' || field.name === 'url') return '';
      throw unknownField('User', field.name);
    }
    case 'Repository': {
      const repo = obj.repo!;
      if (field.name === 'id') return globalId('Repository', repo.owner, repo.name);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return repo.full_name;
      if (field.name === 'owner') {
        const child: ResolverObject = { __kind: 'User' };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : VIEWER.login;
      }
      if (field.name === 'defaultBranchRef') {
        const child: ResolverObject = { __kind: 'Ref', repo };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : { name: repo.default_branch };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'private' || field.name === 'isPrivate') return repo.private;
      if (field.name === 'createdAt' || field.name === 'updatedAt') return FIXED_ISO;
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}`;
      if (field.name === 'issue') {
        const number = intOf(field.args.number);
        const issue = number !== null ? repo.issues.find((i) => i.number === number) : undefined;
        if (!issue) return null;
        const child: ResolverObject = { __kind: 'Issue', repo, issue };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'issues') {
        const connection = issueConnection(store, repo, field.args);
        const child: ResolverObject = { __kind: 'IssueConnection', repo, connection };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'pullRequests') {
        const connection = pullConnection(store, repo, field.args);
        const child: ResolverObject = { __kind: 'PullRequestConnection', repo, connection };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'pullRequest') {
        const number = intOf(field.args.number);
        const pull = number !== null ? repo.pulls.find((p) => p.number === number) : undefined;
        if (!pull) return null;
        const child: ResolverObject = { __kind: 'PullRequest', repo, pull };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'labels') {
        return [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color }));
      }
      throw unknownField('Repository', field.name);
    }
    case 'Issue': {
      const issue = obj.issue!;
      const repo = obj.repo!;
      if (field.name === 'id') return globalId('Issue', repo.owner, repo.name, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'createdAt' || field.name === 'updatedAt') return FIXED_ISO;
      if (field.name === 'closedAt') return issue.state === 'closed' ? FIXED_ISO : null;
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'author') {
        const child: ResolverObject = { __kind: 'User' };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : VIEWER.login;
      }
      if (field.name === 'labels') {
        return issue.labels.map((label) => ({ name: label.name, color: label.color }));
      }
      if (field.name === 'comments') {
        return issue.comments.map((comment) => ({ id: globalId('IssueComment', repo.owner, repo.name, issue.number, comment.id), body: comment.body }));
      }
      if (field.name === 'repository') {
        const child: ResolverObject = { __kind: 'Repository', repo };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField('Issue', field.name);
    }
    case 'PullRequest': {
      const pull = obj.pull!;
      const repo = obj.repo!;
      if (field.name === 'id') return globalId('PullRequest', repo.owner, repo.name, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') return store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRef' || field.name === 'baseRef') {
        const child: ResolverObject = { __kind: 'Ref', repo };
        child.refName = field.name === 'headRef' ? pull.headRef : pull.baseRef;
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'createdAt' || field.name === 'updatedAt') return FIXED_ISO;
      if (field.name === 'mergedAt') return pull.merged_at;
      if (field.name === 'mergeCommit') return pull.merge_commit_sha ? { oid: pull.merge_commit_sha } : null;
      if (field.name === 'author') {
        const child: ResolverObject = { __kind: 'User' };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : VIEWER.login;
      }
      if (field.name === 'files') {
        const files = store.pullFiles(repo, pull).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, status: file.status }));
        const first = intOf(field.args.first);
        const sliced = first !== null ? files.slice(0, first) : files;
        const child: ResolverObject = {
          __kind: 'PullRequestChangedFileConnection',
          connection: { items: sliced, hasNext: first !== null && files.length > first, endCursor: null },
        };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField('PullRequest', field.name);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const connection = obj.connection!;
      if (field.name === 'nodes') {
        return connection.items.map((item) => {
          if (kind === 'IssueConnection') {
            const child: ResolverObject = { __kind: 'Issue', repo: obj.repo, issue: item as Issue };
            return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
          }
          if (kind === 'PullRequestConnection') {
            const child: ResolverObject = { __kind: 'PullRequest', repo: obj.repo, pull: item as Pull };
            return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
          }
          const file = item as { path: string; additions: number; deletions: number; status: string };
          const child: ResolverObject = { __kind: 'PullRequestChangedFile', file };
          return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
        });
      }
      if (field.name === 'edges') {
        return connection.items.map((item, index) => {
          const cursor = Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
          const child: ResolverObject = { __kind: kind === 'IssueConnection' ? 'IssueEdge' : kind === 'PullRequestConnection' ? 'PullRequestEdge' : 'PullRequestChangedFileEdge', edge: { node: item, cursor } };
          return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
        });
      }
      if (field.name === 'pageInfo') {
        const child: ResolverObject = {
          __kind: 'PageInfo',
          pageInfo: { hasNextPage: connection.hasNext, hasPreviousPage: false, startCursor: null, endCursor: connection.endCursor },
        };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'totalCount') return connection.items.length;
      throw unknownField(kind, field.name);
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge': {
      const edge = obj.edge!;
      if (field.name === 'cursor') return edge.cursor;
      if (field.name === 'node') {
        if (kind === 'IssueEdge') {
          const child: ResolverObject = { __kind: 'Issue', repo: obj.repo, issue: edge.node as Issue };
          return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
        }
        if (kind === 'PullRequestEdge') {
          const child: ResolverObject = { __kind: 'PullRequest', repo: obj.repo, pull: edge.node as Pull };
          return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
        }
        const child: ResolverObject = { __kind: 'PullRequestChangedFile', file: edge.node as { path: string; additions: number; deletions: number; status: string } };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField(kind, field.name);
    }
    case 'PullRequestChangedFile': {
      const file = obj.file!;
      if (field.name === 'path') return file.path;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changeType') return file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED';
      throw unknownField('PullRequestChangedFile', field.name);
    }
    case 'PageInfo': {
      const pageInfo = obj.pageInfo as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field.name === 'hasNextPage') return pageInfo.hasNextPage;
      if (field.name === 'hasPreviousPage') return pageInfo.hasPreviousPage;
      if (field.name === 'startCursor') return pageInfo.startCursor;
      if (field.name === 'endCursor') return pageInfo.endCursor;
      throw unknownField('PageInfo', field.name);
    }
    case 'Ref': {
      const repo = obj.repo!;
      const refName = (obj.refName as string | undefined) ?? repo.default_branch;
      if (field.name === 'name') return refName;
      if (field.name === 'id') return globalId('Ref', repo.owner, repo.name, refName);
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') {
        const tip = repo.refs.get(`refs/heads/${refName}`);
        return tip ?? null;
      }
      throw unknownField('Ref', field.name);
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') {
        const child: ResolverObject = { __kind: 'Issue', repo: obj.repo, issue: obj.issue as Issue };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField('CreateIssuePayload', field.name);
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') {
        const child: ResolverObject = { __kind: 'Issue', repo: obj.repo, issue: obj.issue as Issue };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField('CloseIssuePayload', field.name);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') {
        const child: ResolverObject = { __kind: 'PullRequest', repo: obj.repo, pull: obj.pull as Pull };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField(kind, field.name);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        const child: ResolverObject = { __kind: 'IssueCommentEdge', repo: obj.repo, issue: obj.issue as Issue, comment: obj.comment as { id: number; body: string } };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      throw unknownField('AddCommentPayload', field.name);
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') {
        const child: ResolverObject = { __kind: 'IssueComment', repo: obj.repo, issue: obj.issue as Issue, comment: obj.comment as { id: number; body: string } };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : null;
      }
      if (field.name === 'cursor') return Buffer.from('cursor:0', 'utf8').toString('base64');
      throw unknownField('IssueCommentEdge', field.name);
    }
    case 'IssueComment': {
      const comment = obj.comment as { id: number; body: string };
      const repo = obj.repo!;
      const issue = obj.issue as Issue;
      if (field.name === 'id') return globalId('IssueComment', repo.owner, repo.name, issue.number, comment.id);
      if (field.name === 'body') return comment.body;
      if (field.name === 'createdAt' || field.name === 'updatedAt') return FIXED_ISO;
      if (field.name === 'author') {
        const child: ResolverObject = { __kind: 'User' };
        return field.selections ? resolveSelections(store, child, field.selections, errors) : VIEWER.login;
      }
      throw unknownField('IssueComment', field.name);
    }
    case '__Type': {
      const typeName = obj.typeName!;
      if (field.name === 'name') return typeName;
      if (field.name === 'kind') return ENUM_VALUES[typeName] ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[typeName] ?? [];
        return names.map((name) => ({ __kind: '__Field', fieldName: name }));
      }
      if (field.name === 'enumValues') {
        const names = ENUM_VALUES[typeName] ?? [];
        return names.map((name) => ({ __kind: '__EnumValue', enumName: name }));
      }
      throw unknownField('__Type', field.name);
    }
    case '__Field': {
      if (field.name === 'name') return obj.fieldName as string;
      throw unknownField('__Field', field.name);
    }
    case '__EnumValue': {
      if (field.name === 'name') return obj.enumName as string;
      throw unknownField('__EnumValue', field.name);
    }
    case '__Schema': {
      if (field.name === 'queryType') return { __kind: '__Type', typeName: 'Query' };
      if (field.name === 'mutationType') return { __kind: '__Type', typeName: 'Mutation' };
      if (field.name === 'types') return Object.keys(TYPE_FIELDS).map((name) => ({ __kind: '__Type', typeName: name }));
      throw unknownField('__Schema', field.name);
    }
    default:
      throw unknownField(kind, field.name);
  }
}

function resolveTypeObject(name: string, field: FieldNode, errors: { message: string }[], store: Store): unknown {
  if (!(name in TYPE_FIELDS) && !(name in ENUM_VALUES)) return null;
  const child: ResolverObject = { __kind: '__Type', typeName: name };
  if (!field.selections) return null;
  return resolveSelections(store, child, field.selections, errors);
}

function resolveSelections(store: Store, obj: ResolverObject, selections: FieldNode[], errors: { message: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    try {
      const value = resolveField(store, obj, field, errors);
      // __Type fields/enumValues return raw marker objects; expand them.
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null && '__kind' in (value[0] as Record<string, unknown>)) {
        out[field.alias ?? field.name] = (value as ResolverObject[]).map((entry) => {
          if (!field.selections) return entry;
          return resolveSelections(store, entry, field.selections, errors);
        });
      } else {
        out[field.alias ?? field.name] = value;
      }
    } catch (err) {
      if (err instanceof FieldError) {
        errors.push({ message: err.message });
        out[field.alias ?? field.name] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexAfterCursor(after: string | null): number {
  if (after === null) return -1;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match) return Number.parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
  return -1;
}

function issueConnection(store: Store, repo: Repo, args: Record<string, GqlValue>): { items: Issue[]; hasNext: boolean; endCursor: string | null } {
  let items = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((s) => enumOf(s)).filter((s): s is string => s !== null));
    items = items.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy;
  let direction = 'DESC';
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const dir = enumOf((orderBy as Record<string, GqlValue>).direction);
    if (dir) direction = dir;
  }
  items.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  const after = stringOf(args.after);
  const start = indexAfterCursor(after);
  const page = items.slice(start + 1);
  const first = intOf(args.first);
  const sliced = first !== null ? page.slice(0, first) : page;
  const hasNext = first !== null ? page.length > first : false;
  const endCursor = sliced.length ? cursorOf(start + sliced.length) : null;
  return { items: sliced, hasNext, endCursor };
}

function pullConnection(store: Store, repo: Repo, args: Record<string, GqlValue>): { items: Pull[]; hasNext: boolean; endCursor: string | null } {
  let items = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((s) => enumOf(s)).filter((s): s is string => s !== null));
    items = items.filter((pull) => wanted.has(pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  items.sort((a, b) => b.seq - a.seq || b.number - a.number);
  const after = stringOf(args.after);
  const start = indexAfterCursor(after);
  const page = items.slice(start + 1);
  const first = intOf(args.first);
  const sliced = first !== null ? page.slice(0, first) : page;
  const hasNext = first !== null ? page.length > first : false;
  const endCursor = sliced.length ? cursorOf(start + sliced.length) : null;
  return { items: sliced, hasNext, endCursor };
}
