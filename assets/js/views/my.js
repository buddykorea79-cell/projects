/** 내 제출물 — 로그인한 회원의 제출물 목록·상세·수정. */
import { store, submissionOpen } from '../store/index.js';
import { esc, attr, fmtDate } from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, confirmModal, FilePicker,
  fieldError, clearErrors, focusFirstError, busy,
} from '../ui.js';
import { isAdmin, currentUser } from '../auth.js';
import { go } from '../router.js';
import { renderAttachments } from './project.js';

const isMine = (sub) => {
  const me = currentUser();
  return Boolean(me && sub?.author?.email && sub.author.email === me.email);
};

/* ------------------------------------------------------------- 목록 -- */

export async function myView(mount) {
  const me = currentUser();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--mid">
        <div class="page-head">
          <div>
            <h1 class="page-title">내 제출물</h1>
            <p class="page-sub">${esc(me.institution || '')} · ${esc(me.name)} · ${esc(me.email)}</p>
          </div>
          <a class="btn btn--quiet" href="#/account">내 계정</a>
        </div>
        <div id="myResult">${spinner()}</div>
      </div>
    </section>`;

  const holder = mount.querySelector('#myResult');
  try {
    const rows = await store.listSubmissions({ email: me.email });
    if (!rows.length) {
      holder.innerHTML = emptyState({
        title: '아직 제출한 과제가 없습니다',
        body: '프로젝트를 열어 첫 과제를 제출해 보세요.',
        action: '<a class="btn btn--primary" href="#/">프로젝트 보러 가기</a>',
      });
      return;
    }

    const projects = await store.listProjects();
    const byId = new Map(projects.map((p) => [p.id, p]));

    holder.innerHTML = `
      <div class="tablewrap">
        <table class="table">
          <thead><tr><th>프로젝트</th><th>제목</th><th>첨부</th><th>최종 수정</th><th></th></tr></thead>
          <tbody>
            ${rows.map((s) => {
              const p = byId.get(s.projectId);
              const open = submissionOpen(p);
              return `
              <tr>
                <td>${esc(p?.title || '(삭제된 프로젝트)')}</td>
                <td><a href="#/s/${attr(s.id)}">${esc(s.title)}</a></td>
                <td class="num">${(s.files || []).length}</td>
                <td>${esc(fmtDate(s.updatedAt || s.createdAt, true))}</td>
                <td style="white-space:nowrap">
                  ${open
                    ? `<a class="btn btn--outline btn--sm" href="#/s/${attr(s.id)}/edit">수정</a>`
                    : '<span class="badge badge--closed">마감</span>'}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    holder.innerHTML = `<div class="notice notice--err">불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}

/* ----------------------------------------------------------- 상세 -- */

export async function submissionView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const sub = await store.getSubmission(id);
  if (!sub) {
    // 서버가 권한에 맞게 걸러 주므로, 없다는 건 없거나 볼 수 없다는 뜻입니다.
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: '제출물을 볼 수 없습니다',
      body: '삭제되었거나, 본인 또는 관리자만 볼 수 있는 제출물입니다.',
      action: '<a class="btn btn--outline" href="#/my">내 제출물로</a>',
    })}</div></section>`;
    return;
  }

  const project = await store.getProject(sub.projectId);
  const mine = isMine(sub);
  const canEdit = mine || isAdmin();
  const editable = canEdit && (isAdmin() || submissionOpen(project));

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
              ${esc(sub.author?.institution || '—')} · ${esc(sub.author?.name || '—')}
              ${sub.author?.email ? ` · ${esc(sub.author.email)}` : ''}
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
        go(isAdmin() && !isMine(sub) ? `/admin/submissions/${sub.projectId}` : '/my');
      } catch (e) {
        busy(del, false);
        toastErr(`삭제에 실패했습니다 — ${e.message}`);
      }
    });
  }
}

/* ----------------------------------------------------------- 수정 -- */

export async function editSubmissionView(mount, { id }) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;

  const sub = await store.getSubmission(id);
  if (!sub) { go('/my'); return; }

  const project = await store.getProject(sub.projectId);
  const mine = isMine(sub);

  if (!mine && !isAdmin()) {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">본인 제출물만 수정할 수 있습니다.</div>
      <div style="margin-top:var(--space-4)"><a class="btn btn--outline" href="#/my">내 제출물로</a></div>
    </div></section>`;
    return;
  }
  if (!isAdmin() && !submissionOpen(project)) {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">제출이 마감되어 수정할 수 없습니다.</div>
    </div></section>`;
    return;
  }

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow">
        <p class="crumb"><a href="#/s/${attr(sub.id)}">${esc(sub.title)}</a><span>/</span>수정</p>
        <h1 class="page-title" style="margin-bottom:var(--space-4)">제출물 수정</h1>

        <form id="editForm" class="card" novalidate>
          <div class="field-row field-row--2">
            <label class="field">
              <span class="field__label">기관명</span>
              <input class="input" name="institution" value="${attr(sub.author?.institution || '')}" />
            </label>
            <label class="field">
              <span class="field__label">성명</span>
              <input class="input" name="name" value="${attr(sub.author?.name || '')}" />
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
    ? new FilePicker(pickerMount, { existing: [...(sub.files || [])] })
    : null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    let ok = true;
    if (!form.name.value.trim()) { fieldError(form.name, '성명을 입력하세요.'); ok = false; }
    if (!form.title.value.trim()) { fieldError(form.title, '제목을 입력하세요.'); ok = false; }
    if (!form.body.value.trim()) { fieldError(form.body, '설명을 입력하세요.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '저장 중…');
    try {
      // 색인에서 빠진 첨부는 서버가 버킷에서도 함께 정리합니다.
      await store.saveSubmission({
        ...sub,
        author: {
          ...sub.author,
          institution: form.institution.value.trim(),
          name: form.name.value.trim(),
        },
        title: form.title.value.trim(),
        body: form.body.value.trim(),
        files: picker ? picker.existing : sub.files,
      }, picker ? picker.files : []);
      toastOk('수정되었습니다.');
      go(`/s/${sub.id}`);
    } catch (err) {
      busy(btn, false);
      toastErr(`저장에 실패했습니다 — ${err.message}`);
    }
  });
}
