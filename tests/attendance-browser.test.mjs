/**
 * 수강 현황 브라우저 종단간 테스트.
 *
 * R2 스텁 위에 사이트와 `/api` 를 같은 오리진으로 띄우고, 실제 크로미움으로
 * 관리자가 하는 순서를 그대로 밟습니다 — 명단 올리기 → Zoom 접속기록으로
 * 출석 반영(동명이인·명단에 없는 이름 확인) → 직접 체크 → 대시보드 → 엑셀 내려받기.
 */
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { startServer } from './mock-r2.mjs';
import { readSheet } from '../assets/js/sheet.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fails = [];
const log = (...a) => console.log(...a);
const step = async (name, fn) => {
  try { await fn(); log(`  PASS  ${name}`); }
  catch (e) { log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};
const ok = (v, m) => { if (!v) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

const { server, bucket, origin } = await startServer({ root, env: { PBKDF2_ITERATIONS: 1000 } });
log(`\n로컬 R2 스텁 서버: ${origin}`);

const executablePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const text = m.text();
  const fromFonts = /fonts\.(googleapis|gstatic)/.test(m.location()?.url || '');
  const expectedHttp = /Failed to load resource.*(401|403|409)/.test(text);
  if (m.type() === 'error' && !fromFonts && !expectedHttp) consoleErrors.push(text);
});

/* 올릴 파일들을 임시 폴더에 만들어 둡니다. */
const dir = mkdtempSync(join(tmpdir(), 'att-'));
const write = (name, text) => {
  const p = join(dir, name);
  writeFileSync(p, `﻿${text}`, 'utf8');
  return p;
};

// 동명이인(이수현 2명)과 소속이 있는 12명짜리 명단.
const ROSTER_CSV = write('roster.csv', [
  '연번,소속,성명,이메일',
  '1,행정안전부,홍길동,a@x.kr',
  '2,교육부,이수현,b@x.kr',
  '3,과학기술정보통신부,이수현,c@x.kr',
  '4,기획재정부,김철수,d@x.kr',
  '5,행정안전부,박영희,e@x.kr',
  '6,교육부,최민수,f@x.kr',
].join('\r\n'));

// Zoom 접속기록 — 위에 회의 정보가 붙고, 표시 이름이 "부서명_이름" 입니다.
const ZOOM_CSV = write('zoom.csv', [
  '회의 보고서,,',
  '주제,AI 리더스 아카데미 1회차,',
  ',,',
  '이름(원래 이름),사용자 이메일,참가 시간(분)',
  '행정안전부_홍길동,a@x.kr,92',
  '교육부_이수현,b@x.kr,88',          // 소속으로 자동 구분
  '이수현,,85',                       // 소속이 없어 사람에게 물어봄
  '김철수의 iPhone,,77',              // 기기 이름이 붙어도 찾아냄
  '행안부_강감찬,,61',                // 명단에 없는 이름
].join('\r\n'));

const SUBMIT_CSV = write('submit.csv', [
  '이름',
  '홍길동',
  '박영희',
].join('\r\n'));

const PASSWORD = 'hunter2!hunter2';

async function signup() {
  await page.goto(`${origin}/#/signup`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signupForm', { timeout: 8000 });
  await page.fill('#signupForm [name="institution"]', '행정안전부');
  await page.fill('#signupForm [name="name"]', '관리자');
  await page.fill('#signupForm [name="email"]', 'aireader@mois.go.kr');
  await page.fill('#signupForm [name="password"]', PASSWORD);
  await page.fill('#signupForm [name="confirm"]', PASSWORD);
  await page.check('#signupForm [name="agree"]');
  await page.locator('#signupForm button[type="submit"]').click();
  await page.waitForURL((u) => u.hash === '#/' || u.hash === '', { timeout: 12000 });
}

const goto = async (hash, sel) => {
  await page.goto(`${origin}/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForSelector(sel, { timeout: 10000 });
};

/**
 * 해시만 바뀌는 이동은 새로고침이 아니라 지난 토스트가 화면에 남습니다.
 * 무엇을 확인하는지 분명해지도록 확인할 동작 직전에 비웁니다.
 */
const clearToasts = () => page.evaluate(() => { document.querySelector('#toaster').innerHTML = ''; });
const lastToast = () => page.locator('.toast--ok').last().innerText();

log('\n== 1. 들어가기 ==');

await step('관리자로 가입', signup);

await step('관리자 대시보드에 "수강 현황" 자리가 있고 명단 없음을 알려줍니다', async () => {
  await goto('#/admin', '#adminAttendance .empty h3');
  const title = await page.locator('#adminAttendance .empty h3').innerText();
  ok(title.includes('명단'), title);
  ok(await page.locator('a[href="#/admin/attendance"]').count(), '수강 현황 링크');
});

await step('수강 현황 대시보드가 열리고 네 개의 탭이 보입니다', async () => {
  await goto('#/admin/attendance', '.subnav');
  eq(await page.locator('.subnav__item').count(), 4, '탭 수');
  eq(await page.locator('.subnav__item.is-active').innerText(), '대시보드', '현재 탭');
  // 명단이 없으니 회차별 현황은 그려지되 전체 학생 표 자리는 안내가 나옵니다.
  eq(await page.locator('.table tbody tr').count(), 8, '회차 8줄');
  ok(await page.locator('#matrix .empty').count(), '명단 안내');
});

log('\n== 2. 전체 명단 ==');

await step('CSV 명단을 올리면 이름·소속을 알아서 읽습니다', async () => {
  await goto('#/admin/attendance/roster', '[data-drop]');
  await page.setInputFiles('#rosterDrop [data-input]', ROSTER_CSV);
  await page.waitForSelector('.modal h2', { timeout: 8000 });
  const body = await page.locator('.modal').innerText();
  ok(body.includes('6명'), `읽은 인원: ${body}`);
  ok(body.includes('새로 추가: 6명'), '새로 추가');
  await page.locator('.modal [data-ok]').click();
  await page.waitForSelector('.table tbody tr', { timeout: 8000 });
  eq(await page.locator('#rosterRows .table tbody tr').count(), 6, '표에 6명');
});

await step('동명이인이 있으면 알려줍니다', async () => {
  const note = await page.locator('.notice--info').innerText();
  ok(note.includes('이수현'), note);
});

await step('R2 에 data/roster.json 으로 저장됩니다', async () => {
  const obj = await bucket.get('data/roster.json');
  const list = JSON.parse(await obj.text());
  eq(list.length, 6, '저장된 인원');
  eq(list[0].name, '홍길동', '첫 사람');
  eq(list[1].dept, '교육부', '소속');
});

await step('직접 한 명 추가하고 다시 지울 수 있습니다', async () => {
  await page.fill('#addForm [name="name"]', '임시학생');
  await page.fill('#addForm [name="dept"]', '테스트부');
  await page.locator('#addForm button[type="submit"]').click();
  await page.waitForFunction(() =>
    document.querySelectorAll('#rosterRows .table tbody tr').length === 7, null, { timeout: 8000 });

  const row = page.locator('#rosterRows .table tbody tr', { hasText: '임시학생' });
  await row.locator('[data-del]').click();
  await page.waitForSelector('.modal [data-ok]', { timeout: 8000 });
  await page.locator('.modal [data-ok]').click();
  await page.waitForFunction(() =>
    document.querySelectorAll('#rosterRows .table tbody tr').length === 6, null, { timeout: 8000 });
});

log('\n== 3. 회차별 기록 ==');

await step('회차 8개가 칩으로 보이고 온라인 1회차가 먼저 열립니다', async () => {
  await goto('#/admin/attendance/sessions', '.chips .chip');
  eq(await page.locator('.chip').count(), 8, '회차 수');
  eq(await page.locator('.chip.is-active').innerText(), '온라인 1회차', '기본 회차');
  ok((await page.locator('.card').first().innerText()).includes('AI를 이해한다'), '주제');
});

await step('Zoom 접속기록을 올리면 자동 대조 결과와 확인 팝업이 뜹니다', async () => {
  await page.setInputFiles('#attDrop [data-input]', ZOOM_CSV);
  await page.waitForSelector('.modal--wide', { timeout: 8000 });
  const text = await page.locator('.modal--wide').innerText();
  // 홍길동(부서명_이름) · 이수현(소속으로 구분) · 김철수(기기 이름) = 3명
  ok(text.includes('3명'), `자동 매칭 문구: ${text.slice(0, 200)}`);
  ok(text.includes('동명이인 1건'), '동명이인 안내');
  ok(text.includes('강감찬'), '명단에 없는 이름');
});

await step('동명이인은 소속을 보고 고르고, 없는 이름은 명단에 넣습니다', async () => {
  // 이수현 두 명 중 '과학기술정보통신부' 를 고릅니다.
  const group = page.locator('.att-group', { hasText: '이수현' });
  await group.locator('.check', { hasText: '과학기술정보통신부' }).locator('input').check();
  await page.locator('[data-new]').first().check();     // 강감찬을 명단에 추가
  await clearToasts();
  await page.locator('.modal--wide [data-ok]').click();
  await page.waitForSelector('.toast--ok', { timeout: 8000 });
  const toast = await lastToast();
  ok(toast.includes('5명'), `반영 인원: ${toast}`);     // 3 + 선택 1 + 새 학생 1
});

await step('반영 결과가 화면과 R2 양쪽에 남습니다', async () => {
  await page.waitForFunction(() =>
    document.body.innerText.includes('출석 5명'), null, { timeout: 8000 });
  const obj = await bucket.get('data/attendance.json');
  const list = JSON.parse(await obj.text());
  const on1 = list.find((s) => s.id === 'on1');
  eq(on1.attendance.length, 5, '저장된 출석');
  eq(on1.recorded, true, '기록됨');
  const roster = JSON.parse(await (await bucket.get('data/roster.json')).text());
  eq(roster.length, 7, '강감찬이 명단에 들어옴');
  ok(roster.some((e) => e.name === '강감찬'), '새 학생');
});

await step('출석을 반영해도 보고 있던 회차가 바뀌지 않습니다', async () => {
  // 기록을 마치면 "아직 안 한 첫 회차"가 달라집니다. 그때 화면이 따라 움직이면
  // 이어서 올리는 제출자 파일이 옆 회차로 들어가 버립니다.
  const chip = (await page.locator('.chip.is-active').innerText()).replace(/\s+/g, ' ');
  ok(chip.startsWith('온라인 1회차'), `보고 있던 회차: ${chip}`);
  ok(chip.includes('✓'), `기록 표시: ${chip}`);
  ok(page.url().includes('s=on1'), `주소에 회차가 남음: ${page.url()}`);
});

await step('과제 제출자 파일도 같은 방식으로 반영됩니다', async () => {
  await page.setInputFiles('#subDrop [data-input]', SUBMIT_CSV);
  await page.waitForSelector('.modal--wide', { timeout: 8000 });
  const text = await page.locator('.modal--wide').innerText();
  ok(text.includes('2명'), `제출자: ${text.slice(0, 160)}`);
  // 물어볼 것이 없으므로 확인만 누르면 됩니다.
  eq(await page.locator('.att-group').count(), 0, '동명이인 없음');
  await page.locator('.modal--wide [data-ok]').click();
  await page.waitForFunction(() =>
    document.body.innerText.includes('제출 2명'), null, { timeout: 8000 });
});

await step('파일 없이 체크박스로 직접 고칠 수 있습니다', async () => {
  await goto('#/admin/attendance/sessions?s=on2', '#checkRows .table');
  eq(await page.locator('#checkRows .table tbody tr').count(), 7, '학생 수');
  ok(await page.locator('[data-save][aria-disabled="true"]').count(), '처음엔 저장 잠김');

  // 앞의 세 명을 출석 처리하고 한 명은 제출까지.
  const ticks = page.locator('[data-att]');
  for (let i = 0; i < 3; i += 1) await ticks.nth(i).check();
  await page.locator('[data-sub]').first().check();
  ok(await page.locator('[data-save][aria-disabled="false"]').count(), '변경되면 저장 열림');

  await clearToasts();
  await page.locator('[data-save]').click();
  // 저장이 끝나면 화면을 다시 그리므로 "저장하지 않은 변경" 문구가 사라집니다.
  await page.waitForFunction(() => {
    const el = document.querySelector('#dirty');
    return el && !el.textContent.trim()
      && document.body.innerText.includes('출석 3명 · 제출 1명');
  }, null, { timeout: 10000 });
  ok((await lastToast()).includes('저장'), '저장 알림');

  const list = JSON.parse(await (await bucket.get('data/attendance.json')).text());
  const on2 = list.find((s) => s.id === 'on2');
  eq(on2.attendance.length, 3, '저장된 출석');
  eq(on2.submission.length, 1, '저장된 제출');
});

await step('필터로 결석자만 추려 볼 수 있습니다', async () => {
  await page.selectOption('#filter', 'absent');
  await page.waitForFunction(() =>
    document.querySelectorAll('#checkRows .table tbody tr').length === 4, null, { timeout: 8000 });
});

await step('오프라인 회차는 일자를 직접 정할 수 있습니다', async () => {
  await goto('#/admin/attendance/sessions?s=off1', '[data-edit-session]');
  ok((await page.locator('.page-head').nth(1).innerText()).includes('일자 미정'), '처음엔 미정');
  await page.locator('[data-edit-session]').click();
  await page.waitForSelector('.modal [data-date]', { timeout: 8000 });
  await page.fill('.modal [data-title]', '현장 워크숍');
  await page.fill('.modal [data-date]', '2026-10-30');
  await page.locator('.modal [data-ok]').click();
  await page.waitForFunction(() =>
    document.body.innerText.includes('현장 워크숍'), null, { timeout: 8000 });
  const list = JSON.parse(await (await bucket.get('data/attendance.json')).text());
  const off1 = list.find((s) => s.id === 'off1');
  eq(off1.date, '2026-10-30', '저장된 일자');
});

log('\n== 4. 대시보드와 학생별 상세 ==');

await step('대시보드가 인원·평균·주의 학생을 셉니다', async () => {
  await goto('#/admin/attendance', '.stat-row .stat');
  const stats = await page.locator('.stat-row .stat').allInnerTexts();
  ok(stats[0].includes('7'), `전체 수강생: ${stats[0]}`);
  // 출결을 넣은 on1·on2 만 셉니다. off1 은 일자만 정했을 뿐 기록은 없습니다.
  ok(stats[3].includes('2/8'), `기록된 회차: ${stats[3]}`);
  ok(/\d+%/.test(stats[1]), `평균 출석률: ${stats[1]}`);
});

await step('전체 학생 표에 회차마다 두 칸이 그려집니다', async () => {
  await page.waitForSelector('.table--matrix', { timeout: 8000 });
  eq(await page.locator('.table--matrix tbody tr').count(), 7, '학생 줄');
  eq(await page.locator('.table--matrix tbody tr').first().locator('td').count(),
    2 + 8 * 2 + 2, '한 줄의 칸 수');
  ok(await page.locator('.table--matrix .mark--ok').count(), '완료 표시');
  ok(await page.locator('.table--matrix .mark--none').count(), '미기록 표시');
});

await step('한 회차라도 결석·미제출이 겹친 학생이 표시됩니다', async () => {
  const text = await page.locator('.card', { hasText: '주의가 필요한 학생' }).innerText();
  ok(text.includes('최민수'), `주의 목록: ${text.slice(0, 300)}`);
});

await step('주의 학생을 누르면 그 학생의 이력이 열립니다', async () => {
  await page.locator('.card', { hasText: '주의가 필요한 학생' })
    .locator('a[href*="#/admin/attendance/students"]').first().click();
  await page.waitForSelector('#detail .table tbody tr', { timeout: 8000 });
  eq(await page.locator('#detail .table tbody tr').count(), 8, '8회차 전부');
  const text = await page.locator('#detail').innerText();
  ok(text.includes('결석') || text.includes('미제출'), '출결 표시');
});

await step('학생을 검색해 고를 수 있습니다', async () => {
  await goto('#/admin/attendance/students', '.att-people .att-person');
  eq(await page.locator('.att-person').count(), 7, '전체 학생');
  await page.fill('#pq', '이수현');
  await page.waitForFunction(() =>
    document.querySelectorAll('.att-person').length === 2, null, { timeout: 8000 });
  await page.locator('.att-person', { hasText: '과학기술정보통신부' }).click();
  await page.waitForFunction(() =>
    document.querySelector('#detail .page-title')?.innerText.includes('과학기술정보통신부'),
  null, { timeout: 8000 });
  // 주소에도 남아 새로고침하면 같은 학생이 열립니다.
  ok(page.url().includes('id='), `주소: ${page.url()}`);
});

log('\n== 5. 엑셀 내보내기 ==');

await step('학생별 상세 + 회차별 요약 두 장이 내려받아집니다', async () => {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.locator('[data-xlsx]').click(),
  ]);
  const saved = join(dir, 'out.xlsx');
  await download.saveAs(saved);

  const bytes = readFileSync(saved);
  const text = bytes.toString('latin1');
  ok(text.includes('sheet1.xml') && text.includes('sheet2.xml'), '시트 두 장');

  // 첫 시트를 실제로 파싱해 내용을 확인합니다.
  const blob = Object.assign(new Blob([bytes]), { name: 'out.xlsx' });
  const rows = await readSheet(blob);
  eq(rows[0][1], '이름', '머리글');
  eq(rows.length, 8, '머리글 + 학생 7명');
  ok(rows[0].includes('온라인 1회차 출석'), '회차 열');
  ok(rows[0].includes('오프라인 2회차 제출'), '오프라인 열');
  const hong = rows.find((r) => r[1] === '홍길동');
  eq(hong[3], '출석', '홍길동 1회차 출석');
  eq(hong[4], '제출', '홍길동 1회차 제출');
  const choi = rows.find((r) => r[1] === '최민수');
  eq(choi[3], '결석', '최민수 1회차 결석');
  eq(choi[4], '미제출', '최민수 1회차 미제출');
  eq(choi[15], '미기록', '아직 안 한 회차');
});

log('\n== 6. 권한 ==');

await step('일반 회원은 수강 현황을 볼 수 없습니다', async () => {
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(`${origin}/#/signup`, { waitUntil: 'networkidle' });
  await p2.waitForSelector('#signupForm', { timeout: 8000 });
  await p2.fill('#signupForm [name="institution"]', '교육부');
  await p2.fill('#signupForm [name="name"]', '홍길동');
  await p2.fill('#signupForm [name="email"]', 'member@x.kr');
  await p2.fill('#signupForm [name="password"]', PASSWORD);
  await p2.fill('#signupForm [name="confirm"]', PASSWORD);
  await p2.check('#signupForm [name="agree"]');
  await p2.locator('#signupForm button[type="submit"]').click();
  await p2.waitForURL((u) => u.hash === '#/' || u.hash === '', { timeout: 12000 });

  await p2.goto(`${origin}/#/admin/attendance`, { waitUntil: 'networkidle' });
  await p2.waitForSelector('.notice--warn', { timeout: 8000 });
  ok((await p2.locator('.notice--warn').innerText()).includes('관리자'), '관리자 전용 안내');

  // API 를 직접 찔러도 막힙니다.
  const status = await p2.evaluate(async () =>
    (await fetch('/api/data/roster', { credentials: 'include' })).status);
  eq(status, 403, '명단 API');
  await other.close();
});

await step('자바스크립트 오류 없음', () => {
  if (consoleErrors.length) throw new Error(consoleErrors.join(' | '));
});

await browser.close();
server.close();

log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n모든 검사 통과');
process.exit(fails.length ? 1 : 0);
