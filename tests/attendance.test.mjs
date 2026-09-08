/**
 * 수강 현황 테스트 — 표 파일 읽기·쓰기(sheet.js)와 명단 대조·집계(attendance.js),
 * 그리고 새 색인(roster·attendance)의 접근 권한을 봅니다.
 *
 * 브라우저 없이 Node 에서 그대로 돕니다. sheet.js 는 DecompressionStream 과
 * Blob.arrayBuffer 만 쓰는데 Node 18+ 에 둘 다 들어 있습니다.
 */
import { MockBucket } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';
import {
  readSheet, buildXlsx, buildCsv, parseDelimited, decodeText, colName, colIndex,
} from '../assets/js/sheet.js';
import {
  SESSIONS, sessionLabel, sessionShort, shortDate, mergeSessions, toRecord,
  normalizeName, splitDisplayName, nameCandidates, buildNameIndex, matchEntry, matchAll,
  findColumns, extractRoster, extractDisplayNames, columnValues,
  labelFor, shortLabelFor, mergeRoster, pruneSessions, computeStats,
  detailRows, summaryRows, pct,
} from '../assets/js/attendance.js';

const ORIGIN = 'https://site.test';
const ADMIN = 'aireader@mois.go.kr';

const fails = [];
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const deep = (a, b, m) => eq(JSON.stringify(a), JSON.stringify(b), m);
const ok = (v, m) => { if (!v) throw new Error(m); };

/** 이름을 붙인 Blob — 브라우저의 File 처럼 readSheet 에 넘길 수 있습니다. */
const fileOf = (blobOrBytes, name) => {
  const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes]);
  return Object.assign(blob, { name });
};
const csvFile = (text, name = 'a.csv') =>
  fileOf(new Blob([new TextEncoder().encode(text)]), name);

console.log('\n== 표 파일 읽기·쓰기 (sheet.js) ==');

await t('CSV — 따옴표·쉼표·줄바꿈을 지킵니다', () => {
  const rows = parseDelimited('이름,소속\n"홍, 길동","행안부\n1과"\n김철수,교육부\n');
  eq(rows.length, 3, '줄 수');
  deep(rows[1], ['홍, 길동', '행안부\n1과'], '따옴표 안');
  deep(rows[2], ['김철수', '교육부'], '두 번째 줄');
});

await t('CSV — 탭 구분 파일도 알아봅니다', () => {
  const rows = parseDelimited('이름\t소속\n홍길동\t행안부');
  deep(rows[1], ['홍길동', '행안부'], 'TSV');
});

await t('CSV — UTF-8 BOM 을 떼어냅니다', () => {
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('이름\n홍길동')]);
  const rows = parseDelimited(decodeText(bytes));
  deep(rows[0], ['이름'], 'BOM 제거');
});

await t('CSV — 엑셀이 저장한 EUC-KR 도 읽습니다', () => {
  // '이름' 을 CP949 로 적은 바이트. UTF-8 로 읽으면 깨지므로 EUC-KR 로 넘어가야 합니다.
  const euckr = new Uint8Array([0xC0, 0xCC, 0xB8, 0xA7, 0x0A, 0xC8, 0xAB, 0xB1, 0xE6, 0xB5, 0xBF]);
  eq(decodeText(euckr), '이름\n홍길동', 'EUC-KR 해독');
});

await t('열 이름 ↔ 번호 변환', () => {
  eq(colName(0), 'A', 'A');
  eq(colName(26), 'AA', 'AA');
  eq(colIndex('A1'), 0, 'A1');
  eq(colIndex('BC12'), 54, 'BC12');
});

await t('XLSX — 만든 파일을 그대로 다시 읽습니다 (한글·숫자·특수문자)', async () => {
  const rows = [
    ['이름', '소속', '점수'],
    ['홍길동', '행정안전부 <디지털>', 100],
    ['김철수', '교육부 & 과기부', 0],
    ['이수현', '"따옴표" 부서', -3.5],
  ];
  const blob = buildXlsx([{ name: '명단', rows }]);
  const back = await readSheet(fileOf(blob, 'out.xlsx'));
  eq(back.length, 4, '줄 수');
  deep(back[1], ['홍길동', '행정안전부 <디지털>', '100'], '한글·꺾쇠');
  deep(back[2], ['김철수', '교육부 & 과기부', '0'], '앰퍼샌드');
  deep(back[3], ['이수현', '"따옴표" 부서', '-3.5'], '따옴표·음수');
});

await t('XLSX — 시트 두 장이 각각 살아 있습니다', async () => {
  const blob = buildXlsx([
    { name: '학생별 상세', rows: [['이름'], ['홍길동']] },
    { name: '회차별 요약', rows: [['회차'], ['온라인 1회차']] },
  ]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  ok(text.includes('sheet1.xml') && text.includes('sheet2.xml'), '시트 두 장');
  ok(text.includes('학생별 상세') && text.includes('회차별 요약'), '시트 이름');
  // 첫 시트만 읽어도 첫 시트의 내용이 나와야 합니다.
  const back = await readSheet(fileOf(blob, 'out.xlsx'));
  deep(back[1], ['홍길동'], '첫 시트');
});

await t('XLSX — 빈 칸이 자리를 지킵니다', async () => {
  const blob = buildXlsx([{ name: 'S', rows: [['a', 'b', 'c'], ['x', '', 'z']] }]);
  const back = await readSheet(fileOf(blob, 'out.xlsx'));
  deep(back[1], ['x', '', 'z'], '가운데 빈 칸');
});

await t('readSheet — 확장자로 CSV 와 XLSX 를 갈라 봅니다', async () => {
  const rows = await readSheet(csvFile('이름,소속\n홍길동,행안부'));
  deep(rows[1], ['홍길동', '행안부'], 'CSV 경로');
  const xlsx = buildXlsx([{ name: 'S', rows: [['이름'], ['홍길동']] }]);
  // 확장자가 없어도 zip 머리(PK)를 보고 엑셀로 읽습니다.
  const back = await readSheet(fileOf(xlsx, 'noext'));
  deep(back[1], ['홍길동'], '내용으로 판별');
});

await t('readSheet — 예전 .xls 는 이유를 알려주고 멈춥니다', async () => {
  let msg = '';
  try { await readSheet(fileOf(new Blob([new Uint8Array([0xD0, 0xCF, 0x11, 0xE0])]), 'old.xls')); }
  catch (e) { msg = e.message; }
  ok(msg.includes('.xls'), `안내 문구: ${msg}`);
});

await t('buildCsv — BOM 을 붙여 엑셀에서 한글이 깨지지 않습니다', async () => {
  const blob = buildCsv([['이름', '소속'], ['홍, 길동', '행안부']]);
  // Blob.text() 는 BOM 을 떼고 돌려주므로 바이트로 확인합니다.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  deep([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM 바이트');
  ok((await blob.text()).includes('"홍, 길동"'), '쉼표는 따옴표로');
});

console.log('\n== 이름 대조 (attendance.js) ==');

const ROSTER = [
  { id: 'a', name: '홍길동', dept: '행정안전부' },
  { id: 'b', name: '이수현', dept: '교육부' },
  { id: 'c', name: '이수현', dept: '과학기술정보통신부' },
  { id: 'd', name: '김철수', dept: '' },
];
const INDEX = buildNameIndex(ROSTER);

await t('이름에서 공백을 털어냅니다', () => {
  eq(normalizeName('  홍 길동 '), '홍길동', '공백 제거');
  eq(normalizeName(null), '', 'null');
});

await t('Zoom 표시 이름을 조각냅니다', () => {
  deep(splitDisplayName('행정안전부_홍길동').slice(0, 2), ['행정안전부', '홍길동'], '밑줄');
  ok(splitDisplayName('홍길동 (행정안전부)').includes('행정안전부'), '괄호');
  ok(splitDisplayName('교육부/이수현').includes('이수현'), '슬래시');
});

await t('이름 후보는 2~5자 한글을 먼저 봅니다', () => {
  const cands = nameCandidates('행정안전부_홍길동');
  eq(cands[0], '홍길동', `첫 후보: ${cands.join(',')}`);
});

await t('"부서명_이름" 에서 이름만 뽑아 명단과 맞춥니다', () => {
  const r = matchEntry('행정안전부_홍길동', INDEX);
  eq(r.status, 'matched', '상태');
  eq(r.id, 'a', '누구');
});

await t('구분자가 없어도 붙어 있는 이름을 찾아냅니다', () => {
  eq(matchEntry('행정안전부홍길동', INDEX).id, 'a', '붙여쓴 표시 이름');
});

await t('기기 이름·괄호가 붙어도 찾아냅니다', () => {
  eq(matchEntry('홍길동의 iPhone', INDEX).id, 'a', 'iPhone');
  eq(matchEntry('행안부_홍길동 (홍길동)', INDEX).id, 'a', '괄호 반복');
  eq(matchEntry('홍 길동', INDEX).id, 'a', '이름 사이 공백');
});

await t('동명이인은 소속이 함께 적혀 있으면 자동으로 갈라냅니다', () => {
  const r = matchEntry('교육부_이수현', INDEX);
  eq(r.status, 'matched', '상태');
  eq(r.id, 'b', '교육부 이수현');
  eq(matchEntry('과학기술정보통신부_이수현', INDEX).id, 'c', '과기부 이수현');
});

await t('소속이 없으면 동명이인은 사람에게 묻습니다', () => {
  const r = matchEntry('이수현', INDEX);
  eq(r.status, 'ambiguous', '상태');
  eq(r.options.length, 2, '고를 사람 수');
});

await t('명단에 없는 이름은 추정 이름과 함께 남습니다', () => {
  const r = matchEntry('행정안전부_박영희', INDEX);
  eq(r.status, 'unmatched', '상태');
  eq(r.guess, '박영희', '추정 이름');
});

await t('한 파일을 통째로 대조합니다', () => {
  const res = matchAll([
    '행정안전부_홍길동',
    '교육부_이수현',
    '이수현',            // 소속이 없어 못 고름
    '김철수',
    '행안부_박영희',      // 명단에 없음
    '행안부_박영희',      // 같은 사람 — 한 건으로 묶여야 합니다
    '',                  // 빈 칸은 셈에서 빠집니다
  ], ROSTER);
  deep(res.matched.sort(), ['a', 'b', 'd'], '자동 매칭');
  eq(res.ambiguous.length, 1, '동명이인 묶음');
  eq(res.ambiguous[0].name, '이수현', '동명이인 이름');
  eq(res.unmatched.length, 1, '못 찾은 이름 묶음');
  eq(res.unmatched[0].raws.length, 2, '같은 이름 두 번');
  eq(res.total, 6, '읽은 건수');
});

await t('같은 사람이 두 번 접속해도 한 명으로 셉니다', () => {
  const res = matchAll(['행안부_홍길동', '홍길동', '홍길동의 iPad'], ROSTER);
  deep(res.matched, ['a'], '중복 제거');
});

console.log('\n== 업로드 파일 해석 ==');

await t('머리글이 몇 줄 아래 있어도 찾아냅니다 (Zoom 보고서)', () => {
  const rows = [
    ['회의 보고서'],
    ['주제', 'AI 리더스 아카데미 2회차'],
    [],
    ['이름(원래 이름)', '사용자 이메일', '참가 시간'],
    ['행정안전부_홍길동', 'a@x.kr', '90'],
    ['교육부_이수현', 'b@x.kr', '88'],
  ];
  const cols = findColumns(rows);
  eq(cols.nameCol, 0, '이름 열');
  eq(cols.headerRow, 3, '머리글 줄');
  deep(extractDisplayNames(rows), ['행정안전부_홍길동', '교육부_이수현'], '표시 이름');
});

await t('명단 파일에서 이름·소속을 함께 읽습니다', () => {
  const rows = [
    ['연번', '소속', '성명', '비고'],
    ['1', '행정안전부', '홍길동', ''],
    ['2', '교육부', '이수현', ''],
    ['3', '교육부', '이수현', ''],      // 완전히 같은 줄은 한 번만
    ['', '', '', ''],
    ['4', '', '합계', ''],             // 합계 줄은 버립니다
  ];
  const out = extractRoster(rows);
  eq(out.length, 2, '사람 수');
  deep(out[0], { name: '홍길동', dept: '행정안전부' }, '첫 사람');
});

await t('머리글이 없으면 열을 직접 지정해 읽습니다', () => {
  const rows = [['홍길동', '행정안전부'], ['이수현', '교육부']];
  eq(findColumns(rows).nameCol, -1, '자동으로는 못 찾음');
  const out = extractRoster(rows, { nameCol: 0, deptCol: 1, headerRow: -1 });
  eq(out.length, 2, '직접 지정하면 읽힘');
  deep(columnValues(rows, 0, -1), ['홍길동', '이수현'], '지정 열 값');
});

await t('머리글이 없는 출석 파일은 첫 열을 이름으로 봅니다', () => {
  deep(extractDisplayNames([['행안부_홍길동'], ['교육부_이수현']]),
    ['행안부_홍길동', '교육부_이수현'], '첫 열');
});

console.log('\n== 명단 다루기 ==');

await t('다시 올려도 같은 사람은 id 를 지킵니다', () => {
  const incoming = [
    { name: '홍길동', dept: '행정안전부' },   // 그대로
    { name: '박영희', dept: '기획재정부' },   // 새 사람
  ];
  const m = mergeRoster(ROSTER, incoming, () => 'new1');
  eq(m.kept.length, 1, '유지');
  eq(m.kept[0].id, 'a', '기존 id 유지');
  eq(m.added.length, 1, '추가');
  eq(m.removed.length, 3, '이번 파일에 없는 사람');
  eq(m.roster.length, 2, '결과 명단');
});

await t('명단에서 빠진 학생은 회차 기록에서도 지웁니다', () => {
  const sessions = [{ id: 'on1', attendance: ['a', 'b'], submission: ['b'], recorded: true }];
  const pruned = pruneSessions(sessions, ['a']);
  deep(pruned[0].attendance, ['a'], '출석');
  deep(pruned[0].submission, [], '제출');
});

await t('동명이인은 소속을 붙여 부릅니다', () => {
  eq(labelFor(ROSTER[0], ROSTER), '홍길동', '유일한 이름');
  eq(labelFor(ROSTER[1], ROSTER), '이수현 (교육부)', '동명이인');
  eq(shortLabelFor(ROSTER[2], ROSTER), '이수현2', '좁은 표');
});

console.log('\n== 회차 정의 ==');

await t('온라인 6회차 + 오프라인 2회차', () => {
  eq(SESSIONS.length, 8, '전체 회차');
  eq(SESSIONS.filter((s) => s.mode === '온라인').length, 6, '온라인');
  eq(SESSIONS.filter((s) => s.mode === '오프라인').length, 2, '오프라인');
  eq(SESSIONS[0].date, '2026-08-25', '첫 회차');
  eq(SESSIONS[5].date, '2026-12-08', '마지막 온라인 회차');
  eq(sessionLabel(SESSIONS[6]), '오프라인 1회차', '이름');
  eq(sessionShort(SESSIONS[2]), '온3', '짧은 이름');
  eq(shortDate('2026-08-25'), '8.25.', '짧은 날짜');
  eq(shortDate(''), '', '날짜 미정');
});

await t('저장된 기록을 회차 정의 위에 얹습니다', () => {
  const merged = mergeSessions([{ id: 'on2', attendance: ['a'], submission: [], recorded: true }]);
  eq(merged.length, 8, '회차 수');
  eq(merged[1].recorded, true, '기록됨');
  deep(merged[1].attendance, ['a'], '출석자');
  eq(merged[0].recorded, false, '손대지 않은 회차');
  eq(merged[1].title, SESSIONS[1].title, '기본 주제 유지');
});

await t('고친 제목·일자만 저장합니다', () => {
  const base = mergeSessions([])[6];
  const plain = toRecord({ ...base, recorded: true });
  eq(plain.title, undefined, '기본값이면 저장 안 함');
  const edited = toRecord({ ...base, title: '현장 워크숍', date: '2026-10-30', recorded: true });
  eq(edited.title, '현장 워크숍', '고친 제목');
  eq(edited.date, '2026-10-30', '정한 일자');
});

await t('회차 기록의 중복 id 는 한 번만 저장됩니다', () => {
  const rec = toRecord({ id: 'on1', attendance: ['a', 'a', 'b'], submission: [], recorded: true });
  deep(rec.attendance, ['a', 'b'], '중복 제거');
});

console.log('\n== 집계 ==');

const SESS = mergeSessions([
  { id: 'on1', attendance: ['a', 'b', 'c'], submission: ['a', 'b'], recorded: true },
  { id: 'on2', attendance: ['a'], submission: ['a', 'c'], recorded: true },
]);
const STATS = computeStats(ROSTER, SESS);

await t('출석률·제출률은 기록된 회차만 셈합니다', () => {
  eq(STATS.total, 4, '전체 인원');
  eq(STATS.recordedCount, 2, '기록된 회차');
  // 1회차 3/4, 2회차 1/4 → 평균 50%
  eq(pct(STATS.avgAtt), '50%', '평균 출석률');
  // 1회차 2/4, 2회차 2/4 → 50%
  eq(pct(STATS.avgSub), '50%', '평균 제출률');
});

await t('아직 안 한 회차는 결석으로 잡지 않습니다', () => {
  const hong = STATS.perStudent.find((p) => p.entry.id === 'a');
  eq(hong.recordedCount, 2, '분모는 기록된 회차뿐');
  eq(hong.attCount, 2, '출석');
  eq(hong.subCount, 2, '제출');
  eq(pct(hong.attRate), '100%', '출석률');
});

await t('한 회차라도 결석·미제출이 겹치면 주의 학생', () => {
  // b(이수현/교육부): 1회차 출석·제출, 2회차 결석·미제출 → 주의
  // c(이수현/과기부): 1회차 출석했고 2회차는 미출석이지만 제출함 → 주의 아님
  // d(김철수): 두 회차 모두 결석·미제출 → 주의, 겹친 회차 2개
  const ids = STATS.atRisk.map((p) => p.entry.id);
  ok(ids.includes('b'), '한 회차 겹침');
  ok(ids.includes('d'), '두 회차 겹침');
  ok(!ids.includes('c'), '결석했지만 제출한 학생은 제외');
  ok(!ids.includes('a'), '개근');
  eq(STATS.atRisk[0].entry.id, 'd', '많이 겹친 학생이 위로');
  eq(STATS.atRisk[0].riskSessions.length, 2, '겹친 회차 수');
});

await t('명단에서 지운 학생은 회차 인원에서도 빠집니다', () => {
  const s = computeStats(ROSTER.filter((e) => e.id !== 'c'), SESS);
  eq(s.perSession[0].attCount, 2, '유령 id 제외');
});

console.log('\n== 내보내기 표 ==');

await t('학생별 상세 — 학생 한 명이 한 줄, 회차마다 두 칸', () => {
  const rows = detailRows(ROSTER, SESS, STATS);
  eq(rows.length, 5, '머리글 + 4명');
  eq(rows[0].length, 3 + 8 * 2 + 5, '열 수');
  eq(rows[0][3], '온라인 1회차 출석', '머리글');
  const hong = rows[1];
  deep(hong.slice(0, 3), [1, '홍길동', '행정안전부'], '앞 세 칸');
  eq(hong[3], '출석', '1회차 출석');
  eq(hong[4], '제출', '1회차 제출');
  eq(hong[7], '미기록', '아직 안 한 회차');
  const kim = rows.find((r) => r[1] === '김철수');
  eq(kim[3], '결석', '결석 표기');
  ok(String(kim[kim.length - 1]).includes('결석+미제출'), '주의 표기');
});

await t('회차별 요약 — 8줄과 비율', () => {
  const rows = summaryRows(STATS);
  eq(rows.length, 9, '머리글 + 8회차');
  eq(rows[1][0], '온라인 1회차', '회차 이름');
  eq(rows[1][5], 3, '출석 인원');
  eq(rows[1][6], 1, '결석 인원');
  eq(rows[1][9], '75%', '출석률');
  eq(rows[3][4], '미기록', '기록 안 한 회차');
  eq(rows[7][2], '미정', '일자 미정');
});

await t('내보낸 엑셀을 다시 읽으면 같은 내용입니다', async () => {
  const blob = buildXlsx([
    { name: '학생별 상세', rows: detailRows(ROSTER, SESS, STATS) },
    { name: '회차별 요약', rows: summaryRows(STATS) },
  ]);
  const back = await readSheet(fileOf(blob, '수강현황.xlsx'));
  eq(back[0][1], '이름', '머리글');
  eq(back[1][1], '홍길동', '첫 학생');
  eq(back[1][3], '출석', '출석 칸');
});

console.log('\n== 저장소 권한 (roster · attendance) ==');

const bucket = new MockBucket();
const env = { BUCKET: bucket, PBKDF2_ITERATIONS: 1000 };

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, ...headers } };
    if (cookie) init.headers.Cookie = cookie;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await handleApi(new Request(`${ORIGIN}/api${path}`, init), env, { basePath: '/api' });
    const set = res.headers.get('Set-Cookie');
    if (set) {
      const pair = set.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    let data = null;
    if ((res.headers.get('Content-Type') || '').includes('json')) {
      data = await res.json().catch(() => null);
    }
    return { status: res.status, data };
  };
}

const admin = client();
const member = client();

await t('계정 준비 — 관리자와 일반 회원', async () => {
  const a = await admin('/auth/signup', {
    method: 'POST',
    body: { institution: '행정안전부', name: '관리자', email: ADMIN, password: 'Admin!2345' },
  });
  eq(a.status, 200, `관리자 가입: ${JSON.stringify(a.data)}`);
  const m = await member('/auth/signup', {
    method: 'POST',
    body: { institution: '교육부', name: '홍길동', email: 'hong@x.kr', password: 'Member!2345' },
  });
  eq(m.status, 200, '회원 가입');
});

await t('일반 회원은 명단·출결을 읽을 수 없습니다', async () => {
  eq((await member('/data/roster')).status, 403, '명단');
  eq((await member('/data/attendance')).status, 403, '출결');
});

await t('일반 회원은 명단을 쓸 수도 없습니다', async () => {
  const res = await member('/data/roster', {
    method: 'PUT', body: { etag: 'x', data: [{ id: 'z', name: '침입', dept: '' }] },
  });
  eq(res.status, 403, '쓰기 거부');
});

await t('관리자는 명단을 읽고 씁니다 (etag 조건부)', async () => {
  const first = await admin('/data/roster');
  eq(first.status, 200, '읽기');
  deep(first.data.data, [], '처음엔 빈 명단');

  const put = await admin('/data/roster', {
    method: 'PUT',
    body: { etag: first.data.etag, data: [{ id: 'st_1', name: '홍길동', dept: '행정안전부' }] },
  });
  eq(put.status, 200, '쓰기');

  const again = await admin('/data/roster');
  eq(again.data.data[0].name, '홍길동', '되읽기');

  // 낡은 etag 로 다시 쓰면 충돌로 막혀야 합니다.
  const stale = await admin('/data/roster', {
    method: 'PUT', body: { etag: first.data.etag, data: [] },
  });
  eq(stale.status, 409, '낡은 etag 충돌');
});

await t('회차 기록도 같은 규칙으로 저장됩니다', async () => {
  const cur = await admin('/data/attendance');
  const put = await admin('/data/attendance', {
    method: 'PUT',
    body: {
      etag: cur.data.etag,
      data: [{ id: 'on1', attendance: ['st_1'], submission: [], recorded: true }],
    },
  });
  eq(put.status, 200, '쓰기');
  const back = await admin('/data/attendance');
  eq(back.data.data[0].id, 'on1', '회차 id');
  deep(back.data.data[0].attendance, ['st_1'], '출석자');
});

await t('로그인하지 않으면 아무것도 못 봅니다', async () => {
  const anon = client();
  eq((await anon('/data/roster')).status, 401, '비회원');
});

await t('알 수 없는 색인 이름은 여전히 404 입니다', async () => {
  eq((await admin('/data/members')).status, 404, 'members 는 노출되지 않습니다');
  eq((await admin('/data/nope')).status, 404, '없는 이름');
});

console.log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n전부 통과');
process.exit(fails.length ? 1 : 0);
