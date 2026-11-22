/** 페스타 단계별 코드 입장과 위원별 채점. 이전에 발급한 개인 링크도 지원합니다. */
import { readState, updateState, fail, reply, jsonBody, requireAdmin, entryInstitution, validEmail,
  judgeCanScore, validJuryScores as validScores } from './festa.js';
import { normEmail, hashPassword, verifyPassword, signSession, readSession, cookieValue, safeEqual, sessionSecret, conditionFor } from './auth.js';
import { publishClosedFinalIfReady } from './festa-awards.js';

export const JURY_KEYS = ['mois', 'iwest', 'final'];
export const JURY_LABELS = { mois: '행정안전부 1차 평가', iwest: '한국서부발전 1차 평가', final: '2차 본선 평가' };
const INSTITUTIONS = { mois: '행정안전부', iwest: '한국서부발전' };
const INVITE_TTL = 7 * 24 * 3600 * 1000;
const SESSION_TTL = 8 * 3600 * 1000;
const ATTEMPTS = 5;
const LOCK_MS = 10 * 60 * 1000;
const PANEL_ATTEMPTS = 100;
const RATE_SOURCES = 256;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^fj_[a-f0-9-]{36}$/;
const FILE_RE = /^festa\/uploads\/[a-f0-9-]{36}\.[a-z0-9]+$/;
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const digest = async (text) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

// 낮은 엔트로피의 PIN을 일반 해시로 색인하지 않습니다. 목적·패널을 분리한 서버 HMAC만 저장합니다.
async function privateSelector(env, purpose, key, value) {
  const encoder = new TextEncoder();
  const secret = await crypto.subtle.importKey('raw', encoder.encode(await sessionSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', secret,
    encoder.encode(JSON.stringify(['festa-jury-v1', purpose, key, value])))));
}

function panelKey(value) {
  if (!JURY_KEYS.includes(value)) fail(400, '올바른 심사 단계를 선택하세요.');
  return value;
}

function panelOf(state, key, create = false) {
  if (state.juryPanels !== undefined && (!state.juryPanels || typeof state.juryPanels !== 'object'
      || Array.isArray(state.juryPanels))) fail(503, '심사위원 데이터 형식이 올바르지 않습니다.');
  if (!state.juryPanels || !Object.hasOwn(state.juryPanels, key)) {
    const empty = { status: 'draft', entryIds: [], judges: [], scores: [] };
    if (create) {
      state.juryPanels ??= {};
      state.juryPanels[key] = empty;
    }
    return empty;
  }
  const panel = state.juryPanels[key];
  if (!panel || !['draft', 'open', 'closed'].includes(panel.status)
      || !Array.isArray(panel.entryIds) || !Array.isArray(panel.judges) || !Array.isArray(panel.scores)) {
    fail(503, '심사위원 데이터 형식이 올바르지 않습니다.');
  }
  return panel;
}

function draftOnly(panel) {
  if (panel.status !== 'draft' || panel.scores.length) fail(409, '심사를 시작한 뒤에는 작품과 위원 배정을 변경할 수 없습니다.');
}

function entryList(state, key, entryIds, opening = false) {
  if (!Array.isArray(entryIds) || entryIds.length > 500
      || entryIds.some((id) => typeof id !== 'string') || new Set(entryIds).size !== entryIds.length) {
    fail(400, '중복 없는 작품 목록을 선택하세요.');
  }
  const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
  const entries = entryIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) fail(400, '선택한 작품을 찾을 수 없습니다.');
    const institution = entryInstitution(entry);
    if (key !== 'final' && institution !== INSTITUTIONS[key]) fail(400, '해당 기관의 작품만 1차 심사에 배정할 수 있습니다.');
    if (!Object.values(INSTITUTIONS).includes(institution)) fail(400, '작품의 참가 기관을 먼저 지정하세요.');
    return entry;
  });
  if (key === 'final') {
    if (entries.length > 6 || new Set(entries.map((entry) => normEmail(entry.author?.email))).size !== entries.length) {
      fail(400, '본선은 서로 다른 참가자 6명의 작품을 선택해야 합니다.');
    }
    if (opening && (entries.length !== 6
        || entries.filter((entry) => entryInstitution(entry) === INSTITUTIONS.mois).length < 2
        || entries.filter((entry) => entryInstitution(entry) === INSTITUTIONS.iwest).length < 1)) {
      fail(409, '본선은 서로 다른 참가자 6명이며 행정안전부 2명 이상, 한국서부발전 1명 이상이어야 합니다.');
    }
  }
  if (opening && !entries.length) fail(409, '심사할 작품을 먼저 선택하세요.');
  return entries;
}

function findJudge(panel, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) fail(400, '심사위원 번호가 올바르지 않습니다.');
  const judge = panel.judges.find((row) => row.id === id);
  if (!judge) fail(404, '심사위원을 찾을 수 없습니다.');
  return judge;
}

function scoreRows(panel, entries) {
  const judges = new Map(panel.judges.map((judge) => [judge.id, judge]));
  const works = new Map(entries.map((entry) => [entry.id, entry]));
  const rows = new Map();
  for (const row of panel.scores) {
    const entry = works.get(row?.entryId);
    const judge = judges.get(row?.judgeId);
    if (entry && judgeCanScore(judge, entry) && validScores(row.scores)) {
      rows.set(`${row.judgeId}/${row.entryId}`, row);
    }
  }
  return [...rows.values()];
}

function publicEntry(entry, judge, rows) {
  const own = judge && rows.find((row) => row.judgeId === judge.id && row.entryId === entry.id);
  return {
    id: entry.id, title: entry.title, description: entry.description,
    institution: entryInstitution(entry), localOnly: Boolean(entry.localOnly),
    deployUrl: entry.deployUrl || '', githubUrl: entry.githubUrl || '',
    files: (entry.files || []).map(({ key, name, size }) => ({ key, name, size })),
    author: { name: entry.author?.name || '', institution: entryInstitution(entry) },
    ...(judge ? { myScores: own ? [...own.scores] : null,
      scoreBlocked: judgeCanScore(judge, entry) ? '' : '자신의 작품은 평가할 수 없습니다.' } : {}),
  };
}

function adminPanel(state, key) {
  const panel = panelOf(state, key);
  const entries = entryList(state, key, panel.entryIds);
  const rows = scoreRows(panel, entries);
  return {
    key, label: JURY_LABELS[key], status: panel.status, entryIds: [...panel.entryIds],
    judges: panel.judges.map((judge) => ({
      id: judge.id, name: judge.name, email: judge.email, expiresAt: judge.expiresAt || null,
      revoked: Boolean(judge.revoked), hasInvite: Boolean(judge.tokenHash && judge.pinHash),
      hasCommonCode: Boolean(judge.pinLookup && judge.pinHash),
      scoredCount: rows.filter((row) => row.judgeId === judge.id).length,
      eligibleCount: entries.filter((entry) => judgeCanScore(judge, entry)).length,
    })),
    scores: rows.map(({ judgeId, entryId, scores }) => ({ judgeId, entryId, scores: [...scores] })),
    results: entries.map((entry) => {
      const votes = rows.filter((row) => row.entryId === entry.id);
      return { entryId: entry.id, scoreCount: votes.length,
        average: votes.length ? votes.reduce((sum, row) => sum + row.scores.reduce((a, b) => a + b, 0), 0) / votes.length : null };
    }),
  };
}

async function overview(env, member, cors) {
  requireAdmin(member);
  const { state } = await readState(env);
  return reply({
    phase: state.phase,
    panels: JURY_KEYS.map((key) => adminPanel(state, key)),
    entries: state.entries.map((entry) => {
      const view = publicEntry(entry);
      return { ...view, author: { ...view.author, email: normEmail(entry.author?.email) } };
    }),
  }, 200, cors);
}

async function configure(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const key = panelKey(body.panel);
  const { state } = await updateState(env, (current) => {
    const panel = panelOf(current, key, true);
    draftOnly(panel);
    entryList(current, key, body.entryIds);
    panel.entryIds = [...body.entryIds];
  });
  return reply({ panel: adminPanel(state, key) }, 200, cors);
}

async function saveJudge(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const key = panelKey(body.panel);
  const email = normEmail(body.email);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!validEmail(email) || !name || name.length > 80) fail(400, '심사위원 성명과 올바른 이메일을 입력하세요.');
  const newId = `fj_${crypto.randomUUID()}`;
  const { state, result } = await updateState(env, (current) => {
    const panel = panelOf(current, key, true);
    draftOnly(panel);
    const existing = body.judgeId ? findJudge(panel, body.judgeId) : null;
    if (panel.judges.some((judge) => judge.email === email && judge.id !== existing?.id)) fail(409, '이미 배정한 심사위원 이메일입니다.');
    if (!existing && panel.judges.length >= 100) fail(400, '심사위원은 단계별 100명까지 배정할 수 있습니다.');
    if (existing) {
      if (existing.email !== email || existing.name !== name) {
        Object.assign(existing, { name, email, tokenHash: null, pinHash: null, pinLookup: null, expiresAt: 0,
          revoked: true, credentialVersion: crypto.randomUUID(), failedAttempts: 0, lockedUntil: 0 });
      }
      return existing.id;
    }
    panel.judges.push({ id: newId, name, email, revoked: false, expiresAt: 0,
      failedAttempts: 0, lockedUntil: 0, credentialVersion: crypto.randomUUID() });
    return newId;
  });
  return reply({ judge: adminPanel(state, key).judges.find((judge) => judge.id === result) }, 200, cors);
}

async function removeJudge(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const key = panelKey(body.panel);
  const { state } = await updateState(env, (current) => {
    const panel = panelOf(current, key, true);
    draftOnly(panel);
    const judge = findJudge(panel, body.judgeId);
    panel.judges = panel.judges.filter((row) => row.id !== judge.id);
  });
  return reply({ panel: adminPanel(state, key) }, 200, cors);
}

async function invite(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const key = panelKey(body.panel);
  if (typeof body.pin !== 'string' || !/^\d{6}$/.test(body.pin)) fail(400, 'PIN은 숫자 6자리로 입력하세요.');
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const [tokenHash, pinHash, pinLookup, before] = await Promise.all([
    digest(token), hashPassword(body.pin, env), privateSelector(env, 'pin', key, body.pin), readState(env),
  ]);
  // 이전 개별 링크는 색인이 없으므로 발급 때만 중복을 확인합니다. 공개 로그인은 명부 전체를 해시하지 않습니다.
  const legacy = panelOf(before.state, key).judges.filter((judge) => judge.id !== body.judgeId && judge.pinHash && !judge.pinLookup);
  const legacyChecks = new Map(await Promise.all(legacy.map(async (judge) => [judge.id,
    { hash: judge.pinHash, matches: await verifyPassword(body.pin, judge.pinHash) }])));
  const expiresAt = Date.now() + INVITE_TTL;
  await updateState(env, (state) => {
    const panel = panelOf(state, key, true);
    if (panel.status === 'closed') fail(409, '마감한 심사의 초대는 변경할 수 없습니다.');
    const judge = findJudge(panel, body.judgeId);
    for (const other of panel.judges) {
      if (other.id === judge.id || !other.pinHash) continue;
      if (other.pinLookup) {
        if (safeEqual(other.pinLookup, pinLookup)) fail(409, '이 단계의 다른 심사위원이 사용하는 코드입니다. 다른 6자리 코드를 입력하세요.');
      } else {
        const checked = legacyChecks.get(other.id);
        if (!checked || checked.hash !== other.pinHash) fail(409, '심사위원 코드가 변경되었습니다. 다시 발급해 주세요.');
        if (checked.matches) fail(409, '이 단계의 다른 심사위원이 사용하는 코드입니다. 다른 6자리 코드를 입력하세요.');
      }
    }
    Object.assign(judge, { tokenHash, pinHash, pinLookup, expiresAt, revoked: false,
      credentialVersion: crypto.randomUUID(), failedAttempts: 0, lockedUntil: 0 });
  });
  // 선택한 PIN은 응답에도 기록에도 남기지 않습니다. 초대 토큰은 이 응답에서만 제공합니다.
  return reply({ token, expiresAt, panel: key, judgeId: body.judgeId }, 200, cors);
}

async function revoke(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const key = panelKey(body.panel);
  await updateState(env, (state) => {
    const panel = panelOf(state, key, true);
    const judge = findJudge(panel, body.judgeId);
    judge.revoked = true;
    judge.credentialVersion = crypto.randomUUID();
  });
  return reply({ ok: true }, 200, cors);
}

async function changeStatus(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const key = panelKey(body.panel);
  if (!['open', 'closed'].includes(body.status)) fail(400, '올바른 심사 상태를 선택하세요.');
  const { state } = await updateState(env, (current) => {
    const panel = panelOf(current, key, true);
    if (body.status === 'open') {
      draftOnly(panel);
      if (current.phase === 'open') fail(409, '출품 접수를 수동 마감한 뒤 심사를 시작하세요.');
      const entries = entryList(current, key, panel.entryIds, true);
      if (!panel.judges.length || panel.judges.some((judge) => !judge.tokenHash || !judge.pinHash
          || judge.revoked || judge.expiresAt <= Date.now())) fail(409, '모든 배정 위원에게 유효한 개별 초대를 먼저 발급하세요.');
      if (entries.some((entry) => !panel.judges.some((judge) => judgeCanScore(judge, entry)))) {
        fail(409, '본인 평가를 제외한 유효 심사위원이 없는 작품이 있습니다. 위원 배정을 확인하세요.');
      }
      panel.status = 'open';
      panel.openedAt = new Date().toISOString();
    } else {
      if (panel.status !== 'open') fail(409, '진행 중인 심사만 마감할 수 있습니다.');
      const entries = entryList(current, key, panel.entryIds, true);
      const rows = scoreRows(panel, entries);
      const scored = new Set(rows.map((row) => `${row.judgeId}/${row.entryId}`));
      if (entries.some((entry) => {
        const eligible = panel.judges.filter((judge) => judgeCanScore(judge, entry));
        return !eligible.length || eligible.some((judge) => !scored.has(`${judge.id}/${entry.id}`));
      })) fail(409, '모든 배정 위원의 평가가 완료된 뒤 마감하세요.');
      panel.status = 'closed';
      panel.closedAt = new Date().toISOString();
      if (key === 'final') publishClosedFinalIfReady(current);
    }
  });
  return reply({ panel: adminPanel(state, key) }, 200, cors);
}

async function invitationContext(env, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) fail(404, '유효한 심사 초대를 찾을 수 없습니다.');
  const tokenHash = await digest(token);
  const { state } = await readState(env);
  for (const key of JURY_KEYS) {
    const panel = panelOf(state, key);
    const judge = panel.judges.find((row) => row.tokenHash && safeEqual(row.tokenHash, tokenHash));
    if (judge) {
      activeInvite(judge);
      return { state, key, panel, judge, tokenHash };
    }
  }
  fail(404, '유효한 심사 초대를 찾을 수 없습니다.');
}

function activeInvite(judge) {
  if (judge.revoked || !judge.pinHash || judge.expiresAt <= Date.now()) fail(410, '초대가 만료되었거나 폐기되었습니다. 운영자에게 문의하세요.');
}

function invitationView(context) {
  return { panel: context.key, label: JURY_LABELS[context.key], judgeId: context.judge.id,
    judgeName: context.judge.name, status: context.panel.status, expiresAt: context.judge.expiresAt };
}

function juryCookie(request, key, value, expiresAt) {
  const url = new URL(request.url);
  const index = url.pathname.indexOf('/festa/jury');
  const path = `${index >= 0 ? url.pathname.slice(0, index) : '/api'}/festa/jury`;
  return `fj_${key}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax`
    + `${url.protocol === 'https:' ? '; Secure' : ''}; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`;
}

function checkRate(rate, source) {
  if (rate.count >= PANEL_ATTEMPTS || (rate.sources.find((row) => row.key === source)?.count || 0) >= ATTEMPTS) {
    fail(429, '코드 입력 시도가 많습니다. 10분 후 다시 시도하세요.');
  }
}

async function readRate(env, key) {
  const object = await env.BUCKET.get(`data/festa-jury-attempts-${key}.json`);
  let rate;
  if (object) {
    try { rate = JSON.parse(await object.text()); } catch { fail(503, '심사 인증 상태를 읽지 못했습니다.'); }
    if (!rate || !Number.isFinite(rate.start) || !Number.isInteger(rate.count) || rate.count < 0
        || rate.count > PANEL_ATTEMPTS || !Array.isArray(rate.sources) || rate.sources.length > RATE_SOURCES
        || rate.sources.some((row) => !TOKEN_RE.test(row?.key) || !Number.isInteger(row.count) || row.count < 1 || row.count > ATTEMPTS)
        || new Set(rate.sources.map((row) => row.key)).size !== rate.sources.length) {
      fail(503, '심사 인증 상태를 읽지 못했습니다.');
    }
  }
  if (!rate || rate.start + LOCK_MS <= Date.now()) rate = { start: Date.now(), count: 0, sources: [] };
  return { etag: object?.etag, rate };
}

// 성공 로그인은 읽기만 합니다. 같은 장소의 여러 위원이 동시에 접속해도 실패 횟수를 소비하지 않습니다.
async function recordCodeFailure(env, key, source) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { etag, rate } = await readRate(env, key);
    checkRate(rate, source);
    let row = rate.sources.find((item) => item.key === source);
    if (!row) {
      if (rate.sources.length >= RATE_SOURCES) fail(429, '코드 입력 시도가 많습니다. 10분 후 다시 시도하세요.');
      row = { key: source, count: 0 };
      rate.sources.push(row);
    }
    row.count += 1;
    rate.count += 1;
    const saved = await env.BUCKET.put(`data/festa-jury-attempts-${key}.json`, JSON.stringify(rate), {
      onlyIf: conditionFor(etag),
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    if (saved) {
      checkRate(rate, source);
      fail(403, '심사 코드가 올바르지 않거나 사용할 수 없습니다.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
  }
  fail(429, '코드 입력 시도가 많습니다. 잠시 후 다시 시도하세요.');
}

async function issueSession(request, env, key, judge, cors) {
  const expiresAt = Math.min(Date.now() + SESSION_TTL, judge.expiresAt);
  const session = await signSession({ sub: judge.id, purpose: 'festa-jury', panel: key,
    version: judge.credentialVersion, exp: expiresAt }, env);
  return reply({ ok: true, panel: key, judgeId: judge.id, expiresAt }, 200,
    { ...cors, 'Set-Cookie': juryCookie(request, key, session, expiresAt) });
}

async function unlockCommon(request, env, body, cors) {
  const key = panelKey(body.panel);
  // Cloudflare가 덮어쓰는 실제 접속 주소만 신뢰합니다. 임의 X-Forwarded-For로 제한을 우회할 수 없습니다.
  const source = await privateSelector(env, 'source', key, (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64));
  const { state } = await readState(env);
  const panel = panelOf(state, key);
  if (panel.status !== 'open') fail(409, '현재 진행 중인 심사가 아닙니다.');
  checkRate((await readRate(env, key)).rate, source);
  const pinLookup = typeof body.pin === 'string' && /^\d{6}$/.test(body.pin)
    ? await privateSelector(env, 'pin', key, body.pin) : null;
  const matches = pinLookup ? panel.judges.filter((row) => row.pinLookup && safeEqual(row.pinLookup, pinLookup)) : [];
  const judge = matches.length === 1 ? matches[0] : null;
  if (!judge || judge.revoked || judge.expiresAt <= Date.now() || !judge.pinHash
      || judge.lockedUntil > Date.now() || !await verifyPassword(body.pin, judge.pinHash)) {
    return recordCodeFailure(env, key, source);
  }
  // PBKDF 도중의 재발급·폐기·마감도 다시 읽어 확인합니다. 성공 경로는 공용 R2 키를 갱신하지 않습니다.
  const current = panelOf((await readState(env)).state, key);
  const latest = current.judges.find((row) => row.id === judge.id);
  if (current.status !== 'open') fail(409, '현재 진행 중인 심사가 아닙니다.');
  if (!latest || latest.revoked || latest.expiresAt <= Date.now() || latest.lockedUntil > Date.now()
      || latest.credentialVersion !== judge.credentialVersion || latest.pinLookup !== pinLookup) {
    return recordCodeFailure(env, key, source);
  }
  return issueSession(request, env, key, latest, cors);
}

async function unlock(request, env, cors) {
  const body = await jsonBody(request);
  if (!Object.hasOwn(body, 'token')) return unlockCommon(request, env, body, cors);
  const context = await invitationContext(env, body.token);
  if (body.panel !== undefined && body.panel !== context.key) fail(400, '초대와 심사 단계가 일치하지 않습니다.');
  if (context.panel.status !== 'open') fail(409, '현재 진행 중인 심사가 아닙니다.');
  if (Number(context.judge.lockedUntil || 0) > Date.now()) fail(429, 'PIN 입력 시도가 많습니다. 10분 후 다시 시도하세요.');
  // 형식 오류도 실패 횟수에 포함합니다. 해시를 계산한 뒤 CAS 안에서 잠금과 초대를 다시 확인합니다.
  const correct = typeof body.pin === 'string' && /^\d{6}$/.test(body.pin)
    && await verifyPassword(body.pin, context.judge.pinHash);
  const { result } = await updateState(env, (state) => {
    const panel = panelOf(state, context.key);
    const judge = findJudge(panel, context.judge.id);
    activeInvite(judge);
    if (panel.status !== 'open') fail(409, '현재 진행 중인 심사가 아닙니다.');
    if (judge.tokenHash !== context.tokenHash || judge.credentialVersion !== context.judge.credentialVersion) {
      fail(410, '초대가 변경되었습니다. 새 초대 링크를 사용하세요.');
    }
    if (Number(judge.lockedUntil || 0) > Date.now()) fail(429, 'PIN 입력 시도가 많습니다. 10분 후 다시 시도하세요.');
    if (!correct) {
      judge.failedAttempts = Number(judge.failedAttempts || 0) + 1;
      if (judge.failedAttempts >= ATTEMPTS) {
        judge.lockedUntil = Date.now() + LOCK_MS;
        judge.failedAttempts = 0;
      }
      return { error: judge.lockedUntil > Date.now() ? 429 : 403 };
    }
    judge.failedAttempts = 0;
    judge.lockedUntil = 0;
    return { judge };
  });
  if (result.error) return reply({ message: result.error === 429
    ? 'PIN 입력 시도가 많습니다. 10분 후 다시 시도하세요.' : 'PIN이 올바르지 않습니다.' }, result.error, cors);
  return issueSession(request, env, context.key, result.judge, cors);
}

function queryCredentials(request) {
  const query = new URL(request.url).searchParams;
  return { token: query.get('token') ?? undefined, panel: query.get('panel') ?? undefined,
    judgeId: query.get('judgeId') ?? undefined };
}

async function authenticatedContext(request, env, credentials, mustBeOpen = false, requireJudgeId = false) {
  const legacy = credentials.token !== undefined;
  let context = legacy ? await invitationContext(env, credentials.token) : null;
  const key = context?.key || panelKey(credentials.panel);
  if (credentials.panel !== undefined && credentials.panel !== key) fail(401, '심사 로그인 정보가 일치하지 않습니다.');
  const signed = cookieValue(request.headers.get('Cookie'), `fj_${key}`);
  const session = await readSession(signed, env);
  if (!session || session.purpose !== 'festa-jury' || session.panel !== key || session.exp <= Date.now()) {
    fail(401, '심사 코드로 다시 입장해 주세요.');
  }
  if (!legacy) {
    const { state } = await readState(env);
    const panel = panelOf(state, key);
    const judge = panel.judges.find((row) => row.id === session.sub);
    if (!judge) fail(401, '심사 코드로 다시 입장해 주세요.');
    activeInvite(judge);
    context = { state, key, panel, judge, tokenHash: judge.tokenHash };
    if (requireJudgeId && credentials.judgeId === undefined) fail(401, '현재 심사위원을 다시 확인해 주세요.');
  }
  if (session.sub !== context.judge.id || session.version !== context.judge.credentialVersion) {
    fail(401, '심사 코드가 변경되었거나 만료되었습니다. 다시 입장해 주세요.');
  }
  if (credentials.judgeId !== undefined && credentials.judgeId !== context.judge.id) {
    fail(401, '다른 심사위원으로 로그인되었습니다. 심사 코드로 다시 입장해 주세요.');
  }
  if (mustBeOpen && context.panel.status !== 'open') fail(409, '마감된 심사는 평가하거나 파일을 열 수 없습니다.');
  return context;
}

async function privateSession(request, env, cors) {
  const context = await authenticatedContext(request, env, queryCredentials(request));
  const entries = context.panel.status === 'open'
    ? entryList(context.state, context.key, context.panel.entryIds) : [];
  return reply({ ...invitationView(context), entries: entries.map((entry) => publicEntry(entry, context.judge,
    context.panel.scores.filter((row) => row.judgeId === context.judge.id))) }, 200, cors);
}

async function score(request, env, cors) {
  const body = await jsonBody(request);
  if (typeof body.entryId !== 'string' || !validScores(body.scores)) fail(400, '각 배점(40·30·20·10) 안에서 네 항목의 정수 점수를 입력하세요.');
  const context = await authenticatedContext(request, env, body, true, true);
  await updateState(env, (state) => {
    const panel = panelOf(state, context.key);
    const judge = findJudge(panel, context.judge.id);
    activeInvite(judge);
    if (judge.credentialVersion !== context.judge.credentialVersion || judge.tokenHash !== context.tokenHash) fail(401, '초대가 변경되었습니다. 다시 인증해 주세요.');
    if (panel.status !== 'open') fail(409, '마감된 심사는 평가할 수 없습니다.');
    if (!panel.entryIds.includes(body.entryId)) fail(403, '배정된 작품만 평가할 수 있습니다.');
    const entry = state.entries.find((row) => row.id === body.entryId);
    if (!entry || !judgeCanScore(judge, entry)) fail(403, '자신의 작품은 평가할 수 없습니다.');
    const index = panel.scores.findIndex((row) => row.judgeId === judge.id && row.entryId === entry.id);
    const row = { judgeId: judge.id, entryId: entry.id, scores: [...body.scores], updatedAt: new Date().toISOString() };
    if (index >= 0) panel.scores[index] = row;
    else panel.scores.push(row);
  });
  return reply({ ok: true, entryId: body.entryId, myScores: [...body.scores] }, 200, cors);
}

async function download(request, env, rawKey, cors) {
  const context = await authenticatedContext(request, env, queryCredentials(request), true, true);
  let key;
  try { key = decodeURIComponent(rawKey); } catch { fail(400, '파일 경로가 올바르지 않습니다.'); }
  if (!FILE_RE.test(key)) fail(400, '파일 경로가 올바르지 않습니다.');
  const entry = context.state.entries.find((row) => context.panel.entryIds.includes(row.id)
    && row.files?.some((file) => file.key === key));
  if (!entry) fail(403, '배정된 작품의 첨부파일만 열 수 있습니다.');
  const obj = await env.BUCKET.get(key);
  if (!obj) fail(404, '파일을 찾을 수 없습니다.');
  const name = entry.files.find((file) => file.key === key).name;
  const filename = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(obj.body, { status: 200, headers: {
    ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': String(obj.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
  } });
}

export async function handleJury(request, env, { path, member, cors = {} }) {
  if (request.method === 'GET') {
    if (path === '/festa/jury/admin') return overview(env, member, cors);
    if (path === '/festa/jury/invitation') {
      const credentials = queryCredentials(request);
      if (credentials.token !== undefined) return reply(invitationView(await invitationContext(env, credentials.token)), 200, cors);
      const key = panelKey(credentials.panel);
      const { state } = await readState(env);
      return reply({ panel: key, label: JURY_LABELS[key], status: panelOf(state, key).status }, 200, cors);
    }
    if (path === '/festa/jury/session') return privateSession(request, env, cors);
    if (path.startsWith('/festa/jury/file/')) return download(request, env, path.slice('/festa/jury/file/'.length), cors);
  }
  if (request.method === 'POST') {
    if (path === '/festa/jury/panel') return configure(request, env, member, cors);
    if (path === '/festa/jury/judge') return saveJudge(request, env, member, cors);
    if (path === '/festa/jury/judge/remove') return removeJudge(request, env, member, cors);
    if (path === '/festa/jury/invite') return invite(request, env, member, cors);
    if (path === '/festa/jury/revoke') return revoke(request, env, member, cors);
    if (path === '/festa/jury/status') return changeStatus(request, env, member, cors);
    if (path === '/festa/jury/unlock') return unlock(request, env, cors);
    if (path === '/festa/jury/logout') {
      const body = await jsonBody(request);
      const key = panelKey(body.panel);
      if (body.judgeId !== undefined) await authenticatedContext(request, env, body);
      return reply({ ok: true }, 200, { ...cors, 'Set-Cookie': juryCookie(request, key, '', 0) });
    }
    if (path === '/festa/jury/score') return score(request, env, cors);
  }
  fail(405, '허용되지 않은 심사 요청입니다.');
}
