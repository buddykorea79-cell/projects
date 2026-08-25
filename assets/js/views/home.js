/** 홈 — 히어로 + 진행중 프로젝트 그리드. */
import { store, submissionOpen } from '../store/index.js';
import { CONFIG } from '../config.js';
import { esc, attr, fmtDate, isPastDue } from '../utils.js';
import { spinner, emptyState } from '../ui.js';
import { isAdmin, currentUser } from '../auth.js';

export function projectCard(p) {
  const open = submissionOpen(p);
  const due = p.dueAt
    ? `<span class="badge ${isPastDue(p.dueAt) ? 'badge--due' : 'badge--soft'}">마감 ${esc(fmtDate(p.dueAt, true))}</span>`
    : '<span class="badge badge--soft">마감일 없음</span>';

  return `
    <a class="tile" href="#/p/${attr(p.id)}">
      <div class="tile__cap${open ? '' : ' tile__cap--closed'}"></div>
      <div class="tile__body">
        <div class="row" style="gap:6px">
          <span class="badge ${open ? 'badge--open' : 'badge--closed'}">${open ? '접수중' : '마감'}</span>
          ${p.visibility === 'public' ? '<span class="badge badge--gold">제출물 공개</span>' : ''}
        </div>
        <h3 class="tile__title">${esc(p.title)}</h3>
        <p class="tile__desc">${esc(p.description || '설명이 없습니다.')}</p>
        <div class="tile__foot">
          ${due}
          <span style="color:var(--green-accent);font-weight:600;font-size:1.4rem">
            ${open ? '제출하기 →' : '자세히 보기 →'}
          </span>
        </div>
      </div>
    </a>`;
}

export async function homeView(mount) {
  mount.innerHTML = `
    <section class="hero">
      <div class="wrap hero__inner">
        <div class="stack-4">
          <p class="hero__eyebrow">${esc(CONFIG.orgName)}${
            currentUser() ? ` · ${esc(currentUser().name)}님` : ''}</p>
          <h1 class="hero__title">여기에서 과제를 제출하고,<br>강의자료를 받을 수 있습니다.</h1>
          <p class="hero__lead">
            로그인하면 제출자 정보가 자동으로 채워집니다.
            마감 전까지는 언제든 내용을 고치거나 삭제할 수 있어요.
          </p>
          <div class="row">
            <button class="btn btn--primary btn--lg" type="button" data-scroll-projects>
              진행중 프로젝트 보기
            </button>
            <a class="btn btn--outline btn--lg" href="#/materials">강의자료 받기</a>
          </div>
        </div>
        <div class="hero__art" aria-hidden="true">
          <svg viewBox="0 0 320 260" width="100%">
            <rect x="18" y="26" width="284" height="208" rx="14" fill="#ffffff"/>
            <rect x="18" y="26" width="284" height="40" rx="14" fill="#1E3932"/>
            <rect x="18" y="52" width="284" height="14" fill="#1E3932"/>
            <circle cx="40" cy="46" r="5" fill="#cba258"/>
            <circle cx="58" cy="46" r="5" fill="rgba(255,255,255,.35)"/>
            <rect x="40" y="88" width="150" height="13" rx="6.5" fill="#006241"/>
            <rect x="40" y="112" width="240" height="9" rx="4.5" fill="#edebe9"/>
            <rect x="40" y="130" width="210" height="9" rx="4.5" fill="#edebe9"/>
            <rect x="40" y="158" width="110" height="70" rx="10" fill="#f2f0eb"/>
            <path d="M62 210l22-26 18 21 14-12 18 17" stroke="#00754A" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="76" cy="180" r="8" fill="#cba258"/>
            <rect x="166" y="158" width="114" height="30" rx="15" fill="#00754A"/>
            <rect x="192" y="169" width="62" height="8" rx="4" fill="#fff"/>
            <rect x="166" y="200" width="114" height="28" rx="14" fill="#ffffff" stroke="#00754A" stroke-width="2"/>
          </svg>
        </div>
      </div>
    </section>

    <section class="band">
      <div class="wrap">
        <div class="stack-4">
          <h2>과제 제출 방법</h2>
          <div class="steps">
            <div class="step">
              <div class="step__n">1</div>
              <h3>참석자 정보</h3>
              <p>기관명·성명·이메일로 한 번 가입하면 다음부터는 로그인만 하면 됩니다.</p>
            </div>
            <div class="step">
              <div class="step__n">2</div>
              <h3>제출할 과제 목록 선택</h3>
              <p>프로젝트에서 제출할 과제 목록을 클릭합니다.</p>
            </div>
            <div class="step">
              <div class="step__n">3</div>
              <h3>과제 내용</h3>
              <p>제목과 설명을 쓰고 이미지·영상·문서를 첨부합니다.
                 마감 전까지 [내 제출물]에서 고칠 수 있습니다.</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="projects">
      <div class="wrap">
        <div class="page-head">
          <div>
            <h2 class="page-title">프로젝트</h2>
            <p class="page-sub">참여할 과제를 선택하세요.</p>
          </div>
          ${isAdmin() ? '<a class="btn btn--outline" href="#/admin/project/new">＋ 프로젝트 개설</a>' : ''}
        </div>
        <div id="projectGrid">${spinner()}</div>
      </div>
    </section>`;

  // `href="#projects"` 는 해시 라우터가 경로로 오해하므로 스크롤로 처리합니다.
  mount.querySelector('[data-scroll-projects]')?.addEventListener('click', () => {
    mount.querySelector('#projects')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const grid = mount.querySelector('#projectGrid');
  try {
    const projects = await store.listProjects();
    if (!projects.length) {
      grid.innerHTML = emptyState({
        title: '아직 개설된 프로젝트가 없습니다',
        body: '관리자가 프로젝트를 개설하면 이곳에 표시됩니다.',
        action: isAdmin()
          ? '<a class="btn btn--primary" href="#/admin/project/new">첫 프로젝트 개설하기</a>'
          : '<a class="btn btn--outline" href="#/admin">관리자 로그인</a>',
      });
      return;
    }

    const open = projects.filter(submissionOpen);
    const closed = projects.filter((p) => !submissionOpen(p));

    grid.innerHTML = `
      ${open.length ? `<div class="grid">${open.map(projectCard).join('')}</div>` : ''}
      ${closed.length ? `
        <h3 style="margin-top:var(--space-7);margin-bottom:var(--space-3);font-size:1.9rem;color:var(--text-black-soft)">
          마감된 프로젝트 <span style="font-weight:400">(${closed.length})</span>
        </h3>
        <div class="grid">${closed.map(projectCard).join('')}</div>` : ''}`;
  } catch (e) {
    grid.innerHTML = `<div class="notice notice--err">프로젝트를 불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}
