/** 프로젝트 상세 · 과제 제출 · 첨부 렌더. */
import {
  store, submissionOpen, closedReason, canSubmit, submitsLate,
  votingOf, votingPhase, VOTE_PHASE_LABEL,
} from '../store/index.js';
import { CONFIG } from '../config.js';
import { esc, attr, fmtDate, fmtBytes, kindOf, downloadLink, normEmail } from '../utils.js';
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
  const vote = votingOf(project);
  const votePhase = votingPhase(project);

  mount.innerHTML = `
    <section class="band" style="padding-block:var(--space-6)">
      <div class="wrap">
        <p class="crumb" style="color:var(--text-white-soft)">
          <a href="#/" style="color:#fff">프로젝트</a><span>/</span>${esc(project.title)}
        </p>
        <div class="row" style="gap:6px;margin-bottom:var(--space-3)">
          <span class="badge ${open ? 'badge--open' : 'badge--closed'}">${open ? '접수중' : '마감'}</span>
          ${project.visibility === 'public' ? '<span class="badge badge--gold">제출물 공개</span>' : ''}
          ${vote ? `<span class="badge badge--gold">${esc(VOTE_PHASE_LABEL[votePhase])}</span>` : ''}
        </div>
        <h1 style="font-size:3.2rem;color:#fff;font-weight:600">${esc(project.title)}</h1>
        <p style="color:var(--text-white-soft);margin-top:var(--space-2);font-size:1.6rem">
          마감 ${esc(fmtDate(project.dueAt, true))}${project.dueAt ? '' : ' — 상시 접수'}
        </p>
        <div class="row" style="margin-top:var(--space-4)">
          ${open
            ? `<a class="btn btn--onDark btn--lg" href="#/p/${attr(project.id)}/submit">과제 제출하기</a>`
            : isAdmin()
              ? `<a class="btn btn--onDark btn--lg" href="#/p/${attr(project.id)}/submit">관리자로 등록하기</a>
                 <span class="btn btn--ghostDark btn--lg" aria-disabled="true">${esc(reason)}</span>`
              : `<span class="btn btn--ghostDark btn--lg" aria-disabled="true">${esc(reason)}</span>`}
          ${vote ? `<a class="btn btn--onDark btn--lg" href="#/vote/${attr(project.id)}">
            ${votePhase === 'open' ? '투표하기' : '투표 결과 보기'}</a>` : ''}
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
              project.visibility === 'public' || vote
                ? '다른 회원도 목록을 볼 수 있습니다 (이메일은 비공개)'
                : '관리자와 본인만 볼 수 있습니다'
            }</div></div>
            ${vote ? `
            <div class="kv__row"><div class="kv__k">상호 투표</div><div class="kv__v">
              ${esc(VOTE_PHASE_LABEL[votePhase])} · 1인당 ${esc(vote.perMember)}표 —
              <a href="#/vote/${attr(project.id)}">투표 화면으로</a>
            </div></div>` : ''}
          </div>
        </div>

        <div id="gallery"></div>
      </div>
    </section>`;

  const gallery = mount.querySelector('#gallery');
  // 투표를 받는 프로젝트는 서로의 제출물을 봐야 하므로 공개 프로젝트와 같이 목록을 폅니다.
  if (project.visibility === 'public' || vote || isAdmin()) {
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

  if (!canSubmit(project, isAdmin())) {
    mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">
      <div class="notice notice--warn">${esc(closedReason(project))}</div>
      <div style="margin-top:var(--space-4)"><a class="btn btn--outline" href="#/p/${attr(project.id)}">프로젝트로 돌아가기</a></div>
    </div></section>`;
    return;
  }

  const me = currentUser();
  // 마감 뒤 등록 — 관리자만 여기까지 옵니다. 결과가 달라지므로 미리 알려줍니다.
  const late = submitsLate(project);

  /**
   * 관리자는 다른 회원 이름으로 등록할 수 있습니다 — 메일로 받은 과제를 대신
   * 올리는 경우가 있습니다. 고를 수 있게 명부를 미리 읽어 둡니다(관리자만 열립니다).
   */
  const members = isAdmin()
    ? (await store.auth.listMembers().catch(() => []))
      .filter((m) => m.email && normEmail(m.email) !== normEmail(me.email))
      .sort((a, b) => String(a.institution || '').localeCompare(String(b.institution || ''), 'ko')
        || String(a.name || '').localeCompare(String(b.name || ''), 'ko'))
    : [];

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow">
        <p class="crumb">
          <a href="#/">프로젝트</a><span>/</span>
          <a href="#/p/${attr(project.id)}">${esc(project.title)}</a><span>/</span>제출
        </p>
        <h1 class="page-title" style="margin-bottom:var(--space-4)">${late ? '과제 등록 (마감 뒤)' : '과제 제출'}</h1>

        ${late ? `
          <div class="notice notice--warn" style="margin-bottom:var(--space-3)">
            <strong>${esc(closedReason(project))}</strong>
            관리자 권한으로 등록합니다. 이 제출물에는 <strong>'마감 후 등록'</strong> 표시가 붙고
            <strong>투표 대상에서 빠집니다.</strong> 목록·제출 현황·내려받기에는 그대로 나옵니다.
          </div>` : ''}

        <div class="card card--flat" style="margin-bottom:var(--space-3)">
          <div class="row row--between" style="gap:var(--space-3)">
            <div class="grow">
              <div class="field__label" style="margin-bottom:2px">제출자</div>
              <div style="font-size:1.5rem" id="authorLine">
                ${esc(me.institution || '—')} · <strong>${esc(me.name)}</strong>
                <span style="color:var(--text-black-soft)"> · ${esc(me.email)}</span>
              </div>
            </div>
            <a class="btn btn--quiet btn--sm" href="#/account">내 계정</a>
          </div>

          ${members.length ? `
            <label class="field" style="margin:var(--space-3) 0 0">
              <span class="field__label">다른 회원 이름으로 등록 (관리자)</span>
              <select class="select" id="authorPick">
                <option value="">나 — ${attr(me.name)}</option>
                ${members.map((m) => `
                  <option value="${attr(m.email)}">${esc(
    `${m.institution || '소속 없음'} · ${m.name} · ${m.email}${m.status === 'blocked' ? ' (정지)' : ''}`)}</option>`).join('')}
              </select>
              <span class="field__hint">
                고른 회원의 제출물로 등록됩니다 — 그 사람의 '내 제출물'과 제출 현황에도 잡힙니다.
                누가 대신 올렸는지는 기록에 남습니다.
              </span>
            </label>` : ''}
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

  // 제출자를 바꾸면 위쪽 안내줄도 함께 바뀝니다 — 누구 이름으로 올리는지 헷갈리지 않도록.
  const pickEl = mount.querySelector('#authorPick');
  const lineEl = mount.querySelector('#authorLine');
  pickEl?.addEventListener('change', () => {
    const m = members.find((x) => x.email === pickEl.value);
    const who = m || me;
    lineEl.innerHTML = `${esc(who.institution || '—')} · <strong>${esc(who.name)}</strong>`
      + `<span style="color:var(--text-black-soft)"> · ${esc(who.email)}</span>`
      + (m ? ' <span class="badge badge--gold">관리자가 대신 등록</span>' : '');
  });
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
      const picked = pickEl?.value || '';
      const target = members.find((m) => m.email === picked) || null;
      const saved = await store.saveSubmission({
        projectId: project.id,
        title: form.title.value,
        body: form.body.value,
        files: [],
        // 서버(R2)는 authorEmail 만 보고 명부에서 이름·기관을 채웁니다.
        // 서버 없는 모드(브라우저·GitHub)에서는 author 를 그대로 저장합니다.
        ...(target ? {
          authorEmail: target.email,
          author: {
            institution: target.institution || '', name: target.name, email: target.email,
          },
          registeredBy: normEmail(me.email),
        } : {}),
        // 서버가 있는 R2 모드에서는 서버가 다시 판정합니다(클라이언트 값은 무시).
        // 서버 없는 모드(브라우저·GitHub)에서는 이 값이 그대로 저장됩니다.
        ...(late ? { late: true } : {}),
      }, picker ? picker.files : []);
      toastOk(target
        ? `${target.name} 님의 제출물로 등록했습니다.${late ? ' (마감 뒤 등록 — 투표 제외)' : ''}`
        : (late ? '마감 뒤 등록으로 저장했습니다. 투표에서는 빠집니다.' : '제출이 완료되었습니다.'));
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
