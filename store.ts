// store.ts — the forge's in-memory store: repositories, refs, git objects,
// issues, labels, pull requests, and the operations REST, GraphQL and MCP
// share. Everything is deterministic: fixed timestamps, fixed author identity,
// creation-order sequences (no wall clock, no randomness).

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

/** The token owner, from the kit's fixed scenario seed (wire.ts buildScenario). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const FIXED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const AUTHOR_LINE = `${VIEWER.name} <${VIEWER.email}> ${FIXED_EPOCH} +0000`;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  comments: IssueComment[];
  // Pre-serialized single-issue JSON body (with trailing newline), rebuilt
  // lazily after any mutation. v3: the read workload fetches the same issue
  // 2,000x, so caching its exact bytes removes the per-request rebuild.
  cachedJson: Buffer | null;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** Bumped on every refs mutation; response caches key on it. */
  refsVersion: number;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  seq: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1000;
  private nextIssueId = 10000;
  private nextCommentId = 50000;
  private nextRepoSeq = 0;
  private nextSeq = 0;
  // Cache of fetch results (pack bytes + shallow/unshallow lines). The result
  // is a pure function of the repo's content-addressed objects and the fetch
  // arguments, so a cached entry stays valid without invalidation: two repos
  // with the same name and the same wanted oids hold the same objects.
  private fetchCache = new Map<string, { pack: Buffer | null; shallow: string[]; unshallow: string[] }>();

  /** objectsForFetch result with the pack already serialised, cached so that
   * repeated identical fetches (e.g. 50 concurrent shallow clones of one
   * repo) only build the pack once. */
  fetchResult(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth: number | null,
    clientShallow: readonly string[],
  ): { pack: Buffer | null; shallow: string[]; unshallow: string[] } {
    const key = [repo.full_name, wants.join(','), haves.join(','), depth === null ? '' : String(depth), clientShallow.join(',')].join('|');
    const cached = this.fetchCache.get(key);
    if (cached) return cached;
    const { objects, shallow, unshallow } = this.objectsForFetch(repo, wants, haves, depth, clientShallow);
    const result = { pack: objects.length > 0 ? writePack(objects) : null, shallow, unshallow };
    if (this.fetchCache.size >= 128) this.fetchCache.clear();
    // Only cache modest packs; a full clone of a huge repo must not pin memory.
    if (result.pack === null || result.pack.length <= 512 * 1024) this.fetchCache.set(key, result);
    return result;
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string } = {}): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      full_name: key,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: 'main',
      objects: new Map(),
      refs: new Map(),
      refsVersion: 0,
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      seq: this.nextRepoSeq++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.seq - b.seq);
  }

  nextGlobalIssueId(): number {
    return this.nextIssueId++;
  }

  nextGlobalCommentId(): number {
    return this.nextCommentId++;
  }

  nextCreationSeq(): number {
    return this.nextSeq++;
  }

  // -----------------------------------------------------------------------------------------
  // git objects
  // -----------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The tip of a ref, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a branch name, full ref, or object id to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (!object) return null;
      if (object.type === 'commit') return ref;
      if (object.type === 'tag') return parseTag(object.data).object;
      return null;
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const tip = repo.refs.get(full);
    if (tip === undefined) return null;
    const object = repo.objects.get(tip);
    if (!object) return null;
    if (object.type === 'commit') return tip;
    if (object.type === 'tag') return parseTag(object.data).object;
    return null;
  }

  /** All refs, sorted by name, each with its peeled target for annotated tags. */
  listRefs(repo: Repo): { name: string; oid: string; peeled?: string }[] {
    const out: { name: string; oid: string; peeled?: string }[] = [];
    for (const name of [...repo.refs.keys()].sort()) {
      const oid = repo.refs.get(name)!;
      const entry: { name: string; oid: string; peeled?: string } = { name, oid };
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') entry.peeled = parseTag(object.data).object;
      out.push(entry);
    }
    return out;
  }

  /** Walk commits reachable from `tip`, newest first (parents after children). */
  listCommits(repo: Repo, tip: string, limit = 1000): { sha: string; message: string; author: string; committer: string }[] {
    const out: { sha: string; message: string; author: string; committer: string }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The merge base of two commits: the common ancestor closest to both. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    if (treeOid !== null) walk(treeOid, '');
    return out;
  }

  /** Set (or delete, when blobOid is null) one path in a tree, returning the new root tree oid. */
  setPathInTree(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const object = repo.objects.get(treeOid);
        if (object?.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const segment = segments[depth]!;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(segment);
        else entries.set(segment, { mode: '100644', name: segment, oid: blobOid });
      } else {
        const child = entries.get(segment);
        const childOid = child && child.mode === '40000' ? child.oid : null;
        const next = build(childOid, depth + 1);
        entries.set(segment, { mode: '40000', name: segment, oid: next });
      }
      // Drop directories that became empty.
      for (const [name, entry] of [...entries]) {
        if (entry.mode === '40000') {
          const object = repo.objects.get(entry.oid);
          if (!object || object.type !== 'tree' || parseTree(object.data).length === 0) entries.delete(name);
        }
      }
      return this.putObject(repo, 'tree', buildTree([...entries.values()]));
    };
    return build(rootTreeOid, 0);
  }

  /** Read one path out of a tree: the blob oid and its bytes, or a directory listing, or null. */
  readPath(
    repo: Repo,
    treeOid: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segments[depth]);
      if (!entry) return null;
      if (depth === segments.length - 1) {
        if (entry.mode === '40000') {
          const dir = repo.objects.get(entry.oid);
          if (!dir || dir.type !== 'tree') return null;
          return { kind: 'dir', entries: parseTree(dir.data) };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    return { kind: 'dir', entries: parseTree(object.data) };
  }

  /** Create a commit on `branch` (creating the branch when it does not exist). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    let parentTree: string | null = null;
    const parents: string[] = [];
    if (tip !== null) {
      const object = repo.objects.get(tip);
      if (object?.type === 'commit') {
        parentTree = parseCommit(object.data).tree;
        parents.push(tip);
      }
    }
    const blobOid = this.putObject(repo, 'blob', content);
    const treeOid = this.setPathInTree(repo, parentTree, path, blobOid);
    const commitData = buildCommit({ tree: treeOid, parents, message, author: AUTHOR_LINE, committer: AUTHOR_LINE });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    repo.refsVersion += 1;
    return { commitSha, contentSha: blobOid };
  }

  /** Delete one path from a branch's tree, committing the result. Returns null when nothing to delete. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null) return null;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const commit = parseCommit(object.data);
    const read = this.readPath(repo, commit.tree, path);
    if (!read || read.kind !== 'file') return null;
    const treeOid = this.setPathInTree(repo, commit.tree, path, null);
    const commitData = buildCommit({ tree: treeOid, parents: [tip], message, author: AUTHOR_LINE, committer: AUTHOR_LINE });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    repo.refsVersion += 1;
    return { commitSha };
  }

  // -----------------------------------------------------------------------------------------
  // issues and pull requests
  // -----------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { error: `Validation Failed: label "${name}" does not exist` };
    }
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: labelNames.map((name) => repo.labels.get(name)!),
      seq: this.nextSeq++,
      comments: [],
      cachedJson: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    if (headTip === undefined) return { error: `Validation Failed: head branch "${head}" does not exist` };
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (baseTip === undefined) return { error: `Validation Failed: base branch "${base}" does not exist` };
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (existing) return { error: `Validation Failed: A pull request already exists for ${head} into ${base}` };
    const pull: Pull = {
      number: repo.nextNumber++,
      id: this.nextIssueId++,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      seq: this.nextSeq++,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** The current head/base shas of a pull request (branches may have moved). */
  pullShas(repo: Repo, pull: Pull): { headSha: string; baseSha: string } {
    return {
      headSha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha,
      baseSha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha,
    };
  }

  /** Is this pull request mergeable (no conflicting change to the same path)? */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const { headSha, baseSha } = this.pullShas(repo, pull);
    if (headSha === baseSha) return true;
    const base = this.mergeBase(repo, headSha, baseSha);
    if (base === null) return false;
    if (base === baseSha) return true; // base has not moved: fast-forward
    const baseTree = this.treeOf(repo, base);
    const headTree = this.treeOf(repo, headSha);
    const baseTipTree = this.treeOf(repo, baseSha);
    if (baseTree === null || headTree === null || baseTipTree === null) return false;
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const tipFiles = this.flattenTree(repo, baseTipTree);
    const paths = new Set([...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path)?.oid ?? null;
      const h = headFiles.get(path)?.oid ?? null;
      const t = tipFiles.get(path)?.oid ?? null;
      if (h !== b && t !== b && h !== t) return false;
    }
    return true;
  }

  private treeOf(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** The file diff between a pull request's base tip and head tip. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] {
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const baseTree = this.treeOf(repo, baseSha);
    const headTree = this.treeOf(repo, headSha);
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const out: { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if (b && !h) {
        const lines = countLines(repo.objects.get(b.oid)?.data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (!b && h) {
        const lines = countLines(repo.objects.get(h.oid)?.data);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const newText = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const { additions, deletions } = lineDiff(oldText, newText);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or an error. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    if (!this.pullMergeable(repo, pull)) return { error: 'Merge conflict', status: 405 };
    const { headSha, baseSha } = this.pullShas(repo, pull);
    const headTree = this.treeOf(repo, headSha);
    if (headTree === null) return { error: 'Head commit not found', status: 422 };
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const commitData = buildCommit({ tree: headTree, parents: [baseSha], message, author: AUTHOR_LINE, committer: AUTHOR_LINE });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    repo.refsVersion += 1;
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = FIXED_ISO;
    pull.merge_commit_sha = mergeSha;
    return { sha: mergeSha };
  }

  // -----------------------------------------------------------------------------------------
  // fetch object selection (upload-pack)
  // -----------------------------------------------------------------------------------------

  /**
   * The objects a fetch must send for `wants`, given the client's `haves` and an
   * optional shallow `depth`. Returns the pack objects (in deterministic order),
   * the shallow boundary lines and the unshallow lines.
   */
  objectsForFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth: number | null,
    clientShallow: readonly string[],
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    // What the client already holds. A shallow tip (named in `shallow`) carries
    // only itself and its tree closure — never its parents. A full tip carries
    // its whole reachable graph.
    const haveCommits = new Set<string>();
    const heldObjects = new Set<string>();
    const addTreeClosure = (set: Set<string>, treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length) {
        const current = stack.pop()!;
        if (set.has(current)) continue;
        const currentObject = repo.objects.get(current);
        if (!currentObject) continue;
        set.add(current);
        if (currentObject.type === 'tree') {
          for (const entry of parseTree(currentObject.data)) {
            if (entry.mode === '160000') continue;
            stack.push(entry.oid);
          }
        }
      }
    };
    for (const have of haves) {
      const object = repo.objects.get(have);
      if (!object) continue;
      if (clientShallow.includes(have)) {
        haveCommits.add(have);
        heldObjects.add(have);
        if (object.type === 'commit') addTreeClosure(heldObjects, parseCommit(object.data).tree);
        else if (object.type === 'tag') {
          const target = parseTag(object.data).object;
          heldObjects.add(target);
          const targetObject = repo.objects.get(target);
          if (targetObject?.type === 'commit') addTreeClosure(heldObjects, parseCommit(targetObject.data).tree);
        }
      } else {
        try {
          for (const oid of collectReachable([have], (o) => repo.objects.get(o))) {
            heldObjects.add(oid);
            if (repo.objects.get(oid)?.type === 'commit') haveCommits.add(oid);
          }
        } catch {
          // A have the server does not hold is ignored.
        }
      }
    }

    // Walk from the wants. A held commit is not sent, but the walk continues
    // through it: a deepen asks for the parents of a held shallow tip.
    const included = new Map<string, number>(); // commit oid -> distance from a want
    const queue: { oid: string; dist: number }[] = [];
    const visited = new Set<string>();
    const extraObjects = new Set<string>();
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (!object) continue;
      if (object.type === 'commit') {
        queue.push({ oid: want, dist: 0 });
      } else if (object.type === 'tag') {
        extraObjects.add(want);
        const target = parseTag(object.data).object;
        const targetObject = repo.objects.get(target);
        if (targetObject?.type === 'commit') queue.push({ oid: target, dist: 0 });
        else if (targetObject) extraObjects.add(target);
      } else {
        extraObjects.add(want);
      }
    }
    while (queue.length) {
      const { oid, dist } = queue.shift()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      if (!haveCommits.has(oid)) included.set(oid, dist);
      if (depth !== null && dist + 1 >= depth) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!visited.has(parent)) queue.push({ oid: parent, dist: dist + 1 });
      }
    }

    const send = new Set<string>(extraObjects);
    for (const oid of included.keys()) {
      send.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      // The commit's tree closure only — never its parents (a shallow fetch
      // must not leak history past the depth window).
      addTreeClosure(send, parseCommit(object.data).tree);
    }
    // Never re-send what the client holds.
    for (const oid of heldObjects) send.delete(oid);
    const objects: GitObject[] = [];
    for (const oid of [...send].sort()) {
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }

    const shallow: string[] = [];
    const unshallow: string[] = [];
    if (depth !== null) {
      for (const [oid] of included) {
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.length > 0 && !parents.some((p) => included.has(p))) shallow.push(oid);
      }
      for (const boundary of clientShallow) {
        if (!haves.includes(boundary)) continue;
        const object = repo.objects.get(boundary);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.length > 0 && parents.every((p) => included.has(p))) unshallow.push(boundary);
      }
    }
    return { objects, shallow: [...new Set(shallow)].sort(), unshallow: [...new Set(unshallow)].sort() };
  }
}

function countLines(data: Buffer | undefined): number {
  if (!data || data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** A multiset line diff: lines only in new count as additions, only in old as deletions. */
function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

export { ZERO_OID };
