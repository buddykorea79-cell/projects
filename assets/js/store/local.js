/**
 * LocalStore — IndexedDB 기반 저장소.
 * 설정 없이 즉시 동작하지만 데이터는 "그 브라우저에만" 남습니다.
 * 시연·연수·오프라인 실습용 기본값입니다.
 */
import { uid } from '../utils.js';

const DB_NAME = 'assignment-hub';
const DB_VER = 2;

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

export class LocalStore {
  constructor() {
    this.kind = 'local';
    this.urlCache = new Map();
  }

  /** 이 저장소가 지금 쓰기 가능한지. 로컬은 항상 가능. */
  capabilities() {
    return { canWrite: true, canPublicWrite: true, needsToken: false, shared: false };
  }

  async init() { await openDB(); }

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
  }
}
