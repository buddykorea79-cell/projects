/** 프로젝트 상세 · 과제 제출 · 첨부 렌더. */
import { store, submissionOpen, closedReason } from '../store/index.js';
import { CONFIG } from '../config.js';
import { esc, attr, fmtDate, fmtBytes, kindOf, downloadLink } from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, FilePicker, fieldError, clearErrors,
  focusFirstError, busy, lightbox,
} from '../ui.js';
import { isAdmin, currentUser } from '../auth.js';
import { go } from '../router.js';

/* ------------------------------------------------------- 프로젝트 상세 -- */

export async function projectView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const project = await store.getProject(id);
  if (!project) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: '프로젝트를 찾을 수 없습니다',
      body: '삭제되었거나 주소가 잘못되었습니다.',
      action: '<a class="btn btn--outline" href="#/">프로젝트 목록으로</a>',
    })}</div></section>`;
    return;
  }

  const open = submissionOpen(project);
  const reason = closedReason(project);

  mount.innerHTML = `
    <section class="band" style="padding-block:var(--space-6)">
      <div class="wrap">
        <p class="crumb" style="color:var(--text-white-soft)">
          <a href="#/" style="color:#fff">프로젝트</a><span>/</span>${esc(project.title)}
        </p>
        <div class="row" style="gap:6px;margin-bottom:var(--space-3)">
          <span class="badge ${open ? 'badge--open' : 'badge--closed'}">${open ? '접수중' : '마감'}</span>
          ${project.visibility === 'public' ? '<span class="badge badge--gold">제출물 공개</span>' : ''}
        </div>
        <h1 style="font-size:3.2rem;color:#fff;font-weight:600">${esc(project.title)}</h1>
        <p style="color:var(--text-white-soft);margin-top:var(--space-2);font-size:1.6rem">
          마감 ${esc(fmtDate(project.dueAt, true))}${project.dueAt ? '' : ' — 상시 접수'}
        </p>
        <div class="row" style="margin-top:var(--space-4)">
          ${open
            ? `<a class="btn btn--onDark btn--lg" href="#/p/${attr(project.id)}/submit">과제 제출하기</a>`
            : `<span class="btn btn--ghostDark btn--lg" aria-disabled="true">${esc(reason)}</span>`}
          <a class="btn btn--ghostDark btn--lg" href="#/my">내 제출물</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap wrap--mid stack-4">
        <div class="card">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">과제 안내</h2>
          <div class="prose">${esc(project.description || '별도 안내가 없습니다.')}</div>
        </div>

        <div class="card">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">제출 규정</h2>
          <div class="kv">
            <div class="kv__row"><div class="kv__k">제출 자격</div><div class="kv__v">로그인한 회원</div></div>
            <div class="kv__row"><div class="kv__k">첨부</div><div class="kv__v">${
              project.allowFiles === false
                ? '첨부 없음 (본문만)'
                : `최대 ${CONFIG.upload.maxFiles}개, 개당 ${CONFIG.upload.maxFileMB}MB`
            }</div></div>
            <div class="kv__row"><div class="kv__k">수정·삭제</div><div class="kv__v">마감 전까지 본인이 언제든</div></div>
            <div class="kv__row"><div class="kv__k">제출물 공개</div><div class="kv__v">${
              project.visibility === 'public'
                ? '다른 회원도 목록을 볼 수 있습니다 (이메일은 비공개)'
                : '관리자와 본인만 볼 수 있습니다'
            }</div></div>
          </div>
        </div>

        <div id="gallery"></div>
      </div>
    </section>`;

  const gallery = mount.querySelector('#gallery');
  if (project.visibility === 'public' || isAdmin()) {
    await renderGallery(gallery, project);
  }
}

async function renderGallery(mount, project) {
  mount.innerHTML = `<div class="card">${spinner()}</div>`;
  try {
    const subs = await store.listSubmissions({ projectId: project.id });
    if (!subs.length) {
      mount.innerHTML = `<div class="card">${emptyState({
        title: '아직 제출물이 없습니다',
        body: '첫 번째로 제출해 보세요.',
      })}</div>`;
      return;
    }
    mount.innerHTML = `
      <div class="card">
        <div class="page-head" style="margin-bottom:var(--space-3)">
          <h2 class="page-title" style="font-size:2rem">제출물 <span style="font-weight:400;color:var(--text-black-soft)">${subs.length}</span></h2>
          ${isAdmin() ? `<a class="btn btn--outline btn--sm" href="#/admin/submissions/${attr(project.id)}">관리 화면에서 보기</a>` : ''}
        </div>
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>제목</th><th>기관 / 성명</th><th>첨부</th><th>제출일</th></tr></thead>
            <tbody>
              ${subs.map((s) => `
                <tr>
                  <td><a href="#/s/${attr(s.id)}">${esc(s.title)}</a></td>
                  <td>${esc(s.author?.institution || '—')} / ${esc(s.author?.name || '—')}</td>
                  <td class="num">${(s.files || []).length}</td>
                  <td>${esc(fmtDate(s.createdAt, true))}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch (e) {
    mount.innerHTML = `<div class="notice notice--err">제출물을 불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}

/* --------------------------------------------------------------- 제출 -- */

export async function submitView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const project = await store.getProject(id);
  if (!project) { go('/'); return; }

  if (!submissionOpen(project)) {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">${esc(closedReason(project))}</div>
      <div style="margin-top:var(--space-4)"><a class="btn btn--outline" href="#/p/${attr(project.id)}">프로젝트로 돌아가기</a></div>
    </div></section>`;
    return;
  }

  const me = currentUser();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow">
        <p class="crumb">
          <a href="#/">프로젝트</a><span>/</span>
          <a href="#/p/${attr(project.id)}">${esc(project.title)}</a><span>/</span>제출
        </p>
        <h1 class="page-title" style="margin-bottom:var(--space-4)">과제 제출</h1>

        <div class="card card--flat" style="margin-bottom:var(--space-3)">
          <div class="row row--between" style="gap:var(--space-3)">
            <div>
              <div class="field__label" style="margin-bottom:2px">제출자</div>
              <div style="font-size:1.5rem">
                ${esc(me.institution || '—')} · <strong>${esc(me.name)}</strong>
                <span style="color:var(--text-black-soft)"> · ${esc(me.email)}</span>
              </div>
            </div>
            <a class="btn btn--quiet btn--sm" href="#/account">내 계정</a>
          </div>
        </div>

        <form id="submitForm" class="card" novalidate>
          <label class="field">
            <span class="field__label">제목<span class="field__req">*</span></span>
            <input class="input" name="title" maxlength="120" placeholder="과제 제목을 입력하세요" />
          </label>
          <label class="field">
            <span class="field__label">설명<span class="field__req">*</span></span>
            <textarea class="textarea" name="body" maxlength="8000"
                      placeholder="과제 내용, 제작 의도, 참고 자료 등을 자유롭게 적어주세요."></textarea>
            <span class="field__hint"><span data-count>0</span> / 8000자</span>
          </label>

          ${project.allowFiles === false ? '' : `
          <div class="field">
            <span class="field__label">첨부파일</span>
            <div id="picker"></div>
          </div>`}

          <label class="check">
            <input type="checkbox" name="agree" />
            <span>제출한 내용과 첨부파일이 교육 목적으로 열람·보관되는 데 동의합니다.<span class="field__req">*</span></span>
          </label>

          <div class="row row--between" style="margin-top:var(--space-4)">
            <a class="btn btn--quiet" href="#/p/${attr(project.id)}">← 취소</a>
            <button type="submit" class="btn btn--primary btn--lg">제출하기</button>
          </div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector('#submitForm');
  const picker = project.allowFiles === false
    ? null
    : new FilePicker(mount.querySelector('#picker'));

  const bodyInput = form.querySelector('[name="body"]');
  const counter = form.querySelector('[data-count]');
  bodyInput.addEventListener('input', () => { counter.textContent = bodyInput.value.length; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    let ok = true;
    if (!form.title.value.trim()) { fieldError(form.title, '제목을 입력하세요.'); ok = false; }
    if (!form.body.value.trim()) { fieldError(form.body, '설명을 입력하세요.'); ok = false; }
    if (!form.agree.checked) { fieldError(form.agree.closest('.check'), '동의가 필요합니다.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '제출 중…');
    try {
      const saved = await store.saveSubmission({
        projectId: project.id,
        title: form.title.value,
        body: form.body.value,
        files: [],
      }, picker ? picker.files : []);
      toastOk('제출이 완료되었습니다.');
      go(`/s/${saved.id}`);
    } catch (err) {
      busy(btn, false);
      toastErr(`제출에 실패했습니다 — ${err.message}`);
    }
  });

  form.title.focus();
}

/* --------------------------------------------------------- 첨부 렌더 -- */

/** 제출물 첨부를 카드 그리드로 그립니다. (상세/관리 화면 공용) */
export async function renderAttachments(mount, files) {
  if (!files?.length) {
    mount.innerHTML = '<p style="color:var(--text-black-soft);font-size:1.4rem">첨부파일이 없습니다.</p>';
    return;
  }
  mount.innerHTML = '<div class="media-grid"></div>';
  const grid = mount.querySelector('.media-grid');

  for (const f of files) {
    const url = await store.fileURL(f);
    const kind = kindOf(f);
    const card = document.createElement('div');
    card.className = 'media-card';

    let viewHtml = `<div class="media-card__view" style="font-weight:700;color:var(--text-black-soft)">
                      ${esc((f.name.split('.').pop() || 'FILE').toUpperCase())}
                    </div>`;
    if (url && kind === 'image') {
      viewHtml = `<div class="media-card__view"><img src="${attr(url)}" alt="${attr(f.name)}" loading="lazy" /></div>`;
    } else if (url && kind === 'video') {
      viewHtml = `<div class="media-card__view"><video src="${attr(url)}" preload="metadata" muted></video></div>`;
    }

    const dl = downloadLink(url, f);
    card.innerHTML = `
      ${viewHtml}
      <div class="media-card__bar">
        <div style="min-width:0">
          <div class="fileitem__name" style="font-size:1.3rem">${esc(f.name)}</div>
          <div class="fileitem__meta">${esc(fmtBytes(f.size))}</div>
        </div>
        ${dl ? `<a class="btn btn--quiet btn--sm" href="${attr(dl.href)}" ${dl.attrs}>받기</a>` : ''}
      </div>`;

    if (url && (kind === 'image' || kind === 'video')) {
      const viewEl = card.querySelector('.media-card__view');
      viewEl.style.cursor = 'zoom-in';
      viewEl.addEventListener('click', () => lightbox(url, kind, f.name));
    }
    grid.appendChild(card);
  }
}
