/** 관리자 — 대시보드, 프로젝트·강의자료·제출물·회원 관리. */
import { store, currentMode, setMode } from '../store/index.js';
import { CONFIG, STORAGE_LABEL } from '../config.js';
import { currentUser, isAdmin, isSimulated } from '../auth.js';
import {
  esc, attr, fmtDate, fmtBytes, toLocalInput, fromLocalInput, csvCell,
  downloadBlob, isPastDue, debounce, firstUrl,
} from '../utils.js';
import {
  spinner, emptyState, toastOk, toastErr, confirmModal, FilePicker,
  fieldError, clearErrors, focusFirstError, busy,
} from '../ui.js';
import { go } from '../router.js';

/* ---------------------------------------------------------- 대시보드 -- */

export async function adminView(mount) {
  const me = currentUser();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap">
        <div class="page-head">
          <div>
            <h1 class="page-title">관리자 대시보드</h1>
            <p class="page-sub">${esc(me.name)} · ${esc(me.email)}</p>
          </div>
          <div class="row">
            <a class="btn btn--primary" href="#/admin/project/new">＋ 프로젝트 개설</a>
            <a class="btn btn--outline" href="#/admin/members">회원 관리</a>
          </div>
        </div>

        <div id="stats" class="stat-row" style="margin-bottom:var(--space-5)">${spinner()}</div>

        <div class="card" style="margin-bottom:var(--space-5)">
          <div class="page-head" style="margin-bottom:var(--space-3)">
            <h2 class="page-title" style="font-size:2rem">프로젝트</h2>
            <div class="row">
              <button class="btn btn--outline btn--sm" data-export-all>전체 백업 내려받기</button>
              <button class="btn btn--outline btn--sm" data-import>백업 복원</button>
            </div>
          </div>
          <div id="adminProjects">${spinner()}</div>
        </div>

        <div class="card" style="margin-bottom:var(--space-5)">
          <div class="page-head" style="margin-bottom:var(--space-3)">
            <h2 class="page-title" style="font-size:2rem">회원</h2>
            <a class="btn btn--outline btn--sm" href="#/admin/members">회원 관리</a>
          </div>
          <div id="adminMembers">${spinner()}</div>
        </div>

        <div class="card" style="margin-bottom:var(--space-5)">
          <div class="page-head" style="margin-bottom:var(--space-3)">
            <h2 class="page-title" style="font-size:2rem">강의자료</h2>
            <div class="row">
              <a class="btn btn--primary btn--sm" href="#/admin/material/new">＋ 자료 등록</a>
              <a class="btn btn--quiet btn--sm" href="#/materials">다운로드 화면 보기</a>
            </div>
          </div>
          <div id="adminMaterials">${spinner()}</div>
        </div>

        <div class="card">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">저장소</h2>
          <div id="storagePanel"></div>
        </div>
      </div>
    </section>`;

  renderStoragePanel(mount.querySelector('#storagePanel'));

  mount.querySelector('[data-export-all]').addEventListener('click', async () => {
    try {
      const dump = await store.exportAll();
      downloadBlob(new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }),
        `assignment-hub-backup-${new Date().toISOString().slice(0, 10)}.json`);
      toastOk('백업 파일을 내려받았습니다. (첨부 원본은 포함되지 않습니다)');
    } catch (e) { toastErr(e.message); }
  });

  mount.querySelector('[data-import]').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const ok = await confirmModal({
        title: '백업을 복원할까요?',
        body: '같은 ID 의 항목은 덮어씁니다. 첨부 원본은 복원되지 않습니다.',
        confirmLabel: '복원', danger: true,
      });
      if (!ok) return;
      try {
        await store.importAll(JSON.parse(await file.text()));
        toastOk('복원되었습니다.');
        adminView(mount);
      } catch (e) { toastErr(`복원 실패 — ${e.message}`); }
    });
    input.click();
  });

  try {
    const [projects, submissions, materials, members] = await Promise.all([
      store.listProjects(), store.listSubmissions(), store.listMaterials(),
      store.auth.listMembers().catch(() => []),
    ]);
    const openCount = projects.filter((p) => p.status === 'open' && !isPastDue(p.dueAt)).length;
    const fileCount = submissions.reduce((n, s) => n + (s.files || []).length, 0);
    const people = new Set(submissions.map((s) => s.author?.email)).size;

    mount.querySelector('#stats').innerHTML = `
      ${stat(projects.length, '전체 프로젝트')}
      ${stat(openCount, '접수중')}
      ${stat(submissions.length, '총 제출물')}
      ${stat(people, '제출 인원')}
      ${stat(fileCount, '첨부 파일')}
      ${stat(materials.length, '강의자료')}
      ${stat(members.length, '회원')}`;

    const counts = new Map();
    submissions.forEach((s) => counts.set(s.projectId, (counts.get(s.projectId) || 0) + 1));

    const holder = mount.querySelector('#adminProjects');
    if (!projects.length) {
      holder.innerHTML = emptyState({
        title: '프로젝트가 없습니다',
        body: '첫 프로젝트를 개설해 제출을 받아보세요.',
        action: '<a class="btn btn--primary" href="#/admin/project/new">프로젝트 개설</a>',
      });
    } else {
      holder.innerHTML = `
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>제목</th><th>상태</th><th>마감</th><th>제출</th><th>공개</th><th></th></tr></thead>
            <tbody>
              ${projects.map((p) => {
                const open = p.status === 'open' && !isPastDue(p.dueAt);
                return `
                <tr>
                  <td><a href="#/p/${attr(p.id)}">${esc(p.title)}</a></td>
                  <td><span class="badge ${open ? 'badge--open' : 'badge--closed'}">${open ? '접수중' : '마감'}</span></td>
                  <td>${esc(fmtDate(p.dueAt, true))}</td>
                  <td class="num"><a href="#/admin/submissions/${attr(p.id)}">${counts.get(p.id) || 0}</a></td>
                  <td>${p.visibility === 'public' ? '공개' : '비공개'}</td>
                  <td style="white-space:nowrap">
                    <a class="btn btn--outline btn--sm" href="#/admin/project/${attr(p.id)}">편집</a>
                    <a class="btn btn--quiet btn--sm" href="#/admin/submissions/${attr(p.id)}">제출물</a>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }

    const memberHolder = mount.querySelector('#adminMembers');
    const active = members.filter((m) => m.status !== 'blocked');
    const admins = members.filter((m) => m.role === 'admin');
    memberHolder.innerHTML = members.length
      ? `<div class="kv">
           <div class="kv__row"><div class="kv__k">전체</div><div class="kv__v">${members.length}명</div></div>
           <div class="kv__row"><div class="kv__k">이용중</div><div class="kv__v">${active.length}명</div></div>
           <div class="kv__row"><div class="kv__k">관리자</div><div class="kv__v">${
             admins.map((m) => esc(m.name)).join(', ') || '—'}</div></div>
           <div class="kv__row"><div class="kv__k">최근 가입</div><div class="kv__v">${
             esc(fmtDate([...members].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0]?.createdAt))
           }</div></div>
         </div>`
      : emptyState({ title: '아직 회원이 없습니다', body: '교육생이 가입하면 이곳에 표시됩니다.' });

    const mHolder = mount.querySelector('#adminMaterials');
    if (!materials.length) {
      mHolder.innerHTML = emptyState({
        title: '등록된 강의자료가 없습니다',
        body: 'PDF 등 수업 자료를 올리면 수강생이 내려받을 수 있습니다.',
        action: '<a class="btn btn--primary" href="#/admin/material/new">자료 등록</a>',
      });
    } else {
      mHolder.innerHTML = `
        <div class="tablewrap">
          <table class="table">
            <thead><tr><th>제목</th><th>회차</th><th>파일</th><th>용량</th><th>등록일</th><th></th></tr></thead>
            <tbody>
              ${materials.map((m) => {
                const bytes = (m.files || []).reduce((n, f) => n + (f.size || 0), 0);
                return `
                <tr>
                  <td>${esc(m.title)}</td>
                  <td>${esc(m.session || '—')}</td>
                  <td class="num">${(m.files || []).length}</td>
                  <td class="num">${esc(bytes ? fmtBytes(bytes) : '—')}</td>
                  <td>${esc(fmtDate(m.createdAt))}</td>
                  <td style="white-space:nowrap">
                    <a class="btn btn--outline btn--sm" href="#/admin/material/${attr(m.id)}">편집</a>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }
  } catch (e) {
    mount.querySelector('#adminProjects').innerHTML =
      `<div class="notice notice--err">불러오지 못했습니다 — ${esc(e.message)}</div>`;
  }
}

/* --------------------------------------------------- 강의자료 등록/편집 -- */

export async function materialFormView(mount, { id }) {
  const isNew = !id || id === 'new';
  const m = isNew ? null : await store.getMaterial(id);
  if (!isNew && !m) { toastErr('강의자료를 찾을 수 없습니다.'); go('/admin'); return; }

  const removedFiles = [];

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow">
        <p class="crumb">
          <a href="#/admin">관리자</a><span>/</span>
          <a href="#/materials">강의자료</a><span>/</span>${isNew ? '등록' : '편집'}
        </p>
        <h1 class="page-title" style="margin-bottom:var(--space-4)">
          ${isNew ? '강의자료 등록' : '강의자료 편집'}
        </h1>

        <form class="card" id="matForm" novalidate>
          <label class="field">
            <span class="field__label">제목<span class="field__req">*</span></span>
            <input class="input" name="title" maxlength="120"
                   placeholder="예) 1강 · AI 리더십 개론" value="${attr(m?.title || '')}" />
          </label>

          <label class="field">
            <span class="field__label">회차 / 분류</span>
            <input class="input" name="session" maxlength="60"
                   placeholder="예) 1주차" value="${attr(m?.session || '')}" />
            <span class="field__hint">목록에서 제목 옆에 표시됩니다. 비워도 됩니다.</span>
          </label>

          <label class="field">
            <span class="field__label">설명</span>
            <textarea class="textarea" name="description" maxlength="2000"
              placeholder="자료 내용이나 참고 사항을 적어주세요.&#10;주소(https://…)를 적으면 목록에서 새 창으로 열리는 바로가기가 생깁니다.">${esc(m?.description || '')}</textarea>
            <span class="field__hint">
              <code>https://</code> 로 시작하는 주소를 적으면 자동으로 링크가 됩니다.
            </span>
          </label>

          <div class="field">
            <span class="field__label">파일</span>
            <div id="matPicker"></div>
            <span class="field__hint">
              설명에 주소를 넣었다면 파일은 없어도 됩니다. (둘 중 하나는 있어야 저장됩니다)
            </span>
          </div>

          <div class="row row--between" style="margin-top:var(--space-4)">
            ${isNew ? '<a class="btn btn--quiet" href="#/admin">← 취소</a>'
              : '<button type="button" class="btn btn--danger" data-delete>자료 삭제</button>'}
            <button class="btn btn--primary btn--lg" type="submit">
              ${isNew ? '등록하기' : '변경사항 저장'}
            </button>
          </div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector('#matForm');
  const picker = new FilePicker(mount.querySelector('#matPicker'), {
    existing: [...(m?.files || [])],
    onRemoveExisting: (f) => removedFiles.push(f),
    policy: CONFIG.materials,
    hint: '강의자료 (PDF 권장)',
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    let ok = true;
    if (!form.title.value.trim()) { fieldError(form.title, '제목을 입력하세요.'); ok = false; }
    // 파일이든 링크든, 수강생이 실제로 열 수 있는 것이 하나는 있어야 합니다.
    if (!picker.total && !firstUrl(form.description.value)) {
      fieldError(mount.querySelector('#matPicker'),
        '파일을 첨부하거나, 설명에 https:// 로 시작하는 주소를 넣어주세요.');
      ok = false;
    }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '저장 중…');
    try {
      await store.saveMaterial({
        ...(m || {}),
        title: form.title.value.trim(),
        session: form.session.value.trim(),
        description: form.description.value.trim(),
        files: picker.existing,
      }, picker.files);
      for (const f of removedFiles) await store.deleteFile(f);
      toastOk(isNew ? '강의자료가 등록되었습니다.' : '저장되었습니다.');
      go('/materials');
    } catch (err) {
      busy(btn, false);
      toastErr(`저장에 실패했습니다 — ${err.message}`);
    }
  });

  const del = mount.querySelector('[data-delete]');
  if (del) {
    del.addEventListener('click', async () => {
      const okConfirm = await confirmModal({
        title: '강의자료를 삭제할까요?',
        body: `"${m.title}" 과 파일 ${(m.files || []).length}건이 영구 삭제됩니다.`,
        confirmLabel: '영구 삭제', danger: true,
      });
      if (!okConfirm) return;
      busy(del, true, '삭제 중…');
      try {
        await store.deleteMaterial(m.id);
        toastOk('삭제되었습니다.');
        go('/materials');
      } catch (e) {
        busy(del, false);
        toastErr(`삭제에 실패했습니다 — ${e.message}`);
      }
    });
  }
}

const stat = (v, k) => `<div class="stat"><div class="stat__v">${esc(v)}</div><div class="stat__k">${esc(k)}</div></div>`;

/* ------------------------------------------------------- 저장소 패널 -- */

function renderStoragePanel(mount) {
  const mode = currentMode();
  const caps = store.capabilities();

  mount.innerHTML = `
    <div class="kv" style="margin-bottom:var(--space-4)">
      <div class="kv__row"><div class="kv__k">현재 모드</div>
        <div class="kv__v"><strong>${esc(STORAGE_LABEL[mode])}</strong></div></div>
      <div class="kv__row"><div class="kv__k">쓰기 가능</div>
        <div class="kv__v">${caps.canWrite ? '예' : '아니오 — 토큰 또는 프록시 필요'}</div></div>
      <div class="kv__row"><div class="kv__k">교육생 제출</div>
        <div class="kv__v">${caps.canPublicWrite ? '토큰 없이 가능' : '토큰 보유자만 가능'}</div></div>

      ${mode === 'r2' ? `
      <div class="kv__row"><div class="kv__k">API</div>
        <div class="kv__v"><code>${esc(store.base)}</code></div></div>
      <div class="kv__row"><div class="kv__k">업로드 한도</div>
        <div class="kv__v">${store.maxUploadMB ? `${esc(store.maxUploadMB)}MB / 파일` : '—'}</div></div>
      <div class="kv__row"><div class="kv__k">회원 인증</div>
        <div class="kv__v">서버에서 확인 — 로그인한 회원만 파일을 받을 수 있습니다</div></div>
      ${store.crossSite ? `
      <div class="kv__row"><div class="kv__k">주의</div>
        <div class="kv__v" style="color:var(--red)">
          API 가 다른 사이트에 있습니다. 세션 쿠키가 전달되지 않아 로그인이 유지되지 않습니다 —
          <code>config.js</code> 의 <code>r2.apiBase</code> 를 같은 도메인으로 두세요.
        </div></div>` : ''}` : ''}

      ${mode === 'github' ? `
      <div class="kv__row"><div class="kv__k">레포</div>
        <div class="kv__v"><code>${esc(CONFIG.github.owner)}/${esc(CONFIG.github.repo)}@${esc(CONFIG.github.branch)}</code></div></div>
      <div class="kv__row"><div class="kv__k">프록시</div>
        <div class="kv__v">${CONFIG.github.proxyUrl ? `<code>${esc(CONFIG.github.proxyUrl)}</code>` : '설정 안 됨'}</div></div>` : ''}
    </div>

    <div class="row" style="margin-bottom:var(--space-3);align-items:flex-end">
      <label class="field" style="margin:0;flex:1 1 220px">
        <span class="field__label">저장소 모드 전환</span>
        <select class="select" id="modeSelect">
          ${['r2', 'github', 'local'].map((m) => `
            <option value="${attr(m)}" ${m === mode ? 'selected' : ''}>${esc(STORAGE_LABEL[m])}</option>
          `).join('')}
        </select>
      </label>
      <button class="btn btn--outline" data-switch>전환</button>
    </div>

    ${mode === 'github' && !CONFIG.github.proxyUrl ? `
    <form id="tokenForm" class="card card--flat">
      <label class="field" style="margin-bottom:var(--space-2)">
        <span class="field__label">GitHub 개인 토큰 (이 브라우저에만 저장)</span>
        <input class="input" name="token" type="password" autocomplete="off"
               placeholder="${store.token ? '등록됨 — 새 토큰으로 교체하려면 입력' : 'github_pat_...'}" />
        <span class="field__hint">
          Fine-grained token · 이 레포에 <code>Contents: Read and write</code> 권한만 부여하세요.
        </span>
      </label>
      <div class="row">
        <button class="btn btn--primary btn--sm" type="submit">토큰 저장</button>
        ${store.token ? '<button class="btn btn--danger btn--sm" type="button" data-cleartoken>토큰 삭제</button>' : ''}
      </div>
    </form>` : ''}

    <div class="notice notice--info" style="margin-top:var(--space-3)">
      ${mode === 'r2'
        ? '파일과 색인이 모두 <strong>Cloudflare R2</strong> 에 저장됩니다. 브라우저는 같은 도메인의 <code>/api</code> 만 호출하고, 버킷 권한은 서버 바인딩으로만 존재합니다.'
        : '<strong>브라우저 저장</strong>은 이 기기에만 데이터가 남습니다. 여러 사람에게 제출을 받으려면 <strong>Cloudflare R2</strong> 모드를 쓰세요.'}
      자세한 설정은 <a href="#/guide#storage">이용안내 → 저장소</a>를 참고하세요.
    </div>`;

  mount.querySelector('[data-switch]').addEventListener('click', async () => {
    const next = mount.querySelector('#modeSelect').value;
    if (next === mode) { toastOk('이미 그 모드입니다.'); return; }
    const ok = await confirmModal({
      title: `${STORAGE_LABEL[next]} 로 전환할까요?`,
      body: '데이터는 자동으로 옮겨지지 않습니다. 필요하면 먼저 백업을 내려받으세요. 페이지가 새로고침됩니다.',
      confirmLabel: '전환',
    });
    if (!ok) return;
    setMode(next);
    location.reload();
  });

  const tokenForm = mount.querySelector('#tokenForm');
  if (tokenForm) {
    tokenForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = tokenForm.token.value.trim();
      if (!v) { toastErr('토큰을 입력하세요.'); return; }
      store.setToken(v);
      toastOk('토큰이 저장되었습니다.');
      renderStoragePanel(mount);
    });
    const clear = mount.querySelector('[data-cleartoken]');
    if (clear) clear.addEventListener('click', () => {
      store.setToken('');
      toastOk('토큰을 삭제했습니다.');
      renderStoragePanel(mount);
    });
  }
}

/* --------------------------------------------------- 프로젝트 개설/편집 -- */

export async function projectFormView(mount, { id }) {
  const isNew = !id || id === 'new';
  const p = isNew ? null : await store.getProject(id);
  if (!isNew && !p) { toastErr('프로젝트를 찾을 수 없습니다.'); go('/admin'); return; }

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow">
        <p class="crumb"><a href="#/admin">관리자</a><span>/</span>${isNew ? '프로젝트 개설' : '프로젝트 편집'}</p>
        <h1 class="page-title" style="margin-bottom:var(--space-4)">
          ${isNew ? '프로젝트 개설' : '프로젝트 편집'}
        </h1>

        <form class="card" id="projForm" novalidate>
          <label class="field">
            <span class="field__label">제목<span class="field__req">*</span></span>
            <input class="input" name="title" maxlength="120"
                   placeholder="예) 1주차 · 브랜드 디자인 시스템 분석" value="${attr(p?.title || '')}" />
          </label>

          <label class="field">
            <span class="field__label">과제 안내<span class="field__req">*</span></span>
            <textarea class="textarea" name="description" maxlength="4000"
              placeholder="제출 범위, 분량, 평가 기준 등을 적어주세요.">${esc(p?.description || '')}</textarea>
          </label>

          <div class="field-row field-row--2">
            <label class="field">
              <span class="field__label">마감일시</span>
              <input class="input" name="dueAt" type="datetime-local" value="${attr(toLocalInput(p?.dueAt))}" />
              <span class="field__hint">비워두면 상시 접수입니다.</span>
            </label>
            <label class="field">
              <span class="field__label">접수 상태</span>
              <select class="select" name="status">
                <option value="open"   ${p?.status !== 'closed' ? 'selected' : ''}>접수중</option>
                <option value="closed" ${p?.status === 'closed' ? 'selected' : ''}>마감</option>
              </select>
            </label>
          </div>

          <label class="field">
            <span class="field__label">제출물 공개 범위</span>
            <select class="select" name="visibility">
              <option value="private" ${p?.visibility !== 'public' ? 'selected' : ''}>비공개 — 관리자와 본인만</option>
              <option value="public"  ${p?.visibility === 'public' ? 'selected' : ''}>공개 — 누구나 목록 열람</option>
            </select>
            <span class="field__hint">공개해도 이메일 주소는 본인·관리자에게만 보입니다.</span>
          </label>

          <label class="check">
            <input type="checkbox" name="requireInstitution" ${p?.requireInstitution !== false ? 'checked' : ''} />
            <span>기관명을 필수 입력으로 받습니다</span>
          </label>
          <label class="check">
            <input type="checkbox" name="allowFiles" ${p?.allowFiles !== false ? 'checked' : ''} />
            <span>파일 첨부를 허용합니다 (이미지·동영상·문서)</span>
          </label>

          <div class="row row--between" style="margin-top:var(--space-4)">
            ${isNew ? '<a class="btn btn--quiet" href="#/admin">← 취소</a>'
              : '<button type="button" class="btn btn--danger" data-delete>프로젝트 삭제</button>'}
            <button class="btn btn--primary btn--lg" type="submit">
              ${isNew ? '개설하기' : '변경사항 저장'}
            </button>
          </div>
        </form>
      </div>
    </section>`;

  const form = mount.querySelector('#projForm');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    let ok = true;
    if (!form.title.value.trim()) { fieldError(form.title, '제목을 입력하세요.'); ok = false; }
    if (!form.description.value.trim()) { fieldError(form.description, '과제 안내를 입력하세요.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '저장 중…');
    try {
      const saved = await store.saveProject({
        ...(p || {}),
        title: form.title.value.trim(),
        description: form.description.value.trim(),
        dueAt: fromLocalInput(form.dueAt.value),
        status: form.status.value,
        visibility: form.visibility.value,
        requireInstitution: form.requireInstitution.checked,
        allowFiles: form.allowFiles.checked,
      });
      toastOk(isNew ? '프로젝트가 개설되었습니다.' : '저장되었습니다.');
      go(`/p/${saved.id}`);
    } catch (err) {
      busy(btn, false);
      toastErr(`저장에 실패했습니다 — ${err.message}`);
    }
  });

  const del = mount.querySelector('[data-delete]');
  if (del) {
    del.addEventListener('click', async () => {
      const subs = await store.listSubmissions({ projectId: p.id });
      const okConfirm = await confirmModal({
        title: '프로젝트를 삭제할까요?',
        body: `제출물 ${subs.length}건과 첨부파일이 함께 영구 삭제됩니다. 되돌릴 수 없습니다.`,
        confirmLabel: '영구 삭제', danger: true, requireText: p.title.slice(0, 20),
      });
      if (!okConfirm) return;
      busy(del, true, '삭제 중…');
      try {
        await store.deleteProject(p.id);
        toastOk('프로젝트가 삭제되었습니다.');
        go('/admin');
      } catch (e) {
        busy(del, false);
        toastErr(`삭제에 실패했습니다 — ${e.message}`);
      }
    });
  }
}

/* ------------------------------------------------------- 제출물 관리 -- */

export async function adminSubmissionsView(mount, { projectId }) {

  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;
  const project = await store.getProject(projectId);
  if (!project) { toastErr('프로젝트를 찾을 수 없습니다.'); go('/admin'); return; }

  const all = await store.listSubmissions({ projectId });

  mount.innerHTML = `
    <section class="section">
      <div class="wrap">
        <p class="crumb">
          <a href="#/admin">관리자</a><span>/</span>
          <a href="#/p/${attr(project.id)}">${esc(project.title)}</a><span>/</span>제출물
        </p>
        <div class="page-head">
          <div>
            <h1 class="page-title">제출물 관리</h1>
            <p class="page-sub">${esc(project.title)} · 총 ${all.length}건</p>
          </div>
          <div class="row">
            <button class="btn btn--outline" data-csv>CSV 내려받기</button>
            <a class="btn btn--quiet" href="#/admin/project/${attr(project.id)}">프로젝트 편집</a>
          </div>
        </div>

        <div class="toolbar">
          <input class="input" id="q" type="search" placeholder="기관 · 성명 · 이메일 · 제목 검색" />
          <select class="select" id="sort">
            <option value="new">최신순</option>
            <option value="old">오래된순</option>
            <option value="name">성명순</option>
            <option value="inst">기관순</option>
          </select>
        </div>

        <div id="rows"></div>
      </div>
    </section>`;

  const rowsEl = mount.querySelector('#rows');
  const qEl = mount.querySelector('#q');
  const sortEl = mount.querySelector('#sort');

  const draw = () => {
    const q = qEl.value.trim().toLowerCase();
    let rows = all.filter((s) => {
      if (!q) return true;
      return [s.author?.institution, s.author?.name, s.author?.email, s.title]
        .some((v) => String(v || '').toLowerCase().includes(q));
    });

    const sorters = {
      new:  (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
      old:  (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
      name: (a, b) => (a.author?.name || '').localeCompare(b.author?.name || '', 'ko'),
      inst: (a, b) => (a.author?.institution || '').localeCompare(b.author?.institution || '', 'ko'),
    };
    rows = rows.sort(sorters[sortEl.value]);

    if (!rows.length) {
      rowsEl.innerHTML = emptyState({
        title: all.length ? '검색 결과가 없습니다' : '아직 제출물이 없습니다',
        body: all.length ? '다른 검색어로 시도해 보세요.' : '교육생이 제출하면 이곳에 표시됩니다.',
      });
      return;
    }

    rowsEl.innerHTML = `
      <div class="tablewrap">
        <table class="table">
          <thead>
            <tr><th>#</th><th>기관명</th><th>성명</th><th>이메일</th><th>제목</th>
                <th>첨부</th><th>용량</th><th>제출일</th><th></th></tr>
          </thead>
          <tbody>
            ${rows.map((s, i) => {
              const bytes = (s.files || []).reduce((n, f) => n + (f.size || 0), 0);
              return `
              <tr>
                <td class="num">${i + 1}</td>
                <td>${esc(s.author?.institution || '—')}</td>
                <td>${esc(s.author?.name || '—')}</td>
                <td><a href="mailto:${attr(s.author?.email || '')}">${esc(s.author?.email || '—')}</a></td>
                <td><a href="#/s/${attr(s.id)}">${esc(s.title)}</a></td>
                <td class="num">${(s.files || []).length}</td>
                <td class="num">${esc(bytes ? fmtBytes(bytes) : '—')}</td>
                <td>${esc(fmtDate(s.createdAt, true))}</td>
                <td style="white-space:nowrap">
                  <a class="btn btn--quiet btn--sm" href="#/s/${attr(s.id)}">보기</a>
                  <button class="btn btn--quiet btn--sm" data-del="${attr(s.id)}"
                          style="color:var(--red)">삭제</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    rowsEl.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sid = btn.dataset.del;
        const sub = all.find((x) => x.id === sid);
        const ok = await confirmModal({
          title: '제출물을 삭제할까요?',
          body: `"${sub?.title}" 과 첨부파일이 영구 삭제됩니다.`,
          confirmLabel: '영구 삭제', danger: true,
        });
        if (!ok) return;
        try {
          await store.deleteSubmission(sid);
          toastOk('삭제되었습니다.');
          adminSubmissionsView(mount, { projectId });
        } catch (e) { toastErr(`삭제 실패 — ${e.message}`); }
      });
    });
  };

  qEl.addEventListener('input', debounce(draw, 200));
  sortEl.addEventListener('change', draw);
  draw();

  mount.querySelector('[data-csv]').addEventListener('click', () => {
    const header = ['번호', '기관명', '성명', '이메일', '제목', '설명', '첨부수', '첨부목록', '제출일시', '수정일시', '제출ID'];
    const lines = [header.map(csvCell).join(',')];
    all.forEach((s, i) => {
      lines.push([
        i + 1,
        s.author?.institution || '',
        s.author?.name || '',
        s.author?.email || '',
        s.title || '',
        s.body || '',
        (s.files || []).length,
        (s.files || []).map((f) => f.name).join(' | '),
        fmtDate(s.createdAt, true),
        fmtDate(s.updatedAt, true),
        s.id,
      ].map(csvCell).join(','));
    });
    // Excel 이 UTF-8 로 열도록 BOM 을 붙입니다.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `제출물_${project.title.slice(0, 20)}_${new Date().toISOString().slice(0, 10)}.csv`);
    toastOk('CSV 를 내려받았습니다.');
  });
}


/* ---------------------------------------------------------- 회원 관리 -- */

export async function membersView(mount) {
  mount.innerHTML = `
    <section class="section">
      <div class="wrap">
        <p class="crumb"><a href="#/admin">관리자</a><span>/</span>회원</p>
        <div class="page-head">
          <div>
            <h1 class="page-title">회원 관리</h1>
            <p class="page-sub">가입한 교육생을 확인하고 권한·이용 상태를 조정합니다.</p>
          </div>
          <button class="btn btn--outline" data-csv>CSV 내려받기</button>
        </div>

        ${isSimulated() ? `
          <div class="notice notice--warn" style="margin-bottom:var(--space-3)">
            <strong>시연용 계정입니다.</strong> 지금 저장소가 서버 없는 모드라
            회원 정보가 이 브라우저에만 있습니다. 실제 운영은 R2 모드에서 하세요.
          </div>` : ''}

        <div class="toolbar">
          <input class="input" id="q" type="search" placeholder="기관 · 성명 · 이메일 검색" />
          <select class="select" id="filter">
            <option value="all">전체</option>
            <option value="active">이용중만</option>
            <option value="blocked">정지만</option>
            <option value="admin">관리자만</option>
          </select>
        </div>

        <div id="memberRows">${spinner()}</div>
      </div>
    </section>`;

  const rowsEl = mount.querySelector('#memberRows');
  const qEl = mount.querySelector('#q');
  const filterEl = mount.querySelector('#filter');
  const me = currentUser();
  let all = [];

  const draw = () => {
    const q = qEl.value.trim().toLowerCase();
    let rows = all.filter((m) => {
      if (filterEl.value === 'active' && m.status === 'blocked') return false;
      if (filterEl.value === 'blocked' && m.status !== 'blocked') return false;
      if (filterEl.value === 'admin' && m.role !== 'admin') return false;
      if (!q) return true;
      return [m.institution, m.name, m.email].some((v) => String(v || '').toLowerCase().includes(q));
    }).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    if (!rows.length) {
      rowsEl.innerHTML = emptyState({
        title: all.length ? '검색 결과가 없습니다' : '아직 회원이 없습니다',
        body: all.length ? '다른 검색어로 시도해 보세요.' : '교육생이 가입하면 이곳에 표시됩니다.',
      });
      return;
    }

    rowsEl.innerHTML = `
      <div class="tablewrap">
        <table class="table">
          <thead><tr><th>기관명</th><th>성명</th><th>이메일</th><th>권한</th><th>상태</th>
                     <th>가입일</th><th>최근 로그인</th><th></th></tr></thead>
          <tbody>
            ${rows.map((m) => {
              const self = m.email === me.email;
              return `
              <tr>
                <td>${esc(m.institution || '—')}</td>
                <td>${esc(m.name)}</td>
                <td><a href="mailto:${attr(m.email)}">${esc(m.email)}</a></td>
                <td>${m.role === 'admin' ? '<span class="badge badge--gold">관리자</span>' : '회원'}</td>
                <td>${m.status === 'blocked'
                  ? '<span class="badge badge--due">정지</span>'
                  : '<span class="badge badge--open">이용중</span>'}</td>
                <td>${esc(fmtDate(m.createdAt))}</td>
                <td>${esc(m.lastLoginAt ? fmtDate(m.lastLoginAt, true) : '—')}</td>
                <td style="white-space:nowrap">
                  ${self ? '<span style="color:var(--text-black-mute);font-size:1.3rem">본인</span>' : `
                    <button class="btn btn--quiet btn--sm" data-reset="${attr(m.email)}">비밀번호 초기화</button>
                    <button class="btn btn--quiet btn--sm" data-role="${attr(m.email)}"
                            data-next="${m.role === 'admin' ? 'member' : 'admin'}">
                      ${m.role === 'admin' ? '관리자 해제' : '관리자로'}
                    </button>
                    <button class="btn btn--quiet btn--sm" data-status="${attr(m.email)}"
                            data-next="${m.status === 'blocked' ? 'active' : 'blocked'}"
                            style="color:${m.status === 'blocked' ? 'var(--moss, var(--sb-green))' : 'var(--red)'}">
                      ${m.status === 'blocked' ? '정지 해제' : '이용 정지'}
                    </button>`}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    rowsEl.querySelectorAll('[data-role], [data-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.role || btn.dataset.status;
        const change = btn.dataset.role
          ? { role: btn.dataset.next }
          : { status: btn.dataset.next };
        const label = btn.dataset.role
          ? (change.role === 'admin' ? '관리자로 올릴까요?' : '관리자 권한을 뺄까요?')
          : (change.status === 'blocked' ? '이용을 정지할까요?' : '정지를 풀까요?');

        const ok = await confirmModal({
          title: label,
          body: `${email}\n정지하면 로그인과 기존 세션이 모두 막힙니다.`,
          confirmLabel: '적용', danger: change.status === 'blocked',
        });
        if (!ok) return;
        try {
          await store.auth.patchMember(email, change);
          toastOk('적용되었습니다.');
          await load();
        } catch (e) { toastErr(e.message); }
      });
    });

    rowsEl.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.reset;
        const ok = await confirmModal({
          title: '비밀번호를 초기화할까요?',
          body: `${email} 의 비밀번호가 임시 비밀번호로 바뀝니다.\n메일 발송 기능이 없으니 화면에 뜨는 값을 본인에게 직접 전달해 주세요.`,
          confirmLabel: '초기화', danger: true,
        });
        if (!ok) return;
        try {
          const temp = await store.auth.resetPassword(email);
          await confirmModal({
            title: '임시 비밀번호',
            body: `${email}\n\n${temp}\n\n이 값을 본인에게 전달하세요. 창을 닫으면 다시 볼 수 없습니다.`,
            confirmLabel: '확인했습니다', cancelLabel: '닫기',
          });
          await load();
        } catch (e) { toastErr(e.message); }
      });
    });
  };

  const load = async () => {
    try {
      all = await store.auth.listMembers();
      draw();
    } catch (e) {
      rowsEl.innerHTML = `<div class="notice notice--err">회원 목록을 불러오지 못했습니다 — ${esc(e.message)}</div>`;
    }
  };

  qEl.addEventListener('input', debounce(draw, 200));
  filterEl.addEventListener('change', draw);

  mount.querySelector('[data-csv]').addEventListener('click', () => {
    const header = ['번호', '기관명', '성명', '이메일', '권한', '상태', '가입일', '최근 로그인'];
    const lines = [header.map(csvCell).join(',')];
    all.forEach((m, i) => {
      lines.push([
        i + 1, m.institution || '', m.name, m.email,
        m.role === 'admin' ? '관리자' : '회원',
        m.status === 'blocked' ? '정지' : '이용중',
        fmtDate(m.createdAt), m.lastLoginAt ? fmtDate(m.lastLoginAt, true) : '',
      ].map(csvCell).join(','));
    });
    downloadBlob(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
      `회원목록_${new Date().toISOString().slice(0, 10)}.csv`);
    toastOk('CSV 를 내려받았습니다.');
  });

  await load();
}
