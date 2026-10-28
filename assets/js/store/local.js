/**
 * LocalStore — IndexedDB 기반 저장소.
 * 설정 없이 즉시 동작하지만 데이터는 "그 브라우저에만" 남습니다.
 * 시연·연수·오프라인 실습용 기본값입니다.
 */
import { uid } from '../utils.js';
import { DemoAuth } from './demo-auth.js';
import { summarizeVotes, applyVote } from './voting.js';
import {
  isCamp, normTeam, summarizeScores, applyScore, myTeamIn,
  nominateBlock, applyNominate, TEAM_MAX,
  nomineeProgress, drawBlock, shuffle, drawOf, drawStale,
} from '../camp.js';

const DB_NAME = 'assignment-hub';
const DB_VER = 7;

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
      if (!db.objectStoreNames.contains('votes')) {
        const v = db.createObjectStore('votes', { keyPath: 'id' });
        v.createIndex('projectId', 'projectId');
      }
      // 수강 현황 — 전체 명단과 회차별 출결.
      if (!db.objectStoreNames.contains('roster')) {
        db.createObjectStore('roster', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('attendance')) {
        db.createObjectStore('attendance', { keyPath: 'id' });
      }
      // AI Build Camp 발표 평가 — 한 사람이 한 발표에 한 줄.
      if (!db.objectStoreNames.contains('scores')) {
        const sc = db.createObjectStore('scores', { keyPath: 'id' });
        sc.createIndex('projectId', 'projectId');
      }
      // 발표 순서 추첨 — 한 과제에 한 줄.
      if (!db.objectStoreNames.contains('draws')) {
        db.createObjectStore('draws', { keyPath: 'id' });
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
    // 제출물이 하나도 없던 프로젝트라도 표가 남지 않게 한 번 더 훑습니다.
    const stray = (await this.listVotes()).filter((v) => v.projectId === id);
    if (stray.length) {
      await tx('votes', 'readwrite', (os) => { for (const v of stray) os.delete(v.id); });
    }
    const strayScores = (await this.listScores()).filter((r) => r.projectId === id);
    if (strayScores.length) {
      await tx('scores', 'readwrite', (os) => { for (const r of strayScores) os.delete(r.id); });
    }
    const strayDraws = (await this.listDraws()).filter((d) => d.projectId === id);
    if (strayDraws.length) {
      await tx('draws', 'readwrite', (os) => { for (const d of strayDraws) os.delete(d.id); });
    }
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

    // AI Build Camp 과제는 조를 골라야 합니다 (서버와 같은 규칙 — shared/camp.js).
    const project = await this.getProject(rec.projectId);
    if (isCamp(project)) {
      const team = normTeam(rec.team);
      if (!team) throw new Error(`조를 선택하세요 (1조~${TEAM_MAX}조).`);
      rec.team = team;
    } else {
      delete rec.team;
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
    // 지워진 제출물에 들어간 표도 함께 거둡니다 (서버 모드와 같은 규칙).
    const stale = (await this.listVotes()).filter((v) => v.submissionId === id);
    if (stale.length) {
      await tx('votes', 'readwrite', (os) => { for (const v of stale) os.delete(v.id); });
    }
    // 발표 평가 점수도 함께 — 없는 발표의 점수는 평균만 흐립니다.
    const staleScores = (await this.listScores()).filter((r) => r.submissionId === id);
    if (staleScores.length) {
      await tx('scores', 'readwrite', (os) => { for (const r of staleScores) os.delete(r.id); });
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

  /* ----------------------------------------------------------- 수강 현황 */

  async listStudents() {
    return (await tx('roster', 'readonly', (os) => wrap(os.getAll()))) || [];
  }

  /** 명단 전체를 화면이 들고 있는 상태로 맞춥니다 — 빠진 사람은 지웁니다. */
  async saveStudents(list) {
    await tx('roster', 'readwrite', (os) => {
      os.clear();
      for (const e of list) os.put(e);
    });
    return list;
  }

  async listAttendance() {
    return (await tx('attendance', 'readonly', (os) => wrap(os.getAll()))) || [];
  }

  async saveAttendance(records) {
    const incoming = Array.isArray(records) ? records : [records];
    await tx('attendance', 'readwrite', (os) => { for (const r of incoming) os.put(r); });
    return incoming;
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

  /* --------------------------------------------------------------- 투표 */

  async listVotes() {
    const rows = await tx('votes', 'readonly', (os) => wrap(os.getAll()));
    return rows || [];
  }

  async voteSummary(projectId) {
    const project = await this.getProject(projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    return summarizeVotes(project, await this.listVotes(), this.auth?.me() || {});
  }

  /** 삭제된 회원이 넣은 표·점수를 걷어냅니다 (DemoAuth.deleteMember 가 부릅니다). */
  async dropVoter(email) {
    const e = String(email || '').trim().toLowerCase();
    const gone = (await this.listVotes()).filter((v) => String(v.voter || '').toLowerCase() === e);
    if (gone.length) {
      await tx('votes', 'readwrite', (os) => { for (const v of gone) os.delete(v.id); });
    }
    const goneScores = (await this.listScores())
      .filter((r) => String(r.voter || '').toLowerCase() === e);
    if (goneScores.length) {
      await tx('scores', 'readwrite', (os) => { for (const r of goneScores) os.delete(r.id); });
    }
  }

  async castVote(submissionId, on = true) {
    const me = this.auth?.me();
    if (!me) throw new Error('로그인이 필요합니다.');
    const sub = await this.getSubmission(submissionId);
    if (!sub) throw new Error('제출물을 찾을 수 없습니다.');
    const project = await this.getProject(sub.projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');

    const rows = await this.listVotes();
    const next = applyVote(project, rows, me, submissionId, on, sub);
    if (next) {
      const before = new Map(rows.map((v) => [v.id, v]));
      for (const v of next) if (!v.id) v.id = uid('v_');
      const keep = new Set(next.map((v) => v.id));
      await tx('votes', 'readwrite', (os) => {
        for (const id of before.keys()) if (!keep.has(id)) os.delete(id);
        for (const v of next) os.put(v);
      });
    }
    return summarizeVotes(project, next || rows, me);
  }

  /* ---------------------------------------------------------- 발표 평가 */

  async listScores() {
    const rows = await tx('scores', 'readonly', (os) => wrap(os.getAll()));
    return rows || [];
  }

  async scoreSummary(projectId) {
    const project = await this.getProject(projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    return summarizeScores(project, await this.listScores(), this.auth?.me() || {});
  }

  /** 발표 과제 선정 — 조마다 하나. 먼저 올라가 있던 것은 내려갑니다. */
  async nominate(submissionId, on = true) {
    const me = this.auth?.me();
    if (!me) throw new Error('로그인이 필요합니다.');
    const sub = await this.getSubmission(submissionId);
    if (!sub) throw new Error('제출물을 찾을 수 없습니다.');
    const project = await this.getProject(sub.projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');

    const blocked = nominateBlock(project, sub, me, on);
    if (blocked) throw new Error(blocked);

    const siblings = await this.listSubmissions({ projectId: sub.projectId });
    const target = siblings.find((s) => s.id === submissionId);
    const touched = applyNominate(siblings, target, on);
    if (!touched.length) return sub;

    await tx('submissions', 'readwrite', (os) => { for (const s of touched) os.put(s); });
    // 내려간 발표에 들어와 있던 점수는 갈 곳이 없습니다.
    const dropped = touched.filter((s) => !s.presenting).map((s) => s.id);
    if (dropped.length) {
      const stale = (await this.listScores()).filter((r) => dropped.includes(r.submissionId));
      if (stale.length) {
        await tx('scores', 'readwrite', (os) => { for (const r of stale) os.delete(r.id); });
      }
    }
    return target;
  }

  /** 세 문항 점수 주기. 같은 사람이 다시 주면 덮어씁니다. */
  async castScore(submissionId, input) {
    const me = this.auth?.me();
    if (!me) throw new Error('로그인이 필요합니다.');
    const sub = await this.getSubmission(submissionId);
    if (!sub) throw new Error('제출물을 찾을 수 없습니다.');
    const project = await this.getProject(sub.projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');

    const here = await this.listSubmissions({ projectId: sub.projectId });
    const rows = await this.listScores();
    const next = applyScore(project, rows, me, submissionId, input, sub, myTeamIn(here, me));

    // applyScore 는 줄을 지우지 않고 더하거나 고치기만 합니다 — put 만 하면 됩니다.
    for (const r of next) if (!r.id) r.id = uid('sc_');
    await tx('scores', 'readwrite', (os) => { for (const r of next) os.put(r); });
    return summarizeScores(project, next, me);
  }

  /* ------------------------------------------------------ 발표 순서 추첨 */

  async listDraws() {
    const rows = await tx('draws', 'readonly', (os) => wrap(os.getAll()));
    return rows || [];
  }

  /** 발표 순서 + 조별 선정 진행 상황 (서버 모드의 GET /draw 와 같은 모양). */
  async drawOrder(projectId) {
    const project = await this.getProject(projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');
    const here = await this.listSubmissions({ projectId });
    const draw = drawOf((await this.listDraws()).find((d) => d.projectId === projectId));
    const p = nomineeProgress(here);
    return {
      draw,
      progress: { teams: p.teams, picked: p.picked, missing: p.missing },
      stale: drawStale(draw, here),
    };
  }

  /** 발표 순서 추첨. 이미 뽑아 둔 것이 있으면 다시 뽑고 횟수를 올립니다. */
  async runDraw(projectId) {
    const me = this.auth?.me();
    if (!me) throw new Error('로그인이 필요합니다.');
    const project = await this.getProject(projectId);
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.');

    const here = await this.listSubmissions({ projectId });
    const blocked = drawBlock(project, here, me);
    if (blocked) throw new Error(blocked);

    const rows = await this.listDraws();
    const before = rows.find((d) => d.projectId === projectId);
    const row = {
      id: before?.id || uid('dr_'),
      projectId,
      order: shuffle(nomineeProgress(here).nominees.map((s) => s.id)),
      seq: before ? Math.max(1, Math.round(Number(before.seq)) || 1) + 1 : 1,
      drawnAt: new Date().toISOString(),
      drawnBy: String(me.email || '').toLowerCase(),
    };
    await tx('draws', 'readwrite', (os) => os.put(row));
    return drawOf(row);
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
      roster: await this.listStudents(),
      attendance: await this.listAttendance(),
      scores: await this.listScores(),
      draws: await this.listDraws(),
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
    for (const e of dump.roster || []) {
      await tx('roster', 'readwrite', (os) => os.put(e));
    }
    for (const a of dump.attendance || []) {
      await tx('attendance', 'readwrite', (os) => os.put(a));
    }
    for (const r of dump.scores || []) {
      await tx('scores', 'readwrite', (os) => os.put(r));
    }
    for (const d of dump.draws || []) {
      await tx('draws', 'readwrite', (os) => os.put(d));
    }
  }
}
