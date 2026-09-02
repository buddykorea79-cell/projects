/** 앱 진입점 — 저장소 초기화, 로그인 가드, 라우팅, 전역 크롬(헤더/푸터/Frap). */
import { CONFIG, STORAGE_LABEL } from './config.js';
import { initStore, currentMode, submissionOpen, store } from './store/index.js';
import { currentUser, isAdmin, isSignedIn, logout } from './auth.js';
import { $, esc, attr } from './utils.js';
import { toastErr, toastOk, emptyState } from './ui.js';
import * as R from './router.js';

import { homeView } from './views/home.js';
import { projectView, submitView } from './views/project.js';
import { myView, submissionView, editSubmissionView } from './views/my.js';
import { guideView } from './views/guide.js';
import { materialsView } from './views/materials.js';
import { boardView, postView, postFormView } from './views/board.js';
import { loginView, signupView, accountView, forgotView, resetView } from './views/account.js';
import {
  adminView, projectFormView, adminSubmissionsView, materialFormView, membersView,
} from './views/admin.js';

const main = $('#main');

/**
 * 로그인 없이 볼 수 있는 화면. 나머지는 전부 회원 전용입니다.
 * 홈은 소개용이라 열어 두되, 프로젝트 목록은 homeView 가 로그인 안내로 대체합니다.
 */
const PUBLIC_PATHS = new Set(['/', '/login', '/signup', '/forgot', '/reset', '/guide']);

/* ------------------------------------------------------------- 크롬 -- */

function renderAuthButtons() {
  const me = currentUser();
  const html = me
    ? `<a class="btn btn--darkline btn--sm" href="#/account">${esc(me.name)}님</a>
       ${me.role === 'admin' ? '<a class="btn btn--darkline btn--sm" href="#/admin">관리자</a>' : ''}
       <button class="btn btn--dark btn--sm" data-logout>로그아웃</button>`
    : `<a class="btn btn--darkline btn--sm" href="#/login">로그인</a>
       <a class="btn btn--dark btn--sm" href="#/signup">회원가입</a>`;

  ['#gnavActions', '#gnavDrawerActions'].forEach((sel) => {
    const el = $(sel);
    if (el) el.innerHTML = html;
  });

  document.querySelectorAll('[data-logout]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await logout();
      toastOk('로그아웃되었습니다.');
      R.go('/login');
    });
  });
}

/** 로그인 여부에 따라 메뉴를 감춥니다. */
function renderNavLinks() {
  const signed = isSignedIn();
  document.querySelectorAll('.gnav__links a, .gnav__drawer a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const memberOnly = ['#/materials', '#/board', '#/my'].includes(href);
    a.hidden = memberOnly && !signed;
  });
}

function markActiveNav(path) {
  const key = path === '/' ? 'home' : path.split('/')[1];
  document.querySelectorAll('.gnav__links a').forEach((a) => {
    const nav = a.dataset.nav;
    const active = (nav === 'home' && (key === 'home' || key === 'p'))
      || (nav === 'materials' && key === 'materials')
      || (nav === 'board' && key === 'board')
      || (nav === 'my' && (key === 'my' || key === 's'))
      || (nav === 'guide' && key === 'guide');
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function setupDrawer() {
  const burger = $('#gnavBurger');
  const drawer = $('#gnavDrawer');
  burger.addEventListener('click', () => {
    const open = burger.getAttribute('aria-expanded') === 'true';
    burger.setAttribute('aria-expanded', String(!open));
    burger.setAttribute('aria-label', open ? '메뉴 열기' : '메뉴 닫기');
    drawer.hidden = open;
  });
  drawer.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      burger.setAttribute('aria-expanded', 'false');
      drawer.hidden = true;
    }
  });
}

/** Frap 버튼 — 로그인했고 접수중인 프로젝트가 있을 때만. */
async function updateFrap(path) {
  const frap = $('#frap');
  if (!isSignedIn() || path.startsWith('/admin') || path.startsWith('/materials')
      || path.startsWith('/board')
      || path.includes('/submit') || PUBLIC_PATHS.has(path)) {
    frap.hidden = true;
    return;
  }
  try {
    const open = (await store.listProjects()).filter(submissionOpen);
    if (!open.length) { frap.hidden = true; return; }
    const match = path.match(/^\/p\/([^/]+)/);
    const target = (match && open.find((p) => p.id === match[1])) || open[0];
    frap.hidden = false;
    frap.onclick = () => R.go(`/p/${target.id}/submit`);
    frap.setAttribute('aria-label', `"${target.title}" 과제 제출하기`);
  } catch {
    frap.hidden = true;
  }
}

/* ----------------------------------------------------------- 라우팅 -- */

function signInWall(path) {
  main.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
    ${emptyState({
    title: '로그인이 필요합니다',
    body: '과제 제출과 강의자료는 회원만 이용할 수 있습니다.',
    action: `<div class="row" style="justify-content:center">
        <a class="btn btn--primary" href="#/login?next=${attr(encodeURIComponent(path))}">로그인</a>
        <a class="btn btn--outline" href="#/signup">회원가입</a>
      </div>`,
  })}
  </div></section>`;
}

/** 각 화면 핸들러를 로그인 가드 + 공통 에러 처리로 감쌉니다. */
const view = (fn, { admin = false } = {}) => async (params, query) => {
  const path = R.currentPath();

  if (!PUBLIC_PATHS.has(path) && !isSignedIn()) {
    // 서버에 아직 물어본 적이 없다면(새로고침 직후 등) 한 번 확인하고 판단합니다.
    if (store?.auth && !store.auth.synced) await store.auth.refresh();
    renderAuthButtons();
    renderNavLinks();
    if (!isSignedIn()) { signInWall(path); return; }
  }
  if (admin && !isAdmin()) {
    main.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">관리자만 볼 수 있는 화면입니다.</div>
      <div style="margin-top:var(--space-4)"><a class="btn btn--outline" href="#/">홈으로</a></div>
    </div></section>`;
    return;
  }

  try {
    await fn(main, params, query);
  } catch (e) {
    console.error(e);
    if (e?.status === 401) { signInWall(path); return; }
    main.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--err">
        <strong>화면을 불러오지 못했습니다.</strong><br>${esc(e.message)}
      </div>
      <div style="margin-top:var(--space-4)"><a class="btn btn--outline" href="#/">홈으로</a></div>
    </div></section>`;
    toastErr('오류가 발생했습니다.');
  }
};

function registerRoutes() {
  R.route('/', view((m) => homeView(m)));
  R.route('/guide', view((m) => guideView(m)));
  R.route('/materials', view((m) => materialsView(m)));

  R.route('/board', view((m) => boardView(m)));
  R.route('/board/new', view((m) => postFormView(m, { id: 'new' })));
  R.route('/board/:id', view((m, p) => postView(m, p)));
  R.route('/board/:id/edit', view((m, p) => postFormView(m, p)));
  R.route('/my', view((m) => myView(m)));

  R.route('/login', view((m) => loginView(m)));
  R.route('/signup', view((m) => signupView(m)));
  R.route('/forgot', view((m) => forgotView(m)));
  R.route('/reset', view((m) => resetView(m)));
  R.route('/account', view((m) => accountView(m)));

  R.route('/p/:id', view((m, p) => projectView(m, p)));
  R.route('/p/:id/submit', view((m, p) => submitView(m, p)));

  R.route('/s/:id', view((m, p) => submissionView(m, p)));
  R.route('/s/:id/edit', view((m, p) => editSubmissionView(m, p)));

  R.route('/admin', view((m) => adminView(m), { admin: true }));
  R.route('/admin/members', view((m) => membersView(m), { admin: true }));
  R.route('/admin/project/:id', view((m, p) => projectFormView(m, p), { admin: true }));
  R.route('/admin/material/:id', view((m, p) => materialFormView(m, p), { admin: true }));
  R.route('/admin/submissions/:projectId', view((m, p) => adminSubmissionsView(m, p), { admin: true }));

  R.setNotFound(view((m) => {
    m.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: '페이지를 찾을 수 없습니다',
      body: '주소가 잘못되었거나 삭제된 항목입니다.',
      action: '<a class="btn btn--primary" href="#/">홈으로 돌아가기</a>',
    })}</div></section>`;
  }));

  R.beforeEach(() => {
    main.scrollTop = 0;
    window.scrollTo({ top: 0 });
  });

  R.afterEach((path) => {
    markActiveNav(path);
    renderAuthButtons();
    renderNavLinks();
    updateFrap(path);
    main.focus({ preventScroll: true });
  });
}

/* -------------------------------------------------------------- 부팅 -- */

async function boot() {
  $('#footYear').textContent = new Date().getFullYear();
  $('#footMeta').textContent = `저장소: ${STORAGE_LABEL[currentMode()]}`;
  document.title = CONFIG.siteName;

  setupDrawer();
  renderAuthButtons();
  renderNavLinks();
  registerRoutes();

  try {
    await initStore();
  } catch (e) {
    main.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--err">
        <strong>저장소를 초기화하지 못했습니다.</strong><br>${esc(e.message)}
      </div>
    </div></section>`;
    return;
  }

  window.addEventListener('ah:auth', () => {
    renderAuthButtons();
    renderNavLinks();
    const path = R.currentPath();
    // 보는 도중 세션이 끊겼다면(만료·정지) 오류 대신 로그인 안내를 보여줍니다.
    if (!isSignedIn() && !PUBLIC_PATHS.has(path)) { signInWall(path); return; }
    // 홈은 로그인 여부에 따라 내용이 달라지므로 다시 그립니다.
    if (path === '/') R.resolve();
  });
  R.start();
}

boot();
