/**
 * DemoAuth — 서버가 없는 저장소(브라우저 저장 · GitHub)를 위한 회원 흉내내기.
 *
 * 화면 코드가 저장소마다 갈라지지 않도록 R2Auth 와 같은 모양을 갖췄습니다.
 * 다만 **이건 진짜 인증이 아닙니다.** 회원 정보가 이 브라우저의 localStorage 에만
 * 있고 검증도 브라우저에서 일어나므로, 마음먹으면 얼마든지 우회할 수 있습니다.
 * 화면을 둘러보거나 시연할 때만 쓰고, 실제 운영은 R2 모드로 하세요.
 */
import { CONFIG } from '../config.js';

const MEMBERS_KEY = 'ah.demo.members';
const SESSION_KEY = 'ah.demo.session';
const ITERATIONS = 15000;

const enc = new TextEncoder();
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

function b64(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 1) s += String.fromCharCode(a[i]);
  return btoa(s);
}
function unb64(text) {
  const s = atob(text);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) a[i] = s.charCodeAt(i);
  return a;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256,
  );
  return b64(new Uint8Array(bits));
}

async function hash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${await derive(password, salt, ITERATIONS)}`;
}

async function verify(password, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  return (await derive(password, unb64(p[2]), Number(p[1]))) === p[3];
}

const adminEmails = () => new Set((CONFIG.admins || []).map((a) => normEmail(a.email)));

function publicMember(m) {
  if (!m) return null;
  return {
    email: m.email,
    name: m.name,
    institution: m.institution || '',
    role: adminEmails().has(normEmail(m.email)) ? 'admin' : (m.role || 'member'),
    status: m.status || 'active',
    createdAt: m.createdAt,
    lastLoginAt: m.lastLoginAt || null,
    mustChangePassword: Boolean(m.mustChangePassword),
    resetRequestedAt: m.resetRequestedAt || null,
  };
}

export class DemoAuth {
  /** @param {object|null} store 회원을 지울 때 그 사람의 제출물·표까지 정리하기 위해 씁니다. */
  constructor(store = null) {
    this.store = store;
    this.supported = true;
    /** 화면에 "시연용" 이라고 표시하기 위한 표식입니다. */
    this.simulated = true;
    /** R2Auth 와 모양을 맞추기 위한 필드 — 로컬은 늘 최신입니다. */
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

  async signup({ email, password, name, institution }) {
    const e = normEmail(email);
    const errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) errors.email = '올바른 이메일 주소를 입력하세요.';
    if (String(password || '').length < 8) errors.password = '비밀번호는 8자 이상이어야 합니다.';
    if (!String(name || '').trim()) errors.name = '성명을 입력하세요.';
    if (!String(institution || '').trim()) errors.institution = '기관명을 입력하세요.';
    if (Object.keys(errors).length) {
      const err = new Error('입력을 확인하세요.'); err.errors = errors; throw err;
    }
    if (this.find(e)) {
      const err = new Error('이미 가입된 이메일입니다. 로그인해 주세요.');
      err.errors = { email: '이미 가입된 이메일입니다.' };
      throw err;
    }

    const now = new Date().toISOString();
    const rec = {
      email: e,
      name: String(name).trim(),
      institution: String(institution).trim(),
      passwordHash: await hash(String(password)),
      role: adminEmails().has(e) ? 'admin' : 'member',
      status: 'active',
      createdAt: now,
      lastLoginAt: now,
    };
    write(MEMBERS_KEY, [...this.members(), rec]);
    write(SESSION_KEY, e);
    this.setMe(publicMember(rec));
    return this._me;
  }

  async login(email, password) {
    const m = this.find(email);
    const generic = () => new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
    if (!m) { await hash(String(password)); throw generic(); }
    if ((m.status || 'active') !== 'active') throw new Error('이용이 정지된 계정입니다.');
    if (!(await verify(String(password), m.passwordHash))) throw generic();

    m.lastLoginAt = new Date().toISOString();
    write(MEMBERS_KEY, this.members().map((x) => (normEmail(x.email) === normEmail(m.email) ? m : x)));
    write(SESSION_KEY, normEmail(m.email));
    this.setMe(publicMember(m));
    return this._me;
  }

  async logout() {
    write(SESSION_KEY, null);
    this.setMe(null);
  }

  async changePassword(current, next) {
    const m = this.find(this._me?.email);
    if (!m) throw new Error('로그인이 필요합니다.');
    if (!(await verify(String(current), m.passwordHash))) throw new Error('현재 비밀번호가 올바르지 않습니다.');
    if (String(next).length < 8) throw new Error('새 비밀번호는 8자 이상이어야 합니다.');
    m.passwordHash = await hash(String(next));
    m.mustChangePassword = false;
    write(MEMBERS_KEY, this.members().map((x) => (normEmail(x.email) === normEmail(m.email) ? m : x)));
    this._me = { ...this._me, mustChangePassword: false };
  }

  async requestReset(email) {
    const list = this.members();
    const m = list.find((x) => normEmail(x.email) === normEmail(email));
    if (m) {
      const last = m.resetRequestedAt ? Date.parse(m.resetRequestedAt) : 0;
      if (!(Number.isFinite(last) && Date.now() - last < 5 * 60 * 1000)) {
        m.resetRequestedAt = new Date().toISOString();
        write(MEMBERS_KEY, list);
      }
    }
    // 계정이 없어도 성공한 것처럼 끝냅니다(가입 여부를 알려주지 않기 위해).
  }

  async listMembers() { return this.members().map(publicMember); }

  async patchMember(email, changes) {
    if (normEmail(email) === normEmail(this._me?.email)) {
      throw new Error('자기 계정의 권한은 바꿀 수 없습니다.');
    }
    const list = this.members();
    const m = list.find((x) => normEmail(x.email) === normEmail(email));
    if (!m) throw new Error('해당 회원을 찾을 수 없습니다.');
    if (changes.role === 'admin' || changes.role === 'member') m.role = changes.role;
    if (changes.status === 'active' || changes.status === 'blocked') m.status = changes.status;
    write(MEMBERS_KEY, list);
    return publicMember(m);
  }

  /**
   * 회원 삭제 — R2 모드의 서버 규칙을 그대로 흉내냅니다.
   * 이용 정지된 일반 회원만, 자기 자신은 제외.
   */
  async deleteMember(email, { purgeSubmissions = false } = {}) {
    const e = normEmail(email);
    if (e === normEmail(this._me?.email)) throw new Error('자기 계정은 삭제할 수 없습니다.');

    const list = this.members();
    const m = list.find((x) => normEmail(x.email) === e);
    if (!m) throw new Error('해당 회원을 찾을 수 없습니다.');
    if (adminEmails().has(e) || m.role === 'admin') {
      throw new Error('관리자 계정은 삭제할 수 없습니다. 관리자 권한을 먼저 해제하세요.');
    }
    if ((m.status || 'active') !== 'blocked') {
      throw new Error('이용 정지된 회원만 삭제할 수 있습니다. 먼저 이용을 정지하세요.');
    }

    let removedSubmissions = 0;
    if (purgeSubmissions && this.store) {
      const subs = await this.store.listSubmissions({ email: m.email });
      for (const s of subs) await this.store.deleteSubmission(s.id);
      removedSubmissions = subs.length;
    }
    // 계정이 없어졌으니 그 사람이 넣은 표도 남겨둘 이유가 없습니다.
    await this.store?.dropVoter?.(e);

    write(MEMBERS_KEY, list.filter((x) => normEmail(x.email) !== e));
    if (read(SESSION_KEY, null) === e) write(SESSION_KEY, null);
    return { ok: true, removedSubmissions };
  }

  async resetPassword(email) {
    const list = this.members();
    const m = list.find((x) => normEmail(x.email) === normEmail(email));
    if (!m) throw new Error('해당 회원을 찾을 수 없습니다.');
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint32Array(12));
    const temp = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    m.passwordHash = await hash(temp);
    m.mustChangePassword = true;
    m.resetRequestedAt = null;
    write(MEMBERS_KEY, list);
    return temp;
  }
}
