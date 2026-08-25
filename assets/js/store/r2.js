/**
 * R2Store — Cloudflare R2 저장소 + 서버 회원 인증.
 *
 *   data/projects.json / materials.json   색인 (관리자만 쓰기)
 *   data/submissions.json                 제출물 — 서버만 고칩니다
 *   data/members.json                     회원 명부 — 브라우저로 절대 안 내려옵니다
 *   uploads/m_<회원키>/…                   과제 첨부
 *   uploads/materials/<자료ID>/…           강의자료
 *
 * 브라우저는 같은 도메인의 `/api` 만 호출합니다. 세션은 HttpOnly 쿠키라
 * 자바스크립트로 읽거나 위조할 수 없고, 제출물 수정·삭제 권한은 서버가 봅니다.
 */
import { CONFIG } from '../config.js';
import { uid } from '../utils.js';

const MAX_RETRY = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class R2Store {
  constructor(cfg = CONFIG.r2) {
    this.kind = 'r2';
    this.base = String(cfg?.apiBase || '/api').replace(/\/$/, '');
    this.maxUploadMB = null;
    this.ready = false;
    this.auth = new R2Auth(this);
  }

  capabilities() {
    return { canWrite: true, canPublicWrite: true, needsToken: false, shared: true };
  }

  async init() {
    try {
      const res = await this.fetch('/health', { cache: 'no-store' });
      if (!res.ok) throw await this.httpError(res);
      const info = await res.json();
      this.maxUploadMB = info.maxUploadMB ?? null;
      this.auth.setMe(info.me || null);
      this.auth.synced = true;   // 방금 서버에 확인했습니다
      this.ready = true;
    } catch (e) {
      throw new Error(
        `저장소 API 에 연결하지 못했습니다 (${this.base}/health). `
        + `Cloudflare 에 R2 버킷이 BUCKET 이름으로 연결되어 있는지 확인하세요. — ${e.message}`,
      );
    }
  }

  /* ------------------------------------------------------------ 저수준 */

  /** 세션 쿠키가 함께 가도록 항상 credentials 를 붙입니다. */
  fetch(path, init = {}) {
    return fetch(`${this.base}${path}`, { credentials: 'include', ...init });
  }

  async httpError(res) {
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    const err = new Error(body?.message || `요청 실패 (${res.status})`);
    err.status = res.status;
    err.errors = body?.errors || null;

    // 세션이 끊겼는데(만료·정지·다른 기기 로그아웃) 화면은 로그인한 줄 알고 있으면
    // 엉뚱한 오류 메시지가 뜹니다. 여기서 상태를 정리하고 앱에 알립니다.
    if (res.status === 401 && this.auth?.me()) {
      this.auth.setMe(null);
      window.dispatchEvent(new CustomEvent('ah:auth'));
    }
    return err;
  }

  async json(path, init) {
    const res = await this.fetch(path, init);
    if (!res.ok) throw await this.httpError(res);
    return res.json();
  }

  post(path, body) {
    return this.json(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  /** 프로젝트·강의자료 색인 읽기 (로그인 필요). */
  async readIndex(name) {
    const body = await this.json(`/data/${name}`, { cache: 'no-store' });
    return { etag: body.etag, data: Array.isArray(body.data) ? body.data : [] };
  }

  /**
   * 색인을 read-modify-write 합니다 (관리자 전용 경로).
   * 다른 관리자와 겹쳐 etag 가 어긋나면 서버가 409 와 함께 최신본을 보내주므로
   * 그 위에 다시 적용해 재시도합니다.
   */
  async mutateIndex(name, mutator) {
    let snapshot = await this.readIndex(name);

    for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
      const next = await mutator(structuredClone(snapshot.data));
      const res = await this.fetch(`/data/${name}`, {
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

  /** 파일 하나를 올리고 파일 레코드를 돌려줍니다. 저장 위치는 서버가 정합니다. */
  async uploadFile(file, { kind = 'submission', materialId = null } = {}) {
    const qs = new URLSearchParams({ name: file.name, kind });
    if (materialId) qs.set('materialId', materialId);

    const res = await this.fetch(`/upload?${qs}`, {
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

  /** 서버가 권한에 맞게 걸러 줍니다. 클라이언트 필터는 화면용 편의입니다. */
  async listSubmissions({ projectId = null, email = null } = {}) {
    const { data } = await this.json('/submissions', { cache: 'no-store' });
    let out = Array.isArray(data) ? data : [];
    if (projectId) out = out.filter((s) => s.projectId === projectId);
    if (email) out = out.filter((s) => s.author?.email === email);
    return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getSubmission(id) {
    return (await this.listSubmissions()).find((s) => s.id === id) || null;
  }

  /**
   * @param {object} sub       id 가 있으면 수정, 없으면 신규
   * @param {File[]} newFiles  새로 올릴 파일
   */
  async saveSubmission(sub, newFiles = []) {
    const files = [...(sub.files || [])];
    for (const file of newFiles) files.push(await this.uploadFile(file));

    if (!sub.id) {
      const { submission } = await this.post('/submissions', {
        projectId: sub.projectId,
        title: sub.title,
        body: sub.body,
        files,
      });
      return submission;
    }

    const { submission } = await this.json(`/submissions/${encodeURIComponent(sub.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: sub.title,
        body: sub.body,
        files,
        name: sub.author?.name,
        institution: sub.author?.institution,
      }),
    });
    return submission;
  }

  async deleteSubmission(id) {
    await this.json(`/submissions/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

    for (const file of newFiles) {
      rec.files.push(await this.uploadFile(file, { kind: 'material', materialId: rec.id }));
    }
    await this.mutateIndex('materials', (list) => upsert(list, rec));
    return rec;
  }

  async deleteMaterial(id) {
    const m = await this.getMaterial(id);
    if (m) for (const f of m.files || []) await this.deleteFile(f);
    await this.mutateIndex('materials', (list) => list.filter((x) => x.id !== id));
  }

  /* ------------------------------------------------------------- files */

  /** 관리자만 직접 지울 수 있습니다. 제출물 첨부는 서버가 함께 정리합니다. */
  async deleteFile(fileRef) {
    if (!fileRef?.key) return;
    try {
      await this.json(`/file/${encodeURI(fileRef.key)}`, { method: 'DELETE' });
    } catch (e) {
      console.warn('첨부 삭제 실패:', e.message);
    }
  }

  async fileURL(fileRef) {
    if (!fileRef?.key) return null;
    return `${this.base}/file/${encodeURI(fileRef.key)}`;
  }

  revoke() { /* 서버가 주는 URL 이라 해제할 것이 없습니다 */ }

  /* ------------------------------------------------------ import/export */

  async exportAll() {
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      projects: await this.listProjects(),
      submissions: await this.listSubmissions(),
      materials: await this.listMaterials(),
    };
  }

  async importAll(dump) {
    for (const name of ['projects', 'materials']) {
      if (Array.isArray(dump[name])) await this.mutateIndex(name, () => dump[name]);
    }
    // 제출물은 서버가 소유하므로 통째로 덮어쓰지 않습니다.
  }
}

/* ==================================================== 회원 인증 (서버) == */

class R2Auth {
  constructor(store) {
    this.store = store;
    this.supported = true;
    this.simulated = false;
    /** 서버에 세션 상태를 한 번이라도 확인했는지. 불필요한 /auth/me 호출을 막습니다. */
    this.synced = false;
    this._me = null;
  }

  me() { return this._me; }
  setMe(v) { this._me = v || null; }
  isSignedIn() { return Boolean(this._me); }
  isAdmin() { return this._me?.role === 'admin'; }

  async refresh() {
    try {
      const { me } = await this.store.json('/auth/me', { cache: 'no-store' });
      this.setMe(me);
    } catch {
      this.setMe(null);
    }
    this.synced = true;
    return this._me;
  }

  async signup(payload) {
    const { me } = await this.store.post('/auth/signup', payload);
    this.setMe(me);
    this.synced = true;
    return me;
  }

  async login(email, password) {
    const { me } = await this.store.post('/auth/login', { email, password });
    this.setMe(me);
    this.synced = true;
    return me;
  }

  async logout() {
    try { await this.store.post('/auth/logout'); } catch { /* 이미 끊겼을 수 있음 */ }
    this.setMe(null);
    this.synced = true;
  }

  async changePassword(current, next) {
    await this.store.post('/auth/password', { current, next });
    if (this._me) this._me = { ...this._me, mustChangePassword: false };
  }

  async listMembers() {
    const { data } = await this.store.json('/auth/members', { cache: 'no-store' });
    return Array.isArray(data) ? data : [];
  }

  async patchMember(email, changes) {
    const { member } = await this.store.json('/auth/members', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...changes }),
    });
    return member;
  }

  async resetPassword(email) {
    const { tempPassword } = await this.store.post('/auth/members/reset', { email });
    return tempPassword;
  }
}

function upsert(list, rec) {
  const arr = Array.isArray(list) ? list : [];
  const i = arr.findIndex((x) => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  return arr;
}
