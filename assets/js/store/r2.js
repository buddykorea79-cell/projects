/**
 * R2Store — Cloudflare R2 를 쓰는 저장소.
 *
 *   data/projects.json      프로젝트 색인
 *   data/submissions.json   제출물 색인
 *   data/materials.json     강의자료 색인
 *   uploads/<제출ID>/…                과제 첨부
 *   uploads/materials/<자료ID>/…      강의자료
 *
 * 브라우저는 R2 를 직접 만지지 않고 같은 도메인의 `/api` 만 호출합니다.
 * 버킷 접근 권한은 Cloudflare 바인딩으로만 존재하므로 브라우저에 비밀값이
 * 내려가지 않습니다. 토큰을 나눠줄 필요가 없어 교육생이 그냥 제출할 수 있습니다.
 */
import { CONFIG } from '../config.js';
import { uid } from '../utils.js';

const MAX_RETRY = 5;
const TOKEN_KEY = 'ah.r2.materialsToken';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class R2Store {
  constructor(cfg = CONFIG.r2) {
    this.kind = 'r2';
    this.base = String(cfg?.apiBase || '/api').replace(/\/$/, '');
    /** 서버가 강의자료 다운로드를 잠그고 있는지 — /health 로 확인합니다. */
    this.materialsGate = false;
    this.maxUploadMB = null;
    this.ready = false;
  }

  capabilities() {
    return {
      canWrite: true,
      /** 교육생이 토큰 없이 바로 제출할 수 있습니다. */
      canPublicWrite: true,
      needsToken: false,
      shared: true,
    };
  }

  async init() {
    try {
      const res = await fetch(`${this.base}/health`, { cache: 'no-store' });
      if (!res.ok) throw await this.httpError(res);
      const info = await res.json();
      this.materialsGate = Boolean(info.materialsGate);
      this.maxUploadMB = info.maxUploadMB ?? null;
      this.ready = true;
    } catch (e) {
      throw new Error(
        `저장소 API 에 연결하지 못했습니다 (${this.base}/health). `
        + `Cloudflare Pages 에 R2 버킷이 BUCKET 이름으로 바인딩되어 있는지 확인하세요. — ${e.message}`,
      );
    }
  }

  /* ------------------------------------------------------------ 저수준 */

  async httpError(res) {
    let detail = '';
    try { detail = (await res.json())?.message || ''; } catch { /* ignore */ }
    const err = new Error(detail || `요청 실패 (${res.status})`);
    err.status = res.status;
    return err;
  }

  /** 색인 하나를 읽습니다. 서버가 없으면 빈 배열로 만들어 줍니다. */
  async readIndex(name) {
    const res = await fetch(`${this.base}/data/${name}`, { cache: 'no-store' });
    if (!res.ok) throw await this.httpError(res);
    const body = await res.json();
    return { etag: body.etag, data: Array.isArray(body.data) ? body.data : [] };
  }

  /**
   * 색인을 read-modify-write 합니다.
   * 그 사이 다른 사람이 저장해 etag 가 어긋나면 서버가 409 와 함께 최신본을
   * 실어 보내므로, 추가 조회 없이 그 위에 다시 적용해 재시도합니다.
   */
  async mutateIndex(name, mutator) {
    let snapshot = await this.readIndex(name);

    for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
      const next = await mutator(structuredClone(snapshot.data));
      const res = await fetch(`${this.base}/data/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ etag: snapshot.etag, data: next }),
      });

      if (res.ok) return next;
      if (res.status !== 409) throw await this.httpError(res);

      const body = await res.json().catch(() => ({}));
      snapshot = body.current?.etag ? body.current : await this.readIndex(name);
      await sleep(120 * (attempt + 1) + Math.random() * 200);
    }
    throw new Error('다른 사용자의 저장과 계속 겹쳐 반영하지 못했습니다. 잠시 후 다시 시도하세요.');
  }

  /** 파일 하나를 R2 에 올리고 파일 레코드를 돌려줍니다. */
  async uploadFile(file, dir) {
    const qs = new URLSearchParams({ dir, name: file.name });
    const res = await fetch(`${this.base}/upload?${qs}`, {
      method: 'POST',
      headers: { 'X-File-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw await this.httpError(res);
    const out = await res.json();
    return {
      id: uid('f_'),
      name: file.name,
      size: out.size ?? file.size,
      type: out.type || file.type || '',
      storage: 'r2',
      key: out.key,
    };
  }

  async attachFiles(rec, newFiles, dir) {
    for (const file of newFiles) {
      rec.files.push(await this.uploadFile(file, dir));
    }
  }

  /* ---------------------------------------------------------- projects */

  async listProjects() {
    const { data } = await this.readIndex('projects');
    return data.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getProject(id) {
    return (await this.listProjects()).find((p) => p.id === id) || null;
  }

  async saveProject(project) {
    const now = new Date().toISOString();
    const rec = { ...project };
    if (!rec.id) { rec.id = uid('p_'); rec.createdAt = now; }
    rec.updatedAt = now;
    await this.mutateIndex('projects', (list) => upsert(list, rec));
    return rec;
  }

  async deleteProject(id) {
    for (const s of await this.listSubmissions({ projectId: id })) {
      await this.deleteSubmission(s.id);
    }
    await this.mutateIndex('projects', (list) => list.filter((p) => p.id !== id));
  }

  /* ------------------------------------------------------- submissions */

  async listSubmissions({ projectId = null, email = null } = {}) {
    const { data } = await this.readIndex('submissions');
    let out = data;
    if (projectId) out = out.filter((s) => s.projectId === projectId);
    if (email) out = out.filter((s) => s.author?.email === email);
    return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getSubmission(id) {
    const { data } = await this.readIndex('submissions');
    return data.find((s) => s.id === id) || null;
  }

  async saveSubmission(sub, newFiles = []) {
    const now = new Date().toISOString();
    const rec = { ...sub, files: [...(sub.files || [])] };
    if (!rec.id) { rec.id = uid('s_'); rec.createdAt = now; }
    rec.updatedAt = now;

    // 파일을 먼저 올린 뒤 색인을 갱신합니다.
    // 순서가 반대면 파일 없는 항목이 잠깐 목록에 보입니다.
    await this.attachFiles(rec, newFiles, rec.id);
    await this.mutateIndex('submissions', (list) => upsert(list, rec));
    return rec;
  }

  async deleteSubmission(id) {
    const sub = await this.getSubmission(id);
    if (sub) for (const f of sub.files || []) await this.deleteFile(f);
    await this.mutateIndex('submissions', (list) => list.filter((s) => s.id !== id));
  }

  /* --------------------------------------------------------- materials */

  async listMaterials() {
    const { data } = await this.readIndex('materials');
    return data.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getMaterial(id) {
    return (await this.listMaterials()).find((m) => m.id === id) || null;
  }

  async saveMaterial(material, newFiles = []) {
    const now = new Date().toISOString();
    const rec = { ...material, files: [...(material.files || [])] };
    if (!rec.id) { rec.id = uid('m_'); rec.createdAt = now; }
    rec.updatedAt = now;

    await this.attachFiles(rec, newFiles, `materials/${rec.id}`);
    await this.mutateIndex('materials', (list) => upsert(list, rec));
    return rec;
  }

  async deleteMaterial(id) {
    const m = await this.getMaterial(id);
    if (m) for (const f of m.files || []) await this.deleteFile(f);
    await this.mutateIndex('materials', (list) => list.filter((x) => x.id !== id));
  }

  /* ------------------------------------------------------------- files */

  async deleteFile(fileRef) {
    if (!fileRef?.key) return;
    try {
      const res = await fetch(`${this.base}/file/${encodeURI(fileRef.key)}`, { method: 'DELETE' });
      if (!res.ok) throw await this.httpError(res);
    } catch (e) {
      // 파일이 이미 없어도 색인 정리는 계속되어야 합니다.
      console.warn('첨부 삭제 실패:', e.message);
    }
  }

  async fileURL(fileRef) {
    if (!fileRef?.key) return null;
    const url = `${this.base}/file/${encodeURI(fileRef.key)}`;
    if (this.materialsGate && fileRef.key.startsWith('uploads/materials/')) {
      const token = this.materialsToken();
      if (!token) return null;
      return `${url}?t=${encodeURIComponent(token)}`;
    }
    return url;
  }

  revoke() { /* 서버가 주는 URL 이라 해제할 것이 없습니다 */ }

  /* --------------------------------------------- 강의자료 다운로드 토큰 */

  materialsToken() {
    if (!this.materialsGate) return null;
    try {
      const raw = sessionStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const { token, expiresAt } = JSON.parse(raw);
      if (!token || !expiresAt || expiresAt < Date.now()) {
        sessionStorage.removeItem(TOKEN_KEY);
        return null;
      }
      return token;
    } catch { return null; }
  }

  hasMaterialsAccess() { return !this.materialsGate || Boolean(this.materialsToken()); }

  /** 서버에 비밀번호를 확인받고 다운로드용 서명 토큰을 받아 둡니다. */
  async authorizeMaterials(password) {
    if (!this.materialsGate) return true;
    const res = await fetch(`${this.base}/materials/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw await this.httpError(res);
    const out = await res.json();
    if (out.token) {
      try {
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
          token: out.token, expiresAt: out.expiresAt,
        }));
      } catch { /* private mode */ }
    }
    return true;
  }

  clearMaterialsAccess() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------ import/export */

  async exportAll() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: await this.listProjects(),
      submissions: await this.listSubmissions(),
      materials: await this.listMaterials(),
    };
  }

  async importAll(dump) {
    for (const name of ['projects', 'submissions', 'materials']) {
      if (Array.isArray(dump[name])) {
        await this.mutateIndex(name, () => dump[name]);
      }
    }
  }
}

/** 같은 id 가 있으면 교체하고 없으면 추가합니다. */
function upsert(list, rec) {
  const arr = Array.isArray(list) ? list : [];
  const i = arr.findIndex((x) => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  return arr;
}
