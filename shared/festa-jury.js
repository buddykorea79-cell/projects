/** 페스타 단계별 코드 입장과 위원별 채점. 이전에 발급한 개인 링크도 지원합니다. */
import { readState, updateState, fail, reply, jsonBody, requireAdmin, entryInstitution, validEmail,
  judgeCanScore, validJuryScores as validScores, validRawJuryScores as validRawScores,
  convertRawJuryScores as convertRawScores, deriveRawJuryScores as deriveRawScores } from './festa.js';
import { normEmail, hashPassword, verifyPassword, signSession, readSession, cookieValue, safeEqual, sessionSecret, conditionFor, readMembers } from './auth.js';
import { publishClosedFinalIfReady, finalBallots } from './festa-awards.js';

export const JURY_KEYS = ['mois', 'iwest', 'final'];
export const PRELIM_KEYS = ['mois', 'iwest'];
export const JURY_LABELS = { mois: '행정안전부 1차 평가', iwest: '한국서부발전 1차 평가', final: '2차 본선 평가' };
export const PRELIM_LABELS = { mois: '예선 심사(행정안전부)', iwest: '예선 심사(한국서부발전)' };
const INSTITUTIONS = { mois: '행정안전부', iwest: '한국서부발전' };
const SIGNATURE_MAX_LEN = 250 * 1024;
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
      || !Array.isArray(panel.entryIds) || !Array.isArray(panel.judges) || !Array.isArray(panel.scores)
      || (panel.memberScores !== undefined && !Array.isArray(panel.memberScores))) {
    fail(503, '심사위원 데이터 형식이 올바르지 않습니다.');
  }
  return panel;
}

function draftOnly(panel) {
  if (panel.status !== 'draft' || panel.scores.length || panel.memberScores?.length) fail(409, '심사를 시작한 뒤에는 작품과 위원 배정을 변경할 수 없습니다.');
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

function publicEntry(entry, judge, rows, blind = false) {
  const own = judge && rows.find((row) => row.judgeId === judge.id && row.entryId === entry.id);
  const myScores = own ? [...own.scores] : null;
  const myRawScores = own
    ? (validRawScores(own.rawScores) ? [...own.rawScores] : deriveRawScores(own.scores))
    : null;
  return {
    id: entry.id, title: entry.title, description: entry.description,
    institution: blind ? '' : entryInstitution(entry), localOnly: Boolean(entry.localOnly),
    deployUrl: entry.deployUrl || '', githubUrl: entry.githubUrl || '',
    files: (entry.files || []).map(({ key, name, size }) => ({ key, name, size })),
    author: blind
      ? { name: '', institution: '' }
      : { name: entry.author?.name || '', institution: entryInstitution(entry) },
    ...(judge ? {
      myScores,
      ...(blind ? { myRawScores } : {}),
      scoreBlocked: judgeCanScore(judge, entry) ? '' : '자신의 작품은 평가할 수 없습니다.',
    } : {}),
  };
}

function parseScoreInput(body, requireRaw = false) {
  if (body.rawScores !== undefined) {
    if (!validRawScores(body.rawScores)) {
      fail(400, '각 4개 항목은 1~10 사이의 정수로 선택해 주세요.');
    }
    return { rawScores: [...body.rawScores], scores: convertRawScores(body.rawScores) };
  }
  if (requireRaw) {
    fail(400, '각 4개 항목은 1~10 사이의 정수로 선택해 주세요.');
  }
  if (!validScores(body.scores)) {
    fail(400, '각 배점(40·30·20·10) 안에서 네 항목의 정수 점수를 입력하세요.');
  }
  return { rawScores: null, scores: [...body.scores] };
}

function validateSigner(signer) {
  if (!signer || typeof signer !== 'object' || Array.isArray(signer)) {
    fail(400, '심사위원 소속, 직급, 성명과 서명을 모두 입력해 주세요.');
  }
  const affiliation = typeof signer.affiliation === 'string' ? signer.affiliation.trim() : '';
  const position = typeof signer.position === 'string' ? signer.position.trim() : '';
  const name = typeof signer.name === 'string' ? signer.name.trim() : '';
  const signatureDataUrl = typeof signer.signatureDataUrl === 'string' ? signer.signatureDataUrl.trim() : '';
  if (!affiliation || affiliation.length > 100) fail(400, '심사위원 소속을 100자 이내로 입력해 주세요.');
  if (!position || position.length > 100) fail(400, '심사위원 직급을 100자 이내로 입력해 주세요.');
  if (!name || name.length > 80) fail(400, '심사위원 성명을 80자 이내로 입력해 주세요.');
  if (!signatureDataUrl.startsWith('data:image/png;base64,')
      || signatureDataUrl.length > SIGNATURE_MAX_LEN) {
    fail(400, '서명란에 직접 서명을 입력해 주세요.');
  }
  const b64 = signatureDataUrl.slice('data:image/png;base64,'.length);
  if (b64.length < 32 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
    fail(400, '서명 이미지 형식이 올바르지 않습니다.');
  }
  return { affiliation, position, name, signatureDataUrl };
}

function buildCompletionRecord({ judgeId, panelKey: key, entries, items, signer, adminPreview = false }) {
  if (!Array.isArray(items) || !items.length) {
    fail(400, '심사 대상 작품의 점수가 모두 입력되지 않았습니다.');
  }
  const byEntry = new Map();
  for (const item of items) {
    if (!item || typeof item.entryId !== 'string' || byEntry.has(item.entryId)) {
      fail(400, '심사 결과에 중복되거나 잘못된 작품 정보가 있습니다.');
    }
    if (!validRawScores(item.rawScores)) {
      fail(400, '모든 작품의 4개 항목을 1~10 사이의 정수로 선택해 주세요.');
    }
    byEntry.set(item.entryId, [...item.rawScores]);
  }
  if (byEntry.size !== entries.length || entries.some((entry) => !byEntry.has(entry.id))) {
    fail(400, '모든 평가 대상 작품의 4개 항목을 빠짐없이 심사한 뒤 완료해 주세요.');
  }
  const rows = entries.map((entry, index) => {
    const rawScores = byEntry.get(entry.id);
    const scores = convertRawScores(rawScores);
    const total = scores.reduce((sum, val) => sum + val, 0);
    return { entryId: entry.id, title: entry.title, rawScores, scores, total, order: index };
  });
  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    for (let i = 0; i < 4; i += 1) {
      if (b.scores[i] !== a.scores[i]) return b.scores[i] - a.scores[i];
    }
    return a.order - b.order;
  });
  let prevTotal = null;
  let rank = 0;
  const rankedResults = rows.map((row, index) => {
    if (row.total !== prevTotal) {
      rank = index + 1;
      prevTotal = row.total;
    }
    return { rank, entryId: row.entryId, title: row.title, rawScores: row.rawScores, scores: row.scores, total: row.total };
  });
  return {
    judgeId,
    panel: key,
    panelLabel: PRELIM_LABELS[key] || JURY_LABELS[key],
    completedAt: new Date().toISOString(),
    affiliation: signer.affiliation,
    position: signer.position,
    name: signer.name,
    signatureDataUrl: signer.signatureDataUrl,
    rankedResults,
    ...(adminPreview ? { adminPreview: true } : {}),
  };
}

function manualScoreRows(panel, entries) {
  const works = new Map(entries.map((entry) => [entry.id, entry]));
  const rows = new Map();
  for (const row of Array.isArray(panel?.manualScores) ? panel.manualScores : []) {
    const entry = works.get(row?.entryId);
    const judgeId = typeof row?.judgeId === 'string' ? row.judgeId : '';
    const judgeEmail = normEmail(row?.judgeEmail);
    const selfVote = judgeEmail && judgeEmail === normEmail(entry?.author?.email);
    if (!judgeId.startsWith('manual_') || !entry || selfVote || !validScores(row?.scores)) continue;
    rows.set(`${judgeId}/${entry.id}`, {
      judgeId,
      judgeName: String(row.judgeName || '수동 심사위원'),
      judgeEmail,
      entryId: entry.id,
      scores: [...row.scores],
      ...(validRawScores(row.rawScores) ? { rawScores: [...row.rawScores] } : {}),
      source: 'excel',
      importedAt: row.importedAt || null,
    });
  }
  return [...rows.values()];
}

function adminTestsSummary(panel) {
  const previews = panel?.adminPreviews;
  if (!previews || typeof previews !== 'object' || Array.isArray(previews)) return [];
  return Object.entries(previews).map(([email, data]) => {
    const scoredCount = Array.isArray(data?.scores) ? data.scores.length : 0;
    const completed = Boolean(data?.completion);
    if (!scoredCount && !completed) return null;
    return {
      email,
      name: String(data?.completion?.name || data?.name || email),
      scoredCount,
      completed,
      completedAt: data?.completion?.completedAt || null,
    };
  }).filter(Boolean);
}

function adminPanel(state, key) {
  const panel = panelOf(state, key);
  const entries = entryList(state, key, panel.entryIds);
  const manualRows = manualScoreRows(panel, entries);
  let rows = key === 'final'
    ? finalBallots(panel, entries).rows
    : [...scoreRows(panel, entries), ...manualRows];
  const people = new Map();
  if (key === 'final') {
    for (const row of rows) {
      const previous = people.get(row.email);
      if (!previous || (row.member && !previous.member)
          || String(row.memberCreatedAt || '') > String(previous.memberCreatedAt || '')) people.set(row.email, row);
    }
    // 이전 PIN·재가입 이력이 있어도 관리자 참여 인원은 같은 이메일을 한 사람으로 표시합니다.
    rows = rows.map((row) => ({ ...row, judgeId: people.get(row.email).judgeId }));
  }
  const participants = [...people.values()].map((row) => ({
    id: row.judgeId, name: row.name, email: row.email, member: Boolean(row.member),
    manual: Boolean(row.manual),
    scoredCount: rows.filter((score) => score.email === row.email).length,
    eligibleCount: entries.filter((entry) => normEmail(entry.author?.email) !== row.email).length,
  }));
  const manualJudgeMap = new Map();
  for (const row of manualRows) {
    const existing = manualJudgeMap.get(row.judgeId);
    if (!existing) {
      manualJudgeMap.set(row.judgeId, {
        id: row.judgeId, name: row.judgeName, email: row.judgeEmail,
        scoredCount: 1, importedAt: row.importedAt,
      });
    } else {
      existing.scoredCount += 1;
      if (row.importedAt && (!existing.importedAt || row.importedAt > existing.importedAt)) existing.importedAt = row.importedAt;
    }
  }
  return {
    key, label: JURY_LABELS[key], status: panel.status, entryIds: [...panel.entryIds],
    ...(key === 'final' ? { memberVoting: true, participants, minimumBallots: 1 } : {}),
    judges: panel.judges.map((judge) => {
      const comp = panel.completions?.[judge.id];
      return {
        id: judge.id, name: judge.name, email: judge.email,
        institution: judge.institution || INSTITUTIONS[key] || '',
        expiresAt: judge.expiresAt || null,
        revoked: Boolean(judge.revoked), hasInvite: Boolean(judge.tokenHash && judge.pinHash),
        hasCommonCode: Boolean(judge.pinLookup && judge.pinHash),
        scoredCount: rows.filter((row) => row.judgeId === judge.id).length,
        eligibleCount: entries.filter((entry) => judgeCanScore(judge, entry)).length,
        completed: Boolean(comp),
        completedAt: comp?.completedAt || null,
      };
    }),
    manualJudges: [...manualJudgeMap.values()],
    adminTests: adminTestsSummary(panel),
    scores: rows.map((row) => ({
      judgeId: row.judgeId, entryId: row.entryId, scores: [...row.scores],
      ...(validRawScores(row.rawScores) ? { rawScores: [...row.rawScores] } : {}),
      ...(row.source === 'excel' || row.manual ? { source: 'excel', judgeName: row.judgeName || row.name || '수동 심사위원' } : {}),
    })),
    results: entries.map((entry) => {
      const votes = rows.filter((row) => row.entryId === entry.id);
      const manualCount = votes.filter((row) => row.source === 'excel' || row.manual).length;
      const criterionAverages = votes.length
        ? [0, 1, 2, 3].map((i) => Math.round((votes.reduce((s, r) => s + r.scores[i], 0) / votes.length) * 100) / 100)
        : null;
      return {
        entryId: entry.id,
        scoreCount: votes.length,
        onlineCount: votes.length - manualCount,
        manualCount,
        criterionAverages,
        average: votes.length ? votes.reduce((sum, row) => sum + row.scores.reduce((a, b) => a + b, 0), 0) / votes.length : null,
      };
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
    if (key === 'final' && current.awardsPublication) fail(409, '공개된 본선 결과는 변경할 수 없습니다.');
    draftOnly(panel);
    entryList(current, key, body.entryIds);
    panel.entryIds = [...body.entryIds];
  });
  return reply({ panel: adminPanel(state, key) }, 200, cors);
}

async function adminEmailSet(env) {
  try {
    const { list } = await readMembers(env);
    return new Set(
      (Array.isArray(list) ? list : [])
        .filter((row) => row?.role === 'admin')
        .map((row) => normEmail(row?.email))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

const INSTITUTION_TO_PANEL = { 행정안전부: 'mois', 한국서부발전: 'iwest' };

async function saveJudge(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const sourceKey = panelKey(body.panel);
  const email = normEmail(body.email);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!validEmail(email) || !name || name.length > 80) fail(400, '심사위원 성명과 올바른 이메일을 입력하세요.');
  let targetKey = sourceKey;
  let institution = INSTITUTIONS[sourceKey] || '';
  if (body.institution !== undefined && body.institution !== '') {
    if (!Object.hasOwn(INSTITUTION_TO_PANEL, body.institution)) {
      fail(400, '기관명은 행정안전부 또는 한국서부발전 중에서 선택해 주세요.');
    }
    institution = body.institution;
    if (PRELIM_KEYS.includes(sourceKey)) targetKey = INSTITUTION_TO_PANEL[institution];
  }
  const admins = await adminEmailSet(env);
  if (admins.has(email) || email === normEmail(member.email)) {
    fail(400, '관리자 이메일은 실제 심사위원으로 등록할 수 없습니다. 관리자는 테스트 모드로만 심사를 점검할 수 있습니다.');
  }
  const newId = `fj_${crypto.randomUUID()}`;
  const { state, result } = await updateState(env, (current) => {
    const sourcePanel = panelOf(current, sourceKey, true);
    const targetPanel = targetKey === sourceKey ? sourcePanel : panelOf(current, targetKey, true);
    draftOnly(sourcePanel);
    if (targetPanel !== sourcePanel) draftOnly(targetPanel);
    const existing = body.judgeId ? findJudge(sourcePanel, body.judgeId) : null;
    if (targetPanel.judges.some((judge) => judge.email === email && judge.id !== existing?.id)) {
      fail(409, '이미 해당 기관에 배정한 심사위원 이메일입니다.');
    }
    if (!existing && targetPanel.judges.length >= 100) fail(400, '심사위원은 단계별 100명까지 배정할 수 있습니다.');
    if (existing) {
      const moved = targetPanel !== sourcePanel;
      const changed = moved || existing.email !== email || existing.name !== name || (existing.institution || INSTITUTIONS[sourceKey] || '') !== institution;
      if (changed) {
        Object.assign(existing, {
          name, email, institution, tokenHash: null, pinHash: null, pinLookup: null, expiresAt: 0,
          revoked: true, credentialVersion: crypto.randomUUID(), failedAttempts: 0, lockedUntil: 0,
        });
      }
      if (moved) {
        sourcePanel.judges = sourcePanel.judges.filter((row) => row.id !== existing.id);
        targetPanel.judges.push(existing);
      }
      return { id: existing.id, panelKey: targetKey };
    }
    targetPanel.judges.push({
      id: newId, name, email, institution, revoked: false, expiresAt: 0,
      failedAttempts: 0, lockedUntil: 0, credentialVersion: crypto.randomUUID(),
    });
    return { id: newId, panelKey: targetKey };
  });
  return reply({
    panel: result.panelKey,
    judge: adminPanel(state, result.panelKey).judges.find((judge) => judge.id === result.id),
  }, 200, cors);
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
  let activeMemberEmails = new Set();
  if (body.status === 'open' && key !== 'final') {
    try {
      const { list } = await readMembers(env);
      activeMemberEmails = new Set(
        (Array.isArray(list) ? list : [])
          .filter((row) => (row?.status || 'active') === 'active')
          .map((row) => normEmail(row?.email))
          .filter(Boolean),
      );
    } catch { /* 회원 명부가 없으면 초대 코드 기준으로만 검사합니다. */ }
  }
  const { state } = await updateState(env, (current) => {
    const panel = panelOf(current, key, true);
    if (body.status === 'open') {
      if (key === 'final' && current.awardsPublication) fail(409, '공개된 본선 결과는 변경할 수 없습니다.');
      draftOnly(panel);
      if (current.phase === 'open') fail(409, '출품 접수를 수동 마감한 뒤 심사를 시작하세요.');
      const entries = entryList(current, key, panel.entryIds, true);
      if (key !== 'final') {
        const hasValidAccess = (judge) => !judge.revoked && (
          Boolean(judge.tokenHash && judge.pinHash && judge.expiresAt > Date.now())
          || activeMemberEmails.has(normEmail(judge.email))
        );
        if (!panel.judges.length || panel.judges.some((judge) => !hasValidAccess(judge))) {
          fail(409, '모든 배정 위원에게 유효한 개별 초대를 발급하거나 사이트 가입 이메일을 확인하세요.');
        }
        if (entries.some((entry) => !panel.judges.some((judge) => judgeCanScore(judge, entry)))) {
          fail(409, '본인 평가를 제외한 유효 심사위원이 없는 작품이 있습니다. 위원 배정을 확인하세요.');
        }
      }
      panel.status = 'open';
      panel.openedAt = new Date().toISOString();
    } else {
      if (panel.status !== 'open') fail(409, '진행 중인 심사만 마감할 수 있습니다.');
      const entries = entryList(current, key, panel.entryIds, true);
      if (key === 'final') {
        const ballots = finalBallots(panel, entries);
        if (ballots.issues.length) fail(409, ballots.issues.join(' '));
        if (entries.some((entry) => !ballots.rows.some((row) => row.entryId === entry.id))) {
          fail(409, '모든 본선 작품에 본인 평가를 제외한 유효 평가가 최소 1건 있어야 마감할 수 있습니다.');
        }
      } else {
        const rows = scoreRows(panel, entries);
        const scored = new Set(rows.map((row) => `${row.judgeId}/${row.entryId}`));
        if (entries.some((entry) => {
          const eligible = panel.judges.filter((judge) => judgeCanScore(judge, entry));
          return !eligible.length || eligible.some((judge) => !scored.has(`${judge.id}/${entry.id}`));
        })) fail(409, '모든 배정 위원의 평가가 완료된 뒤 마감하세요.');
      }
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
  if (key === 'final') fail(409, '2차 본선 평가는 회원 로그인 후 참여해 주세요. 심사 코드는 필요하지 않습니다.');
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
  if (context.key === 'final') fail(409, '2차 본선 평가는 회원 로그인 후 참여해 주세요. 심사 코드는 필요하지 않습니다.');
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
  if (key === 'final') fail(409, '2차 본선 평가는 회원 로그인 후 참여해 주세요. 심사 코드는 필요하지 않습니다.');
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
  const blind = PRELIM_KEYS.includes(context.key);
  const entries = context.panel.status === 'open'
    ? entryList(context.state, context.key, context.panel.entryIds) : [];
  const completion = context.panel.completions?.[context.judge.id] || null;
  return reply({
    ...invitationView(context),
    ...(blind ? { blind: true, defaultName: context.judge.name || '', completion } : {}),
    entries: entries.map((entry) => publicEntry(entry, context.judge,
      context.panel.scores.filter((row) => row.judgeId === context.judge.id), blind)),
  }, 200, cors);
}

async function score(request, env, cors) {
  const body = await jsonBody(request);
  if (typeof body.entryId !== 'string') fail(400, '작품 정보가 올바르지 않습니다.');
  const { rawScores, scores } = parseScoreInput(body, false);
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
    const row = {
      judgeId: judge.id, entryId: entry.id, scores: [...scores],
      ...(rawScores ? { rawScores: [...rawScores] } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (index >= 0) panel.scores[index] = row;
    else panel.scores.push(row);
    if (panel.completions?.[judge.id]) delete panel.completions[judge.id];
  });
  return reply({
    ok: true, entryId: body.entryId, myScores: [...scores],
    ...(rawScores ? { myRawScores: [...rawScores] } : {}),
  }, 200, cors);
}

async function pinComplete(request, env, cors) {
  const body = await jsonBody(request, 384 * 1024);
  const signer = validateSigner(body.signer);
  const context = await authenticatedContext(request, env, body, true, true);
  if (!PRELIM_KEYS.includes(context.key)) fail(400, '예선 심사 단계에서만 사용할 수 있습니다.');
  const { result: completion } = await updateState(env, (state) => {
    const panel = panelOf(state, context.key);
    const judge = findJudge(panel, context.judge.id);
    activeInvite(judge);
    if (judge.credentialVersion !== context.judge.credentialVersion || judge.tokenHash !== context.tokenHash) {
      fail(401, '초대가 변경되었습니다. 다시 인증해 주세요.');
    }
    if (panel.status !== 'open') fail(409, '마감된 심사는 완료할 수 없습니다.');
    const assigned = entryList(state, context.key, panel.entryIds);
    const eligible = assigned.filter((entry) => judgeCanScore(judge, entry));
    const record = buildCompletionRecord({
      judgeId: judge.id, panelKey: context.key, entries: eligible, items: body.items, signer,
    });
    const now = record.completedAt;
    for (const item of record.rankedResults) {
      const idx = panel.scores.findIndex((row) => row.judgeId === judge.id && row.entryId === item.entryId);
      const scoreRow = {
        judgeId: judge.id, entryId: item.entryId, scores: [...item.scores], rawScores: [...item.rawScores], updatedAt: now,
      };
      if (idx >= 0) panel.scores[idx] = scoreRow;
      else panel.scores.push(scoreRow);
    }
    panel.completions ??= {};
    panel.completions[judge.id] = record;
    return record;
  });
  return reply({ ok: true, completion }, 200, cors);
}

function prelimKey(value) {
  if (!PRELIM_KEYS.includes(value)) fail(400, '올바른 예선 심사 기관을 선택해 주세요.');
  return value;
}

function requireActiveMember(member) {
  if (!member || (member.status || 'active') !== 'active' || !validEmail(normEmail(member.email))) {
    fail(401, '회원 로그인 후 예선 심사를 이용할 수 있습니다.');
  }
  return member;
}

function prelimTargets(state, key, panel, adminPreview) {
  if (panel.entryIds.length) return entryList(state, key, panel.entryIds);
  if (adminPreview) {
    return state.entries.filter((entry) => entryInstitution(entry) === INSTITUTIONS[key]);
  }
  return [];
}

function resolvePrelimAccess(state, key, member) {
  const panel = panelOf(state, key);
  const email = normEmail(member.email);
  // 관리자는 실제 심사위원 집계에 참여하지 않고 항상 테스트 모드로만 심사 화면을 점검합니다.
  if (member.role === 'admin') return { mode: 'admin-preview', panel, judge: null, email };
  const judge = panel.judges.find((row) => normEmail(row?.email) === email && !row.revoked) || null;
  if (judge) return { mode: 'judge', panel, judge, email };
  fail(403, '해당 기관의 예선 심사위원으로 등록된 이메일이 아닙니다.');
}

async function prelimSession(request, env, member, cors) {
  requireActiveMember(member);
  const key = prelimKey(new URL(request.url).searchParams.get('panel'));
  const { state } = await readState(env);
  const access = resolvePrelimAccess(state, key, member);
  const isPreview = access.mode === 'admin-preview';
  const otherKey = key === 'mois' ? 'iwest' : 'mois';
  const otherPanel = panelOf(state, otherKey);
  const canSwitchPanel = isPreview || otherPanel.judges.some(
    (row) => normEmail(row?.email) === access.email && !row.revoked && (!row.institution || row.institution === INSTITUTIONS[otherKey]),
  );
  const canScore = isPreview ? access.panel.status !== 'closed' : access.panel.status === 'open';
  const rawEntries = (canScore || isPreview) ? prelimTargets(state, key, access.panel, isPreview) : [];
  if (isPreview) {
    const preview = access.panel.adminPreviews?.[access.email] || { scores: [], completion: null };
    const pseudoJudge = { id: `admin:${access.email}`, email: '' };
    return reply({
      panel: key,
      label: PRELIM_LABELS[key],
      status: access.panel.status,
      mode: 'admin-preview',
      adminPreview: true,
      canSwitchPanel: true,
      blind: true,
      canScore,
      judgeId: pseudoJudge.id,
      judgeName: String(member.name || '관리자'),
      defaultAffiliation: String(member.institution || ''),
      defaultName: String(member.name || ''),
      completion: preview.completion || null,
      entries: rawEntries.map((entry) => {
        const own = (preview.scores || []).find((row) => row.entryId === entry.id);
        return {
          id: entry.id, title: entry.title, description: entry.description,
          institution: '', localOnly: Boolean(entry.localOnly),
          deployUrl: entry.deployUrl || '', githubUrl: entry.githubUrl || '',
          files: (entry.files || []).map(({ key: fKey, name, size }) => ({ key: fKey, name, size })),
          author: { name: '', institution: '' },
          myScores: own ? [...own.scores] : null,
          myRawScores: own && validRawScores(own.rawScores) ? [...own.rawScores] : deriveRawScores(own?.scores),
          scoreBlocked: '',
        };
      }),
    }, 200, cors);
  }
  const ownRows = access.panel.scores.filter((row) => row.judgeId === access.judge.id);
  return reply({
    panel: key,
    label: PRELIM_LABELS[key],
    status: access.panel.status,
    mode: 'judge',
    adminPreview: false,
    canSwitchPanel,
    blind: true,
    canScore,
    judgeId: access.judge.id,
    judgeName: access.judge.name || String(member.name || ''),
    defaultAffiliation: String(member.institution || ''),
    defaultName: access.judge.name || String(member.name || ''),
    completion: access.panel.completions?.[access.judge.id] || null,
    entries: rawEntries.map((entry) => publicEntry(entry, access.judge, ownRows, true)),
  }, 200, cors);
}

async function prelimScore(request, env, member, cors) {
  requireActiveMember(member);
  const body = await jsonBody(request);
  const key = prelimKey(body.panel);
  if (typeof body.entryId !== 'string') fail(400, '작품 정보가 올바르지 않습니다.');
  const { rawScores, scores } = parseScoreInput(body, true);
  await updateState(env, (state) => {
    const access = resolvePrelimAccess(state, key, member);
    const panel = panelOf(state, key, true);
    if (access.mode === 'admin-preview') {
      if (panel.status === 'closed') fail(409, '마감된 심사는 수정할 수 없습니다.');
      const targets = prelimTargets(state, key, panel, true);
      if (!targets.some((entry) => entry.id === body.entryId)) fail(403, '해당 기관의 예선 대상 작품만 평가할 수 있습니다.');
      panel.adminPreviews ??= {};
      const preview = panel.adminPreviews[access.email] ??= { name: String(member.name || access.email), scores: [], completion: null };
      preview.name = String(member.name || access.email);
      const idx = preview.scores.findIndex((row) => row.entryId === body.entryId);
      const row = { entryId: body.entryId, scores: [...scores], rawScores: [...rawScores], updatedAt: new Date().toISOString() };
      if (idx >= 0) preview.scores[idx] = row;
      else preview.scores.push(row);
      preview.completion = null;
      return;
    }
    if (panel.status !== 'open') fail(409, '현재 진행 중인 심사가 아닙니다.');
    if (!panel.entryIds.includes(body.entryId)) fail(403, '배정된 작품만 평가할 수 있습니다.');
    const entry = state.entries.find((row) => row.id === body.entryId);
    if (!entry || !judgeCanScore(access.judge, entry)) fail(403, '자신의 작품은 평가할 수 없습니다.');
    const idx = panel.scores.findIndex((row) => row.judgeId === access.judge.id && row.entryId === entry.id);
    const row = {
      judgeId: access.judge.id, entryId: entry.id, scores: [...scores], rawScores: [...rawScores],
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) panel.scores[idx] = row;
    else panel.scores.push(row);
    if (panel.completions?.[access.judge.id]) delete panel.completions[access.judge.id];
  });
  return reply({ ok: true, entryId: body.entryId, myRawScores: [...rawScores], myScores: [...scores] }, 200, cors);
}

async function prelimComplete(request, env, member, cors) {
  requireActiveMember(member);
  const body = await jsonBody(request, 384 * 1024);
  const key = prelimKey(body.panel);
  const signer = validateSigner(body.signer);
  const { result: completion } = await updateState(env, (state) => {
    const access = resolvePrelimAccess(state, key, member);
    const panel = panelOf(state, key, true);
    if (access.mode === 'admin-preview') {
      if (panel.status === 'closed') fail(409, '마감된 심사는 완료할 수 없습니다.');
      const targets = prelimTargets(state, key, panel, true);
      if (!targets.length) fail(409, '심사할 작품이 없습니다.');
      const record = buildCompletionRecord({
        judgeId: `admin:${access.email}`, panelKey: key, entries: targets, items: body.items, signer, adminPreview: true,
      });
      panel.adminPreviews ??= {};
      panel.adminPreviews[access.email] = {
        scores: record.rankedResults.map((item) => ({
          entryId: item.entryId, scores: [...item.scores], rawScores: [...item.rawScores], updatedAt: record.completedAt,
        })),
        completion: record,
      };
      return record;
    }
    if (panel.status !== 'open') fail(409, '현재 진행 중인 심사가 아닙니다.');
    const assigned = entryList(state, key, panel.entryIds);
    const eligible = assigned.filter((entry) => judgeCanScore(access.judge, entry));
    const record = buildCompletionRecord({
      judgeId: access.judge.id, panelKey: key, entries: eligible, items: body.items, signer,
    });
    for (const item of record.rankedResults) {
      const idx = panel.scores.findIndex((row) => row.judgeId === access.judge.id && row.entryId === item.entryId);
      const scoreRow = {
        judgeId: access.judge.id, entryId: item.entryId, scores: [...item.scores], rawScores: [...item.rawScores],
        updatedAt: record.completedAt,
      };
      if (idx >= 0) panel.scores[idx] = scoreRow;
      else panel.scores.push(scoreRow);
    }
    panel.completions ??= {};
    panel.completions[access.judge.id] = record;
    return record;
  });
  return reply({ ok: true, completion }, 200, cors);
}

async function prelimDownload(request, env, member, rawKey, cors) {
  requireActiveMember(member);
  const key = prelimKey(new URL(request.url).searchParams.get('panel'));
  const { state } = await readState(env);
  const access = resolvePrelimAccess(state, key, member);
  const isPreview = access.mode === 'admin-preview';
  if (!isPreview && access.panel.status !== 'open') fail(409, '마감된 심사의 파일은 열 수 없습니다.');
  const targets = prelimTargets(state, key, access.panel, isPreview);
  return downloadAssigned(env, state, { entryIds: targets.map((entry) => entry.id) }, rawKey, cors);
}

async function adminCompletion(request, env, member, cors) {
  requireAdmin(member);
  const query = new URL(request.url).searchParams;
  const key = prelimKey(query.get('panel'));
  const judgeId = query.get('judgeId');
  const { state } = await readState(env);
  const panel = panelOf(state, key);
  findJudge(panel, judgeId);
  const completion = panel.completions?.[judgeId];
  if (!completion) fail(404, '해당 심사위원의 완료 기록이 없습니다.');
  return reply({ completion }, 200, cors);
}

async function download(request, env, rawKey, cors) {
  const context = await authenticatedContext(request, env, queryCredentials(request), true, true);
  return downloadAssigned(env, context.state, context.panel, rawKey, cors);
}

async function downloadAssigned(env, state, panel, rawKey, cors) {
  let key;
  try { key = decodeURIComponent(rawKey); } catch { fail(400, '파일 경로가 올바르지 않습니다.'); }
  if (!FILE_RE.test(key)) fail(400, '파일 경로가 올바르지 않습니다.');
  const entry = state.entries.find((row) => panel.entryIds.includes(row.id)
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

async function memberIdentity(env, member) {
  if (!member || (member.status || 'active') !== 'active' || !validEmail(normEmail(member.email))) {
    fail(401, '회원 로그인 후 2차 본선 평가에 참여해 주세요.');
  }
  const email = normEmail(member.email);
  const memberCreatedAt = String(member.createdAt || '');
  return { id: `fm_${await privateSelector(env, 'member', 'final', JSON.stringify([email, memberCreatedAt]))}`,
    email, name: String(member.name || ''), memberCreatedAt };
}

async function memberFinal(env, member, cors) {
  const identity = await memberIdentity(env, member);
  const { state } = await readState(env);
  const panel = panelOf(state, 'final');
  if (member.role === 'admin') {
    const entries = panel.status !== 'closed' ? entryList(state, 'final', panel.entryIds) : [];
    const preview = panel.adminPreviews?.[identity.email] || { scores: [] };
    const own = (preview.scores || []).map((row) => ({ ...row, judgeId: identity.id }));
    return reply({
      panel: 'final', label: JURY_LABELS.final, status: panel.status,
      adminTest: true, judgeId: identity.id, judgeName: identity.name,
      entries: entries.map((entry) => publicEntry(entry, { id: identity.id, email: '' }, own)),
    }, 200, cors);
  }
  const entries = panel.status === 'open' ? entryList(state, 'final', panel.entryIds) : [];
  // 재가입한 계정에는 이전 가입의 비공개 점수를 보여 주지 않습니다.
  const own = (panel.memberScores || []).filter((row) => row.memberId === identity.id)
    .map((row) => ({ ...row, judgeId: identity.id }));
  return reply({ panel: 'final', label: JURY_LABELS.final, status: panel.status,
    judgeId: identity.id, judgeName: identity.name,
    entries: entries.map((entry) => publicEntry(entry, identity, own)) }, 200, cors);
}

async function memberScore(request, env, member, cors) {
  const identity = await memberIdentity(env, member);
  const body = await jsonBody(request);
  if (body.expectedMemberId !== undefined && body.expectedMemberId !== identity.id) {
    fail(409, '로그인한 회원이 바뀌었습니다. 현재 계정을 확인한 뒤 평가해 주세요.');
  }
  if (typeof body.entryId !== 'string' || !validScores(body.scores)) fail(400, '각 배점(40·30·20·10) 안에서 네 항목의 정수 점수를 입력하세요.');
  if (member.role === 'admin') {
    await updateState(env, (state) => {
      const panel = panelOf(state, 'final', true);
      if (panel.status === 'closed' || state.awardsPublication) fail(409, '마감된 본선 평가에서는 테스트 점수를 저장할 수 없습니다.');
      if (!panel.entryIds.includes(body.entryId)) fail(403, '본선에 선정된 작품만 테스트 평가할 수 있습니다.');
      panel.adminPreviews ??= {};
      const preview = panel.adminPreviews[identity.email] ??= { name: identity.name, scores: [] };
      preview.name = identity.name || identity.email;
      const idx = preview.scores.findIndex((row) => row.entryId === body.entryId);
      const row = { entryId: body.entryId, scores: [...body.scores], updatedAt: new Date().toISOString() };
      if (idx >= 0) preview.scores[idx] = row;
      else preview.scores.push(row);
    });
    return reply({ ok: true, adminTest: true, entryId: body.entryId, myScores: [...body.scores] }, 200, cors);
  }
  await updateState(env, (state) => {
    const panel = panelOf(state, 'final');
    if (panel.status !== 'open' || state.awardsPublication) fail(409, '현재 진행 중인 2차 본선 평가가 아닙니다.');
    if (!panel.entryIds.includes(body.entryId)) fail(403, '본선에 선정된 작품만 평가할 수 있습니다.');
    const entry = state.entries.find((row) => row.id === body.entryId);
    if (!entry || !judgeCanScore(identity, entry)) fail(403, '자신의 작품은 평가할 수 없습니다.');
    panel.memberScores ??= [];
    // 이전 가입/동일 이메일의 표도 작품당 한 표로 교체합니다. 신원은 요청 본문에서 받지 않습니다.
    panel.memberScores = panel.memberScores.filter((row) => !(normEmail(row.email) === identity.email && row.entryId === entry.id));
    panel.memberScores.push({ memberId: identity.id, email: identity.email, memberCreatedAt: identity.memberCreatedAt,
      name: identity.name, entryId: entry.id, scores: [...body.scores], updatedAt: new Date().toISOString() });
  });
  return reply({ ok: true, entryId: body.entryId, myScores: [...body.scores] }, 200, cors);
}

async function manualImport(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request, 512 * 1024);
  const key = panelKey(body.panel);
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 2000) {
    fail(400, '업로드할 수동심사 행이 1~2,000건 범위여야 합니다.');
  }
  const admins = await adminEmailSet(env);
  admins.add(normEmail(member.email));
  const now = new Date().toISOString();
  const isPrelim = PRELIM_KEYS.includes(key);

  const normalized = [];
  for (let i = 0; i < body.rows.length; i += 1) {
    const raw = body.rows[i];
    if (!raw || typeof raw !== 'object') fail(400, `${i + 1}번째 행 형식이 올바르지 않습니다.`);
    const entryId = typeof raw.entryId === 'string' ? raw.entryId.trim() : '';
    const judgeName = typeof raw.judgeName === 'string' ? raw.judgeName.trim() : '';
    const judgeEmail = typeof raw.judgeEmail === 'string' ? normEmail(raw.judgeEmail) : '';
    if (!entryId) fail(400, `${i + 1}번째 행: 접수번호(entryId)가 비어 있습니다.`);
    if (!judgeName || judgeName.length > 80) fail(400, `${i + 1}번째 행: 심사위원명을 1~80자로 입력해 주세요.`);
    if (judgeEmail) {
      if (!validEmail(judgeEmail)) fail(400, `${i + 1}번째 행: 심사위원 이메일 형식이 올바르지 않습니다.`);
      if (admins.has(judgeEmail)) fail(400, `${i + 1}번째 행: 관리자 이메일(${judgeEmail})은 공식 심사 점수에 반영할 수 없습니다.`);
    }
    let scores;
    let rawScores = null;
    if (raw.rawScores !== undefined && raw.rawScores !== null) {
      if (!validRawScores(raw.rawScores)) {
        fail(400, `${i + 1}번째 행: 4개 항목 점수는 1~10 사이의 정수로 입력해 주세요.`);
      }
      rawScores = [...raw.rawScores];
      scores = convertRawScores(rawScores);
    } else if (validScores(raw.scores)) {
      if (isPrelim) {
        const derived = deriveRawScores(raw.scores);
        rawScores = derived ? [...derived] : null;
      }
      scores = [...raw.scores];
    } else {
      fail(400, `${i + 1}번째 행: ${isPrelim ? '4개 항목은 1~10 사이 정수로 입력해 주세요.' : '각 항목 배점(40·30·20·10) 범위의 정수로 입력해 주세요.'}`);
    }
    const identityKey = judgeEmail || judgeName.toLowerCase();
    const judgeId = `manual_${await digest(`${key}:${identityKey}`)}`.slice(0, 23);
    normalized.push({ judgeId, judgeName, judgeEmail, entryId, scores, rawScores });
  }

  const { state, result } = await updateState(env, (current) => {
    const panel = panelOf(current, key, true);
    if (panel.status === 'closed') fail(409, '마감된 심사 단계에는 엑셀 점수를 반영할 수 없습니다.');
    if (key === 'final' && current.awardsPublication) fail(409, '공개된 본선 결과에는 점수를 반영할 수 없습니다.');
    if (!panel.entryIds.length) fail(409, '먼저 [심사위원·평가 대상 관리]에서 평가 대상 작품을 선택·저장해 주세요.');
    const allowed = new Map(entryList(current, key, panel.entryIds).map((e) => [e.id, e]));
    const nextMap = new Map();
    if (mode === 'merge') {
      for (const existing of Array.isArray(panel.manualScores) ? panel.manualScores : []) {
        nextMap.set(`${existing.judgeId}/${existing.entryId}`, existing);
      }
    }
    for (let i = 0; i < normalized.length; i += 1) {
      const row = normalized[i];
      const entry = allowed.get(row.entryId);
      if (!entry) fail(400, `${i + 1}번째 행: 접수번호(${row.entryId})는 이 단계의 평가 대상 작품이 아닙니다.`);
      if (row.judgeEmail && row.judgeEmail === normEmail(entry.author?.email)) {
        fail(400, `${i + 1}번째 행: 출품자 본인(${row.judgeEmail})의 점수는 반영할 수 없습니다.`);
      }
      nextMap.set(`${row.judgeId}/${row.entryId}`, {
        judgeId: row.judgeId,
        judgeName: row.judgeName,
        judgeEmail: row.judgeEmail,
        entryId: row.entryId,
        scores: row.scores,
        ...(row.rawScores ? { rawScores: row.rawScores } : {}),
        source: 'excel',
        importedAt: now,
      });
    }
    panel.manualScores = [...nextMap.values()];
    return { importedCount: normalized.length, totalManualCount: panel.manualScores.length };
  });
  return reply({ ok: true, ...result, panel: adminPanel(state, key) }, 200, cors);
}

async function manualClear(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const key = panelKey(body.panel);
  const judgeId = typeof body.judgeId === 'string' ? body.judgeId.trim() : '';
  const { state } = await updateState(env, (current) => {
    const panel = panelOf(current, key, true);
    if (panel.status === 'closed') fail(409, '마감된 심사의 점수는 삭제할 수 없습니다.');
    if (key === 'final' && current.awardsPublication) fail(409, '공개된 본선 결과의 점수는 삭제할 수 없습니다.');
    const prev = Array.isArray(panel.manualScores) ? panel.manualScores : [];
    panel.manualScores = judgeId ? prev.filter((row) => row.judgeId !== judgeId) : [];
  });
  return reply({ ok: true, panel: adminPanel(state, key) }, 200, cors);
}

async function testClear(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const key = panelKey(body.panel);
  const email = normEmail(member.email);
  const { state } = await updateState(env, (current) => {
    const panel = panelOf(current, key, true);
    if (!panel.adminPreviews || typeof panel.adminPreviews !== 'object') return;
    if (body.all === true) panel.adminPreviews = {};
    else delete panel.adminPreviews[email];
  });
  return reply({ ok: true, panel: adminPanel(state, key) }, 200, cors);
}

async function memberDownload(env, member, rawKey, cors) {
  await memberIdentity(env, member);
  const { state } = await readState(env);
  const panel = panelOf(state, 'final');
  if (panel.status !== 'open' || state.awardsPublication) fail(409, '현재 진행 중인 2차 본선 평가가 아닙니다.');
  return downloadAssigned(env, state, panel, rawKey, cors);
}

export async function handleJury(request, env, { path, member, cors = {} }) {
  if (request.method === 'GET') {
    if (path === '/festa/jury/prelim') return prelimSession(request, env, member, cors);
    if (path.startsWith('/festa/jury/prelim/file/')) return prelimDownload(request, env, member, path.slice('/festa/jury/prelim/file/'.length), cors);
    if (path === '/festa/jury/admin/completion') return adminCompletion(request, env, member, cors);
    if (path === '/festa/jury/member-final') return memberFinal(env, member, cors);
    if (path.startsWith('/festa/jury/member-file/')) return memberDownload(env, member, path.slice('/festa/jury/member-file/'.length), cors);
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
    if (path === '/festa/jury/manual-import') return manualImport(request, env, member, cors);
    if (path === '/festa/jury/manual-clear') return manualClear(request, env, member, cors);
    if (path === '/festa/jury/test-clear') return testClear(request, env, member, cors);
    if (path === '/festa/jury/prelim/score') return prelimScore(request, env, member, cors);
    if (path === '/festa/jury/prelim/complete') return prelimComplete(request, env, member, cors);
    if (path === '/festa/jury/complete') return pinComplete(request, env, cors);
    if (path === '/festa/jury/member-score') return memberScore(request, env, member, cors);
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
