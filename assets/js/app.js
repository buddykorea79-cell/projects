/** 앱 진입점 — 저장소 초기화, 라우팅, 전역 크롬(헤더/푸터/Frap). */
import { CONFIG, STORAGE_LABEL } from './config.js';
import { initStore, currentMode, submissionOpen, store } from './store/index.js';
import { session, logout, hashAdmin, hashMaterials } from './auth.js';
import { $, esc } from './utils.js';
import { toastErr, emptyState } from './ui.js';
import * as R from './router.js';

import { homeView } from './views/home.js';
import { projectView, submitView, receiptView } from './views/project.js';
import { myView, submissionView, editSubmissionView } from './views/my.js';
import { guideView } from './views/guide.js';
import { materialsView } from './views/materials.js';
import {
  loginView, adminView, projectFormView, adminSubmissionsView, materialFormView,
} from './views/admin.js';

/* 콘솔에서 비밀번호 해시를 만들 수 있게 노출합니다 (문서화된 헬퍼). */
window.hashAdmin = hashAdmin;
window.hashMaterials = hashMaterials;

const main = $('#main');

/* ------------------------------------------------------------- 크롬 -- */

function renderAuthButtons() {
  const admin = session();
  const html = admin
    ? `<a class="btn btn--darkline btn--sm" href="#/admin">관리자</a>
       <button class="btn btn--dark btn--sm" data-logout>로그아웃</button>`
    : `<a class="btn btn--darkline btn--sm" href="#/admin">관리자 로그인</a>
       <a class="btn btn--dark btn--sm" href="#/">과제 제출</a>`;

  ['#gnavActions', '#gnavDrawerActions'].forEach((sel) => {
    const el = $(sel);
    if (el) el.innerHTML = html;
  });

  document.querySelectorAll('[data-logout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      logout();
      renderAuthButtons();
      R.go('/');
    });
  });
}

function markActiveNav(path) {
  const key = path === '/' ? 'home' : path.split('/')[1];
  document.querySelectorAll('.gnav__links a').forEach((a) => {
    const nav = a.dataset.nav;
    const active = (nav === 'home' && (key === 'home' || key === 'p'))
      || (nav === 'materials' && key === 'materials')
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

/** Frap 버튼 — 접수중인 프로젝트가 하나라도 있을 때만 띄웁니다. */
async function updateFrap(path) {
  const frap = $('#frap');
  if (path.startsWith('/admin') || path.startsWith('/materials') || path.includes('/submit')) {
    frap.hidden = true; return;
  }
  try {
    const projects = await store.listProjects();
    const open = projects.filter(submissionOpen);
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

/** 각 화면 핸들러를 공통 에러 처리로 감쌉니다. */
const view = (fn) => async (params, query) => {
  try {
    await fn(main, params, query);
  } catch (e) {
    console.error(e);
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
  R.route('/',                        view((m) => homeView(m)));
  R.route('/guide',                   view((m) => guideView(m)));
  R.route('/materials',               view((m) => materialsView(m)));
  R.route('/my',                      view((m) => myView(m)));

  R.route('/p/:id',                   view((m, p) => projectView(m, p)));
  R.route('/p/:id/submit',            view((m, p) => submitView(m, p)));
  R.route('/done/:id',                view((m, p) => receiptView(m, p)));

  R.route('/s/:id',                   view((m, p) => submissionView(m, p)));
  R.route('/s/:id/edit',              view((m, p) => editSubmissionView(m, p)));

  R.route('/admin',                   view((m) => adminView(m)));
  R.route('/admin/login',             view((m) => loginView(m)));
  R.route('/admin/project/:id',       view((m, p) => projectFormView(m, p)));
  R.route('/admin/material/:id',      view((m, p) => materialFormView(m, p)));
  R.route('/admin/submissions/:projectId', view((m, p) => adminSubmissionsView(m, p)));

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

  window.addEventListener('ah:auth', renderAuthButtons);
  R.start();
}

boot();
