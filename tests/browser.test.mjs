/**
 * 데모(브라우저 저장) 모드 UI 흐름 검사.
 *
 * 회원제로 바뀐 뒤의 화면 흐름을 훑습니다 — 가입 → 제출 → 조회/수정 →
 * 관리자(자동 승격) → 강의자료 → 회원 관리 → 라우팅·반응형.
 * 서버 인증의 진짜 동작은 auth.test.mjs / r2-browser.test.mjs 가 봅니다.
 */
import { chromium } from 'playwright';
import { existsSync } from 'fs';

const BASE = 'http://localhost:8899';
const errors = [];
const log = (...a) => console.log(...a);

const ADMIN = { email: 'aireader@mois.go.kr', password: 'dlrhd26!!', name: '관리자', inst: '행정안전부' };
const USER = { email: 'hong@example.com', password: 'hong-pass-2026', name: '홍길동', inst: '한국디자인진흥원' };

// 이 환경에는 Chromium 이 미리 깔려 있습니다. 다른 곳에서는 CHROME_PATH 로 지정하거나
// 이 옵션을 지우고 `npx playwright install chromium` 을 쓰세요.
const executablePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// 이 묶음은 UI 흐름 검증용이라 브라우저 저장 모드로 고정합니다.
// (R2 경로는 r2.test.mjs 와 r2-browser.test.mjs 가 담당합니다.)
await ctx.addInitScript(() => {
  try { localStorage.setItem('ah.storageMode', 'local'); } catch { /* ignore */ }
});
const page = await ctx.newPage();

page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.location()?.url || '')) errors.push(`console: ${m.text()} @ ${m.location()?.url}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function step(name, fn) {
  try { await fn(); log(`  PASS  ${name}`); }
  catch (e) { log(`  FAIL  ${name} — ${e.message}`); errors.push(`${name}: ${e.message}`); }
}

/** 폼에 값을 채우고 제출합니다. */
async function submitForm(sel, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'boolean') await page.setChecked(`${sel} [name="${name}"]`, value);
    else await page.fill(`${sel} [name="${name}"]`, value);
  }
  await page.locator(`${sel} button[type="submit"]`).click();
}

async function signup({ email, password, name, inst }) {
  await page.goto(`${BASE}#/signup`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signupForm', { timeout: 5000 });
  await submitForm('#signupForm', {
    institution: inst, name, email, password, confirm: password, agree: true,
  });
  await page.waitForSelector('.hero__title', { timeout: 8000 });
}

/** confirmModal 의 확인 버튼을 누릅니다. */
async function confirmOk() {
  await page.waitForSelector('.modal [data-ok]', { timeout: 5000 });
  await page.locator('.modal [data-ok]').click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
}

async function logout() {
  await page.locator('#gnavActions [data-logout]').click();
  await page.waitForSelector('#gnavActions a[href="#/signup"]', { timeout: 5000 });
}

/* ============================================================ 1. 비회원 == */

log('\n== 1. 로그인 전 ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await step('비회원도 홈 화면 자체는 보임 (목록만 가려짐)', async () => {
  await page.waitForSelector('.hero__title', { timeout: 6000 });
  await page.waitForSelector('#projects', { timeout: 6000 });
  if (await page.locator('.tile').count()) throw new Error('과제 목록이 노출됨');
  const t = await page.locator('#projectGrid .empty h3').innerText();
  if (!t.includes('로그인이 필요합니다')) throw new Error(t);
});
await step('히어로와 목록 자리에 로그인 버튼', async () => {
  const hero = page.locator('.hero a[href="#/login"]');
  if (!(await hero.count())) throw new Error('히어로에 로그인 버튼 없음');
  if ((await hero.first().innerText()).trim() !== '로그인 하기') {
    throw new Error(await hero.first().innerText());
  }
  if (!(await page.locator('#projectGrid a[href="#/login"]').count())) {
    throw new Error('목록 자리에 로그인 버튼 없음');
  }
});
await step('히어로 문구가 로그인 안내로 바뀜', async () => {
  const lead = await page.locator('.hero__lead').innerText();
  if (!lead.includes('과제 제출과 강의자료는 로그인이 필요합니다')) throw new Error(lead);
  if (lead.includes('마감 전까지는')) throw new Error('예전 문구가 남아 있음');
});
await step('헤더에 로그인 · 회원가입 버튼', async () => {
  if (!(await page.locator('#gnavActions a[href="#/login"]').count())) throw new Error('로그인 버튼 없음');
  if (!(await page.locator('#gnavActions a[href="#/signup"]').count())) throw new Error('회원가입 버튼 없음');
});
await step('회원 전용 메뉴는 감춰지고 홈·이용안내는 남음', async () => {
  const materials = page.locator('.gnav__links a[data-nav="materials"]');
  if (!(await materials.isHidden())) throw new Error('강의자료 메뉴가 보임');
  if (!(await page.locator('.gnav__links a[data-nav="my"]').isHidden())) {
    throw new Error('내 제출물 메뉴가 보임');
  }
  for (const nav of ['home', 'guide']) {
    if (!(await page.locator(`.gnav__links a[data-nav="${nav}"]`).isVisible())) {
      throw new Error(`${nav} 메뉴는 보여야 함`);
    }
  }
});
await step('주소로 직접 들어가도 강의자료가 막힘', async () => {
  await page.goto(`${BASE}#/materials`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.empty h3', { timeout: 5000 });
  if (await page.locator('.material').count()) throw new Error('자료가 노출됨');
});
await step('이용안내는 로그인 없이 열람', async () => {
  await page.goto(`${BASE}#/guide`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.expander', { timeout: 5000 });
});
await step('가입 화면에 시연용 안내가 표시', async () => {
  await page.goto(`${BASE}#/signup`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signupForm', { timeout: 5000 });
  const notice = await page.locator('.notice--warn').first().innerText();
  if (!notice.includes('시연용')) throw new Error(notice);
});

/* ============================================================= 2. 가입 == */

log('\n== 2. 회원가입 ==');
await step('빈 값이면 항목별 오류', async () => {
  await page.locator('#signupForm button[type="submit"]').click();
  await page.waitForSelector('.field__err', { timeout: 3000 });
  const n = await page.locator('.field__err').count();
  if (n < 4) throw new Error(`오류 표시 ${n}건`);
});
await step('짧은 비밀번호 거부', async () => {
  await submitForm('#signupForm', {
    institution: USER.inst, name: USER.name, email: USER.email,
    password: 'short', confirm: 'short', agree: true,
  });
  await page.waitForTimeout(400);
  const err = await page.locator('[name="password"] ~ .field__err, .field__err').allInnerTexts();
  if (!err.some((t) => t.includes('8자'))) throw new Error(err.join(' / '));
});
await step('비밀번호 확인이 다르면 거부', async () => {
  await submitForm('#signupForm', {
    password: USER.password, confirm: `${USER.password}x`, agree: true,
  });
  await page.waitForTimeout(400);
  const err = await page.locator('.field__err').allInnerTexts();
  if (!err.some((t) => t.includes('서로 다릅니다'))) throw new Error(err.join(' / '));
});
await step('동의하지 않으면 거부', async () => {
  await submitForm('#signupForm', { confirm: USER.password, agree: false });
  await page.waitForTimeout(400);
  const err = await page.locator('.field__err').allInnerTexts();
  if (!err.some((t) => t.includes('동의'))) throw new Error(err.join(' / '));
});
await step('가입하면 바로 홈으로', async () => {
  await submitForm('#signupForm', { agree: true });
  await page.waitForSelector('.hero__title', { timeout: 8000 });
  const who = await page.locator('#gnavActions a[href="#/account"]').innerText();
  if (!who.includes(USER.name)) throw new Error(who);
});
await step('같은 이메일로 다시 가입하면 거부', async () => {
  await logout();
  await page.goto(`${BASE}#/signup`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signupForm', { timeout: 5000 });
  await submitForm('#signupForm', {
    institution: USER.inst, name: USER.name, email: USER.email,
    password: USER.password, confirm: USER.password, agree: true,
  });
  await page.waitForSelector('.field__err', { timeout: 4000 });
  const err = await page.locator('.field__err').first().innerText();
  if (!err.includes('이미 가입')) throw new Error(err);
});

/* ============================================================= 3. 로그인 == */

log('\n== 3. 로그인 ==');
await step('틀린 비밀번호는 같은 문구로 거부', async () => {
  await page.goto(`${BASE}#/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 5000 });
  await submitForm('#loginForm', { email: USER.email, password: 'wrong-password' });
  await page.waitForSelector('.field__err', { timeout: 4000 });
  const err = await page.locator('.field__err').first().innerText();
  if (!err.includes('이메일 또는 비밀번호')) throw new Error(err);
});
await step('없는 계정도 같은 문구 (계정 존재가 새지 않음)', async () => {
  await submitForm('#loginForm', { email: 'nobody@example.com', password: 'whatever12' });
  await page.waitForTimeout(600);
  const err = await page.locator('.field__err').first().innerText();
  if (!err.includes('이메일 또는 비밀번호')) throw new Error(err);
});
await step('로그인 성공', async () => {
  await submitForm('#loginForm', { email: USER.email, password: USER.password });
  await page.waitForSelector('.hero__title', { timeout: 8000 });
});
await step('로그인하면 회원 메뉴가 나타남', async () => {
  if (!(await page.locator('.gnav__links a[data-nav="materials"]').isVisible())) {
    throw new Error('강의자료 메뉴가 안 보임');
  }
  if (!(await page.locator('.gnav__links a[data-nav="my"]').isVisible())) {
    throw new Error('내 제출물 메뉴가 안 보임');
  }
});
await step('로그인 뒤 next 경로로 돌아감', async () => {
  await logout();
  await page.goto(`${BASE}#/login?next=/materials`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 5000 });
  await submitForm('#loginForm', { email: USER.email, password: USER.password });
  await page.waitForURL(/#\/materials/, { timeout: 8000 });
});
await step('외부 주소는 next 로 안 먹힘', async () => {
  await logout();
  await page.goto(`${BASE}#/login?next=${encodeURIComponent('https://evil.example.com')}`,
    { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 5000 });
  await submitForm('#loginForm', { email: USER.email, password: USER.password });
  await page.waitForSelector('.hero__title', { timeout: 8000 });
  if (!page.url().startsWith(BASE)) throw new Error(page.url());
});

/* ============================================================== 4. 홈 == */

log('\n== 4. 홈 ==');
await step('시드 프로젝트 2건 표시', async () => {
  await page.waitForSelector('.tile', { timeout: 5000 });
  const n = await page.locator('.tile').count();
  if (n !== 2) throw new Error(`tile count = ${n}`);
});
await step('히어로 문구가 새 문구로 표시', async () => {
  const t = await page.locator('.hero__title').innerText();
  if (!t.includes('여기에서 과제를 제출하고') || !t.includes('강의자료를 받을 수 있습니다')) {
    throw new Error(t);
  }
});
await step('안내 제목이 "과제 제출 방법"', async () => {
  const h = await page.locator('.band h2').first().innerText();
  if (h.trim() !== '과제 제출 방법') throw new Error(h);
  const steps = await page.locator('.step h3').allInnerTexts();
  const want = ['회원가입', '제출할 과제 목록 선택', '과제 내용'];
  if (JSON.stringify(steps) !== JSON.stringify(want)) throw new Error(steps.join(' / '));
});
await step('프로젝트 그리드가 한 행에 2개', async () => {
  const cols = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length);
  if (cols !== 2) throw new Error(`컬럼 ${cols}개`);
});
await step('"진행중 프로젝트 보기"가 목록으로 스크롤 (404 아님)', async () => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('[data-scroll-projects]').click();
  await page.waitForTimeout(900);
  if (!(await page.locator('.tile').first().isVisible())) throw new Error('스크롤 안 됨');
  if (await page.locator('.empty h3').count()) throw new Error('404 화면이 떴음');
  if (page.url().endsWith('#projects')) throw new Error('해시가 오염됨');
});

/* ============================================================ 5. 제출 == */

log('\n== 5. 제출 플로우 ==');
let projectTitle = '';
await step('프로젝트 상세 → 제출 화면', async () => {
  projectTitle = (await page.locator('.tile__title').first().innerText()).trim();
  await page.locator('.tile').first().click();
  await page.waitForSelector('h1', { timeout: 5000 });
  await page.getByRole('link', { name: '과제 제출하기' }).click();
  await page.waitForSelector('#submitForm', { timeout: 5000 });
});
await step('제출자 정보를 다시 묻지 않음', async () => {
  if (await page.locator('#submitForm [name="email"]').count()) throw new Error('이메일 입력칸이 남아 있음');
  if (await page.locator('[data-next]').count()) throw new Error('단계 버튼이 남아 있음');
  const who = await page.locator('.card--flat').first().innerText();
  if (!who.includes(USER.name) || !who.includes(USER.email) || !who.includes(USER.inst)) {
    throw new Error(who);
  }
});
await step('빈 값이면 막힘', async () => {
  await page.locator('#submitForm button[type="submit"]').click();
  await page.waitForSelector('.field__err', { timeout: 3000 });
  if (/#\/s\//.test(page.url())) throw new Error('빈 값으로 제출됨');
});
await step('파일 첨부 (이미지)', async () => {
  await page.setInputFiles('[data-input]', {
    name: 'poster.png',
    mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
      '01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'),
  });
  await page.waitForSelector('.fileitem', { timeout: 3000 });
});
await step('거부: 허용되지 않는 확장자', async () => {
  await page.setInputFiles('[data-input]', {
    name: 'evil.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ'),
  });
  await page.waitForSelector('.toast--err', { timeout: 3000 });
  const n = await page.locator('.fileitem').count();
  if (n !== 1) throw new Error(`fileitem count = ${n}, 확장자 거부 실패`);
});
await step('동의 없으면 막힘', async () => {
  await page.fill('#submitForm [name="title"]', '스타벅스 디자인 시스템 분석');
  await page.fill('#submitForm [name="body"]', '색상 4단계 그린 체계와 50px 필 버튼을 정리했습니다.');
  await page.locator('#submitForm button[type="submit"]').click();
  await page.waitForTimeout(400);
  if (/#\/s\//.test(page.url())) throw new Error('동의 없이 제출됨');
});
await step('제출 성공 → 상세로 이동', async () => {
  await page.check('#submitForm [name="agree"]');
  await page.locator('#submitForm button[type="submit"]').click();
  await page.waitForURL(/#\/s\//, { timeout: 8000 });
  await page.waitForSelector('.page-title', { timeout: 5000 });
  const t = await page.locator('.page-title').first().innerText();
  if (!t.includes('스타벅스')) throw new Error(t);
});
await step('제출자가 로그인한 회원으로 기록됨', async () => {
  const text = await page.locator('.wrap').first().innerText();
  if (!text.includes(USER.name) || !text.includes(USER.inst)) throw new Error(text.slice(0, 200));
});

/* ==================================================== 6. 내 제출물 == */

log('\n== 6. 내 제출물 / 수정 ==');
await step('코드 입력 없이 바로 목록이 보임', async () => {
  await page.goto(`${BASE}#/my`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.table tbody tr', { timeout: 6000 });
  if (await page.locator('#unlockForm').count()) throw new Error('수정코드 폼이 남아 있음');
  const n = await page.locator('.table tbody tr').count();
  if (n !== 1) throw new Error(`행 ${n}개`);
});
await step('제출물 수정', async () => {
  await page.locator('.table tbody tr a[href*="/s/"]').first().click();
  await page.waitForSelector('.page-title', { timeout: 5000 });
  await page.getByRole('link', { name: '수정' }).first().click();
  await page.waitForSelector('#editForm', { timeout: 5000 });
  await page.fill('#editForm [name="title"]', '수정된 제목입니다');
  await page.locator('#editForm button[type="submit"]').click();
  await page.waitForURL((u) => /#\/s\//.test(u.href) && !u.href.includes('/edit'), { timeout: 8000 });
  await page.waitForFunction(
    () => document.querySelector('.page-title')?.textContent.includes('수정된 제목'),
    null, { timeout: 6000 });
});
await step('첨부 이미지가 렌더됨', async () => {
  await page.waitForSelector('.media-card img', { timeout: 5000 });
});
await step('다른 회원의 제출물은 목록에 안 보임', async () => {
  const other = { email: 'kim@example.com', password: 'kim-pass-2026', name: '김철수', inst: '한국정보화진흥원' };
  await logout();
  await signup(other);
  await page.goto(`${BASE}#/my`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.empty h3', { timeout: 6000 });
  const t = await page.locator('.empty h3').innerText();
  if (!t.includes('아직 제출한 과제가 없습니다')) throw new Error(t);
});
await step('일반 회원은 관리자 화면을 못 봄', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.notice--warn', { timeout: 5000 });
  const t = await page.locator('.notice--warn').first().innerText();
  if (!t.includes('관리자만')) throw new Error(t);
  if (await page.locator('.stat').count()) throw new Error('대시보드가 노출됨');
});

/* ========================================================== 7. 관리자 == */

log('\n== 7. 관리자 ==');
await step('설정된 이메일로 가입하면 자동으로 관리자', async () => {
  await logout();
  await signup(ADMIN);
  await page.waitForSelector('#gnavActions a[href="#/admin"]', { timeout: 5000 });
});
await step('대시보드 통계', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.stat', { timeout: 6000 });
  const stats = await page.locator('.stat__v').allInnerTexts();
  log(`        통계: ${stats.join(' / ')}`);
  if (stats[2] !== '1') throw new Error(`총 제출물 = ${stats[2]}`);
  if (stats[6] !== '3') throw new Error(`회원 = ${stats[6]}`);
});
await step('프로젝트 개설', async () => {
  await page.goto(`${BASE}#/admin/project/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#projForm', { timeout: 5000 });
  await page.fill('#projForm [name="title"]', '3주차 · 최종 발표자료');
  await page.fill('#projForm [name="description"]', '최종 발표용 슬라이드를 제출하세요.');
  await page.locator('#projForm button[type="submit"]').click();
  await page.waitForURL(/#\/p\//, { timeout: 6000 });
});
await step('제출물 관리 화면 + 검색', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#adminProjects .table', { timeout: 6000 });
  await page.locator('a[href*="/admin/submissions/"]').first().click();
  await page.waitForSelector('.toolbar', { timeout: 5000 });
});
await step('관리자는 남의 제출물도 열람', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#adminProjects .table', { timeout: 6000 });
  await page.locator('#adminProjects tbody tr', { hasText: projectTitle })
    .locator('a[href*="/admin/submissions/"]').first().click();
  // 대시보드에도 .table 이 있으므로, 이 화면에만 있는 #rows 가 그려질 때까지 기다립니다.
  await page.waitForURL(/#\/admin\/submissions\//, { timeout: 6000 });
  await page.waitForSelector('#rows .table tbody tr, #rows .empty', { timeout: 6000 });
  const rows = await page.locator('#rows .table tbody tr').count();
  if (!rows) throw new Error(`"${projectTitle}" 제출물이 안 보임`);
  const text = await page.locator('#rows .table tbody').innerText();
  if (!text.includes(USER.name) || !text.includes(USER.email)) throw new Error(text.slice(0, 200));
});

/* ====================================================== 8. 회원 관리 == */

log('\n== 8. 회원 관리 ==');
await step('회원 목록에 3명', async () => {
  await page.goto(`${BASE}#/admin/members`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.table tbody tr', { timeout: 6000 });
  const n = await page.locator('.table tbody tr').count();
  if (n !== 3) throw new Error(`회원 ${n}명`);
});
await step('비밀번호 해시는 화면 어디에도 없음', async () => {
  const html = await page.content();
  if (/pbkdf2\$/.test(html)) throw new Error('해시가 노출됨');
});
await step('검색으로 걸러짐', async () => {
  await page.fill('#q', '홍길동');
  await page.waitForTimeout(400);
  const n = await page.locator('.table tbody tr').count();
  if (n !== 1) throw new Error(`검색 결과 ${n}건`);
  await page.fill('#q', '');
  await page.waitForTimeout(400);
});
await step('본인 계정에는 조작 버튼이 없음', async () => {
  const row = page.locator('.table tbody tr', { hasText: ADMIN.email });
  const t = await row.innerText();
  if (!t.includes('본인')) throw new Error(t);
  if (await row.locator('[data-status]').count()) throw new Error('본인 정지 버튼이 있음');
});
await step('회원을 관리자로 승격했다가 되돌림', async () => {
  await page.locator('.table tbody tr', { hasText: USER.email }).locator('[data-role]').click();
  await confirmOk();
  await page.waitForTimeout(500);
  const row = () => page.locator('.table tbody tr', { hasText: USER.email });
  if (!(await row().locator('.badge--gold').count())) throw new Error(await row().innerText());

  await row().locator('[data-role]').click();
  await confirmOk();
  await page.waitForTimeout(500);
  if (await row().locator('.badge--gold').count()) throw new Error(await row().innerText());
});
await step('비밀번호 초기화로 임시 비밀번호 발급', async () => {
  await page.locator('.table tbody tr', { hasText: 'kim@example.com' }).locator('[data-reset]').click();
  await confirmOk();                       // "초기화할까요?"
  await page.waitForSelector('.modal', { timeout: 5000 });
  const text = await page.locator('.modal').innerText();
  if (!text.includes('임시 비밀번호')) throw new Error(text.slice(0, 120));
  if (!text.includes('kim@example.com')) throw new Error(text.slice(0, 120));
  const m = text.match(/[A-Za-z2-9]{12}/);
  if (!m) throw new Error(text.slice(0, 200));
  log(`        임시 비밀번호: ${m[0]}`);
  await confirmOk();
});
await step('이용 정지하면 로그인이 막힘', async () => {
  await page.goto(`${BASE}#/admin/members`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.table tbody tr', { timeout: 6000 });
  await page.locator('.table tbody tr', { hasText: 'kim@example.com' })
    .locator('[data-status]').click();
  await confirmOk();
  await page.waitForTimeout(500);
  const after = await page.locator('.table tbody tr', { hasText: 'kim@example.com' }).innerText();
  if (!after.includes('정지')) throw new Error(after);

  await logout();
  await page.goto(`${BASE}#/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 5000 });
  await submitForm('#loginForm', { email: 'kim@example.com', password: 'kim-pass-2026' });
  await page.waitForSelector('.field__err', { timeout: 5000 });
  const err = await page.locator('.field__err').first().innerText();
  if (!err.includes('정지')) throw new Error(err);
});

/* ====================================================== 9. 강의자료 == */

log('\n== 9. 강의자료 ==');
await step('관리자로 다시 로그인', async () => {
  await submitForm('#loginForm', { email: ADMIN.email, password: ADMIN.password });
  await page.waitForSelector('.hero__title', { timeout: 8000 });
});
await step('관리자가 PDF 자료 등록', async () => {
  await page.goto(`${BASE}#/admin/material/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#matForm', { timeout: 5000 });
  await page.fill('#matForm [name="title"]', '1강 · AI 리더십 개론');
  await page.fill('#matForm [name="session"]', '1주차');
  await page.fill('#matForm [name="description"]', '수업에서 사용한 슬라이드입니다.');
  await page.setInputFiles('#matPicker [data-input]', {
    name: '1강_AI리더십개론.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%강의자료\n'),
  });
  await page.waitForSelector('#matPicker .fileitem', { timeout: 3000 });
  await page.locator('#matForm button[type="submit"]').click();
  await page.waitForURL(/#\/materials/, { timeout: 8000 });
});
await step('강의자료에 PDF 아닌 파일은 거부', async () => {
  await page.goto(`${BASE}#/admin/material/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#matPicker', { timeout: 5000 });
  await page.setInputFiles('#matPicker [data-input]', {
    name: '사진.png', mimeType: 'image/png', buffer: Buffer.from('89504e47', 'hex'),
  });
  await page.waitForSelector('.toast--err', { timeout: 3000 });
  if (await page.locator('#matPicker .fileitem').count()) throw new Error('거부 실패');
});
await step('파일도 링크도 없으면 저장이 막힘', async () => {
  await page.fill('#matForm [name="title"]', '내용 없는 자료');
  await page.locator('#matForm button[type="submit"]').click();
  await page.waitForSelector('.field__err', { timeout: 3000 });
  if (page.url().includes('#/materials')) throw new Error('빈 자료가 저장됨');
});
await step('설명에 주소만 있으면 파일 없이도 저장됨', async () => {
  await page.fill('#matForm [name="title"]', '3강 · 온라인 강의 영상');
  await page.fill('#matForm [name="session"]', '3주차');
  await page.fill('#matForm [name="description"]',
    '녹화본은 https://example.com/lecture?id=3&t=10 에서 볼 수 있습니다.');
  await page.locator('#matForm button[type="submit"]').click();
  await page.waitForURL(/#\/materials/, { timeout: 8000 });
});
await step('강의자료 목록이 한 행에 2칸', async () => {
  await page.waitForSelector('.material', { timeout: 8000 });
  const cols = await page.evaluate(() =>
    getComputedStyle(document.querySelector('#materialList .grid'))
      .gridTemplateColumns.split(' ').length);
  if (cols !== 2) throw new Error(`컬럼 ${cols}개`);
});
await step('설명 속 주소가 새 창 링크로 변환됨', async () => {
  const a = page.locator('.material__desc a').first();
  if (!(await a.count())) throw new Error('링크가 만들어지지 않음');
  if (await a.getAttribute('target') !== '_blank') throw new Error('새 창이 아님');
  if (!(await a.getAttribute('rel') || '').includes('noopener')) throw new Error('rel 누락');
  const href = await a.getAttribute('href');
  if (href !== 'https://example.com/lecture?id=3&t=10') throw new Error(`href = ${href}`);
});
await step('"바로가기" 버튼이 새 창으로 열림', async () => {
  const go = page.locator('.material a.btn--outline', { hasText: '바로가기' }).first();
  if (!(await go.count())) throw new Error('바로가기 버튼 없음');
  if (await go.getAttribute('target') !== '_blank') throw new Error('새 창이 아님');
  if (await go.getAttribute('href') !== 'https://example.com/lecture?id=3&t=10') {
    throw new Error(await go.getAttribute('href'));
  }
});
await step('설명의 HTML 은 주입되지 않고 글자로 표시', async () => {
  await page.goto(`${BASE}#/admin/material/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#matForm', { timeout: 5000 });
  await page.fill('#matForm [name="title"]', '주입 시험');
  await page.fill('#matForm [name="description"]',
    '<img src=x onerror=alert(1)> 그리고 https://safe.example.com');
  await page.locator('#matForm button[type="submit"]').click();
  await page.waitForURL(/#\/materials/, { timeout: 8000 });
  await page.waitForSelector('.material__desc', { timeout: 8000 });
  const injected = await page.locator('.material__desc img').count();
  if (injected) throw new Error('HTML 이 주입됨');
  const text = await page.locator('.material__desc').first().innerText();
  if (!text.includes('<img')) throw new Error(`원문이 글자로 안 보임: ${text}`);
});
await step('비밀번호 잠금 화면이 사라짐', async () => {
  await page.goto(`${BASE}#/materials`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.fileitem', { timeout: 6000 });
  if (await page.locator('#gateForm').count()) throw new Error('잠금 폼이 남아 있음');
});
await step('일반 회원도 내려받기 링크를 봄', async () => {
  await logout();
  await page.goto(`${BASE}#/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 5000 });
  await submitForm('#loginForm', { email: USER.email, password: USER.password });
  await page.waitForSelector('.hero__title', { timeout: 8000 });
  await page.goto(`${BASE}#/materials`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.fileitem', { timeout: 6000 });
  const name = await page.locator('.fileitem__name').first().innerText();
  if (!name.includes('1강_AI리더십개론.pdf')) throw new Error(name);
  const dl = page.locator('.fileitem a.btn--primary').first();
  if (!(await dl.isVisible())) throw new Error('내려받기 버튼 없음');
  const href = await dl.getAttribute('href');
  if (!href || !href.startsWith('blob:')) throw new Error(`href = ${href}`);
});
await step('일반 회원에게 자료 등록 버튼이 없음', async () => {
  if (await page.locator('a[href="#/admin/material/new"]').count()) {
    throw new Error('등록 버튼이 노출됨');
  }
});

/* ======================================================= 10. 내 계정 == */

log('\n== 10. 내 계정 ==');
await step('내 정보가 표시됨', async () => {
  await page.goto(`${BASE}#/account`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.kv', { timeout: 5000 });
  const t = await page.locator('.kv').first().innerText();
  if (!t.includes(USER.email) || !t.includes(USER.inst)) throw new Error(t);
});
await step('현재 비밀번호가 틀리면 변경 거부', async () => {
  await submitForm('#pwForm', { current: 'wrong-password', next: 'new-pass-2026', confirm: 'new-pass-2026' });
  await page.waitForSelector('.field__err', { timeout: 4000 });
});
await step('비밀번호 변경 후 새 비밀번호로 로그인', async () => {
  await submitForm('#pwForm', {
    current: USER.password, next: 'new-pass-2026', confirm: 'new-pass-2026',
  });
  await page.waitForSelector('.toast--ok', { timeout: 5000 });

  await logout();
  await page.goto(`${BASE}#/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 5000 });
  await submitForm('#loginForm', { email: USER.email, password: USER.password });
  await page.waitForSelector('.field__err', { timeout: 5000 });

  await submitForm('#loginForm', { email: USER.email, password: 'new-pass-2026' });
  await page.waitForSelector('.hero__title', { timeout: 8000 });
});
await step('로그아웃하면 로그인 화면으로', async () => {
  await logout();
  await page.waitForSelector('#loginForm', { timeout: 5000 });
});
await step('로그아웃 뒤 새로고침해도 로그인 상태가 안 살아남', async () => {
  await page.goto(`${BASE}#/my`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.empty h3', { timeout: 5000 });
  const t = await page.locator('.empty h3').innerText();
  if (!t.includes('로그인이 필요합니다')) throw new Error(t);
});
await step('로그인하면 홈에 목록이 나오고, 로그아웃하면 다시 가려짐', async () => {
  await page.goto(`${BASE}#/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 5000 });
  await submitForm('#loginForm', { email: USER.email, password: 'new-pass-2026' });
  await page.waitForSelector('.tile', { timeout: 8000 });

  await logout();                                   // 로그아웃하면 로그인 화면으로 갑니다
  await page.goto(`${BASE}#/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#projectGrid .empty h3', { timeout: 6000 });
  if (await page.locator('.tile').count()) throw new Error('목록이 그대로 남아 있음');
});

/* =================================================== 11. 라우팅/반응형 == */

log('\n== 11. 라우팅 / 반응형 ==');
await step('로그인 후 404 처리', async () => {
  await page.goto(`${BASE}#/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loginForm', { timeout: 5000 });
  await submitForm('#loginForm', { email: 'new-user@example.com', password: 'x' });
  await page.waitForTimeout(300);
  await page.goto(`${BASE}#/login`, { waitUntil: 'networkidle' });
  await submitForm('#loginForm', { email: USER.email, password: 'new-pass-2026' });
  await page.waitForSelector('.hero__title', { timeout: 8000 });

  await page.goto(`${BASE}#/does-not-exist`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.empty h3', { timeout: 4000 });
  const t = await page.locator('.empty h3').innerText();
  if (t.includes('로그인이 필요합니다')) throw new Error('로그인 벽이 404 를 가림');
});
await step('이용안내 아코디언', async () => {
  await page.goto(`${BASE}#/guide`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.expander', { timeout: 4000 });
  await page.locator('.expander__btn').nth(1).click();
  await page.waitForTimeout(400);
  const open = await page.locator('.expander').nth(1).getAttribute('data-open');
  if (open !== 'true') throw new Error('아코디언이 열리지 않음');
});
await step('모바일 뷰포트 — 가로 스크롤 없음', async () => {
  await page.setViewportSize({ width: 375, height: 780 });
  await page.goto(`${BASE}#/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`가로 오버플로 ${overflow}px`);
});
await step('모바일 드로어는 처음에 닫혀 있음', async () => {
  if (!(await page.locator('#gnavDrawer').isHidden())) throw new Error('서랍이 열린 채로 뜸');
});
await step('모바일 드로어 열고 닫기', async () => {
  await page.locator('#gnavBurger').click();
  await page.waitForSelector('#gnavDrawer:not([hidden])', { timeout: 3000 });
  if (!(await page.locator('#gnavDrawer').isVisible())) throw new Error('서랍이 안 보임');
  const t = await page.locator('#gnavDrawerActions').innerText();
  if (!/로그아웃|로그인/.test(t)) throw new Error(t);

  await page.locator('#gnavBurger').click();
  await page.waitForSelector('#gnavDrawer', { state: 'hidden', timeout: 3000 });
});

await browser.close();

log('\n================ 결과 ================');
if (errors.length) { log(`실패/오류 ${errors.length}건:`); errors.forEach((e) => log(' - ' + e)); process.exit(1); }
log('모든 검사 통과');
