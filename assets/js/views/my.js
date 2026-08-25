/** 내 제출물 — 이메일 + 수정코드로 조회하고, 수정·삭제합니다. */
import { store, verifyOwner, submissionOpen } from '../store/index.js';
import { esc, attr, fmtDate, isEmail, normEmail } from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, confirmModal, FilePicker,
  fieldError, clearErrors, focusFirstError, busy,
} from '../ui.js';
import { isAdmin } from '../auth.js';
import { go, currentQuery } from '../router.js';
import { readMine, renderAttachments } from './project.js';

const UNLOCK_KEY = 'ah.unlock';   // sessionStorage: { email, code }

export function unlockState() {
  try { return JSON.parse(sessionStorage.getItem(UNLOCK_KEY) || 'null'); } catch { return null; }
}
function setUnlock(v) {
  try {
    if (v) sessionStorage.setItem(UNLOCK_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(UNLOCK_KEY);
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------- 조회 화면 -- */

export async function myView(mount) {
  const unlocked = unlockState();
  const remembered = readMine();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--mid">
        <div class="page-head">
          <div>
            <h1 class="page-title">내 제출물</h1>
            <p class="page-sub">제출할 때 받은 이메일과 수정코드로 조회합니다.</p>
          </div>
          ${unlocked ? '<button class="btn btn--quiet" data-lock>조회 종료</button>' : ''}
        </div>

        ${unlocked ? '' : `
        <form class="card" id="unlockForm" novalidate style="margin-bottom:var(--space-4)">
          <div class="field-row field-row--2">
            <label class="field">
              <span class="field__label">이메일<span class="field__req">*</span></span>
              <input class="input" name="email" type="email" inputmode="email" autocomplete="email"
                     placeholder="you@example.com" value="${attr(remembered[0]?.email || '')}" />
            </label>
            <label class="field">
              <span class="field__label">수정코드<span class="field__req">*</span></span>
              <input class="input" name="code" autocomplete="off" spellcheck="false"
                     style="text-transform:uppercase;letter-spacing:.2em;font-family:ui-monospace,monospace"
                     placeholder="ABC123" maxlength="12" />
            </label>
          </div>
          <div class="row row--end">
            <button class="btn btn--primary" type="submit">조회하기</button>
          </div>
        </form>

        ${remembered.length ? `
        <div class="notice notice--info" style="margin-bottom:var(--space-4)">
          이 브라우저에서 제출한 기록이 ${remembered.length}건 있습니다.
          <button class="btn btn--sm btn--outline" data-quick style="margin-left:8px">코드 자동 입력</button>
        </div>` : ''}`}

        <div id="myResult">${unlocked ? spinner() : ''}</div>
      </div>
    </section>`;

  const form = mount.querySelector('#unlockForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);
      let ok = true;
      if (!isEmail(form.email.value)) { fieldError(form.email, '올바른 이메일을 입력하세요.'); ok = false; }
      if (!form.code.value.trim()) { fieldError(form.code, '수정코드를 입력하세요.'); ok = false; }
      if (!ok) { focusFirstError(form); return; }

      const btn = form.querySelector('button[type="submit"]');
      busy(btn, true, '조회 중…');
      const email = normEmail(form.email.value);
      const code = form.code.value.trim().toUpperCase();
      try {
        const rows = await store.listSubmissions({ email });
        const mine = rows.filter((s) => verifyOwner(s, email, code));
        if (!mine.length) {
          busy(btn, false);
          fieldError(form.code, '일치하는 제출물이 없습니다. 이메일과 코드를 확인하세요.');
          focusFirstError(form);
          return;
        }
        setUnlock({ email, code });
        myView(mount);
      } catch (err) {
        busy(btn, false);
        toastErr(`조회에 실패했습니다 — ${err.message}`);
      }
    });

    const quick = mount.querySelector('[data-quick]');
    if (quick) {
      quick.addEventListener('click', () => {
        form.email.value = remembered[0].email;
        form.code.value = remembered[0].code;
        form.requestSubmit();
      });
    }
  }

  const lock = mount.querySelector('[data-lock]');
  if (lock) lock.addEventListener('click', () => { setUnlock(null); myView(mount); });

  if (unlocked) await renderMyList(mount.querySelector('#myResult'), unlocked);
}

async function renderMyList(mount, { email, code }) {
  try {
    const rows = (await store.listSubmissions({ email })).filter((s) => verifyOwner(s, email, code));
    if (!rows.length) {
      mount.innerHTML = emptyState({
        title: '제출물이 없습니다',
        body: '아직 제출한 과제가 없거나 코드가 변경되었습니다.',
        action: '<a class="btn btn--primary" href="#/">프로젝트 보러 가기</a>',
      });
      return;
    }

    const projects = await store.listProjects();
    const byId = new Map(projects.map((p) => [p.id, p]));

    mount.innerHTML = `
      <div class="notice notice--ok" style="margin-bottom:var(--space-4)">
        <strong>${esc(email)}</strong> 님의 제출물 ${rows.length}건입니다.
      </div>
      <div class="tablewrap">
        <table class="table">
          <thead><tr><th>프로젝트</th><th>제목</th><th>첨부</th><th>제출일</th><th></th></tr></thead>
          <tbody>
            ${rows.map((s) => {
              const p = byId.get(s.projectId);
              return `
              <tr>
                <td>${esc(p?.title || '(삭제된 프로젝트)')}</td>
                <td><a href="#/s/${attr(s.id)}">${esc(s.title)}</a></td>
                <td class="num">${(s.files || []).length}</td>
                <td>${esc(fmtDate(s.updatedAt || s.createdAt, true))}</td>
                <td style="white-space:nowrap">
                  <a class="btn btn--outline btn--sm" href="#/s/${attr(s.id)}/edit">수정</a>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    mount.innerHTML = `<div class="notice notice--err">불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}

/* ----------------------------------------------------------- 제출물 상세 -- */

/** 이 제출물을 볼 권한이 있는지 판단합니다. */
async function accessFor(sub, project) {
  if (isAdmin()) return 'admin';
  const u = unlockState();
  if (u && verifyOwner(sub, u.email, u.code)) return 'owner';
  const q = currentQuery();
  const qcode = q.get('code');
  if (qcode && verifyOwner(sub, sub.author.email, qcode)) {
    setUnlock({ email: sub.author.email, code: qcode.toUpperCase() });
    return 'owner';
  }
  if (project?.visibility === 'public') return 'public';
  return 'none';
}

export async function submissionView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const sub = await store.getSubmission(id);
  if (!sub) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: '제출물을 찾을 수 없습니다',
      body: '삭제되었거나 주소가 잘못되었습니다.',
      action: '<a class="btn btn--outline" href="#/">홈으로</a>',
    })}</div></section>`;
    return;
  }

  const project = await store.getProject(sub.projectId);
  const access = await accessFor(sub, project);

  if (access === 'none') {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">
        이 제출물은 비공개입니다. 본인이라면 <a href="#/my">내 제출물</a>에서
        이메일과 수정코드로 조회하세요.
      </div>
    </div></section>`;
    return;
  }

  const canEdit = access === 'owner' || access === 'admin';
  const editable = canEdit && (access === 'admin' || submissionOpen(project));

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--mid stack-4">
        <p class="crumb">
          <a href="#/">프로젝트</a><span>/</span>
          <a href="#/p/${attr(sub.projectId)}">${esc(project?.title || '프로젝트')}</a><span>/</span>제출물
        </p>

        <div class="page-head">
          <div>
            <h1 class="page-title">${esc(sub.title)}</h1>
            <p class="page-sub">
              ${esc(sub.author.institution || '—')} · ${esc(sub.author.name)}
              ${canEdit ? ` · ${esc(sub.author.email)}` : ''}
            </p>
          </div>
          ${editable ? `
          <div class="row">
            <a class="btn btn--outline" href="#/s/${attr(sub.id)}/edit">수정</a>
            <button class="btn btn--danger" data-del>삭제</button>
          </div>` : ''}
        </div>

        ${canEdit && !editable ? `
        <div class="notice notice--warn">제출이 마감되어 더 이상 수정·삭제할 수 없습니다. 관리자에게 문의하세요.</div>` : ''}

        <div class="card">
          <div class="kv" style="margin-bottom:var(--space-4)">
            <div class="kv__row"><div class="kv__k">제출일</div><div class="kv__v">${esc(fmtDate(sub.createdAt, true))}</div></div>
            <div class="kv__row"><div class="kv__k">최종 수정</div><div class="kv__v">${esc(fmtDate(sub.updatedAt, true))}</div></div>
          </div>
          <h2 style="font-size:1.7rem;margin-bottom:var(--space-2);color:var(--sb-green)">설명</h2>
          <div class="prose">${esc(sub.body)}</div>
        </div>

        <div class="card">
          <h2 style="font-size:1.7rem;margin-bottom:var(--space-3);color:var(--sb-green)">
            첨부파일 <span style="font-weight:400;color:var(--text-black-soft)">${(sub.files || []).length}</span>
          </h2>
          <div id="attach">${spinner()}</div>
        </div>
      </div>
    </section>`;

  await renderAttachments(mount.querySelector('#attach'), sub.files || []);

  const del = mount.querySelector('[data-del]');
  if (del) {
    del.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: '제출물을 삭제할까요?',
        body: `"${sub.title}" 과 첨부파일 ${(sub.files || []).length}건이 영구히 삭제됩니다. 되돌릴 수 없습니다.`,
        confirmLabel: '영구 삭제', danger: true, requireText: '삭제',
      });
      if (!ok) return;
      busy(del, true, '삭제 중…');
      try {
        await store.deleteSubmission(sub.id);
        toastOk('삭제되었습니다.');
        go(isAdmin() ? `/admin/submissions/${sub.projectId}` : '/my');
      } catch (e) {
        busy(del, false);
        toastErr(`삭제에 실패했습니다 — ${e.message}`);
      }
    });
  }
}

/* ----------------------------------------------------------- 제출물 수정 -- */

export async function editSubmissionView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const sub = await store.getSubmission(id);
  if (!sub) { go('/'); return; }
  const project = await store.getProject(sub.projectId);
  const access = await accessFor(sub, project);

  if (access !== 'owner' && access !== 'admin') {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">
        수정 권한이 없습니다. <a href="#/my">내 제출물</a>에서 이메일과 수정코드로 인증하세요.
      </div>
    </div></section>`;
    return;
  }
  if (access === 'owner' && !submissionOpen(project)) {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">제출이 마감되어 수정할 수 없습니다.</div>
    </div></section>`;
    return;
  }

  const removedFiles = [];

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow">
        <p class="crumb"><a href="#/s/${attr(sub.id)}">${esc(sub.title)}</a><span>/</span>수정</p>
        <h1 class="page-title" style="margin-bottom:var(--space-4)">제출물 수정</h1>

        <form id="editForm" class="card" novalidate>
          ${project?.requireInstitution ? `
          <label class="field">
            <span class="field__label">기관명<span class="field__req">*</span></span>
            <input class="input" name="institution" value="${attr(sub.author.institution || '')}" />
          </label>` : ''}
          <div class="field-row field-row--2">
            <label class="field">
              <span class="field__label">성명<span class="field__req">*</span></span>
              <input class="input" name="name" value="${attr(sub.author.name)}" />
            </label>
            <label class="field">
              <span class="field__label">이메일</span>
              <input class="input" value="${attr(sub.author.email)}" disabled />
              <span class="field__hint">이메일은 변경할 수 없습니다.</span>
            </label>
          </div>

          <label class="field">
            <span class="field__label">제목<span class="field__req">*</span></span>
            <input class="input" name="title" maxlength="120" value="${attr(sub.title)}" />
          </label>
          <label class="field">
            <span class="field__label">설명<span class="field__req">*</span></span>
            <textarea class="textarea" name="body" maxlength="8000">${esc(sub.body)}</textarea>
          </label>

          ${project?.allowFiles === false ? '' : `
          <div class="field">
            <span class="field__label">첨부파일</span>
            <div id="picker"></div>
          </div>`}

          <div class="row row--between" style="margin-top:var(--space-4)">
            <a class="btn btn--quiet" href="#/s/${attr(sub.id)}">← 취소</a>
            <button class="btn btn--primary btn--lg" type="submit">변경사항 저장</button>
          </div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector('#editForm');
  const pickerMount = mount.querySelector('#picker');
  const picker = pickerMount
    ? new FilePicker(pickerMount, {
      existing: [...(sub.files || [])],
      onRemoveExisting: (f) => removedFiles.push(f),
    })
    : null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    let ok = true;
    if (form.institution && !form.institution.value.trim()) {
      fieldError(form.institution, '기관명을 입력하세요.'); ok = false;
    }
    if (!form.name.value.trim()) { fieldError(form.name, '성명을 입력하세요.'); ok = false; }
    if (!form.title.value.trim()) { fieldError(form.title, '제목을 입력하세요.'); ok = false; }
    if (!form.body.value.trim()) { fieldError(form.body, '설명을 입력하세요.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '저장 중…');
    try {
      const next = {
        ...sub,
        author: {
          ...sub.author,
          institution: form.institution ? form.institution.value.trim() : sub.author.institution,
          name: form.name.value.trim(),
        },
        title: form.title.value.trim(),
        body: form.body.value.trim(),
        files: picker ? picker.existing : sub.files,
      };
      await store.saveSubmission(next, picker ? picker.files : []);
      for (const f of removedFiles) await store.deleteFile(f);
      toastOk('수정되었습니다.');
      go(`/s/${sub.id}`);
    } catch (err) {
      busy(btn, false);
      toastErr(`저장에 실패했습니다 — ${err.message}`);
    }
  });
}
