/**
 * GitHubStore — 레포 자체를 데이터베이스로 쓰는 저장소.
 *
 *   data/projects.json      프로젝트 목록
 *   data/submissions.json   제출물 색인(메타데이터)
 *   uploads/<제출ID>/<파일명>  첨부 파일 원본
 *
 * 읽기 : raw.githubusercontent.com — 인증 없이 누구나. (공개 레포 기준)
 * 쓰기 : ① proxyUrl 이 설정돼 있으면 프록시가 토큰을 쥐고 대신 커밋 (교육생용)
 *        ② 없으면 브라우저에 저장된 개인 토큰으로 Contents API 직접 호출 (관리자용)
 */
import { CONFIG } from '../config.js';
import { uid, safeName, fileToBase64, utf8ToBase64 } from '../utils.js';

const TOKEN_KEY = 'ah.gh.token';
const API = 'https://api.github.com';

/** 한 파일에 대한 동시 쓰기 충돌(409/422) 시 재시도 횟수. */
const MAX_RETRY = 5;

export class GitHubStore {
  constructor(cfg = CONFIG.github) {
    this.kind = 'github';
    this.cfg = cfg;
    this.shaCache = new Map();
  }

  /* ---------------------------------------------------------- 토큰 관리 */

  get token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  }
  setToken(v) {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* private mode */ }
  }

  get usesProxy() { return Boolean(this.cfg.proxyUrl); }

  capabilities() {
    return {
      canWrite: this.usesProxy || Boolean(this.token),
      /** 토큰 없는 일반 교육생도 제출할 수 있는가 */
      canPublicWrite: this.usesProxy,
      needsToken: !this.usesProxy,
      shared: true,
    };
  }

  async init() { /* 지연 로딩 — 별도 준비 없음 */ }

  /* ------------------------------------------------------------ 저수준 */

  rawURL(path) {
    const { owner, repo, branch } = this.cfg;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  }

  apiURL(path) {
    const { owner, repo } = this.cfg;
    return `${API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** JSON 파일을 읽습니다. 없으면 fallback 을 돌려줍니다. */
  async readJSON(path, fallback) {
    try {
      const res = await fetch(`${this.rawURL(path)}?t=${Date.now()}`, { cache: 'no-store' });
      if (res.status === 404) return fallback;
      if (!res.ok) throw new Error(`읽기 실패 (${res.status})`);
      return await res.json();
    } catch (e) {
      if (e instanceof SyntaxError) return fallback;
      throw e;
    }
  }

  /**
   * 현재 파일의 blob SHA. 파일이 없으면 null.
   *
   * 프록시가 있으면 프록시를 거칩니다. 인증 없는 GitHub API 는 IP 당 시간당 60회
   * 뿐이라, 교실처럼 여러 명이 같은 공인 IP 를 쓰면 금방 막히기 때문입니다.
   * 조회한 SHA 는 클라이언트로 돌려받아 낙관적 동시성 제어에 그대로 씁니다.
   */
  async currentSha(path) {
    if (this.usesProxy) {
      const res = await this.viaProxy({ op: 'head', path });
      return res?.sha || null;
    }
    const headers = { Accept: 'application/vnd.github+json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.apiURL(path)}?ref=${encodeURIComponent(this.cfg.branch)}`, {
      headers, cache: 'no-store',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`SHA 조회 실패 (${res.status})`);
    const json = await res.json();
    return json.sha || null;
  }

  /**
   * 파일을 커밋합니다.
   * @param {string} path     레포 기준 경로
   * @param {string} base64   내용 (base64)
   * @param {string} message  커밋 메시지
   * @param {string|null} sha 덮어쓸 기존 blob SHA
   */
  async putFile(path, base64, message, sha = null) {
    if (this.usesProxy) {
      return this.viaProxy({ op: 'put', path, content: base64, message, sha });
    }
    if (!this.token) throw new Error('쓰기 권한이 없습니다. GitHub 토큰을 등록하거나 관리자에게 문의하세요.');
    const res = await fetch(this.apiURL(path), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, content: base64, branch: this.cfg.branch, ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) throw await this.httpError(res);
    return res.json();
  }

  async removeFile(path, message) {
    const sha = await this.currentSha(path);
    if (!sha) return;
    if (this.usesProxy) {
      return this.viaProxy({ op: 'delete', path, message, sha });
    }
    if (!this.token) throw new Error('쓰기 권한이 없습니다.');
    const res = await fetch(this.apiURL(path), {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, sha, branch: this.cfg.branch }),
    });
    if (!res.ok) throw await this.httpError(res);
  }

  async viaProxy(payload) {
    const res = await fetch(this.cfg.proxyUrl.replace(/\/$/, '') + '/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, branch: this.cfg.branch }),
    });
    if (!res.ok) throw await this.httpError(res);
    return res.json().catch(() => ({}));
  }

  async httpError(res) {
    let detail = '';
    try { detail = (await res.json())?.message || ''; } catch { /* ignore */ }
    const map = {
      401: '인증 실패 — 토큰이 잘못되었거나 만료되었습니다.',
      403: '권한 없음 — 토큰 범위(contents: write)를 확인하세요.',
      404: '경로를 찾을 수 없습니다 — 소유자/레포/브랜치 설정을 확인하세요.',
      409: '동시 수정 충돌이 발생했습니다.',
      422: '동시 수정 충돌이 발생했습니다.',
      429: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
    };
    const err = new Error(map[res.status] || `요청 실패 (${res.status}) ${detail}`);
    err.status = res.status;
    return err;
  }

  /**
   * JSON 색인 파일을 read-modify-write 합니다.
   * 다른 사람이 동시에 제출해 SHA 가 어긋나면 최신본을 다시 읽어 재시도합니다.
   */
  async mutateJSON(path, fallback, mutator, message) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
      const current = await this.readJSON(path, fallback);
      const sha = await this.currentSha(path);
      const next = await mutator(structuredClone(current));
      const base64 = utf8ToBase64(JSON.stringify(next, null, 2));
      try {
        await this.putFile(path, base64, message, sha);
        return next;
      } catch (e) {
        lastErr = e;
        if (e.status !== 409 && e.status !== 422) throw e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1) + Math.random() * 400));
      }
    }
    throw lastErr || new Error('저장에 반복 실패했습니다.');
  }

  get projectsPath()    { return `${this.cfg.dataDir}/projects.json`; }
  get submissionsPath() { return `${this.cfg.dataDir}/submissions.json`; }

  /* ---------------------------------------------------------- projects */

  async listProjects() {
    const rows = await this.readJSON(this.projectsPath, []);
    return (Array.isArray(rows) ? rows : [])
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getProject(id) {
    return (await this.listProjects()).find((p) => p.id === id) || null;
  }

  async saveProject(project) {
    const now = new Date().toISOString();
    const rec = { ...project };
    const isNew = !rec.id;
    if (isNew) { rec.id = uid('p_'); rec.createdAt = now; }
    rec.updatedAt = now;
    await this.mutateJSON(this.projectsPath, [], (list) => {
      const arr = Array.isArray(list) ? list : [];
      const i = arr.findIndex((p) => p.id === rec.id);
      if (i >= 0) arr[i] = rec; else arr.push(rec);
      return arr;
    }, `${isNew ? 'feat' : 'chore'}(projects): ${isNew ? 'add' : 'update'} ${rec.title || rec.id}`);
    return rec;
  }

  async deleteProject(id) {
    const subs = await this.listSubmissions({ projectId: id });
    for (const s of subs) await this.deleteSubmission(s.id);
    await this.mutateJSON(this.projectsPath, [], (list) =>
      (Array.isArray(list) ? list : []).filter((p) => p.id !== id),
    `chore(projects): remove ${id}`);
  }

  /* ------------------------------------------------------- submissions */

  async listSubmissions({ projectId = null, email = null } = {}) {
    const rows = await this.readJSON(this.submissionsPath, []);
    let out = Array.isArray(rows) ? rows : [];
    if (projectId) out = out.filter((s) => s.projectId === projectId);
    if (email) out = out.filter((s) => s.author?.email === email);
    return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async getSubmission(id) {
    return (await this.listSubmissions()).find((s) => s.id === id) || null;
  }

  async saveSubmission(sub, newFiles = []) {
    const now = new Date().toISOString();
    const rec = { ...sub, files: [...(sub.files || [])] };
    const isNew = !rec.id;
    if (isNew) { rec.id = uid('s_'); rec.createdAt = now; }
    rec.updatedAt = now;

    // 첨부를 먼저 올린 뒤 색인을 갱신합니다.
    // (색인이 먼저 커밋되면 파일 없는 항목이 잠깐 보일 수 있습니다.)
    for (const file of newFiles) {
      const fid = uid('f_');
      const path = `${this.cfg.uploadDir}/${rec.id}/${fid}_${safeName(file.name)}`;
      const base64 = await fileToBase64(file);
      await this.putFile(path, base64, `feat(uploads): ${safeName(file.name)}`);
      rec.files.push({
        id: fid,
        name: file.name,
        size: file.size,
        type: file.type || '',
        storage: 'github',
        path,
      });
    }

    await this.mutateJSON(this.submissionsPath, [], (list) => {
      const arr = Array.isArray(list) ? list : [];
      const i = arr.findIndex((s) => s.id === rec.id);
      if (i >= 0) arr[i] = rec; else arr.push(rec);
      return arr;
    }, `${isNew ? 'feat' : 'chore'}(submissions): ${isNew ? 'add' : 'update'} ${rec.id}`);

    return rec;
  }

  async deleteSubmission(id) {
    const sub = await this.getSubmission(id);
    if (sub) for (const f of sub.files || []) await this.deleteFile(f);
    await this.mutateJSON(this.submissionsPath, [], (list) =>
      (Array.isArray(list) ? list : []).filter((s) => s.id !== id),
    `chore(submissions): remove ${id}`);
  }

  async deleteFile(fileRef) {
    if (!fileRef?.path) return;
    try {
      await this.removeFile(fileRef.path, `chore(uploads): remove ${fileRef.name}`);
    } catch (e) {
      // 파일이 이미 없어도 색인 정리는 계속되어야 합니다.
      console.warn('첨부 삭제 실패:', e.message);
    }
  }

  async fileURL(fileRef) {
    if (!fileRef?.path) return null;
    return this.rawURL(fileRef.path);
  }

  revoke() { /* raw URL 은 해제할 것이 없습니다 */ }

  async exportAll() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: await this.listProjects(),
      submissions: await this.listSubmissions(),
    };
  }

  async importAll(dump) {
    if (dump.projects) {
      await this.mutateJSON(this.projectsPath, [], () => dump.projects, 'chore(projects): import');
    }
    if (dump.submissions) {
      await this.mutateJSON(this.submissionsPath, [], () => dump.submissions, 'chore(submissions): import');
    }
  }
}
