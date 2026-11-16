// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable
// HTTP at POST /mcp, speaking the 2026-07-28 revision (server/discover) and
// the handshake era (initialize / notifications/initialized) alike. The six
// tools act on the same store as REST and GraphQL.

import {
  FIXED_ISO,
  VIEWER,
  type Repo,
  type Store,
} from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28'];
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
    required: string[];
  };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach to the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        state: { type: 'string', description: 'The state to filter by: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// -------------------------------------------------------------------------------------------
// shared JSON views (the same shapes REST returns)
// -------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.owner}/${repo.name}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    html_url: `https://example.invalid/${repo.full_name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    default_branch: repo.default_branch,
    permissions: { admin: true, push: true, pull: true },
    has_issues: true,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueJson(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: { name: string; color: string }[]; comments: { id: number; body: string }[] }): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.owner}/${repo.name}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.full_name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: { number: number; id: number; title: string; body: string; state: string; merged: boolean; merged_at: string | null; merge_commit_sha: string | null; headRef: string; baseRef: string }): Record<string, unknown> {
  const { headSha, baseSha } = store.pullShas(repo, pull as never);
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: store.pullMergeable(repo, pull as never),
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.full_name}/pull/${pull.number}`,
  };
}

// -------------------------------------------------------------------------------------------
// tool execution
// -------------------------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Resolve owner/repo from the arguments, accepting full_name as a fallback. */
function resolveRepo(store: Store, args: ToolArgs): Repo | { error: string } {
  let owner = asString(args.owner);
  let name = asString(args.repo ?? args.repository ?? args.name);
  const fullName = asString(args.full_name ?? args.repo_full_name ?? args.repository_full_name);
  if ((!owner || !name) && fullName) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      owner = owner ?? fullName.slice(0, slash);
      name = name ?? fullName.slice(slash + 1);
    }
  }
  if (!owner || !name) return { error: 'missing required arguments: owner and repo' };
  const repo = store.getRepo(owner, name);
  if (!repo) return { error: `Repository ${owner}/${name} not found` };
  return repo;
}

export function callMcpTool(
  store: Store,
  name: string,
  args: ToolArgs,
): { ok: true; payload: unknown } | { ok: false; error: string; rpcCode?: number } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}`, rpcCode: -32601 };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { ok: false, error: `Missing required argument: ${required}`, rpcCode: -32602 };
    }
  }

  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name ?? args.repo ?? args.repository);
      if (!repoName) return { ok: false, error: 'Missing required argument: name', rpcCode: -32602 };
      const owner = asString(args.owner) ?? VIEWER.login;
      const description = asString(args.description) ?? '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const existing = store.getRepo(owner, repoName);
      if (existing) return { ok: true, payload: repoJson(existing) };
      const repo = store.createRepo(owner, repoName, { private: isPrivate, description });
      if (!repo) return { ok: false, error: `Repository ${owner}/${repoName} already exists` };
      return { ok: true, payload: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if ('error' in repo) return { ok: false, error: repo.error };
      return { ok: true, payload: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if ('error' in repo) return { ok: false, error: repo.error };
      const title = asString(args.title);
      if (!title) return { ok: false, error: 'Missing required argument: title', rpcCode: -32602 };
      const body = asString(args.body) ?? '';
      const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = store.createIssue(repo, title, body, labels);
      if ('error' in created) return { ok: false, error: created.error };
      return { ok: true, payload: issueJson(repo, created) };
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if ('error' in repo) return { ok: false, error: repo.error };
      const state = asString(args.state) ?? 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { ok: true, payload: { issues: issues.map((issue) => issueJson(repo, issue)) } };
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if ('error' in repo) return { ok: false, error: repo.error };
      const title = asString(args.title);
      const head = asString(args.head ?? args.head_ref ?? args.head_branch);
      const base = asString(args.base ?? args.base_ref ?? args.base_branch) ?? repo.default_branch;
      if (!title || !head) return { ok: false, error: 'Missing required argument: title or head', rpcCode: -32602 };
      const body = asString(args.body) ?? '';
      const created = store.createPull(repo, title, body, head, base);
      if ('error' in created) return { ok: false, error: created.error };
      return { ok: true, payload: pullJson(store, repo, created) };
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if ('error' in repo) return { ok: false, error: repo.error };
      const number = asNumber(args.pull_number ?? args.pull_request_number ?? args.number);
      if (number === null) return { ok: false, error: 'Missing required argument: pull_number', rpcCode: -32602 };
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return { ok: false, error: `Pull request #${number} not found` };
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return { ok: false, error: merged.error };
      return { ok: true, payload: { ...pullJson(store, repo, pull), sha: merged.sha } };
    }
    default:
      return { ok: false, error: `Unknown tool: ${name}`, rpcCode: -32601 };
  }
}

// -------------------------------------------------------------------------------------------
// JSON-RPC envelope
// -------------------------------------------------------------------------------------------

export type JsonRpcId = string | number | null;

export function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

const SERVER_INFO = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };

/** Handle one decoded JSON-RPC request object. Returns null for notifications (no reply). */
export function handleMcpRequest(store: Store, request: unknown): Record<string, unknown> | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = request as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: JsonRpcId = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (typeof req.params === 'object' && req.params !== null ? req.params : {}) as Record<string, unknown>;
  const isNotification = req.id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const chosen = requested !== null && (MCP_SUPPORTED_VERSIONS.includes(requested) || MCP_LEGACY_VERSIONS.includes(requested))
        ? requested
        : MCP_SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      // The same object every time, so two calls serialize byte for byte.
      return rpcResult(id, { tools: MCP_TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as ToolArgs;
      const outcome = callMcpTool(store, toolName, args);
      if (!outcome.ok) {
        if (outcome.rpcCode !== undefined) return rpcError(id, outcome.rpcCode, outcome.error);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: outcome.error }) }],
          isError: true,
        });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
        structuredContent: outcome.payload,
      });
    }
    default: {
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}
