/**
 * 마감 뒤 등록 — 브라우저 종단간 테스트.
 *
 * 규칙 자체(누가 등록할 수 있는지, 표를 받는지)는 vote.test.mjs 가 서버에서
 * 봅니다. 여기서는 **화면**이 그 규칙대로 움직이는지 확인합니다 — 특히
 * 투표판에서 빼는 일은 화면 쪽에서만 하므로 여기서만 잡힙니다.
 */
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { startServer } from './mock-r2.mjs';

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

const consoleErrors = [];
const PASSWORD = 'hunter2!hunter2';

async function person(label) {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    const fromFonts = /fonts\.(googleapis|gstatic)/.test(m.location()?.url || '');
    // 설계된 거절(400·401·403)과 서버를 내릴 때의 연결 끊김은 오류가 아닙니다.
    const expected = /Failed to load resource.*(400|401|403|409)|ERR_CONNECTION_RESET/.test(text);
    if (m.type() === 'error' && !fromFonts && !expected) consoleErrors.push(`[${label}] ${text}`);
  });
  return page;
}

async function signup(page, email, name) {
  await page.goto(`${origin}/#/signup`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signupForm', { timeout: 8000 });
  for (const [k, v] of [
    ['institution', '행정안전부'], ['name', name], ['email', email],
    ['password', PASSWORD], ['confirm', PASSWORD],
  ]) await page.fill(`#signupForm [name="${k}"]`, v);
  await page.check('#signupForm [name="agree"]');
  await page.locator('#signupForm button[type="submit"]').click();
  await page.waitForURL((u) => u.hash === '#/' || u.hash === '', { timeout: 12000 });
}

/** 제출 폼을 채워 보내고 상세 화면까지 갑니다. asEmail 을 주면 그 회원 이름으로. */
async function submitWork(page, title, body, asEmail = '') {
  await page.waitForSelector('#submitForm', { timeout: 8000 });
  if (asEmail) await page.selectOption('#authorPick', asEmail);
  await page.fill('#submitForm [name="title"]', title);
  await page.fill('#submitForm [name="body"]', body);
  await page.check('#submitForm [name="agree"]');
  await page.locator('#submitForm button[type="submit"]').click();
  await page.waitForURL(/#\/s\//, { timeout: 12000 });
}

const admin = await person('관리자');
const alice = await person('앨리스');

const iso = (ms) => new Date(Date.now() + ms).toISOString();
const project = (over = {}) => ({
  id: 'p1',
  title: '1주차 과제',
  description: '설명',
  status: 'open',
  visibility: 'private',
  dueAt: iso(600000),
  allowFiles: false,
  createdAt: iso(-86400000),
  voting: { enabled: true, startAt: null, endAt: null, perMember: 2, allowSelf: false, showCounts: true },
  ...over,
});

/** 관리자 브라우저에서 프로젝트 색인을 바꿉니다(마감 시각을 옮기려고). */
async function putProject(over) {
  const etag = await admin.evaluate(async () => (await (await fetch('/api/data/projects')).json()).etag);
  const status = await admin.evaluate(async ([tag, data]) => (await fetch('/api/data/projects', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ etag: tag, data }),
  })).status, [etag, [project(over)]]);
  if (status !== 200) throw new Error(`프로젝트 저장 실패 (${status})`);
}

log('\n== 준비 ==');

await step('관리자·회원 가입', async () => {
  await signup(admin, 'aireader@mois.go.kr', '관리자');
  await signup(alice, 'alice@example.com', '앨리스');
});

await step('마감 전에는 회원이 그대로 제출', async () => {
  await putProject({});
  await alice.goto(`${origin}/#/p/p1/submit`, { waitUntil: 'networkidle' });
  await submitWork(alice, '앨리스 작품', '기한 내 제출입니다.');
  eq(await alice.locator('.badge--due').count(), 0, '마감 후 등록 배지 없음');
});

log('\n== 마감 뒤 ==');

await step('회원은 제출 화면이 막힘', async () => {
  await putProject({ dueAt: iso(-600000) });
  await alice.goto(`${origin}/#/p/p1/submit`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.notice--warn', { timeout: 8000 });
  eq((await alice.locator('.notice--warn').first().innerText()).trim(),
    '제출 마감일이 지났습니다.', '차단 문구');
  eq(await alice.locator('#submitForm').count(), 0, '폼이 없어야 함');
});

await step('관리자에게는 프로젝트 화면에 등록 버튼이 보임', async () => {
  await admin.goto(`${origin}/#/p/p1`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.band a[href="#/p/p1/submit"]', { timeout: 8000 });
  eq(await admin.locator('.band a[href="#/p/p1/submit"]').innerText(), '관리자로 등록하기', '버튼 문구');
});

await step('관리자 제출 화면은 열리고 무슨 일이 생기는지 알려줌', async () => {
  await admin.goto(`${origin}/#/p/p1/submit`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#submitForm', { timeout: 8000 });
  eq(await admin.locator('h1.page-title').innerText(), '과제 등록 (마감 뒤)', '제목');
  const note = (await admin.locator('.notice--warn').first().innerText()).replace(/\s+/g, ' ');
  ok(note.includes('투표 대상에서 빠집니다'), `안내 문구: ${note}`);
});

await step('관리자가 등록하면 late 로 저장되고 배지가 붙음', async () => {
  await submitWork(admin, '관리자 등록 작품', '마감 뒤 등록입니다.');
  await admin.waitForSelector('.badge--due', { timeout: 8000 });
  eq(await admin.locator('.badge--due').first().innerText(), '마감 후 등록', '상세 배지');

  const rows = JSON.parse(await (await bucket.get('data/submissions.json')).text());
  eq(rows.find((s) => s.title === '관리자 등록 작품').late, true, '저장된 late');
  eq(rows.find((s) => s.title === '앨리스 작품').late, undefined, '기한 내 제출은 표시 없음');
});

log('\n== 투표 ==');

await step('회원 투표판에는 기한 내 작품만 올라옴', async () => {
  await alice.goto(`${origin}/#/vote/p1`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.votecard', { timeout: 10000 });
  eq(await alice.locator('.votecard').count(), 1, '카드 수');
  eq(await alice.locator('.votecard__title').innerText(), '앨리스 작품', '남은 작품');
});

await step('관리자에게는 몇 건이 빠졌는지 알려줌', async () => {
  await admin.goto(`${origin}/#/vote/p1`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.votecard', { timeout: 10000 });
  eq(await admin.locator('.votecard').count(), 1, '카드 수');
  const notes = (await admin.locator('#voteStatus .notice--info').allInnerTexts()).join(' ').replace(/\s+/g, ' ');
  ok(notes.includes('1건'), `안내: ${notes}`);
});

await step('관리자 제출물 표에 표시되고 득표 칸은 비어 있음', async () => {
  await admin.goto(`${origin}/#/admin/submissions/p1`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.table tbody tr', { timeout: 8000 });
  const row = admin.locator('.table tbody tr', { hasText: '관리자 등록 작품' });
  const text = (await row.innerText()).replace(/\s+/g, ' ');
  ok(text.includes('마감 후 등록'), `줄 내용: ${text}`);
  eq(await admin.locator('.table tbody tr').count(), 2, '제출물 2건 모두 보임');
});

log('\n== 다른 회원 이름으로 등록 ==');

await step('관리자 제출 화면에 제출자 선택기가 있고 회원이 들어 있음', async () => {
  await admin.goto(`${origin}/#/p/p1/submit`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#authorPick', { timeout: 8000 });
  const opts = await admin.locator('#authorPick option').allInnerTexts();
  ok(opts[0].includes('나 —'), `첫 항목: ${opts[0]}`);
  ok(opts.some((o) => o.includes('alice@example.com')), `앨리스 없음: ${opts.join(' / ')}`);
});

await step('회원은 선택기가 보이지 않음', async () => {
  await putProject({});                       // 마감 전으로 되돌려 앨리스도 들어가게
  await alice.goto(`${origin}/#/p/p1/submit`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('#submitForm', { timeout: 8000 });
  eq(await alice.locator('#authorPick').count(), 0, '선택기 없음');
});

await step('고르면 위쪽 제출자 표시가 함께 바뀜', async () => {
  await admin.goto(`${origin}/#/p/p1/submit`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#authorPick', { timeout: 8000 });
  await admin.selectOption('#authorPick', 'alice@example.com');
  const line = (await admin.locator('#authorLine').innerText()).replace(/\s+/g, ' ');
  ok(line.includes('alice@example.com'), `표시: ${line}`);
  ok(line.includes('관리자가 대신 등록'), `표시: ${line}`);
});

await step('앨리스 이름으로 등록하면 앨리스의 제출물이 됨', async () => {
  await submitWork(admin, '대신 등록한 작품', '관리자가 대신 올립니다.', 'alice@example.com');
  const detail = (await admin.locator('.page-head').first().innerText()).replace(/\s+/g, ' ');
  ok(detail.includes('alice@example.com'), `상세 제출자: ${detail}`);
  ok(detail.includes('관리자 대신 등록'), `배지: ${detail}`);

  const rows = JSON.parse(await (await bucket.get('data/submissions.json')).text());
  const one = rows.find((s) => s.title === '대신 등록한 작품');
  eq(one.author.email, 'alice@example.com', '저장된 제출자');
  eq(one.registeredBy, 'aireader@mois.go.kr', '대신 올린 관리자');
});

await step('앨리스의 내 제출물에도 나타남', async () => {
  await alice.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.table tbody tr', { timeout: 8000 });
  const text = (await alice.locator('.table').innerText()).replace(/\s+/g, ' ');
  ok(text.includes('대신 등록한 작품'), `내 제출물: ${text}`);
});

await step('자바스크립트 오류 없음', () => {
  if (consoleErrors.length) throw new Error(consoleErrors.join(' | '));
});

await browser.close();
server.close();

log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n모든 검사 통과');
process.exit(fails.length ? 1 : 0);
