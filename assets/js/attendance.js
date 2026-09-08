/**
 * 수강 현황 — 회차 정의와 이름 대조 규칙.
 *
 * 화면(views/attendance.js)과 테스트가 함께 쓰는 순수 함수 모음입니다.
 * DOM 도 저장소도 건드리지 않으므로 Node 에서 그대로 돌려볼 수 있습니다.
 *
 * 저장 형태
 *   data/roster.json      [{ id, name, dept, createdAt }]                  전체 명단
 *   data/attendance.json  [{ id, attendance:[학생id], submission:[학생id],  회차별 기록
 *                            recorded, title?, date?, updatedAt }]
 */

/* ======================================================= 회차 정의 == */

/** 온라인 6회차 + 오프라인 2회차. 날짜·제목은 화면에서 고칠 수 있습니다. */
export const SESSIONS = [
  { id: 'on1', no: 1, mode: '온라인', seq: 1, date: '2026-08-25', title: 'AI를 이해한다', desc: '생성형 AI가 무엇인지 배우고, AI로 이미지와 영상도 직접 만들어 봅니다.' },
  { id: 'on2', no: 2, mode: '온라인', seq: 2, date: '2026-09-08', title: 'AI에 연결한다', desc: 'AI가 문서와 다양한 도구를 활용하는 방법을 배우고, 발표자료를 직접 만들어 봅니다.' },
  { id: 'on3', no: 3, mode: '온라인', seq: 3, date: '2026-09-29', title: '첫 프로젝트를 만든다', desc: 'AI와 대화하며 코딩하고, 간단한 업무용 웹 프로그램을 직접 만들어 봅니다.' },
  { id: 'on4', no: 4, mode: '온라인', seq: 4, date: '2026-10-13', title: '프로젝트를 확장한다', desc: '만든 프로그램에 데이터를 저장하고, 누구나 접속할 수 있도록 인터넷에 배포해 봅니다.' },
  { id: 'on5', no: 5, mode: '온라인', seq: 5, date: '2026-11-17', title: '프로젝트를 더 확장한다', desc: 'API로 다른 서비스와 연결하고, 내 컴퓨터에서도 AI를 직접 실행해 봅니다.' },
  { id: 'on6', no: 6, mode: '온라인', seq: 6, date: '2026-12-08', title: 'AI가 스스로 일하게 한다', desc: 'AI Agent의 원리를 배우고, 반복 업무를 AI가 처리하는 업무 흐름을 직접 설계합니다.' },
  { id: 'off1', no: 7, mode: '오프라인', seq: 1, date: '', title: '오프라인 워크숍 1', desc: '' },
  { id: 'off2', no: 8, mode: '오프라인', seq: 2, date: '', title: '오프라인 워크숍 2', desc: '' },
];

export const SESSION_IDS = SESSIONS.map((s) => s.id);

/** "온라인 3회차" — 사람이 읽는 이름. */
export const sessionLabel = (s) => `${s.mode} ${s.seq}회차`;

/** "온3" — 표 머리글처럼 좁은 자리에 쓰는 이름. */
export const sessionShort = (s) => `${s.mode === '온라인' ? '온' : '오프'}${s.seq}`;

/** 8.25. — 표에 들어갈 짧은 날짜. 아직 안 정한 회차는 빈 문자열입니다. */
export function shortDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${Number(m[2])}.${Number(m[3])}.`;
}

export const emptySession = (id) => ({
  id, attendance: [], submission: [], recorded: false, updatedAt: null,
});

/**
 * 저장된 기록을 회차 정의 위에 얹어 화면이 쓸 8개 회차를 만듭니다.
 * 저장된 title·date 가 있으면 그것이 이깁니다(관리자가 고친 값).
 */
export function mergeSessions(records = []) {
  const byId = new Map((records || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  return SESSIONS.map((base) => {
    const rec = byId.get(base.id) || {};
    return {
      ...base,
      title: rec.title || base.title,
      date: rec.date === undefined || rec.date === null ? base.date : rec.date,
      attendance: Array.isArray(rec.attendance) ? rec.attendance : [],
      submission: Array.isArray(rec.submission) ? rec.submission : [],
      recorded: Boolean(rec.recorded),
      updatedAt: rec.updatedAt || null,
    };
  });
}

/** 화면이 들고 있던 회차를 저장용 레코드로 되돌립니다. */
export function toRecord(session) {
  const base = SESSIONS.find((s) => s.id === session.id);
  return {
    id: session.id,
    attendance: [...new Set(session.attendance || [])],
    submission: [...new Set(session.submission || [])],
    recorded: Boolean(session.recorded),
    // 기본값과 같으면 굳이 저장하지 않습니다 — 나중에 기본값을 고쳐도 따라옵니다.
    ...(base && session.title !== base.title ? { title: session.title } : {}),
    ...(base && session.date !== base.date ? { date: session.date } : {}),
    updatedAt: session.updatedAt || new Date().toISOString(),
  };
}

/* ==================================================== 이름 다듬기 == */

/** 공백을 모두 없애 "홍 길동"과 "홍길동"을 같게 봅니다. */
export function normalizeName(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, '');
}

/** 소속 비교용 — 공백·괄호·중점 등을 털어냅니다. */
export function normalizeDept(v) {
  return String(v == null ? '' : v).replace(/[\s()[\]·・.,/_-]/g, '').toLowerCase();
}

/**
 * Zoom 접속기록의 표시 이름을 조각냅니다.
 *
 *   "행정안전부_홍길동"          → ['행정안전부', '홍길동']
 *   "홍길동 (행정안전부)"        → ['홍길동', '행정안전부']
 *   "교육부/홍길동의 iPhone"     → ['교육부', '홍길동의', 'iPhone', …]
 *
 * 구분자(_ - / | · 공백 괄호)로 자르고, 붙어 있는 한글 덩어리도 따로 모읍니다.
 */
export function splitDisplayName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  const parts = s
    .split(/[_|/\\,·・()[\]{}<>@:;+\-\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  parts.forEach(push);
  // "행정안전부홍길동" 처럼 구분자 없이 붙은 경우를 대비해 한글 덩어리도 담습니다.
  (s.match(/[가-힣]+/g) || []).forEach(push);
  return out;
}

/**
 * 표시 이름에서 뽑아낼 이름 후보. 뒤쪽(= Zoom 의 "부서명_이름")을 먼저 봅니다.
 * 이름은 보통 2~5자라 그 길이를 우선합니다.
 */
export function nameCandidates(raw) {
  const tokens = splitDisplayName(raw);
  const scored = tokens.map((t, i) => {
    const name = normalizeName(t);
    const korean = /^[가-힣]+$/.test(name);
    const nameLike = korean && name.length >= 2 && name.length <= 5;
    return { name, score: (nameLike ? 100 : 0) + (korean ? 10 : 0) + i };
  }).filter((c) => c.name);

  // 조각을 통째로 이어 붙인 것도 후보에 넣습니다("홍 길동" → "홍길동").
  const joined = normalizeName(String(raw || ''));
  if (joined) scored.push({ name: joined, score: 5 });

  const seen = new Set();
  return scored.sort((a, b) => b.score - a.score)
    .filter((c) => (seen.has(c.name) ? false : seen.add(c.name)))
    .map((c) => c.name);
}

/* ================================================== 명단 대조 == */

/** 이름 → 그 이름을 가진 명단 항목들. 동명이인이면 두 명 이상입니다. */
export function buildNameIndex(roster) {
  const map = new Map();
  (roster || []).forEach((entry) => {
    const key = normalizeName(entry.name);
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  });
  return map;
}

/**
 * 표시 이름 하나를 명단과 맞춰 봅니다.
 *
 * @returns {{status:'matched'|'ambiguous'|'unmatched', raw:string,
 *            id?:string, name?:string, options?:Array, guess?:string}}
 *   matched    한 사람으로 특정됨
 *   ambiguous  동명이인이라 소속만으로도 못 고름 → 사람이 골라야 합니다
 *   unmatched  명단에 없는 이름 → 오타이거나 빠진 학생입니다
 */
export function matchEntry(raw, index) {
  const candidates = nameCandidates(raw);
  const name = candidates.find((c) => index.has(c)) || embeddedName(raw, index);

  if (!name) {
    return { status: 'unmatched', raw, guess: candidates[0] || normalizeName(raw) };
  }

  const hits = index.get(name);
  if (hits.length === 1) return { status: 'matched', raw, id: hits[0].id, name };

  // 동명이인 — 표시 이름에 남은 조각(부서명)으로 갈라 봅니다.
  const narrowed = narrowByDept(raw, name, hits);
  if (narrowed.length === 1) {
    return { status: 'matched', raw, id: narrowed[0].id, name, byDept: true };
  }
  return { status: 'ambiguous', raw, name, options: narrowed.length ? narrowed : hits };
}

/**
 * 조각내기로 못 갈라낸 표시 이름 안에 명단의 이름이 통째로 들어 있는지 봅니다.
 * "행정안전부홍길동"(구분자 없음)이나 "홍길동의 iPhone"(기기 이름)이 여기서 잡힙니다.
 * 긴 이름을 먼저, 같은 길이면 뒤에 나온 쪽을 고릅니다 — Zoom 은 이름을 뒤에 붙입니다.
 */
function embeddedName(raw, index) {
  const joined = normalizeName(raw);
  if (joined.length < 2) return null;
  let best = null;
  for (const key of index.keys()) {
    if (key.length < 2) continue;
    const at = joined.lastIndexOf(key);
    if (at < 0) continue;
    if (!best || key.length > best.key.length
      || (key.length === best.key.length && at > best.at)) best = { key, at };
  }
  return best ? best.key : null;
}

/** 표시 이름에 소속이 함께 적혀 있으면 그것으로 동명이인을 가릅니다. */
function narrowByDept(raw, name, hits) {
  const rest = normalizeDept(String(raw).split(normalizeName(name)).join(''));
  if (!rest) return [];
  return hits.filter((e) => {
    const dept = normalizeDept(e.dept);
    if (!dept) return false;
    return rest.includes(dept) || dept.includes(rest);
  });
}

/**
 * 업로드한 표시 이름들을 한 번에 대조합니다.
 * @returns {{matched:string[], ambiguous:Array, unmatched:Array, total:number}}
 */
export function matchAll(rawNames, roster) {
  const index = buildNameIndex(roster);
  const matched = new Set();
  const ambiguous = new Map();      // 이름 → { name, options, raws }
  const unmatched = new Map();      // 추정이름 → { guess, raws }

  (rawNames || []).forEach((raw) => {
    if (!String(raw || '').trim()) return;
    const r = matchEntry(raw, index);
    if (r.status === 'matched') { matched.add(r.id); return; }
    if (r.status === 'ambiguous') {
      const cur = ambiguous.get(r.name) || { name: r.name, options: r.options, raws: [] };
      cur.raws.push(r.raw);
      ambiguous.set(r.name, cur);
      return;
    }
    const cur = unmatched.get(r.guess) || { guess: r.guess, raws: [] };
    cur.raws.push(r.raw);
    unmatched.set(r.guess, cur);
  });

  return {
    matched: [...matched],
    ambiguous: [...ambiguous.values()],
    unmatched: [...unmatched.values()],
    total: (rawNames || []).filter((r) => String(r || '').trim()).length,
  };
}

/* ============================================== 업로드 파일 읽기 == */

const NAME_HEADER = /이름|성명|성함|참가자|참석자|사용자|name|참여자/i;
const DEPT_HEADER = /부서|소속|기관|조직|팀|department|team|organization|company/i;

/**
 * 표의 머리글 줄을 찾습니다. 15줄 안에서 '이름' 류가 보이면 그 줄이 머리글입니다.
 * (Zoom 보고서는 위쪽에 회의 정보가 몇 줄 붙어 나옵니다.)
 * @returns {{nameCol:number, deptCol:number, headerRow:number}} 못 찾으면 nameCol -1
 */
export function findColumns(rows) {
  const limit = Math.min(15, (rows || []).length);
  for (let r = 0; r < limit; r += 1) {
    const row = rows[r] || [];
    let nameCol = -1;
    let deptCol = -1;
    for (let c = 0; c < row.length; c += 1) {
      const cell = String(row[c] ?? '').trim();
      if (!cell) continue;
      if (nameCol < 0 && NAME_HEADER.test(cell)) nameCol = c;
      else if (deptCol < 0 && DEPT_HEADER.test(cell)) deptCol = c;
    }
    if (nameCol >= 0) return { nameCol, deptCol, headerRow: r };
  }
  return { nameCol: -1, deptCol: -1, headerRow: -1 };
}

/** 지정한 열에서 값을 훑어옵니다(머리글 다음 줄부터). */
export function columnValues(rows, col, headerRow = 0) {
  const out = [];
  for (let r = headerRow + 1; r < (rows || []).length; r += 1) {
    const v = String((rows[r] || [])[col] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * 전체 명단 파일에서 {이름, 소속} 을 뽑습니다. 같은 이름·같은 소속은 한 번만.
 * @param {Array<Array<string>>} rows
 * @param {{nameCol:number, deptCol:number, headerRow:number}} [cols] 직접 고른 열
 */
export function extractRoster(rows, cols = null) {
  const { nameCol, deptCol, headerRow } = cols || findColumns(rows);
  if (nameCol < 0) return [];

  const seen = new Set();
  const out = [];
  for (let r = headerRow + 1; r < (rows || []).length; r += 1) {
    const row = rows[r] || [];
    const name = normalizeName(row[nameCol]);
    if (!name) continue;
    // 합계 줄 같은 것이 딸려 들어오지 않도록 최소한만 거릅니다.
    if (/^(합계|총계|계|소계|total)$/i.test(name)) continue;
    const dept = deptCol >= 0 ? String(row[deptCol] ?? '').trim() : '';
    const key = `${name}||${dept}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, dept });
  }
  return out;
}

/**
 * 출석·제출 파일에서 "표시 이름" 을 그대로 뽑습니다(가공은 대조할 때).
 * @param {{nameCol:number, headerRow:number}} [cols]
 */
export function extractDisplayNames(rows, cols = null) {
  const found = cols || findColumns(rows);
  if (found.nameCol >= 0) return columnValues(rows, found.nameCol, found.headerRow);
  // 머리글이 없는 파일이면 첫 열을 이름으로 봅니다.
  return columnValues(rows, 0, -1);
}

/* ================================================ 명단 다루기 == */

/** 같은 이름이 둘 이상이면 소속을 붙여 부릅니다. */
export function labelFor(entry, roster) {
  const dup = (roster || []).filter((e) => e.name === entry.name).length > 1;
  return dup ? `${entry.name} (${entry.dept || '소속 미상'})` : entry.name;
}

/** 표가 좁을 때 쓰는 이름 — 동명이인은 "홍길동1", "홍길동2". */
export function shortLabelFor(entry, roster) {
  const same = (roster || []).filter((e) => e.name === entry.name);
  if (same.length <= 1) return entry.name;
  return `${entry.name}${same.findIndex((e) => e.id === entry.id) + 1}`;
}

/** 이름 → 가나다순, 같은 이름이면 소속순. */
export function sortRoster(roster) {
  return [...(roster || [])].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'ko')
    || String(a.dept || '').localeCompare(String(b.dept || ''), 'ko'));
}

/** 명단에서 빠진 학생의 흔적을 회차 기록에서도 지웁니다. */
export function pruneSessions(sessions, aliveIds) {
  const alive = new Set(aliveIds);
  return (sessions || []).map((s) => ({
    ...s,
    attendance: (s.attendance || []).filter((id) => alive.has(id)),
    submission: (s.submission || []).filter((id) => alive.has(id)),
  }));
}

/**
 * 새로 올린 명단을 기존 명단에 겹칩니다.
 * 이름+소속이 같으면 **기존 id 를 지킵니다** — 그래야 지금까지 쌓은 출결이 남습니다.
 * @returns {{roster:Array, added:Array, kept:Array, removed:Array}}
 */
export function mergeRoster(existing, incoming, makeId) {
  const byKey = new Map((existing || []).map((e) => [`${e.name}||${e.dept || ''}`, e]));
  const roster = [];
  const added = [];
  const kept = [];
  const used = new Set();

  (incoming || []).forEach((row) => {
    const key = `${row.name}||${row.dept || ''}`;
    const found = byKey.get(key);
    if (found && !used.has(found.id)) {
      used.add(found.id);
      kept.push(found);
      roster.push({ ...found, name: row.name, dept: row.dept });
    } else {
      const rec = {
        id: makeId(), name: row.name, dept: row.dept, createdAt: new Date().toISOString(),
      };
      added.push(rec);
      roster.push(rec);
    }
  });

  const removed = (existing || []).filter((e) => !used.has(e.id));
  return { roster, added, kept, removed };
}

/* ====================================================== 집계 == */

/**
 * 대시보드·내보내기가 쓰는 숫자를 한 번에 계산합니다.
 * 출석률·제출률의 분모는 "기록된 회차"뿐입니다 — 아직 안 한 회차가
 * 결석으로 잡히면 안 되니까요.
 */
export function computeStats(roster, sessions) {
  const total = (roster || []).length;
  const alive = new Set((roster || []).map((e) => e.id));

  const perSession = (sessions || []).map((s) => {
    const att = (s.attendance || []).filter((id) => alive.has(id));
    const sub = (s.submission || []).filter((id) => alive.has(id));
    return {
      ...s,
      attCount: att.length,
      subCount: sub.length,
      attRate: total ? att.length / total : 0,
      subRate: total ? sub.length / total : 0,
    };
  });

  const recorded = perSession.filter((s) => s.recorded);
  const avg = (key) => (recorded.length
    ? recorded.reduce((n, s) => n + s[key], 0) / recorded.length : 0);

  const perStudent = (roster || []).map((entry) => {
    const rows = perSession.map((s) => ({
      id: s.id,
      recorded: s.recorded,
      attended: s.recorded && s.attendance.includes(entry.id),
      submitted: s.recorded && s.submission.includes(entry.id),
    }));
    const seen = rows.filter((r) => r.recorded);
    const attCount = seen.filter((r) => r.attended).length;
    const subCount = seen.filter((r) => r.submitted).length;
    // "한 회차라도 결석이면서 과제도 안 낸" 경우 — 주의가 필요한 신호입니다.
    const riskSessions = seen.filter((r) => !r.attended && !r.submitted).map((r) => r.id);
    return {
      entry,
      rows,
      recordedCount: seen.length,
      attCount,
      subCount,
      absentCount: seen.length - attCount,
      missingCount: seen.length - subCount,
      riskSessions,
      attRate: seen.length ? attCount / seen.length : 0,
      subRate: seen.length ? subCount / seen.length : 0,
    };
  });

  const atRisk = perStudent
    .filter((s) => s.riskSessions.length > 0)
    .sort((a, b) => b.riskSessions.length - a.riskSessions.length
      || (b.absentCount + b.missingCount) - (a.absentCount + a.missingCount)
      || String(a.entry.name).localeCompare(String(b.entry.name), 'ko'));

  return {
    total,
    perSession,
    perStudent,
    atRisk,
    recordedCount: recorded.length,
    avgAtt: avg('attRate'),
    avgSub: avg('subRate'),
  };
}

export const pct = (v) => `${Math.round((v || 0) * 100)}%`;

/* ================================================ 내보내기 표 == */

/** 학생별 상세 시트 — 한 줄에 학생 한 명, 회차마다 출석·제출 두 칸. */
export function detailRows(roster, sessions, stats) {
  const header = ['번호', '이름', '소속'];
  sessions.forEach((s) => {
    header.push(`${sessionLabel(s)} 출석`, `${sessionLabel(s)} 제출`);
  });
  header.push('출석', '제출', '출석률', '제출률', '주의');

  const byId = new Map(stats.perStudent.map((p) => [p.entry.id, p]));
  const rows = roster.map((entry, i) => {
    const p = byId.get(entry.id);
    const row = [i + 1, entry.name, entry.dept || ''];
    p.rows.forEach((r) => {
      row.push(
        r.recorded ? (r.attended ? '출석' : '결석') : '미기록',
        r.recorded ? (r.submitted ? '제출' : '미제출') : '미기록',
      );
    });
    row.push(
      `${p.attCount}/${p.recordedCount}`,
      `${p.subCount}/${p.recordedCount}`,
      pct(p.attRate), pct(p.subRate),
      p.riskSessions.length ? `결석+미제출 ${p.riskSessions.length}회` : '',
    );
    return row;
  });
  return [header, ...rows];
}

/** 회차별 요약 시트. */
export function summaryRows(stats) {
  const header = ['회차', '구분', '일자', '주제', '기록', '출석', '결석', '제출', '미제출', '출석률', '제출률'];
  const rows = stats.perSession.map((s) => [
    sessionLabel(s), s.mode, s.date || '미정', s.title,
    s.recorded ? '기록됨' : '미기록',
    s.recorded ? s.attCount : '',
    s.recorded ? stats.total - s.attCount : '',
    s.recorded ? s.subCount : '',
    s.recorded ? stats.total - s.subCount : '',
    s.recorded ? pct(s.attRate) : '',
    s.recorded ? pct(s.subRate) : '',
  ]);
  return [header, ...rows];
}
