/** 프로젝트 상세 · 제출 폼(2단계) · 제출 완료 영수증. */
import { store, submissionOpen, closedReason, newSubmission } from '../store/index.js';
import { CONFIG } from '../config.js';
import {
  esc, attr, fmtDate, fmtBytes, isEmail, normEmail, kindOf, downloadBlob, downloadLink,
} from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, FilePicker, fieldError, clearErrors,
  focusFirstError, busy, lightbox,
} from '../ui.js';
import { isAdmin } from '../auth.js';
import { go } from '../router.js';

const DRAFT_KEY = 'ah.author';

function loadAuthor() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
}
function saveAuthor(a) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(a)); } catch { /* ignore */ }
}

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
          마감 ${esc(fmtDate(project.dueAt, true))}
          ${project.dueAt ? '' : '— 상시 접수'}
        </p>
        <div class="row" style="margin-top:var(--space-4)">
          ${open
            ? `<a class="btn btn--onDark btn--lg" href="#/p/${attr(project.id)}/submit">과제 제출하기</a>`
            : `<span class="btn btn--ghostDark btn--lg" aria-disabled="true">${esc(reason)}</span>`}
          <a class="btn btn--ghostDark btn--lg" href="#/my">내 제출물 조회</a>
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
            <div class="kv__row"><div class="kv__k">필수 정보</div><div class="kv__v">${
              project.requireInstitution ? '기관명 · 성명 · 이메일' : '성명 · 이메일'
            }</div></div>
            <div class="kv__row"><div class="kv__k">첨부</div><div class="kv__v">${
              project.allowFiles === false
                ? '첨부 없음 (본문만)'
                : `최대 ${CONFIG.upload.maxFiles}개, 개당 ${CONFIG.upload.maxFileMB}MB`
            }</div></div>
            <div class="kv__row"><div class="kv__k">수정·삭제</div><div class="kv__v">이메일 + 제출 시 발급되는 수정코드</div></div>
            <div class="kv__row"><div class="kv__k">제출물 공개</div><div class="kv__v">${
              project.visibility === 'public' ? '다른 참석자도 목록을 볼 수 있습니다' : '관리자와 본인만 볼 수 있습니다'
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

  const caps = store.capabilities();
  const blocked = !caps.canWrite;
  const author = loadAuthor();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow">
        <p class="crumb">
          <a href="#/">프로젝트</a><span>/</span>
          <a href="#/p/${attr(project.id)}">${esc(project.title)}</a><span>/</span>제출
        </p>
        <h1 class="page-title" style="margin-bottom:var(--space-5)">과제 제출</h1>

        <div class="stepper" id="stepper">
          <span class="stepper__item is-active" data-step="1">
            <span class="stepper__dot">1</span> 참석자 정보
          </span>
          <span class="stepper__sep"></span>
          <span class="stepper__item" data-step="2">
            <span class="stepper__dot">2</span> 과제 내용
          </span>
        </div>

        ${blocked ? `<div class="notice notice--warn" style="margin-bottom:var(--space-4)">
          <strong>지금은 제출을 저장할 수 없습니다.</strong><br>
          현재 저장소가 <code>GitHub</code> 모드인데 쓰기 권한이 설정되지 않았습니다.
          관리자에게 문의하거나 <a href="#/guide#storage">저장소 설정</a>을 확인하세요.
        </div>` : ''}

        <form id="submitForm" novalidate>
          <!-- STEP 1 -->
          <fieldset class="card" data-panel="1" style="border:0;margin:0">
            <legend class="sr-only">참석자 정보</legend>
            ${project.requireInstitution ? `
            <label class="field">
              <span class="field__label">기관명<span class="field__req">*</span></span>
              <input class="input" name="institution" autocomplete="organization"
                     placeholder="예) 한국디자인진흥원" value="${attr(author.institution || '')}" />
            </label>` : ''}
            <div class="field-row field-row--2">
              <label class="field">
                <span class="field__label">성명<span class="field__req">*</span></span>
                <input class="input" name="name" autocomplete="name"
                       placeholder="예) 홍길동" value="${attr(author.name || '')}" />
              </label>
              <label class="field">
                <span class="field__label">이메일<span class="field__req">*</span></span>
                <input class="input" name="email" type="email" inputmode="email" autocomplete="email"
                       placeholder="you@example.com" value="${attr(author.email || '')}" />
                <span class="field__hint">수정·삭제할 때 이 주소가 필요합니다.</span>
              </label>
            </div>
            <div class="row row--end" style="margin-top:var(--space-4)">
              <button type="button" class="btn btn--primary btn--lg" data-next>다음 단계 →</button>
            </div>
          </fieldset>

          <!-- STEP 2 -->
          <fieldset class="card" data-panel="2" hidden style="border:0;margin:0">
            <legend class="sr-only">과제 내용</legend>
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
              <button type="button" class="btn btn--quiet" data-prev>← 이전</button>
              <button type="submit" class="btn btn--primary btn--lg" ${blocked ? 'aria-disabled="true"' : ''}>
                제출하기
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector('#submitForm');
  const panels = {
    1: form.querySelector('[data-panel="1"]'),
    2: form.querySelector('[data-panel="2"]'),
  };
  const steps = mount.querySelectorAll('.stepper__item');

  const picker = project.allowFiles === false
    ? null
    : new FilePicker(mount.querySelector('#picker'));

  const showStep = (n) => {
    panels[1].hidden = n !== 1;
    panels[2].hidden = n !== 2;
    steps.forEach((el) => {
      const s = Number(el.dataset.step);
      el.classList.toggle('is-active', s === n);
      el.classList.toggle('is-done', s < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const bodyInput = form.querySelector('[name="body"]');
  const counter = form.querySelector('[data-count]');
  bodyInput.addEventListener('input', () => { counter.textContent = bodyInput.value.length; });

  form.querySelector('[data-next]').addEventListener('click', () => {
    clearErrors(form);
    if (!validateStep1(form, project)) { focusFirstError(form); return; }
    saveAuthor({
      institution: form.institution?.value.trim() || '',
      name: form.name.value.trim(),
      email: normEmail(form.email.value),
    });
    showStep(2);
  });

  form.querySelector('[data-prev]').addEventListener('click', () => showStep(1));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (blocked) { toastErr('저장소에 쓰기 권한이 없습니다.'); return; }

    clearErrors(form);
    const okStep1 = validateStep1(form, project);
    const okStep2 = validateStep2(form);
    if (!okStep1) { showStep(1); focusFirstError(form); return; }
    if (!okStep2) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '제출 중…');
    try {
      const rec = await newSubmission({
        projectId: project.id,
        author: {
          institution: form.institution?.value || '',
          name: form.name.value,
          email: form.email.value,
        },
        title: form.title.value,
        body: form.body.value,
      });
      const saved = await store.saveSubmission(rec, picker ? picker.files : []);
      rememberMine(saved);
      toastOk('제출이 완료되었습니다.');
      go(`/done/${saved.id}`);
    } catch (err) {
      busy(btn, false);
      toastErr(`제출에 실패했습니다 — ${err.message}`);
    }
  });
}

function validateStep1(form, project) {
  let ok = true;
  if (project.requireInstitution && form.institution && !form.institution.value.trim()) {
    fieldError(form.institution, '기관명을 입력하세요.'); ok = false;
  }
  if (!form.name.value.trim()) { fieldError(form.name, '성명을 입력하세요.'); ok = false; }
  if (!isEmail(form.email.value)) { fieldError(form.email, '올바른 이메일 주소를 입력하세요.'); ok = false; }
  return ok;
}

function validateStep2(form) {
  let ok = true;
  if (!form.title.value.trim()) { fieldError(form.title, '제목을 입력하세요.'); ok = false; }
  if (!form.body.value.trim()) { fieldError(form.body, '설명을 입력하세요.'); ok = false; }
  if (!form.agree.checked) {
    fieldError(form.agree.closest('.check'), '동의가 필요합니다.'); ok = false;
  }
  return ok;
}

/** 이 브라우저에서 낸 제출물을 기억해 '내 제출물' 조회를 편하게 합니다. */
export function rememberMine(sub) {
  try {
    const key = 'ah.mine';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    const next = [{ id: sub.id, email: sub.author.email, code: sub.editCode, title: sub.title,
      projectId: sub.projectId, at: sub.createdAt },
    ...list.filter((x) => x.id !== sub.id)].slice(0, 50);
    localStorage.setItem(key, JSON.stringify(next));
  } catch { /* ignore */ }
}

export function readMine() {
  try { return JSON.parse(localStorage.getItem('ah.mine') || '[]'); } catch { return []; }
}

/* ---------------------------------------------------------- 제출 완료 -- */

export async function receiptView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;
  const sub = await store.getSubmission(id);
  if (!sub) { go('/'); return; }
  const project = await store.getProject(sub.projectId);

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow stack-4">
        <div style="text-align:center">
          <svg width="72" height="72" viewBox="0 0 24 24" fill="none" style="margin:0 auto var(--space-3)">
            <circle cx="12" cy="12" r="11" fill="#00754A"/>
            <path d="M7 12.4l3.4 3.4L17 9.2" stroke="#fff" stroke-width="2.2"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <h1 class="page-title" style="font-size:2.8rem">제출이 완료되었습니다</h1>
          <p class="page-sub">${esc(project?.title || '')}</p>
        </div>

        <div class="code-ceremony">
          <p class="code-ceremony__label">수정 코드</p>
          <p class="code-ceremony__code">${esc(sub.editCode)}</p>
          <p class="code-ceremony__hint">
            이메일 <strong style="color:#fff">${esc(sub.author.email)}</strong> 와 이 코드가 있어야
            나중에 수정·삭제할 수 있습니다.
          </p>
          <div class="row" style="justify-content:center;margin-top:var(--space-3)">
            <button class="btn btn--onDark btn--sm" data-copy>코드 복사</button>
            <button class="btn btn--ghostDark btn--sm" data-save>확인증 내려받기</button>
          </div>
        </div>

        <div class="notice notice--info">
          이 코드는 <strong>다시 표시되지 않습니다.</strong> 화면을 닫기 전에 복사하거나 확인증을 저장해 두세요.
          같은 브라우저에서는 <a href="#/my">내 제출물</a>에서 자동으로 찾을 수 있습니다.
        </div>

        <div class="row" style="justify-content:center">
          <a class="btn btn--primary" href="#/s/${attr(sub.id)}?code=${attr(sub.editCode)}">제출물 확인하기</a>
          <a class="btn btn--outline" href="#/p/${attr(sub.projectId)}">프로젝트로 돌아가기</a>
        </div>
      </div>
    </section>`;

  mount.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sub.editCode);
      toastOk('수정 코드를 복사했습니다.');
    } catch {
      toastErr('복사에 실패했습니다. 코드를 직접 적어두세요.');
    }
  });

  mount.querySelector('[data-save]').addEventListener('click', () => {
    const lines = [
      '과제 제출 확인증',
      '========================================',
      `프로젝트 : ${project?.title || '-'}`,
      `제목     : ${sub.title}`,
      `기관명   : ${sub.author.institution || '-'}`,
      `성명     : ${sub.author.name}`,
      `이메일   : ${sub.author.email}`,
      `제출일시 : ${fmtDate(sub.createdAt, true)}`,
      `첨부     : ${(sub.files || []).length}건`,
      '',
      `수정코드 : ${sub.editCode}`,
      '',
      '※ 수정·삭제 시 이메일과 수정코드가 모두 필요합니다.',
    ].join('\n');
    downloadBlob(new Blob([lines], { type: 'text/plain;charset=utf-8' }),
      `제출확인증_${sub.author.name}_${sub.id}.txt`);
  });
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

    let view = `<div class="media-card__view" style="font-weight:700;color:var(--text-black-soft)">
                  ${esc((f.name.split('.').pop() || 'FILE').toUpperCase())}
                </div>`;
    if (url && kind === 'image') {
      view = `<div class="media-card__view"><img src="${attr(url)}" alt="${attr(f.name)}" loading="lazy" /></div>`;
    } else if (url && kind === 'video') {
      view = `<div class="media-card__view"><video src="${attr(url)}" preload="metadata" muted></video></div>`;
    }

    card.innerHTML = `
      ${view}
      <div class="media-card__bar">
        <div style="min-width:0">
          <div class="fileitem__name" style="font-size:1.3rem">${esc(f.name)}</div>
          <div class="fileitem__meta">${esc(fmtBytes(f.size))}</div>
        </div>
        ${(() => {
          const dl = downloadLink(url, f);
          return dl ? `<a class="btn btn--quiet btn--sm" href="${attr(dl.href)}" ${dl.attrs}>받기</a>` : '';
        })()}
      </div>`;

    if (url && (kind === 'image' || kind === 'video')) {
      const viewEl = card.querySelector('.media-card__view');
      viewEl.style.cursor = 'zoom-in';
      viewEl.addEventListener('click', () => lightbox(url, kind, f.name));
    }
    grid.appendChild(card);
  }
}
