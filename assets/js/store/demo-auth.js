/**
 * DemoAuth — 서버가 없는 저장소(브라우저 저장 · GitHub)를 위한 시연용 Google 로그인 흉내.
 *
 * **이건 진짜 인증이 아닙니다.** 회원 정보가 이 브라우저의 localStorage 에만
 * 있고 검증도 브라우저에서 일어나므로, 화면 검수·시연할 때만 쓰고 실제 운영은
 * 반드시 Cloudflare R2 + Google OAuth 모드로 하세요.
 */
import { CONFIG } from '../config.js';
import { normRole, normTeam, TEAM_MAX } from '../camp.js';

const MEMBERS_KEY = 'ah.demo.members';
const SESSION_KEY = 'ah.demo.session';

const normEmail = (v) => String(v || '').trim().toLowerCase();

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const adminEmails = () => new Set((CONFIG.admins || []).map((a) => normEmail(a.email)));

function publicMember(m) {
  if (!m) return null;
  const name = String(m.name || '').trim();
  const institution = String(m.institution || '').trim();
  return {
    email: m.email,
    name,
    institution,
    role: adminEmails().has(normEmail(m.email)) ? 'admin' : normRole(m.role),
    team: normRole(m.role) === 'leader' ? normTeam(m.team) : 0,
    status: m.status || 'active',
    authProvider: 'google',
    googleLinked: true,
    needsProfile: !name || !institution,
    createdAt: m.createdAt,
    lastLoginAt: m.lastLoginAt || null,
  };
}

export class DemoAuth {
  constructor(store = null) {
    this.store = store;
    this.supported = true;
    this.simulated = true;
    this.synced = true;
    this._me = null;
  }

  me() { return this._me; }
  setMe(v) { this._me = v || null; }
  isSignedIn() { return Boolean(this._me); }
  isAdmin() { return this._me?.role === 'admin'; }

  members() { const l = read(MEMBERS_KEY, []); return Array.isArray(l) ? l : []; }
  find(email) { return this.members().find((m) => normEmail(m.email) === normEmail(email)) || null; }

  async refresh() {
    const email = read(SESSION_KEY, null);
    const m = email ? this.find(email) : null;
    this.setMe(m && (m.status || 'active') === 'active' ? publicMember(m) : null);
    if (!this._me) write(SESSION_KEY, null);
    return this._me;
  }

  async demoLogin({ email, name = '', institution = '' }) {
    const e = normEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) {
      throw new Error('올바른 Google 이메일 주소를 입력하세요.');
    }
    const now = new Date().toISOString();
    const list = this.members();
    let rec = list.find((m) => normEmail(m.email) === e);
    if (rec) {
      if ((rec.status || 'active') === 'blocked') throw new Error('이용이 정지된 계정입니다.');
      if ((rec.status || 'active') === 'pending') throw new Error('가입 승인을 기다리고 있습니다.');
      if (name && !rec.name) rec.name = String(name).trim();
      if (institution && !rec.institution) rec.institution = String(institution).trim();
      rec.lastLoginAt = now;
      write(MEMBERS_KEY, list);
    } else {
      rec = {
        email: e,
        name: String(name || '').trim(),
        institution: String(institution || '').trim(),
        role: adminEmails().has(e) ? 'admin' : 'member',
        status: 'active',
        createdAt: now,
        lastLoginAt: now,
      };
      write(MEMBERS_KEY, [...list, rec]);
    }
    write(SESSION_KEY, e);
    this.setMe(publicMember(rec));
    return this._me;
  }

  async completeProfile({ name, institution }) {
    const m = this.find(this._me?.email);
    if (!m) throw new Error('로그인이 필요합니다.');
    if (!String(name || '').trim() || !String(institution || '').trim()) {
      throw new Error('성명과 기관명을 모두 입력하세요.');
    }
    m.name = String(name).trim().slice(0, 60);
    m.institution = String(institution).trim().slice(0, 80);
    write(MEMBERS_KEY, this.members().map((x) => (normEmail(x.email) === normEmail(m.email) ? m : x)));
    this.setMe(publicMember(m));
    return this._me;
  }

  async logout() {
    write(SESSION_KEY, null);
    this.setMe(null);
  }

  async listMembers() { return this.members().map(publicMember); }

  async inviteMembers(members) {
    const list = this.members();
    const now = new Date().toISOString();
    let added = 0;
    let activated = 0;
    let skipped = 0;
    for (const item of members || []) {
      const e = normEmail(typeof item === 'string' ? item : item?.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) continue;
      const existing = list.find((m) => normEmail(m.email) === e);
      if (existing) {
        if ((existing.status || 'active') === 'pending') { existing.status = 'active'; activated += 1; }
        else skipped += 1;
        continue;
      }
      list.push({
        email: e,
        name: typeof item === 'object' ? String(item?.name || '').trim() : '',
        institution: typeof item === 'object' ? String(item?.institution || '').trim() : '',
        role: adminEmails().has(e) ? 'admin' : 'member',
        status: 'active',
        createdAt: now,
        lastLoginAt: null,
      });
      added += 1;
    }
    write(MEMBERS_KEY, list);
    return { ok: true, added, activated, skipped, total: added + activated + skipped };
  }

  async patchMember(email, changes) {
    if (normEmail(email) === normEmail(this._me?.email)) {
      throw new Error('자기 계정의 권한은 바꿀 수 없습니다.');
    }
    const list = this.members();
    const m = list.find((x) => normEmail(x.email) === normEmail(email));
    if (!m) throw new Error('해당 회원을 찾을 수 없습니다.');
    if (['admin', 'member', 'leader'].includes(changes.role)) {
      m.role = changes.role;
      if (changes.role !== 'leader') m.team = 0;
    }
    if (changes.team !== undefined) {
      const team = normTeam(changes.team);
      if (!team && Number(changes.team) !== 0) {
        throw new Error(`조는 1조부터 ${TEAM_MAX}조까지입니다.`);
      }
      m.team = team;
    }
    if (normRole(m.role) === 'leader' && !normTeam(m.team)) m.role = 'member';
    if (normRole(m.role) !== 'leader') m.team = 0;

    if (['active', 'blocked', 'pending'].includes(changes.status)) m.status = changes.status;
    if (typeof changes.name === 'string' && changes.name.trim()) m.name = changes.name.trim();
    if (typeof changes.institution === 'string') m.institution = changes.institution.trim();
    write(MEMBERS_KEY, list);
    return publicMember(m);
  }

  async deleteMember(email, { purgeSubmissions = false } = {}) {
    const e = normEmail(email);
    if (e === normEmail(this._me?.email)) throw new Error('자기 계정은 삭제할 수 없습니다.');

    const list = this.members();
    const m = list.find((x) => normEmail(x.email) === e);
    if (!m) throw new Error('해당 회원을 찾을 수 없습니다.');
    if (adminEmails().has(e) || m.role === 'admin') {
      throw new Error('관리자 계정은 삭제할 수 없습니다. 관리자 권한을 먼저 해제하세요.');
    }
    const st = m.status || 'active';
    if (st !== 'blocked' && st !== 'pending') {
      throw new Error('이용 정지 또는 승인 대기 중인 회원만 삭제할 수 있습니다. 먼저 이용을 정지하세요.');
    }

    let removedSubmissions = 0;
    if (purgeSubmissions && this.store) {
      const subs = await this.store.listSubmissions({ email: m.email });
      for (const s of subs) await this.store.deleteSubmission(s.id);
      removedSubmissions = subs.length;
    }
    await this.store?.dropVoter?.(e);

    write(MEMBERS_KEY, list.filter((x) => normEmail(x.email) !== e));
    if (read(SESSION_KEY, null) === e) write(SESSION_KEY, null);
    return { ok: true, removedSubmissions };
  }
}
