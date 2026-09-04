/**
 * LocalStore — IndexedDB 기반 저장소.
 * 설정 없이 즉시 동작하지만 데이터는 "그 브라우저에만" 남습니다.
 * 시연·연수·오프라인 실습용 기본값입니다.
 */
import { uid } from '../utils.js';
import { DemoAuth } from './demo-auth.js';

const DB_NAME = 'assignment-hub';
const DB_VER = 4;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('submissions')) {
        const s = db.createObjectStore('submissions', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('email', 'author.email');
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('materials')) {
        db.createObjectStore('materials', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('posts')) {
        db.createObjectStore('posts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('evaluations')) {
        // id 는 "프로젝트::투표자" — 한 사람이 한 프로젝트에 한 장만 냅니다.
        const e = db.createObjectStore('evaluations', { keyPath: 'id' });
        e.createIndex('projectId', 'projectId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    try { result = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = (req) => ({ __req: req });

/** 투표용지 하나를 가리키는 키 — 한 사람이 한 프로젝트에 한 장만 냅니다. */
const ballotId = (projectId, email) => `${projectId}::${String(email || '').toLowerCase()}`;

/** 공지를 맨 위로, 그 안에서는 최신순 — 서버(R2) 와 같은 규칙입니다. */
function sortPosts(list) {
  return [...list].sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

export class LocalStore {
  constructor() {
    this.kind = 'local';
    this.urlCache = new Map();
    // 서버가 없으므로 회원 기능은 브라우저 안에서 흉내만 냅니다(시연용).
    this.auth = new DemoAuth(this);
  }

  /** 이 저장소가 지금 쓰기 가능한지. 로컬은 항상 가능. */
  capabilities() {
    return { canWrite: true, canPublicWrite: true, needsToken: false, shared: false };
  }

  async init() {
    await openDB();
    await this.auth.refresh();
  }

  /* ------------------------------------------------------------ projects */

  async listProjects() {
    const rows = await tx('projects', 'readonly', (os) => wrap(os.getAll()));
    return (rows || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getProject(id) {
    return (await tx('projects', 'readonly', (os) => wrap(os.get(id)))) || null;
  }

  async saveProject(project) {
    const now = new Date().toISOString();
    const rec = { ...project };
    if (!rec.id) { rec.id = uid('p_'); rec.createdAt = now; }
    rec.updatedAt = now;
    await tx('projects', 'readwrite', (os) => os.put(rec));
    return rec;
  }

  async deleteProject(id) {
    const subs = await this.listSubmissions({ projectId: id });
    for (const s of subs) await this.deleteSubmission(s.id);
    await this.deleteEvaluation(id, { all: true });
    await tx('projects', 'readwrite', (os) => os.delete(id));
  }

  /* --------------------------------------------------------- submissions */

  async listSubmissions({ projectId = null, email = null } = {}) {
    const rows = await tx('submissions', 'readonly', (os) => wrap(os.getAll()));
    let out = rows || [];
    if (projectId) out = out.filter((s) => s.projectId === projectId);
    if (email) out = out.filter((s) => s.author?.email === email);
    return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getSubmission(id) {
    return (await tx('submissions', 'readonly', (os) => wrap(os.get(id)))) || null;
  }

  /**
   * @param {object} sub          제출 레코드 (id 없으면 신규)
   * @param {File[]} newFiles     새로 추가할 파일
   */
  async saveSubmission(sub, newFiles = []) {
    const now = new Date().toISOString();
    const rec = { ...sub, files: [...(sub.files || [])] };
    if (!rec.id) { rec.id = uid('s_'); rec.createdAt = now; }
    rec.updatedAt = now;

    // 제출자는 로그인한 회원으로 고정합니다.
    // (R2 모드에서는 서버가 같은 일을 하므로 화면 코드가 갈라지지 않습니다.)
    if (!rec.author) {
      const me = this.auth?.me();
      if (!me) throw new Error('로그인이 필요합니다.');
      rec.author = { institution: me.institution || '', name: me.name, email: me.email };
    }

    for (const file of newFiles) {
      const fid = uid('f_');
      await tx('blobs', 'readwrite', (os) => os.put({ id: fid, blob: file }));
      rec.files.push({
        id: fid,
        name: file.name,
        size: file.size,
        type: file.type || '',
        storage: 'idb',
      });
    }

    await tx('submissions', 'readwrite', (os) => os.put(rec));
    return rec;
  }

  async deleteSubmission(id) {
    const sub = await this.getSubmission(id);
    if (sub) {
      for (const f of sub.files || []) await this.deleteFile(f);
    }
    await tx('submissions', 'readwrite', (os) => os.delete(id));
    // 사라진 제출물에 찍힌 표는 결과 화면에 유령으로 남지 않도록 걷어냅니다.
    await this.dropPicks(new Set([id]));
  }

  /* ------------------------------------------------------------- 평가 -- */

  async listEvaluations({ projectId = null } = {}) {
    const rows = await tx('evaluations', 'readonly', (os) => wrap(os.getAll()));
    const out = rows || [];
    return projectId ? out.filter((b) => b.projectId === projectId) : out;
  }

  async saveEvaluation(projectId, picks) {
    const me = this.auth?.me();
    if (!me) throw new Error('로그인이 필요합니다.');
    const now = new Date().toISOString();
    const id = ballotId(projectId, me.email);
    const before = await tx('evaluations', 'readonly', (os) => wrap(os.get(id)));
    const rec = {
      id,
      projectId,
      voter: { email: me.email, name: me.name, institution: me.institution || '' },
      picks: Array.isArray(picks) ? picks : [],
      createdAt: before?.createdAt || now,
      updatedAt: now,
    };
    await tx('evaluations', 'readwrite', (os) => os.put(rec));
    return rec;
  }

  async deleteEvaluation(projectId, { all = false } = {}) {
    const me = this.auth?.me();
    const rows = await this.listEvaluations({ projectId });
    const gone = all ? rows : rows.filter((b) => b.voter?.email === me?.email);
    for (const b of gone) await tx('evaluations', 'readwrite', (os) => os.delete(b.id));
  }

  /** 지워진 제출물에 찍힌 표를 모든 투표용지에서 걷어냅니다. */
  async dropPicks(ids) {
    const rows = await this.listEvaluations();
    for (const b of rows) {
      if (!(b.picks || []).some((p) => ids.has(p.submissionId))) continue;
      const next = { ...b, picks: (b.picks || []).filter((p) => !ids.has(p.submissionId)) };
      await tx('evaluations', 'readwrite', (os) => os.put(next));
    }
  }

  /** 탈퇴·삭제된 회원이 넣은 투표용지를 지웁니다. */
  async dropVoter(email) {
    const e = String(email || '').toLowerCase();
    const rows = await this.listEvaluations();
    for (const b of rows) {
      if (String(b.voter?.email || '').toLowerCase() !== e) continue;
      await tx('evaluations', 'readwrite', (os) => os.delete(b.id));
    }
  }

  /* ----------------------------------------------------------- materials */

  async listMaterials() {
    const rows = await tx('materials', 'readonly', (os) => wrap(os.getAll()));
    return (rows || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getMaterial(id) {
    return (await tx('materials', 'readonly', (os) => wrap(os.get(id)))) || null;
  }

  async saveMaterial(material, newFiles = []) {
    const now = new Date().toISOString();
    const rec = { ...material, files: [...(material.files || [])] };
    if (!rec.id) { rec.id = uid('m_'); rec.createdAt = now; }
    rec.updatedAt = now;

    for (const file of newFiles) {
      const fid = uid('f_');
      await tx('blobs', 'readwrite', (os) => os.put({ id: fid, blob: file }));
      rec.files.push({
        id: fid, name: file.name, size: file.size, type: file.type || '', storage: 'idb',
      });
    }

    await tx('materials', 'readwrite', (os) => os.put(rec));
    return rec;
  }

  async deleteMaterial(id) {
    const m = await this.getMaterial(id);
    if (m) for (const f of m.files || []) await this.deleteFile(f);
    await tx('materials', 'readwrite', (os) => os.delete(id));
  }

  /* --------------------------------------------------------------- 소통방 */

  async listPosts() {
    const rows = await tx('posts', 'readonly', (os) => wrap(os.getAll()));
    return sortPosts(rows || []);
  }

  async getPost(id) {
    return (await tx('posts', 'readonly', (os) => wrap(os.get(id)))) || null;
  }

  async savePost(post) {
    const now = new Date().toISOString();
    const me = this.auth?.me();
    if (!me) throw new Error('로그인이 필요합니다.');

    const rec = post.id
      ? { ...(await this.getPost(post.id)), title: post.title, body: post.body }
      : {
        id: uid('b_'),
        author: { institution: me.institution || '', name: me.name, email: me.email },
        title: post.title,
        body: post.body,
        pinned: false,
        comments: [],
        createdAt: now,
      };
    rec.updatedAt = now;
    await tx('posts', 'readwrite', (os) => os.put(rec));
    return rec;
  }

  async pinPost(id, pinned) {
    const rec = await this.getPost(id);
    if (!rec) throw new Error('글을 찾을 수 없습니다.');
    rec.pinned = Boolean(pinned);
    rec.updatedAt = new Date().toISOString();
    await tx('posts', 'readwrite', (os) => os.put(rec));
    return rec;
  }

  async deletePost(id) {
    await tx('posts', 'readwrite', (os) => os.delete(id));
  }

  async addComment(postId, body) {
    const me = this.auth?.me();
    if (!me) throw new Error('로그인이 필요합니다.');
    const rec = await this.getPost(postId);
    if (!rec) throw new Error('글을 찾을 수 없습니다.');
    rec.comments = [...(rec.comments || []), {
      id: uid('c_'),
      author: { institution: me.institution || '', name: me.name, email: me.email },
      body,
      createdAt: new Date().toISOString(),
    }];
    await tx('posts', 'readwrite', (os) => os.put(rec));
    return rec;
  }

  async deleteComment(postId, commentId) {
    const rec = await this.getPost(postId);
    if (!rec) throw new Error('글을 찾을 수 없습니다.');
    rec.comments = (rec.comments || []).filter((c) => c.id !== commentId);
    await tx('posts', 'readwrite', (os) => os.put(rec));
    return rec;
  }

  /* --------------------------------------------------------------- files */

  async deleteFile(fileRef) {
    if (!fileRef?.id) return;
    this.revoke(fileRef.id);
    await tx('blobs', 'readwrite', (os) => os.delete(fileRef.id));
  }

  async fileURL(fileRef) {
    if (!fileRef) return null;
    if (this.urlCache.has(fileRef.id)) return this.urlCache.get(fileRef.id);
    const rec = await tx('blobs', 'readonly', (os) => wrap(os.get(fileRef.id)));
    if (!rec?.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    this.urlCache.set(fileRef.id, url);
    return url;
  }

  revoke(id) {
    const url = this.urlCache.get(id);
    if (url) { URL.revokeObjectURL(url); this.urlCache.delete(id); }
  }

  /* --------------------------------------------------------- import/export */

  async exportAll() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: await this.listProjects(),
      submissions: await this.listSubmissions(),
      materials: await this.listMaterials(),
      posts: await this.listPosts(),
      evaluations: await this.listEvaluations(),
    };
  }

  /** 파일 blob 은 제외하고 메타데이터만 복원합니다. */
  async importAll(dump) {
    for (const p of dump.projects || []) {
      await tx('projects', 'readwrite', (os) => os.put(p));
    }
    for (const s of dump.submissions || []) {
      await tx('submissions', 'readwrite', (os) => os.put(s));
    }
    for (const m of dump.materials || []) {
      await tx('materials', 'readwrite', (os) => os.put(m));
    }
    for (const b of dump.posts || []) {
      await tx('posts', 'readwrite', (os) => os.put(b));
    }
    for (const b of dump.evaluations || []) {
      const rec = b.id ? b : { ...b, id: ballotId(b.projectId, b.voter?.email) };
      await tx('evaluations', 'readwrite', (os) => os.put(rec));
    }
  }
}
