/**
 * R2 + 회원제 브라우저 종단간 테스트.
 *
 * 메모리 R2 스텁 위에 사이트와 /api 를 같은 오리진으로 띄우고 — 실제 Cloudflare
 * 배포와 같은 구조 — 진짜 크로미움으로 가입부터 제출·다운로드까지 밟아 봅니다.
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

const { server, bucket, origin } = await startServer({
  root,
  env: { PBKDF2_ITERATIONS: 1000 },   // 테스트 속도용
});
log(`\n로컬 R2 스텁 서버: ${origin}`);

const executablePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});

const consoleErrors = [];
/** 사람마다 별도 브라우저 컨텍스트 — 세션 쿠키가 섞이지 않습니다. */
async function person(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    const fromFonts = /fonts\.(googleapis|gstatic)/.test(m.location()?.url || '');
    // /api 가 401(비로그인)·403(권한없음)·409(중복가입)를 주는 것은 설계된 동작입니다.
    // 브라우저가 남기는 네트워크 로그일 뿐 자바스크립트 오류가 아닙니다.
    const expectedHttp = /Failed to load resource.*(401|403|409|Unauthorized|Forbidden|Conflict)/.test(text);
    if (m.type() === 'error' && !fromFonts && !expectedHttp) {
      consoleErrors.push(`[${label}] ${text}`);
    }
  });
  return page;
}

const PASSWORD = 'hunter2!hunter2';

async function signup(page, { email, name, institution }) {
  await page.goto(`${origin}/#/signup`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signupForm', { timeout: 8000 });
  await page.fill('#signupForm [name="institution"]', institution);
  await page.fill('#signupForm [name="name"]', name);
  await page.fill('#signupForm [name="email"]', email);
  await page.fill('#signupForm [name="password"]', PASSWORD);
  await page.fill('#signupForm [name="confirm"]', PASSWORD);
  await page.check('#signupForm [name="agree"]');
  await page.locator('#signupForm button[type="submit"]').click();
  await page.waitForURL((u) => u.hash === '#/' || u.hash === '', { timeout: 12000 });
}

const admin = await person('관리자');
const alice = await person('앨리스');
const bob = await person('밥');

log('\n== 1. 로그인 벽 ==');

await step('비회원도 홈은 보이되 과제 목록만 가려짐', async () => {
  await admin.goto(origin, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.hero__title', { timeout: 10000 });
  await admin.waitForSelector('#projectGrid .empty h3', { timeout: 10000 });
  const title = await admin.locator('#projectGrid .empty h3').innerText();
  if (!title.includes('로그인')) throw new Error(title);
  if (await admin.locator('.tile').count()) throw new Error('과제 목록이 노출됨');
  if (!(await admin.locator('#projectGrid a[href="#/login"]').count())) {
    throw new Error('로그인 버튼이 없음');
  }
});

await step('비회원은 강의자료·내 제출물도 막힘', async () => {
  for (const path of ['#/materials', '#/my']) {
    await admin.goto(`${origin}/${path}`, { waitUntil: 'networkidle' });
    await admin.waitForSelector('.empty h3', { timeout: 8000 });
  }
});

await step('비로그인 상태에서는 회원 전용 메뉴가 숨겨짐', async () => {
  const visible = await admin.locator('.gnav__links a:visible').allInnerTexts();
  if (visible.some((t) => t.includes('내 제출물'))) throw new Error(visible.join(','));
  if (!visible.some((t) => t.includes('이용안내'))) throw new Error('이용안내는 보여야 함');
});

log('\n== 2. 가입 ==');

await step('관리자 이메일로 가입하면 관리자 권한', async () => {
  await signup(admin, { email: 'aireader@mois.go.kr', name: '관리자', institution: '행정안전부' });
  await admin.waitForSelector('.gnav__actions a[href="#/admin"]', { timeout: 8000 });
});

await step('회원 명부가 R2 에 저장되고 해시로만 보관됨', () => {
  const raw = new TextDecoder().decode(bucket.objects.get('data/members.json').bytes);
  if (!raw.includes('aireader@mois.go.kr')) throw new Error('명부에 없음');
  if (!raw.includes('pbkdf2$sha256$')) throw new Error('해시 형식이 아님');
  if (raw.includes(PASSWORD)) throw new Error('비밀번호 원문이 저장됨');
});

await step('같은 이메일로 재가입하면 안내', async () => {
  const other = await person('중복');
  await other.goto(`${origin}/#/signup`, { waitUntil: 'networkidle' });
  await other.fill('#signupForm [name="institution"]', 'X');
  await other.fill('#signupForm [name="name"]', 'Y');
  await other.fill('#signupForm [name="email"]', 'aireader@mois.go.kr');
  await other.fill('#signupForm [name="password"]', PASSWORD);
  await other.fill('#signupForm [name="confirm"]', PASSWORD);
  await other.check('#signupForm [name="agree"]');
  await other.locator('#signupForm button[type="submit"]').click();
  await other.waitForSelector('.field__err', { timeout: 8000 });
  await other.context().close();
});

let projectId;
await step('관리자가 프로젝트 개설', async () => {
  await admin.goto(`${origin}/#/admin/project/new`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#projForm', { timeout: 8000 });
  await admin.fill('#projForm [name="title"]', '1주차 · 브랜드 분석');
  await admin.fill('#projForm [name="description"]', '분석 결과를 제출하세요.');
  await admin.locator('#projForm button[type="submit"]').click();
  await admin.waitForURL(/#\/p\//, { timeout: 12000 });
  projectId = admin.url().split('#/p/')[1];
});

log('\n== 3. 회원 제출 ==');

await step('교육생 가입 후 바로 이용', async () => {
  await signup(alice, { email: 'alice@example.com', name: '앨리스', institution: '한국디자인진흥원' });
  await alice.waitForSelector('.tile', { timeout: 10000 });
});

await step('제출 폼에 제출자 정보가 자동으로 채워짐', async () => {
  await alice.goto(`${origin}/#/p/${projectId}/submit`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('#submitForm', { timeout: 8000 });
  const info = await alice.locator('.card--flat').innerText();
  if (!info.includes('앨리스') || !info.includes('alice@example.com')) throw new Error(info);
  // 이름·이메일을 다시 입력받는 칸이 없어야 합니다.
  if (await alice.locator('#submitForm [name="email"]').count()) throw new Error('이메일 입력칸이 남아 있음');
});

await step('첨부와 함께 제출 — 수정코드 없이 바로 상세로', async () => {
  await alice.fill('[name="title"]', '스타벅스 디자인 시스템 분석');
  await alice.fill('[name="body"]', '4단계 그린 체계를 정리했습니다.');
  await alice.setInputFiles('[data-input]', {
    name: '시안 최종.png',
    mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
      + '0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'),
  });
  await alice.waitForSelector('.fileitem', { timeout: 5000 });
  await alice.check('[name="agree"]');
  await alice.locator('#submitForm button[type="submit"]').click();
  await alice.waitForURL(/#\/s\//, { timeout: 15000 });
});

await step('작성자가 로그인 계정으로 기록됨', () => {
  const raw = new TextDecoder().decode(bucket.objects.get('data/submissions.json').bytes);
  const list = JSON.parse(raw);
  if (list.length !== 1) throw new Error(`제출물 ${list.length}건`);
  if (list[0].author.email !== 'alice@example.com') throw new Error(list[0].author.email);
  if (list[0].author.name !== '앨리스') throw new Error(list[0].author.name);
});

await step('업로드가 회원 전용 폴더로 들어감', () => {
  const keys = bucket.keys('uploads/');
  if (keys.length !== 1) throw new Error(`${keys.length}개: ${keys}`);
  if (!/^uploads\/m_[0-9a-f]{16}\//.test(keys[0])) throw new Error(keys[0]);
  if (!keys[0].includes('시안_최종.png')) throw new Error(keys[0]);
});

await step('첨부 이미지가 실제로 렌더됨', async () => {
  await alice.waitForSelector('.media-card img', { timeout: 10000 });
  const ok = await alice.locator('.media-card img').first().evaluate(
    (img) => img.complete && img.naturalWidth > 0);
  if (!ok) throw new Error('이미지가 로드되지 않음');
});

await step('내 제출물 목록에 로그인만으로 보임', async () => {
  await alice.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.table tbody tr', { timeout: 10000 });
  // 예전의 이메일+코드 입력 폼이 없어야 합니다.
  if (await alice.locator('#unlockForm').count()) throw new Error('수정코드 폼이 남아 있음');
});

log('\n== 4. 남의 제출물 ==');

await step('다른 회원은 비공개 프로젝트의 제출물을 못 봄', async () => {
  await signup(bob, { email: 'bob@example.com', name: '밥', institution: '한국정보화진흥원' });
  const subId = JSON.parse(new TextDecoder().decode(
    bucket.objects.get('data/submissions.json').bytes))[0].id;
  await bob.goto(`${origin}/#/s/${subId}`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.empty h3', { timeout: 8000 });
});

await step('다른 회원은 남의 제출물을 수정할 수 없음', async () => {
  const subId = JSON.parse(new TextDecoder().decode(
    bucket.objects.get('data/submissions.json').bytes))[0].id;
  const res = await bob.request.patch(`${origin}/api/submissions/${subId}`, {
    data: { title: '가로채기' },
  });
  if (res.status() !== 403) throw new Error(`status ${res.status()}`);
});

await step('내 제출물 목록에 남의 것이 섞이지 않음', async () => {
  await bob.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.empty h3, .table tbody tr', { timeout: 10000 });
  const empty = await bob.locator('.empty h3').count();
  if (!empty) throw new Error('밥에게 제출물이 보임');
});

log('\n== 5. 수정 · 삭제 ==');

await step('본인은 첨부를 추가해 수정할 수 있음', async () => {
  const before = bucket.keys('uploads/').length;
  await alice.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await alice.locator('a[href*="/edit"]').first().click();
  await alice.waitForSelector('#editForm', { timeout: 8000 });
  await alice.fill('#editForm [name="title"]', '수정된 제목');
  await alice.setInputFiles('#picker [data-input]', {
    name: '추가자료.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
  });
  await alice.waitForSelector('#picker .fileitem', { timeout: 5000 });
  await alice.locator('#editForm button[type="submit"]').click();
  await alice.waitForURL((u) => /#\/s\//.test(u.href) && !u.href.includes('/edit'), { timeout: 15000 });
  if (bucket.keys('uploads/').length !== before + 1) {
    throw new Error(`파일 ${bucket.keys('uploads/').length}개`);
  }
});

await step('관리자가 삭제하면 첨부까지 정리됨', async () => {
  await admin.goto(`${origin}/#/admin/submissions/${projectId}`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.table tbody tr', { timeout: 10000 });
  await admin.locator('[data-del]').first().click();
  await admin.locator('.modal [data-ok]').click();
  await admin.waitForTimeout(2500);
  if (bucket.keys('uploads/').length !== 0) {
    throw new Error(`파일 잔여: ${bucket.keys('uploads/')}`);
  }
});

log('\n== 6. 강의자료 ==');

await step('관리자가 강의자료 등록', async () => {
  await admin.goto(`${origin}/#/admin/material/new`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#matForm', { timeout: 8000 });
  await admin.fill('#matForm [name="title"]', '1강 · AI 리더십 개론');
  await admin.fill('#matForm [name="session"]', '1주차');
  await admin.setInputFiles('#matPicker [data-input]', {
    name: '1강 자료.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n강의자료\n'),
  });
  await admin.waitForSelector('#matPicker .fileitem', { timeout: 5000 });
  await admin.locator('#matForm button[type="submit"]').click();
  await admin.waitForURL(/#\/materials/, { timeout: 15000 });
});

let materialHref;
await step('회원은 비밀번호 없이 목록을 보고 내려받음', async () => {
  await alice.goto(`${origin}/#/materials`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.fileitem', { timeout: 10000 });
  if (await alice.locator('#gateForm').count()) throw new Error('비밀번호 화면이 남아 있음');
  materialHref = await alice.locator('.fileitem a.btn--primary').first().getAttribute('href');
  const res = await alice.request.get(origin + materialHref);
  if (res.status() !== 200) throw new Error(`status ${res.status()}`);
});

await step('로그인하지 않으면 그 주소로도 못 받음', async () => {
  const stranger = await browser.newContext();
  const res = await stranger.request.get(origin + materialHref);
  if (res.status() !== 401) throw new Error(`status ${res.status()}`);
  await stranger.close();
});

log('\n== 6-2. 소통방 ==');

await step('회원이 글을 남기면 서버에 저장됨', async () => {
  await alice.goto(`${origin}/#/board/new`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('#postForm', { timeout: 8000 });
  await alice.fill('#postForm [name="title"]', '스터디 같이 하실 분');
  await alice.fill('#postForm [name="body"]', '주 1회 온라인으로 모이려 합니다.');
  await alice.locator('#postForm button[type="submit"]').click();
  await alice.waitForURL(/#\/board\/b_[a-z0-9]+$/, { timeout: 15000 });

  const raw = new TextDecoder().decode(bucket.objects.get('data/posts.json').bytes);
  if (!raw.includes('스터디 같이 하실 분')) throw new Error('R2 에 저장되지 않음');
  if (!raw.includes('alice@example.com')) throw new Error('글쓴이가 서버에서 안 채워짐');
});

await step('다른 회원이 댓글을 달면 글쓴이에게도 보임', async () => {
  await bob.goto(`${origin}/#/board`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.post', { timeout: 10000 });
  await bob.locator('.post').first().click();
  await bob.waitForSelector('#commentForm', { timeout: 8000 });
  await bob.fill('#commentForm [name="body"]', '저도 참여하고 싶습니다.');
  await bob.locator('#commentForm button[type="submit"]').click();
  await bob.waitForSelector('.comment', { timeout: 10000 });

  await alice.reload({ waitUntil: 'networkidle' });
  await alice.waitForSelector('.comment', { timeout: 10000 });
  const text = await alice.locator('.comment__body').first().innerText();
  if (!text.includes('저도 참여하고')) throw new Error(text);
});

await step('남의 글에는 수정·삭제·공지 버튼이 없음', async () => {
  if (await bob.locator('[data-del]').count()) throw new Error('삭제 버튼이 보임');
  if (await bob.locator('[data-pin]').count()) throw new Error('공지 버튼이 보임');
});

await step('관리자가 공지로 지정하면 맨 위로', async () => {
  await admin.goto(`${origin}/#/board/new`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#postForm', { timeout: 8000 });
  await admin.fill('#postForm [name="title"]', '더 최근 글');
  await admin.fill('#postForm [name="body"]', '공지보다 나중에 쓴 글입니다.');
  await admin.locator('#postForm button[type="submit"]').click();
  await admin.waitForURL(/#\/board\/b_[a-z0-9]+$/, { timeout: 15000 });

  await admin.goto(`${origin}/#/board`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.post', { timeout: 10000 });
  await admin.locator('.post', { hasText: '스터디 같이' }).click();
  await admin.waitForSelector('[data-pin]', { timeout: 8000 });
  await admin.locator('[data-pin]').click();
  await admin.waitForTimeout(1500);

  await bob.goto(`${origin}/#/board`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.post', { timeout: 10000 });
  const first = await bob.locator('.post').first().innerText();
  if (!first.includes('스터디 같이')) throw new Error(first.split('\n')[0]);
  if (!(await bob.locator('.post--pinned').count())) throw new Error('공지 표시 없음');
});

log('\n== 7. 회원 관리 ==');

await step('관리자만 회원 목록을 볼 수 있음', async () => {
  await alice.goto(`${origin}/#/admin/members`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.notice--warn', { timeout: 8000 });

  await admin.goto(`${origin}/#/admin/members`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#memberRows .table tbody tr', { timeout: 10000 });
  const text = await admin.locator('#memberRows').innerText();
  for (const who of ['alice@example.com', 'bob@example.com']) {
    if (!text.includes(who)) throw new Error(`${who} 없음`);
  }
});

await step('이용 정지하면 그 회원의 세션이 끊김', async () => {
  const row = admin.locator('tr', { hasText: 'bob@example.com' });
  await row.locator('[data-status]').click();
  await admin.locator('.modal [data-ok]').click();
  await admin.waitForTimeout(1500);

  await bob.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.empty h3', { timeout: 10000 });
  const title = await bob.locator('.empty h3').innerText();
  if (!title.includes('로그인')) throw new Error(title);
});

log('\n== 8. 계정 ==');

await step('내 계정에서 비밀번호 변경', async () => {
  await alice.goto(`${origin}/#/account`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('#pwForm', { timeout: 8000 });
  await alice.fill('#pwForm [name="current"]', PASSWORD);
  await alice.fill('#pwForm [name="next"]', 'brand-new-pass1');
  await alice.fill('#pwForm [name="confirm"]', 'brand-new-pass1');
  await alice.locator('#pwForm button[type="submit"]').click();
  await alice.waitForSelector('.toast--ok', { timeout: 10000 });
});

await step('새 비밀번호로 다시 로그인됨', async () => {
  const again = await person('앨리스2');
  await again.goto(`${origin}/#/login`, { waitUntil: 'networkidle' });
  await again.fill('#loginForm [name="email"]', 'alice@example.com');
  await again.fill('#loginForm [name="password"]', 'brand-new-pass1');
  await again.locator('#loginForm button[type="submit"]').click();
  await again.waitForSelector('.tile, .empty', { timeout: 12000 });
  await again.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await again.waitForSelector('.table tbody tr, .empty h3', { timeout: 10000 });
  await again.context().close();
});

await step('로그아웃하면 다시 로그인 벽', async () => {
  await alice.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  await alice.locator('.gnav__actions [data-logout]').click();
  await alice.waitForSelector('.empty h3, #loginForm', { timeout: 10000 });
});

log('\n== 9. 콘솔 오류 ==');
await step('실행 중 자바스크립트 오류 없음', () => {
  if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(' | '));
});

await browser.close();
server.close();

log('\n================ 결과 ================');
log(`버킷 객체 ${bucket.objects.size}개`);
if (fails.length) { log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
log('모든 검사 통과');
