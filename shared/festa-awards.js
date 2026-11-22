/** 최종 시상: 검토용 계산과 발행된 공개 스냅샷을 명확히 분리합니다. */
import { readState, updateState, fail, reply, jsonBody, requireAdmin, entryInstitution,
  judgeCanScore, juryScoreLimits as LIMITS, validJuryScores as validScores, validEmail } from './festa.js';
import { normEmail } from './auth.js';

const TITLE = '말하는 대로, 바이브 코딩 페스타';
const AWARDS = {
  grand: { awardName: '최우수상', certificate: '행정안전부 장관상', prizeText: '50만원 상당' },
  excellence: { awardName: '우수상', certificate: '행정안전부 장관상', prizeText: '30만원 상당' },
  encouragement: { awardName: '장려상', certificate: '한국서부발전 사장상', prizeText: '30만원 상당' },
};
const total = (scores) => scores.reduce((sum, value) => sum + value, 0);
const round = (value) => Math.round(value * 100) / 100;

// 비교는 반올림 전 정수 합계의 교차곱으로 수행합니다. 화면의 표시값으로 순위를 정하지 않습니다.
function merit(a, b) {
  const sumDifference = b.sum * a.count - a.sum * b.count;
  if (sumDifference) return sumDifference;
  for (let i = 0; i < 4; i += 1) {
    const difference = b.items[i] * a.count - a.items[i] * b.count;
    if (difference) return difference;
  }
  return 0;
}
function tieGroupAt(rows, position, reason) {
  const boundary = rows[position];
  const next = rows[position + 1];
  if (!boundary || !next || merit(boundary, next) !== 0) return null;
  const group = rows.filter((row) => merit(row, boundary) === 0);
  return { reason, entryIds: group.map((row) => row.id) };
}
function safeCandidate(row) {
  return {
    entryId: row.id, institution: row.institution, name: row.name, projectTitle: row.title,
    average: row.count ? round(row.sum / row.count) : null,
    criterionAverages: row.count ? row.items.map((sum) => round(sum / row.count)) : null,
    ballotCount: row.count, eligibleCount: row.expected,
  };
}
function recipient(row, award) {
  return {
    award, ...AWARDS[award], institution: row.institution, name: row.name, projectTitle: row.title,
  };
}

/** 기존 위원표와 회원표를 이메일·작품별 한 표로 합칩니다. 회원표는 같은 사람의 이전 위원표를 대체합니다. */
export function finalBallots(panel, entries) {
  const issues = [];
  const judges = Array.isArray(panel?.judges) ? panel.judges : [];
  const works = new Map(entries.map((entry) => [entry.id, entry]));
  const byJudge = new Map(judges.map((judge) => [judge?.id, judge]));
  if (judges.some((judge) => !judge?.id || !validEmail(normEmail(judge.email)))
      || byJudge.size !== judges.length || new Set(judges.map((judge) => normEmail(judge.email))).size !== judges.length) {
    issues.push('이전 최종 심사위원 명단에 중복·누락이 있습니다.');
  }
  const ballots = new Map();
  const seenLegacy = new Set();
  for (const row of Array.isArray(panel?.scores) ? panel.scores : []) {
    const judge = byJudge.get(row?.judgeId);
    const entry = works.get(row?.entryId);
    const duplicate = `${row?.judgeId}/${row?.entryId}`;
    if (!judge || !entry || !judgeCanScore(judge, entry) || !validScores(row?.scores) || seenLegacy.has(duplicate)) {
      issues.push('최종 평가에 중복·미배정·자기평가 또는 범위를 벗어난 점수가 있습니다. 심사 기록을 확인해 주세요.');
      continue;
    }
    seenLegacy.add(duplicate);
    const email = normEmail(judge.email);
    ballots.set(`${email}/${entry.id}`, { judgeId: judge.id, email, name: judge.name || '',
      entryId: entry.id, scores: [...row.scores], member: false });
  }
  if (panel?.memberScores !== undefined && !Array.isArray(panel.memberScores)) issues.push('회원 평가 기록 형식이 올바르지 않습니다.');
  const seenMembers = new Set();
  for (const row of Array.isArray(panel?.memberScores) ? panel.memberScores : []) {
    const email = normEmail(row?.email);
    const entry = works.get(row?.entryId);
    const unique = `${email}/${row?.entryId}`;
    if (!/^fm_[a-f0-9]{64}$/.test(row?.memberId) || typeof row.memberCreatedAt !== 'string'
        || !entry || !judgeCanScore({ id: row.memberId, email }, entry) || !validScores(row?.scores) || seenMembers.has(unique)) {
      issues.push('회원 평가에 중복·미배정·자기평가 또는 범위를 벗어난 점수가 있습니다. 심사 기록을 확인해 주세요.');
      continue;
    }
    seenMembers.add(unique);
    ballots.set(unique, { judgeId: row.memberId, email, name: row.name || '', entryId: entry.id,
      scores: [...row.scores], member: true, memberCreatedAt: row.memberCreatedAt });
  }
  return { rows: [...ballots.values()], issues: [...new Set(issues)] };
}

/** 관리자 전용 계산 결과. 운영 상태는 변경하지 않습니다. */
export function calculateAwards(state, suppliedOrder) {
  const issues = [];
  const panel = state.juryPanels?.final;
  if (!panel || panel.status !== 'closed') issues.push('최종 심사를 마감한 뒤 수상 결과를 확정할 수 있습니다.');
  const ids = Array.isArray(panel?.entryIds) ? panel.entryIds : [];
  if (ids.length !== 6 || new Set(ids).size !== 6) issues.push('최종 심사 작품은 중복 없이 정확히 6개여야 합니다.');
  const entries = ids.map((id) => state.entries.find((entry) => entry.id === id));
  if (entries.some((entry) => !entry)) issues.push('최종 심사 목록에서 찾을 수 없는 작품이 있습니다.');
  const existing = entries.filter(Boolean);
  const owners = existing.map((entry) => normEmail(entry.author?.email));
  if (owners.some((owner) => !owner) || new Set(owners).size !== existing.length) {
    issues.push('최종 후보 6명은 서로 다른 참가자여야 합니다. 동일 참가자의 작품을 중복 선정할 수 없습니다.');
  }
  if (existing.some((entry) => !entryInstitution(entry) || !String(entry.author?.name || '').trim() || !String(entry.title || '').trim())) {
    issues.push('최종 후보의 기관·성명·작품명을 모두 확인해 주세요.');
  }
  if (existing.filter((entry) => entryInstitution(entry) === '행정안전부').length < 2
      || existing.filter((entry) => entryInstitution(entry) === '한국서부발전').length < 1) {
    issues.push('상위 수상자 선정을 위해 행정안전부 후보 2명 이상과 한국서부발전 후보 1명 이상이 필요합니다.');
  }
  const votes = finalBallots(panel, existing);
  issues.push(...votes.issues);
  const candidates = existing.map((entry) => {
    const completed = votes.rows.filter((row) => row.entryId === entry.id).map((row) => row.scores);
    if (!completed.length) issues.push(`“${entry.title}”에 본인 평가를 제외한 유효 평가가 최소 1건 필요합니다.`);
    return {
      id: entry.id, institution: entryInstitution(entry), name: String(entry.author?.name || '').trim(), title: String(entry.title || '').trim(),
      expected: Math.max(1, completed.length), count: completed.length,
      sum: completed.reduce((sum, scores) => sum + total(scores), 0),
      items: LIMITS.map((_, i) => completed.reduce((sum, scores) => sum + scores[i], 0)),
    };
  });
  let order = [];
  if (suppliedOrder !== undefined && suppliedOrder !== null) {
    if (!Array.isArray(suppliedOrder) || suppliedOrder.length !== 6 || new Set(suppliedOrder).size !== 6
        || suppliedOrder.some((id) => typeof id !== 'string' || !ids.includes(id))) {
      issues.push('동점 결정 순서는 최종 후보 6개를 빠짐없이 한 번씩 포함해야 합니다.');
    } else order = suppliedOrder;
  }
  const sort = (a, b) => merit(a, b) || (order.length ? order.indexOf(a.id) - order.indexOf(b.id) : a.id.localeCompare(b.id));
  const ranking = [...candidates].sort(sort);
  const base = {
    ready: false, issues: [...new Set(issues)], ties: [], ranking: ranking.map(safeCandidate), recipients: [], tieOrder: order,
    tieRule: '총점 평균 → 문제 인식 평균 → 기능 구현 수준 평균 → 완성도 평균 → 확산 가능성 평균 순으로 비교합니다. 모두 같아 수상 구분이 달라지는 경우 관리자가 동점 순서를 명시합니다.',
  };
  if (base.issues.length) return base;
  const mois = candidates.filter((row) => row.institution === '행정안전부').sort(sort);
  const iwest = candidates.filter((row) => row.institution === '한국서부발전').sort(sort);
  const quotaTies = [
    tieGroupAt(mois, 1, '행정안전부 상위 2명 선정'),
    tieGroupAt(iwest, 0, '한국서부발전 상위 1명 선정'),
  ].filter(Boolean);
  if (!order.length && quotaTies.length) {
    base.ties = quotaTies;
    base.issues = ['기관별 수상 후보 선정을 위한 완전동점이 있습니다. 아래에서 동점 순서를 정해 다시 검토해 주세요.'];
    return base;
  }
  const podium = [...mois.slice(0, 2), ...iwest.slice(0, 1)].sort(sort);
  const grandTie = tieGroupAt(podium, 0, '최우수상과 우수상 구분');
  const ties = [...quotaTies, ...(grandTie ? [grandTie] : [])];
  if (!order.length && grandTie) {
    base.ties = ties;
    base.issues = ['최우수상 결정에 영향을 주는 완전동점이 있습니다. 동점 순서를 명시해 주세요.'];
    return base;
  }
  const topIds = new Set(podium.map((row) => row.id));
  const remaining = ranking.filter((row) => !topIds.has(row.id));
  return { ...base, ready: true, ties,
    recipients: [recipient(podium[0], 'grand'), ...podium.slice(1).map((row) => recipient(row, 'excellence')),
      ...remaining.map((row) => recipient(row, 'encouragement'))],
  };
}

// 자격 증명 갱신·만료는 고정 심사위원 배정이나 점수 순위를 바꾸지 않습니다.
function fingerprint(state) {
  const panel = state.juryPanels?.final;
  const ids = Array.isArray(panel?.entryIds) ? panel.entryIds : [];
  return JSON.stringify({
    status: panel?.status, entryIds: [...ids].sort(),
    judges: (Array.isArray(panel?.judges) ? panel.judges : []).map((judge) => ({ id: String(judge?.id || ''), email: normEmail(judge?.email) })).sort((a, b) => a.id.localeCompare(b.id)),
    scores: (Array.isArray(panel?.scores) ? panel.scores : []).map((row) => ({ judgeId: row?.judgeId, entryId: row?.entryId, scores: row?.scores }))
      .sort((a, b) => `${a.judgeId}:${a.entryId}`.localeCompare(`${b.judgeId}:${b.entryId}`)),
    memberScores: (Array.isArray(panel?.memberScores) ? panel.memberScores : []).map((row) => ({
      memberId: row?.memberId, email: normEmail(row?.email), memberCreatedAt: row?.memberCreatedAt,
      name: row?.name, entryId: row?.entryId, scores: row?.scores,
    })).sort((a, b) => `${a.memberId}:${a.entryId}`.localeCompare(`${b.memberId}:${b.entryId}`)),
    entries: ids.map((id) => state.entries.find((entry) => entry.id === id)).filter(Boolean)
      .map((entry) => ({ id: entry.id, owner: normEmail(entry.author?.email), institution: entryInstitution(entry), name: entry.author?.name, title: entry.title }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 공개 응답은 발행 스냅샷에서 허용된 필드만 다시 조립합니다. 원본 entry/panel은 전달하지 않습니다. */
export function publicAwards(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.recipients) || snapshot.recipients.length !== 6) {
    fail(503, '발표 자료를 읽지 못했습니다. 운영자에게 문의해 주세요.');
  }
  const counts = { grand: 0, excellence: 0, encouragement: 0 };
  const recipients = snapshot.recipients.map((row) => {
    if (!AWARDS[row?.award] || !['행정안전부', '한국서부발전'].includes(row.institution)
        || typeof row.name !== 'string' || !row.name || row.name.length > 120
        || typeof row.projectTitle !== 'string' || !row.projectTitle || row.projectTitle.length > 500) {
      fail(503, '발표 자료를 읽지 못했습니다. 운영자에게 문의해 주세요.');
    }
    counts[row.award] += 1;
    return { award: row.award, ...AWARDS[row.award], institution: row.institution, name: row.name, projectTitle: row.projectTitle };
  });
  if (counts.grand !== 1 || counts.excellence !== 2 || counts.encouragement !== 3) fail(503, '발표 자료의 수상 구분을 확인해 주세요.');
  return { published: true, title: TITLE, publishedAt: String(snapshot.publishedAt || ''), recipients };
}

function publishPlan(state, plan) {
  const snapshot = { version: 1, publishedAt: new Date().toISOString(), recipients: plan.recipients };
  const publication = publicAwards(snapshot);
  state.awardsPublication = snapshot;
  return publication;
}

// 본선 마감과 발표 자료 저장은 같은 조건부 쓰기로 처리합니다. 완전동점은 관리자 검토로 넘깁니다.
export function publishClosedFinalIfReady(state) {
  if (state.awardsPublication) return;
  const plan = calculateAwards(state);
  if (plan.ready) publishPlan(state, plan);
}

export async function handleAwards(request, env, { path, member, cors = {} }) {
  if (path === '/festa/awards' && request.method === 'GET') {
    const { state } = await readState(env);
    if (!state.awardsPublication) return reply({ message: '최종 수상 결과는 아직 발표되지 않았습니다.' }, 404, cors);
    return reply(publicAwards(state.awardsPublication), 200, cors);
  }
  requireAdmin(member);
  if (path === '/festa/awards/preview' && ['GET', 'POST'].includes(request.method)) {
    const body = request.method === 'POST' ? await jsonBody(request) : {};
    const { state } = await readState(env);
    const plan = calculateAwards(state, body.tieOrder);
    return reply({ ...plan, revision: await digest(fingerprint(state)), published: Boolean(state.awardsPublication),
      publication: state.awardsPublication ? publicAwards(state.awardsPublication) : null }, 200, cors);
  }
  if (path === '/festa/awards/publish' && request.method === 'POST') {
    const body = await jsonBody(request);
    if (body.confirm !== true) fail(400, '검토한 수상 결과의 공개를 확인해 주세요.');
    const { state } = await readState(env);
    if (state.awardsPublication) fail(409, '이미 공개한 수상 결과입니다. 발표 자료는 고정되어 있습니다.');
    const original = fingerprint(state);
    if (body.revision !== await digest(original)) fail(409, '심사 정보가 변경되었습니다. 수상 결과를 다시 검토해 주세요.');
    const { result } = await updateState(env, (current) => {
      if (current.awardsPublication) fail(409, '이미 공개한 수상 결과입니다.');
      if (fingerprint(current) !== original) fail(409, '심사 정보가 변경되었습니다. 수상 결과를 다시 검토해 주세요.');
      const plan = calculateAwards(current, body.tieOrder);
      if (!plan.ready) fail(409, plan.issues.join(' '));
      return publishPlan(current, plan);
    });
    return reply(result, 200, cors);
  }
  return reply({ message: '지원하지 않는 수상 결과 요청입니다.' }, 404, cors);
}
