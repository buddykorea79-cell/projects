/**
 * 투표 규칙 — 저장소 구현과 화면이 함께 쓰는 순수 함수 모음.
 *
 * 서버(R2 모드)는 같은 규칙을 `shared/r2api.js` 안에 따로 갖고 있습니다.
 * 브라우저 판정은 화면을 그리기 위한 것일 뿐이고, 실제 허용 여부는 서버가
 * 다시 봅니다. **두 곳을 함께 고쳐야 합니다.**
 */

/** 1인당 표 수 상한 — 실수로 큰 값이 들어가도 여기서 잘립니다. */
export const VOTE_MAX_PER_MEMBER = 50;

/** 기본 1인당 표 수. */
export const VOTE_DEFAULT_PER_MEMBER = 3;

/**
 * 프로젝트의 투표 설정을 정규화합니다. 투표를 받지 않으면 null 입니다.
 * @returns {{enabled:true,startAt:?string,endAt:?string,perMember:number,
 *            allowSelf:boolean,showCounts:boolean}|null}
 */
export function votingOf(project) {
  const v = project?.voting;
  if (!v || typeof v !== 'object' || !v.enabled) return null;
  const per = Math.round(Number(v.perMember));
  return {
    enabled: true,
    startAt: v.startAt || null,
    endAt: v.endAt || null,
    perMember: Number.isFinite(per)
      ? Math.min(Math.max(per, 1), VOTE_MAX_PER_MEMBER)
      : VOTE_DEFAULT_PER_MEMBER,
    allowSelf: Boolean(v.allowSelf),
    showCounts: v.showCounts !== false,
  };
}

/** 'off'(투표 없음) | 'before'(시작 전) | 'open'(진행중) | 'closed'(마감) */
export function votingPhase(project, now = Date.now()) {
  const cfg = votingOf(project);
  if (!cfg) return 'off';
  const start = cfg.startAt ? new Date(cfg.startAt).getTime() : null;
  const end = cfg.endAt ? new Date(cfg.endAt).getTime() : null;
  if (Number.isFinite(start) && start > now) return 'before';
  if (Number.isFinite(end) && end < now) return 'closed';
  return 'open';
}

/** 지금 표를 넣을 수 있는 프로젝트인지. */
export function votingOpen(project) { return votingPhase(project) === 'open'; }

export const VOTE_PHASE_LABEL = {
  off: '투표 없음',
  before: '투표 예정',
  open: '투표중',
  closed: '투표 마감',
};

const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * 표 목록을 화면이 쓰는 집계로 바꿉니다 — 서버 `/votes` 응답과 같은 모양입니다.
 * 득표수를 숨기도록 설정했다면 counts 를 아예 만들지 않습니다.
 *
 * @param {object} project
 * @param {Array}  rows   전체 표 (프로젝트 상관없이 넘겨도 됩니다)
 * @param {{email:string, role?:string}} me
 */
export function summarizeVotes(project, rows, me) {
  const cfg = votingOf(project);
  const phase = votingPhase(project);
  const list = (rows || []).filter((v) => v.projectId === project.id);
  const mine = list
    .filter((v) => norm(v.voter) === norm(me?.email))
    .map((v) => v.submissionId);

  const showCounts = me?.role === 'admin'
    || phase === 'closed' || phase === 'off'
    || (phase === 'open' && cfg?.showCounts !== false);

  const counts = {};
  if (showCounts) for (const v of list) counts[v.submissionId] = (counts[v.submissionId] || 0) + 1;

  return {
    projectId: project.id,
    phase,
    limit: cfg ? cfg.perMember : 0,
    allowSelf: Boolean(cfg?.allowSelf),
    startAt: cfg?.startAt || null,
    endAt: cfg?.endAt || null,
    // 지금 집계를 볼 수 있는지. 설정값이 아니라 "이 사람에게 지금 보이는가" 입니다.
    showCounts,
    used: mine.length,
    mine,
    counts: showCounts ? counts : null,
    voters: showCounts ? new Set(list.map((v) => norm(v.voter))).size : null,
    total: showCounts ? list.length : null,
  };
}

/**
 * 서버가 없는 저장소(브라우저·GitHub)에서 표를 넣고 빼는 공통 규칙.
 * 바뀐 표 배열을 돌려주고, 넣을 수 없으면 예외를 던집니다.
 * 바뀐 것이 없으면 `null` — 저장할 필요가 없다는 뜻입니다.
 */
export function applyVote(project, rows, me, submissionId, on, submission) {
  const cfg = votingOf(project);
  if (!cfg) throw new Error('이 프로젝트는 투표를 받지 않습니다.');
  const phase = votingPhase(project);
  if (phase !== 'open') {
    throw new Error(phase === 'before' ? '아직 투표 기간이 아닙니다.' : '투표가 마감되었습니다.');
  }
  if (on && !cfg.allowSelf && norm(submission?.author?.email) === norm(me?.email)) {
    throw new Error('본인 제출물에는 투표할 수 없습니다.');
  }

  const list = Array.isArray(rows) ? [...rows] : [];
  const mineHere = list.filter((v) => v.projectId === project.id && norm(v.voter) === norm(me?.email));
  const already = mineHere.find((v) => v.submissionId === submissionId);

  if (!on) return already ? list.filter((v) => v !== already) : null;
  if (already) return null;
  if (mineHere.length >= cfg.perMember) {
    throw new Error(`투표는 1인당 ${cfg.perMember}표까지 할 수 있습니다.`);
  }
  list.push({
    projectId: project.id,
    submissionId,
    voter: norm(me?.email),
    createdAt: new Date().toISOString(),
  });
  return list;
}
