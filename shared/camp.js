/**
 * AI Build Camp 규칙 — 조 편성과 발표 평가 (서버 측).
 *
 * `assets/js/camp.js` 와 **같은 내용의 사본**입니다. 브라우저는 `shared/` 를
 * 받지 않아(.assetsignore) import 로 공유할 수 없어서 두 벌로 둡니다.
 * 규칙을 고칠 때는 **두 파일을 함께** 고치세요 — tests/camp.test.mjs 가
 * 두 파일이 어긋나지 않았는지 확인합니다.
 */


/* ----------------------------------------------------------------- 조 -- */

/** 조는 1조부터 8조까지 고정입니다. */
export const TEAMS = [1, 2, 3, 4, 5, 6, 7, 8];
export const TEAM_MIN = 1;
export const TEAM_MAX = 8;

/** 조 번호로 다듬습니다. 비었거나 범위를 벗어나면 0 — "조 미지정" 입니다. */
export function normTeam(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < TEAM_MIN || n > TEAM_MAX) return 0;
  return n;
}

export function teamLabel(value) {
  const n = normTeam(value);
  return n ? `${n}조` : '조 미지정';
}

/* ----------------------------------------------------------- 과제 종류 -- */

export const TRACKS = ['general', 'buildcamp'];
export const TRACK_LABEL = { general: '일반 과제', buildcamp: 'AI Build Camp' };

/** 저장할 과제 종류로 다듬습니다. 모르는 값은 일반 과제입니다. */
export function normTrack(value) {
  return TRACKS.includes(String(value)) ? String(value) : 'general';
}

/** 이 프로젝트가 AI Build Camp 과제인지. */
export function isCamp(project) { return normTrack(project?.track) === 'buildcamp'; }

/* ------------------------------------------------------------- 그룹장 -- */

export const ROLES = ['member', 'leader', 'admin'];
export const ROLE_LABEL = { member: '회원', leader: '그룹장', admin: '관리자' };

export function normRole(value) {
  return ROLES.includes(String(value)) ? String(value) : 'member';
}

/** 그룹장이 맡은 조. 그룹장이 아니거나 조가 없으면 0. */
export function leaderTeam(member) {
  return normRole(member?.role) === 'leader' ? normTeam(member?.team) : 0;
}

export function isLeader(member) { return leaderTeam(member) > 0; }

/**
 * 이 사람이 이 제출물을 발표 과제로 뽑을 수 있는지.
 * 관리자는 모든 조, 그룹장은 **자기 조만** 뽑습니다.
 */
export function canNominate(member, submission) {
  if (!member) return false;
  if (normRole(member.role) === 'admin') return true;
  const team = leaderTeam(member);
  return team > 0 && normTeam(submission?.team) === team;
}

/** 발표 과제로 뽑힌 제출물인지. */
export function isNominee(sub) { return Boolean(sub?.presenting); }

/* ------------------------------------------------------- 발표 평가 항목 -- */

/**
 * 발표 평가 항목 — 세 문항, 합계 40점. 배열 순서가 화면 순서입니다.
 * 점수는 항목마다 0점부터 만점까지의 정수입니다.
 */
export const RUBRIC = [
  {
    key: 'goal',
    max: 20,
    label: '목표 타당성 및 문제 정의',
    question: '프로젝트가 해결하려는 문제나 기획된 목표가 명확한가?',
  },
  {
    key: 'creative',
    max: 10,
    label: '창의성 및 차별성',
    question: '기존 방식과의 차별점과 독창적인 시도가 있는가?',
  },
  {
    key: 'quality',
    max: 10,
    label: '완성도 및 전달력',
    question: '최종 결과물은 완성도가 있고 설명이 가능한가?',
  },
];

/** 세 문항을 다 합한 만점 — 40점. */
export const RUBRIC_TOTAL = RUBRIC.reduce((n, r) => n + r.max, 0);

/** 한 항목의 점수를 0..만점 정수로 다듬습니다. */
export function normPoint(value, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), max);
}

/** 세 문항을 한 번에 다듬고 합계를 붙입니다. 빈 칸은 0점입니다. */
export function normScore(input) {
  const out = {};
  for (const r of RUBRIC) out[r.key] = normPoint(input?.[r.key], r.max);
  out.total = RUBRIC.reduce((n, r) => n + out[r.key], 0);
  return out;
}

/* ------------------------------------------------------- 발표 평가 설정 -- */

/**
 * 프로젝트의 발표 평가 설정을 정규화합니다. 받지 않으면 null.
 * 발표 평가는 조가 있어야 성립하므로 **AI Build Camp 과제에서만** 켜집니다.
 */
export function presentationOf(project) {
  const v = project?.presentation;
  if (!isCamp(project) || !v || typeof v !== 'object' || !v.enabled) return null;
  return {
    enabled: true,
    startAt: v.startAt || null,
    endAt: v.endAt || null,
    // 평가 중에도 점수를 공개할지. 끄면 마감 뒤에 공개합니다(관리자는 언제나 봅니다).
    showScores: Boolean(v.showScores),
    // 자기 조의 발표에도 점수를 줄 수 있게 할지. 기본은 막습니다.
    allowOwnTeam: Boolean(v.allowOwnTeam),
  };
}

/** 'off'(평가 없음) | 'before'(시작 전) | 'open'(진행중) | 'closed'(마감) */
export function presentationPhase(project, now = Date.now()) {
  const cfg = presentationOf(project);
  if (!cfg) return 'off';
  const start = cfg.startAt ? new Date(cfg.startAt).getTime() : null;
  const end = cfg.endAt ? new Date(cfg.endAt).getTime() : null;
  if (Number.isFinite(start) && start > now) return 'before';
  if (Number.isFinite(end) && end < now) return 'closed';
  return 'open';
}

export const PRESENT_PHASE_LABEL = {
  off: '발표 평가 없음',
  before: '평가 예정',
  open: '평가중',
  closed: '평가 마감',
};

export const NOT_NOMINEE_MESSAGE = '발표 과제로 선정된 제출물에만 점수를 줄 수 있습니다.';

/* --------------------------------------------------------- 점수 주기 -- */

const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * 이 사람이 이 프로젝트에서 속한 조.
 *
 * 조는 계정이 아니라 **제출물**에 붙습니다(같은 사람이 과제마다 다른 조일 수
 * 있습니다). 그래서 이 프로젝트에 낸 자기 제출물을 보고 알아냅니다.
 */
export function myTeamIn(subs, me) {
  const mine = (subs || []).find((s) => norm(s.author?.email) === norm(me?.email));
  return normTeam(mine?.team);
}

/**
 * 지금 이 발표에 점수를 줄 수 없는 이유. 줄 수 있으면 null 입니다.
 * 화면과 서버가 같은 함수를 써서 문구가 갈라지지 않습니다.
 */
export function scoreBlock(project, submission, me, myTeam = 0) {
  const cfg = presentationOf(project);
  if (!cfg) return '이 과제는 발표 평가를 받지 않습니다.';
  if (!isNominee(submission)) return NOT_NOMINEE_MESSAGE;

  const phase = presentationPhase(project);
  if (phase === 'before') return '아직 발표 평가 기간이 아닙니다.';
  if (phase === 'closed') return '발표 평가가 마감되었습니다.';

  if (norm(submission?.author?.email) === norm(me?.email)) {
    return '본인 발표에는 점수를 줄 수 없습니다.';
  }
  if (!cfg.allowOwnTeam) {
    const t = normTeam(submission?.team);
    if (t && t === normTeam(myTeam)) return '자기 조의 발표에는 점수를 줄 수 없습니다.';
  }
  return null;
}

/**
 * 점수표를 화면이 쓰는 집계로 바꿉니다 — 서버 `/scores` 응답과 같은 모양입니다.
 *
 * 평균은 **채점한 사람 수**로 나눕니다(빈 칸을 0점으로 세지 않습니다).
 * 점수를 아직 공개하지 않을 때는 `scores` 를 아예 만들지 않습니다 — 화면에서
 * 가리는 것만으로는 새어나가기 때문입니다. 관리자는 언제나 볼 수 있습니다.
 */
export function summarizeScores(project, rows, me) {
  const cfg = presentationOf(project);
  const phase = presentationPhase(project);
  const list = (rows || []).filter((r) => r.projectId === project.id);

  const mine = {};
  for (const r of list) {
    if (norm(r.voter) !== norm(me?.email)) continue;
    mine[r.submissionId] = normScore(r);
  }

  const open = normRole(me?.role) === 'admin'
    || phase === 'closed' || phase === 'off'
    || Boolean(cfg?.showScores);

  let scores = null;
  if (open) {
    scores = {};
    for (const r of list) {
      const one = normScore(r);
      const acc = scores[r.submissionId] || (scores[r.submissionId] = {
        judges: 0, total: 0, sum: {}, avg: {},
      });
      for (const item of RUBRIC) acc.sum[item.key] = (acc.sum[item.key] || 0) + one[item.key];
      acc.total += one.total;
      acc.judges += 1;
    }
    for (const acc of Object.values(scores)) {
      for (const item of RUBRIC) acc.avg[item.key] = acc.judges ? acc.sum[item.key] / acc.judges : 0;
      acc.avg.total = acc.judges ? acc.total / acc.judges : 0;
    }
  }

  return {
    projectId: project.id,
    phase,
    // 지금 점수를 볼 수 있는지. 설정값이 아니라 "이 사람에게 지금 보이는가" 입니다.
    showScores: open,
    allowOwnTeam: Boolean(cfg?.allowOwnTeam),
    startAt: cfg?.startAt || null,
    endAt: cfg?.endAt || null,
    judged: Object.keys(mine).length,
    mine,
    scores,
    judges: open ? new Set(list.map((r) => norm(r.voter))).size : null,
  };
}

/**
 * 서버가 없는 저장소(브라우저·GitHub)에서 점수를 넣고 고치는 공통 규칙.
 * 바뀐 점수 배열을 돌려주고, 줄 수 없으면 예외를 던집니다.
 * 같은 사람이 같은 발표에 다시 주면 **덮어씁니다**(한 사람당 한 번).
 */
export function applyScore(project, rows, me, submissionId, input, submission, myTeam = 0) {
  const blocked = scoreBlock(project, submission, me, myTeam);
  if (blocked) throw new Error(blocked);

  const score = normScore(input);
  const now = new Date().toISOString();
  const list = Array.isArray(rows) ? [...rows] : [];
  const at = list.findIndex((r) => r.projectId === project.id
    && r.submissionId === submissionId
    && norm(r.voter) === norm(me?.email));

  if (at >= 0) list[at] = { ...list[at], ...score, updatedAt: now };
  else {
    list.push({
      projectId: project.id,
      submissionId,
      voter: norm(me?.email),
      ...score,
      createdAt: now,
      updatedAt: now,
    });
  }
  return list;
}

/* ----------------------------------------------------------- 조별 묶기 -- */

/** 조별로 제출물을 묶습니다 — Map(1..8, 그리고 0=조 미지정 → 제출물 배열). */
export function byTeam(subs) {
  const out = new Map();
  for (const n of TEAMS) out.set(n, []);
  out.set(0, []);
  for (const s of subs || []) out.get(normTeam(s.team)).push(s);
  return out;
}

/** 조별 한 줄 요약 — 제출 건수와 발표 과제. 화면 표에 그대로 씁니다. */
export function teamRows(subs) {
  const groups = byTeam(subs);
  return TEAMS.map((n) => {
    const rows = groups.get(n);
    return {
      team: n,
      label: teamLabel(n),
      count: rows.length,
      nominee: rows.find(isNominee) || null,
      rows,
    };
  });
}

/* --------------------------------------------------------- 발표 선정 -- */

/**
 * 이 제출물을 발표 과제로 뽑을 수 없는 이유. 뽑을 수 있으면 null 입니다.
 * 서버와 서버 없는 저장소가 같은 함수를 써서 문구가 갈라지지 않습니다.
 */
export function nominateBlock(project, submission, me, on = true) {
  if (!isCamp(project)) return 'AI Build Camp 과제에서만 발표 과제를 뽑습니다.';
  if (!normTeam(submission?.team)) return '조가 지정되지 않은 제출물입니다.';
  if (!canNominate(me, submission)) return '자기 조의 제출물만 발표 과제로 뽑을 수 있습니다.';
  // 마감 뒤에 바꾸면 이미 나온 결과가 흔들립니다 — 관리자도 막습니다.
  if (presentationPhase(project) === 'closed') {
    return '발표 평가가 마감되어 선정을 바꿀 수 없습니다.';
  }
  // 마감 뒤에 관리자가 넣어 준 제출물은 같은 조건에서 만든 것이 아닙니다.
  if (on && submission?.late) {
    return '마감 뒤에 등록된 제출물은 발표 과제로 뽑을 수 없습니다.';
  }
  return null;
}

/**
 * 한 조에 발표 과제가 하나만 올라가도록 목록을 손봅니다 — 먼저 올라가 있던
 * 것은 내려갑니다. 바뀐 제출물들을 돌려줍니다(빈 배열이면 바뀐 것이 없습니다).
 *
 * `target` 은 `subs` 안에 있는 그 객체여야 합니다(제자리에서 고칩니다).
 */
export function applyNominate(subs, target, on = true) {
  const now = new Date().toISOString();
  const team = normTeam(target?.team);
  const touched = [];

  if (!on) {
    if (!target?.presenting) return [];
    delete target.presenting;
    target.updatedAt = now;
    return [target];
  }
  if (target?.presenting) return [];

  for (const s of subs || []) {
    if (s.projectId !== target.projectId || s.id === target.id) continue;
    if (!s.presenting || normTeam(s.team) !== team) continue;
    delete s.presenting;
    s.updatedAt = now;
    touched.push(s);
  }
  target.presenting = true;
  target.updatedAt = now;
  touched.push(target);
  return touched;
}
