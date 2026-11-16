// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and
// MCP, all over one in-memory store. Standard library only.
//
// Auth: every surface except /healthz takes `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN`. When the variable is unset (local runs) any bearer
// token is accepted, but a missing header is still a 401. The token names the
// one viewer of the kit's fixed scenario (adaiversen); any other owner is a
// 404, never a 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildTree,
  collectReachable,
  decodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import {
  FIXED_ISO,
  VIEWER,
  globalId,
  Store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { executeOperation } from './graphql.ts';
import { callMcpTool, handleMcpRequest, issueJson, pullJson, repoJson, rpcError, MCP_TOOLS } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  function requestId(): string {
    requestCounter += 1;
    return `req-${requestCounter.toString(16).padStart(8, '0')}`;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId(),
      ...extra,
    });
    res.end(text);
  }

  function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'x-github-request-id': requestId(),
    });
    res.end(body);
  }

  function sendNoContent(res: ServerResponse, status: number): void {
    res.writeHead(status, { 'x-github-request-id': requestId() });
    res.end();
  }

  function notFound(res: ServerResponse): void {
    sendJson(res, 404, { message: 'Not Found' });
  }

  function badRequest(res: ServerResponse, message: string): void {
    sendJson(res, 400, { message });
  }

  function unauthorized(res: ServerResponse): void {
    sendJson(res, 401, { message: 'Requires authentication' });
  }

  function checkAuth(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length);
    if (presented === '') return false;
    if (token !== '' && presented !== token) return false;
    return true;
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  /** Parse a JSON body; on failure answers 400 and returns null. */
  async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    const raw = await readBody(req);
    if (raw.length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        badRequest(res, 'Invalid JSON: expected an object');
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      badRequest(res, 'Invalid JSON');
      return null;
    }
  }

  function pathOf(req: IncomingMessage): string {
    try {
      const raw = new URL(req.url ?? '/', 'http://entry').pathname;
      return decodeURIComponent(raw);
    } catch {
      return '/';
    }
  }

  function queryOf(req: IncomingMessage): URLSearchParams {
    try {
      return new URL(req.url ?? '/', 'http://entry').searchParams;
    } catch {
      return new URLSearchParams();
    }
  }

  function baseUrlOf(req: IncomingMessage): string {
    return `http://${req.headers.host ?? '127.0.0.1'}`;
  }

  /** Slice a list into a page; returns the page and a Link header value (or ''). */
  function paginate<T>(req: IncomingMessage, path: string, query: URLSearchParams, items: T[]): { page: T[]; link: string } {
    const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
    const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    const start = (pageNum - 1) * perPage;
    const page = items.slice(start, start + perPage);
    let link = '';
    if (start + perPage < items.length) {
      const pageUrl = (n: number): string => {
        const params = new URLSearchParams(query);
        params.set('per_page', String(perPage));
        params.set('page', String(n));
        return `${baseUrlOf(req)}${path}?${params.toString()}`;
      };
      link = `<${pageUrl(pageNum + 1)}>; rel="next", <${pageUrl(Math.ceil(items.length / perPage))}>; rel="last"`;
    }
    return { page, link };
  }

  // -------------------------------------------------------------------------------------------
  // git smart HTTP
  // -------------------------------------------------------------------------------------------

  function gitRepo(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) {
      notFound(res);
      return null;
    }
    const repo = store.getRepo(owner, name);
    if (!repo) {
      notFound(res);
      return null;
    }
    return repo;
  }

  function advertiseV2(res: ServerResponse): void {
    const lines = [
      'version 2\n',
      'agent=github-core-clone/1.0.0\n',
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done\n',
      'server-option\n',
      'object-format=sha1\n',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
    sendBuffer(res, 200, body, UPLOAD_AD);
  }

  function advertiseV0(res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
    const caps =
      service === 'git-upload-pack'
        ? 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=github-core-clone/1.0.0'
        : 'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0.0';
    const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
    const refs = store.listRefs(repo);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      const headTip = repo.refs.get('refs/heads/main') ?? refs.find((r) => r.name.startsWith('refs/heads/'))?.oid ?? ZERO_OID;
      parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
      for (const ref of refs) {
        parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
        if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
    }
    parts.push(pktFlush());
    sendBuffer(res, 200, Buffer.concat(parts), service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD);
  }

  function sidebandPack(pack: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    const chunkSize = 32768;
    for (let offset = 0; offset < pack.length; offset += chunkSize) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
      frames.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    return frames;
  }

  function handleLsRefs(repo: Repo, args: string[]): Buffer {
    const prefixes: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const lines: Buffer[] = [];
    const refs = store.listRefs(repo);
    const headTip = repo.refs.get('refs/heads/main') ?? refs.find((r) => r.name.startsWith('refs/heads/'))?.oid;
    if (headTip !== undefined && keep('HEAD')) {
      lines.push(pktLine(`${headTip} HEAD symref-target:refs/heads/main\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.peeled) line += ` peeled:${ref.peeled}`;
      lines.push(pktLine(`${line}\n`));
    }
    lines.push(pktFlush());
    return Buffer.concat(lines);
  }

  function handleFetch(repo: Repo, args: string[], v2: boolean): Buffer {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowBoundaries: string[] = [];
    let depth: number | null = null;
    for (const arg of args) {
      const tokens = arg.split(' ');
      if (tokens[0] === 'want' && tokens[1] !== undefined) wants.push(tokens[1]);
      else if (tokens[0] === 'have' && tokens[1] !== undefined) haves.push(tokens[1]);
      else if (tokens[0] === 'shallow' && tokens[1] !== undefined) shallowBoundaries.push(tokens[1]);
      else if (tokens[0] === 'deepen' && tokens[1] !== undefined) {
        const n = Number.parseInt(tokens[1], 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    const { pack, shallow, unshallow } = store.fetchResult(repo, wants, haves, depth, shallowBoundaries);
    const parts: Buffer[] = [];
    if (v2) {
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
      if (shallow.length > 0 || unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(pktDelim());
      }
      if (pack !== null) {
        parts.push(pktLine('packfile\n'));
        parts.push(...sidebandPack(pack));
      }
      parts.push(pktFlush());
    } else {
      parts.push(pktLine('NAK\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      if (pack !== null) parts.push(...sidebandPack(pack));
      parts.push(pktFlush());
    }
    return Buffer.concat(parts);
  }

  async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
    const v2 = req.headers['git-protocol'] === 'version=2';
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    let packets;
    try {
      packets = decodePktLines(body).packets;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
    if (v2) {
      const command = lines[0] ?? '';
      const args = lines.slice(1);
      if (command === 'command=ls-refs') {
        sendBuffer(res, 200, handleLsRefs(repo, args), UPLOAD_RESULT);
        return;
      }
      if (command === 'command=fetch') {
        sendBuffer(res, 200, handleFetch(repo, args, true), UPLOAD_RESULT);
        return;
      }
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    sendBuffer(res, 200, handleFetch(repo, lines, false), UPLOAD_RESULT);
  }

  async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    let packets;
    let rest: Buffer;
    try {
      const decoded = decodePktLines(body, true);
      packets = decoded.packets;
      rest = decoded.rest;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const parts = line.split(' ');
      if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) continue;
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    let unpackError: string | null = null;
    if (rest.length > 0) {
      try {
        const objects = readPack(rest);
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackError = (err as Error).message;
      }
    }
    const reportLines: string[] = [];
    if (unpackError !== null) {
      reportLines.push(`unpack ${unpackError}\n`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
    } else {
      reportLines.push('unpack ok\n');
      for (const command of commands) {
        const verdict = applyPushCommand(repo, command);
        reportLines.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
      }
    }
    const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
    const parts = [...sidebandPack(report), pktFlush()];
    sendBuffer(res, 200, Buffer.concat(parts), RECEIVE_RESULT);
  }

  function applyPushCommand(repo: Repo, command: { oldOid: string; newOid: string; ref: string }): { ok: boolean; reason?: string } {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'old oid mismatch' };
      repo.refs.delete(command.ref);
      return { ok: true };
    }
    const object = repo.objects.get(command.newOid);
    if (!object || (object.type !== 'commit' && object.type !== 'tag')) return { ok: false, reason: 'object not found' };
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) return { ok: false, reason: 'remote ref does not exist' };
      repo.refs.set(command.ref, command.newOid);
      return { ok: true };
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return { ok: false, reason: 'old oid mismatch' };
    if (command.newOid === current) return { ok: true };
    const newCommit = object.type === 'commit' ? command.newOid : parseTag(object.data).object;
    if (!store.isAncestor(repo, current, newCommit)) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true };
  }

  // -------------------------------------------------------------------------------------------
  // REST v3
  // -------------------------------------------------------------------------------------------

  function repoOr404(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) {
      notFound(res);
      return null;
    }
    const repo = store.getRepo(owner, name);
    if (!repo) {
      notFound(res);
      return null;
    }
    return repo;
  }

  async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET';

    // GET /api/v3/ — the API root.
    if (segments.length === 0) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    if (segments[0] === 'meta' && segments.length === 1) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    if (segments[0] === 'user') {
      if (segments.length === 1) {
        if (method !== 'GET') {
          notFound(res);
          return;
        }
        sendJson(res, 200, {
          login: VIEWER.login,
          id: VIEWER.id,
          node_id: globalId('User', VIEWER.login),
          name: VIEWER.name,
          email: VIEWER.email,
          type: 'User',
          html_url: `https://example.invalid/${VIEWER.login}`,
        });
        return;
      }
      if (segments[1] === 'repos' && segments.length === 2) {
        if (method === 'GET') {
          const { page, link } = paginate(req, '/api/v3/user/repos', query, store.listRepos(VIEWER.login));
          sendJson(res, 200, page.map((repo) => repoJson(repo)), link === '' ? {} : { link });
          return;
        }
        if (method === 'POST') {
          const body = await jsonBody(req, res);
          if (body === null) return;
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (name === '' || name.includes('/') || name.length > 100) {
            sendJson(res, 422, { message: 'Validation Failed: name is invalid' });
            return;
          }
          const repo = store.createRepo(VIEWER.login, name, {
            private: typeof body.private === 'boolean' ? body.private : false,
            description: typeof body.description === 'string' ? body.description : '',
          });
          if (!repo) {
            sendJson(res, 422, { message: `Validation Failed: Repository ${VIEWER.login}/${name} already exists` });
            return;
          }
          sendJson(res, 201, repoJson(repo));
          return;
        }
      }
      notFound(res);
      return;
    }

    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1]!;
      const name = segments[2]!;
      const rest = segments.slice(3);

      if (rest.length === 0) {
        if (method === 'GET') {
          const repo = repoOr404(req, res, owner, name);
          if (repo) sendJson(res, 200, repoJson(repo));
          return;
        }
        if (method === 'PATCH') {
          const repo = repoOr404(req, res, owner, name);
          if (!repo) return;
          const body = await jsonBody(req, res);
          if (body === null) return;
          if (typeof body.description === 'string') repo.description = body.description;
          sendJson(res, 200, repoJson(repo));
          return;
        }
        if (method === 'DELETE') {
          const repo = repoOr404(req, res, owner, name);
          if (!repo) return;
          store.deleteRepo(owner, name);
          sendNoContent(res, 204);
          return;
        }
        notFound(res);
        return;
      }

      const repo = repoOr404(req, res, owner, name);
      if (!repo) return;

      if (rest[0] === 'branches') {
        if (rest.length === 1 && method === 'GET') {
          const branches = store.listRefs(repo)
            .filter((ref) => ref.name.startsWith('refs/heads/'))
            .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid }, protected: false }));
          sendJson(res, 200, branches);
          return;
        }
        if (rest.length === 2 && method === 'GET') {
          const tip = repo.refs.get(`refs/heads/${rest[1]}`);
          if (tip === undefined) {
            notFound(res);
            return;
          }
          sendJson(res, 200, { name: rest[1], commit: { sha: tip }, protected: false });
          return;
        }
        notFound(res);
        return;
      }

      if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
        const shaParam = query.get('sha') ?? repo.default_branch;
        const tip = store.resolveRef(repo, shaParam);
        if (tip === null) {
          notFound(res);
          return;
        }
        const commits = store.listCommits(repo, tip).map((commit) => ({
          sha: commit.sha,
          commit: {
            message: commit.message,
            author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
            committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
          },
          author: { login: VIEWER.login, id: VIEWER.id },
          committer: { login: VIEWER.login, id: VIEWER.id },
        }));
        sendJson(res, 200, commits);
        return;
      }

      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (method === 'GET' && rest.length === 2) {
          const refs = store.listRefs(repo).map((ref) => ({ ref: ref.name, object: { sha: ref.oid } }));
          sendJson(res, 200, refs);
          return;
        }
        if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
          const tip = repo.refs.get(`refs/heads/${rest[3]}`);
          if (tip === undefined) {
            notFound(res);
            return;
          }
          sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha: tip } });
          return;
        }
        if (method === 'POST' && rest.length === 2) {
          const body = await jsonBody(req, res);
          if (body === null) return;
          const ref = typeof body.ref === 'string' ? body.ref : '';
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (!ref.startsWith('refs/') || !isObjectId(sha)) {
            sendJson(res, 422, { message: 'Validation Failed: ref and sha are required' });
            return;
          }
          const object = repo.objects.get(sha);
          if (!object) {
            sendJson(res, 422, { message: 'Validation Failed: object does not exist' });
            return;
          }
          if (repo.refs.has(ref)) {
            sendJson(res, 422, { message: 'Validation Failed: Reference already exists' });
            return;
          }
          repo.refs.set(ref, sha);
          sendJson(res, 201, { ref, object: { sha } });
          return;
        }
        notFound(res);
        return;
      }

      if (rest[0] === 'contents') {
        const filePath = rest.slice(1).join('/');
        if (method === 'GET') {
          const refParam = query.get('ref') ?? repo.default_branch;
          const tip = store.resolveRef(repo, refParam);
          if (tip === null) {
            notFound(res);
            return;
          }
          const treeOid = (() => {
            const object = repo.objects.get(tip);
            return object?.type === 'commit' ? parseCommit(object.data).tree : null;
          })();
          if (treeOid === null) {
            notFound(res);
            return;
          }
          if (filePath === '') {
            const read = store.readPath(repo, treeOid, '');
            if (!read || read.kind !== 'dir') {
              notFound(res);
              return;
            }
            sendJson(res, 200, read.entries.map((entry) => contentEntry(repo, entry, '')));
            return;
          }
          const read = store.readPath(repo, treeOid, filePath);
          if (!read) {
            notFound(res);
            return;
          }
          if (read.kind === 'dir') {
            sendJson(res, 200, read.entries.map((entry) => contentEntry(repo, entry, filePath)));
            return;
          }
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: read.data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            content: read.data.toString('base64'),
            sha: read.oid,
          });
          return;
        }
        if (method === 'PUT') {
          const body = await jsonBody(req, res);
          if (body === null) return;
          const message = typeof body.message === 'string' ? body.message : '';
          const contentB64 = typeof body.content === 'string' ? body.content : '';
          let content: Buffer;
          try {
            content = Buffer.from(contentB64, 'base64');
          } catch {
            sendJson(res, 422, { message: 'Validation Failed: content is not valid base64' });
            return;
          }
          const branch = typeof body.branch === 'string' ? body.branch : repo.default_branch;
          const sha = typeof body.sha === 'string' ? body.sha : undefined;
          if (filePath === '') {
            sendJson(res, 422, { message: 'Validation Failed: path is required' });
            return;
          }
          // A branch that does not exist yet starts from the default branch's tip.
          if (repo.refs.get(`refs/heads/${branch}`) === undefined) {
            const defaultTip = repo.refs.get(`refs/heads/${repo.default_branch}`);
            if (defaultTip !== undefined) repo.refs.set(`refs/heads/${branch}`, defaultTip);
          }
          // Resolve the branch's current tree to decide create vs update.
          const branchTip = repo.refs.get(`refs/heads/${branch}`);
          let currentBlob: string | null = null;
          if (branchTip !== undefined) {
            const object = repo.objects.get(branchTip);
            if (object?.type === 'commit') {
              const read = store.readPath(repo, parseCommit(object.data).tree, filePath);
              if (read?.kind === 'file') currentBlob = read.oid;
            }
          }
          if (currentBlob !== null) {
            if (sha === undefined) {
              sendJson(res, 422, { message: 'Validation Failed: sha is required to update a file' });
              return;
            }
            if (sha !== currentBlob) {
              sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
              return;
            }
          } else if (sha !== undefined) {
            sendJson(res, 422, { message: 'Validation Failed: sha does not match any file' });
            return;
          }
          const { commitSha, contentSha } = store.commitFile(repo, branch, filePath, content, message);
          sendJson(res, currentBlob === null ? 201 : 200, {
            content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: contentSha, size: content.length, encoding: 'base64' },
            commit: { sha: commitSha, message },
          });
          return;
        }
        if (method === 'DELETE') {
          const body = await jsonBody(req, res);
          if (body === null) return;
          const message = typeof body.message === 'string' ? body.message : '';
          const sha = typeof body.sha === 'string' ? body.sha : undefined;
          const branchTip = repo.refs.get(`refs/heads/${repo.default_branch}`);
          if (branchTip === undefined) {
            notFound(res);
            return;
          }
          const object = repo.objects.get(branchTip);
          if (!object || object.type !== 'commit') {
            notFound(res);
            return;
          }
          const read = store.readPath(repo, parseCommit(object.data).tree, filePath);
          if (!read || read.kind !== 'file') {
            notFound(res);
            return;
          }
          if (sha !== undefined && sha !== read.oid) {
            sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
            return;
          }
          const deleted = store.deleteFile(repo, repo.default_branch, filePath, message);
          if (!deleted) {
            notFound(res);
            return;
          }
          sendJson(res, 200, { commit: { sha: deleted.commitSha, message } });
          return;
        }
        notFound(res);
        return;
      }

      if (rest[0] === 'labels') {
        if (method === 'GET' && rest.length === 1) {
          sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
          return;
        }
        if (method === 'POST' && rest.length === 1) {
          const body = await jsonBody(req, res);
          if (body === null) return;
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (name === '') {
            sendJson(res, 422, { message: 'Validation Failed: name is required' });
            return;
          }
          const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
          const existing = repo.labels.get(name);
          if (existing) {
            sendJson(res, 201, { name: existing.name, color: existing.color });
            return;
          }
          const label = { name, color };
          repo.labels.set(name, label);
          sendJson(res, 201, { name: label.name, color: label.color });
          return;
        }
        notFound(res);
        return;
      }

      if (rest[0] === 'issues') {
        if (rest.length === 1) {
          if (method === 'GET') {
            let issues = [...repo.issues];
            const state = query.get('state') ?? 'open';
            if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
            const sort = query.get('sort') ?? 'created';
            const direction = query.get('direction') ?? 'desc';
            if (sort === 'created') {
              issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
            }
            const { page, link } = paginate(req, `/api/v3/repos/${owner}/${name}/issues`, query, issues);
            sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), link === '' ? {} : { link });
            return;
          }
          if (method === 'POST') {
            const body = await jsonBody(req, res);
            if (body === null) return;
            const title = typeof body.title === 'string' ? body.title : '';
            if (title === '') {
              sendJson(res, 422, { message: 'Validation Failed: title is required' });
              return;
            }
            const issueBody = typeof body.body === 'string' ? body.body : '';
            const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
            const created = store.createIssue(repo, title, issueBody, labels);
            if ('error' in created) {
              sendJson(res, 422, { message: created.error });
              return;
            }
            sendJson(res, 201, issueJson(repo, created));
            return;
          }
        }
        const issueNumber = Number.parseInt(rest[1] ?? '', 10);
        const issue = Number.isInteger(issueNumber) ? repo.issues.find((i) => i.number === issueNumber) : undefined;
        if (rest.length === 2) {
          if (!issue) {
            notFound(res);
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, issueJson(repo, issue));
            return;
          }
          if (method === 'PATCH') {
            const body = await jsonBody(req, res);
            if (body === null) return;
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
            sendJson(res, 200, issueJson(repo, issue));
            return;
          }
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (!issue) {
            notFound(res);
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((comment) => ({
              id: comment.id,
              node_id: globalId('IssueComment', owner, name, issue.number, comment.id),
              body: comment.body,
              user: { login: VIEWER.login, id: VIEWER.id },
              created_at: FIXED_ISO,
              updated_at: FIXED_ISO,
            })));
            return;
          }
          if (method === 'POST') {
            const body = await jsonBody(req, res);
            if (body === null) return;
            const commentBody = typeof body.body === 'string' ? body.body : '';
            const comment = { id: store.nextGlobalCommentId(), body: commentBody };
            issue.comments.push(comment);
            sendJson(res, 201, {
              id: comment.id,
              node_id: globalId('IssueComment', owner, name, issue.number, comment.id),
              body: comment.body,
              user: { login: VIEWER.login, id: VIEWER.id },
              created_at: FIXED_ISO,
              updated_at: FIXED_ISO,
            });
            return;
          }
        }
        notFound(res);
        return;
      }

      if (rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (method === 'GET') {
            let pulls = [...repo.pulls];
            const state = query.get('state') ?? 'open';
            if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
            pulls.sort((a, b) => b.seq - a.seq || b.number - a.number);
            const { page, link } = paginate(req, `/api/v3/repos/${owner}/${name}/pulls`, query, pulls);
            sendJson(res, 200, page.map((pull) => pullJson(store, repo, pull)), link === '' ? {} : { link });
            return;
          }
          if (method === 'POST') {
            const body = await jsonBody(req, res);
            if (body === null) return;
            const title = typeof body.title === 'string' ? body.title : '';
            if (title === '') {
              sendJson(res, 422, { message: 'Validation Failed: title is required' });
              return;
            }
            const pullBody = typeof body.body === 'string' ? body.body : '';
            let head = typeof body.head === 'string' ? body.head : '';
            const base = typeof body.base === 'string' ? body.base : repo.default_branch;
            if (head.includes(':')) head = head.split(':').pop() ?? head;
            const created = store.createPull(repo, title, pullBody, head, base);
            if ('error' in created) {
              sendJson(res, 422, { message: created.error });
              return;
            }
            sendJson(res, 201, pullJson(store, repo, created));
            return;
          }
        }
        const pullNumber = Number.parseInt(rest[1] ?? '', 10);
        const pull = Number.isInteger(pullNumber) ? repo.pulls.find((p) => p.number === pullNumber) : undefined;
        if (rest.length === 2) {
          if (!pull) {
            notFound(res);
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, pullJson(store, repo, pull));
            return;
          }
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          if (!pull) {
            notFound(res);
            return;
          }
          const files = store.pullFiles(repo, pull).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          }));
          sendJson(res, 200, files);
          return;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (!pull) {
            notFound(res);
            return;
          }
          const body = await jsonBody(req, res);
          if (body === null) return;
          const merged = store.mergePull(repo, pull);
          if ('error' in merged) {
            sendJson(res, merged.status, { message: merged.error });
            return;
          }
          sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged` });
          return;
        }
        notFound(res);
        return;
      }

      notFound(res);
      return;
    }

    notFound(res);
  }

  function contentEntry(repo: Repo, entry: { mode: string; name: string; oid: string }, dir: string): Record<string, unknown> {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const object = repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      encoding: isDir ? undefined : 'base64',
      size: isDir ? 0 : (object?.data.length ?? 0),
      name: entry.name,
      path,
      sha: entry.oid,
    };
  }

  // -------------------------------------------------------------------------------------------
  // GraphQL
  // -------------------------------------------------------------------------------------------

  async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      badRequest(res, 'Invalid JSON');
      return;
    }
    const runOne = (operation: unknown): { data: Record<string, unknown> | null; errors: { message: string }[] } => {
      if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
        return { data: null, errors: [{ message: 'Expected a GraphQL operation object' }] };
      }
      const op = operation as { query?: unknown; variables?: unknown };
      if (typeof op.query !== 'string') {
        return { data: null, errors: [{ message: 'Expected a query string' }] };
      }
      const variables = (typeof op.variables === 'object' && op.variables !== null ? op.variables : {}) as Record<string, unknown>;
      return executeOperation(store, op.query, variables);
    };
    if (Array.isArray(parsed)) {
      sendJson(res, 200, parsed.map(runOne));
      return;
    }
    sendJson(res, 200, runOne(parsed));
  }

  // -------------------------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------------------------

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'POST';
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
      return;
    }
    const answer = handleMcpRequest(store, parsed);
    if (answer === null) {
      res.writeHead(202, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    const extra: Record<string, string> = {};
    const rpcMethod = (parsed as { method?: unknown }).method;
    if (rpcMethod === 'initialize') extra['mcp-session-id'] = 'mcp-session-1';
    sendJson(res, 200, answer, extra);
  }

  // -------------------------------------------------------------------------------------------
  // dispatch
  // -------------------------------------------------------------------------------------------

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        const query = queryOf(req);

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch) {
          const owner = gitMatch[1]!;
          const name = gitMatch[2]!;
          const suffix = gitMatch[3]!;
          if (!checkAuth(req)) {
            unauthorized(res);
            return;
          }
          const repo = gitRepo(req, res, owner, name);
          if (!repo) return;
          if (method === 'GET' && suffix === 'info/refs') {
            const service = query.get('service');
            if (service === 'git-upload-pack') {
              if (req.headers['git-protocol'] === 'version=2') advertiseV2(res);
              else advertiseV0(res, repo, 'git-upload-pack');
              return;
            }
            if (service === 'git-receive-pack') {
              advertiseV0(res, repo, 'git-receive-pack');
              return;
            }
            notFound(res);
            return;
          }
          if (method === 'POST' && suffix === 'git-upload-pack') {
            await handleUploadPack(req, res, repo);
            return;
          }
          if (method === 'POST' && suffix === 'git-receive-pack') {
            await handleReceivePack(req, res, repo);
            return;
          }
          notFound(res);
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            notFound(res);
            return;
          }
          if (!checkAuth(req)) {
            unauthorized(res);
            return;
          }
          await handleGraphql(req, res);
          return;
        }

        if (path === '/mcp') {
          if (!checkAuth(req)) {
            unauthorized(res);
            return;
          }
          await handleMcp(req, res);
          return;
        }

        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          if (!checkAuth(req)) {
            unauthorized(res);
            return;
          }
          const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter((s) => s !== '');
          await handleRest(req, res, segments, query);
          return;
        }

        notFound(res);
      } catch (err) {
        try {
          sendJson(res, 500, { message: (err as Error).message || 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
