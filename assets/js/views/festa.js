/** 페스타 접수·접수증·회원 심사·관리자 운영 화면. */
import { festa, FESTA_RUBRIC as RUBRIC, validFestaScores as validScores } from '../festa.js';
import { currentUser, isAdmin } from '../auth.js';
import { esc, attr, fmtDate, fmtBytes, isEmail } from '../utils.js';
import { spinner, emptyState, toastOk, toastErr, confirmModal } from '../ui.js';

const TITLE = '말하는 대로, 바이브 코딩 페스타';
const FILE_LIMIT = 30 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_ENTRIES = 2;
const DEFAULT_DEADLINE = '2027-12-07';
const FILE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'hwp', 'hwpx', 'zip', 'txt', 'md', 'csv', 'mp4', 'mov', 'webm'];
const PHASES = {
  open: { label: '접수 중', badge: 'badge--open' },
  closed: { label: '접수 마감', badge: 'badge--closed' },
  judging: { label: '심사 중', badge: 'badge--gold' },
  finished: { label: '평가 마감', badge: 'badge--closed' },
};

function phaseBadge(phase) {
  const item = PHASES[phase] || PHASES.closed;
  return `<span class="badge ${item.badge}">${item.label}</span>`;
}

function deadlineOf(state) {
  return /^\d{4}-\d{2}-\d{2}$/.test(state.deadline || '') ? state.deadline : DEFAULT_DEADLINE;
}

function deadlineTime(state) { return Date.parse(`${deadlineOf(state)}T23:59:59.999+09:00`); }
function deadlinePassed(state) { return state.deadlinePassed === true || Date.now() > deadlineTime(state); }
function submissionsOpen(state) { return state.phase === 'open' && !deadlinePassed(state); }

function deadlineHtml(state) {
  const date = deadlineOf(state).split('-');
  const passed = deadlinePassed(state);
  return `<section class="card card--flat festa-deadline" data-testid="festa-deadline" aria-label="접수 마감 안내">
    <div class="festa-entry-head"><div><p class="field__label"><span aria-hidden="true">🗓️</span> 작품 접수 마감</p><p class="festa-total" style="font-size:2rem"><time datetime="${attr(deadlineOf(state))}T23:59:59+09:00">${date[0]}년 ${Number(date[1])}월 ${Number(date[2])}일 23:59:59</time></p><p class="field__hint">한국시간 (Asia/Seoul) · 1인 최대 2작품</p></div>${phaseBadge(state.phase === 'open' && passed ? 'closed' : state.phase)}</div>
    <p class="field__hint" data-deadline-message>${state.phase !== 'open' ? '운영자가 접수를 마감했습니다. 신규 제출과 수정은 할 수 없습니다.' : passed ? '접수 기한이 지났습니다. 신규 제출·수정·파일 업로드가 마감되었습니다.' : '마감 시각까지 작품 제출과 수정, 파일 업로드를 완료해 주세요.'}</p>
  </section>`;
}

/** 화면을 열어 둔 상태로 한국시간 마감 시각을 지나도 입력을 막습니다. */
function watchDeadline(root, state, expire) {
  let timer;
  const check = () => {
    if (!root.isConnected || state.phase !== 'open') return;
    if (deadlinePassed(state)) {
      state.deadlinePassed = true;
      const holder = root.querySelector('[data-testid="festa-deadline"]');
      if (holder) holder.outerHTML = deadlineHtml(state);
      expire?.();
      return;
    }
    timer = setTimeout(check, Math.min(60000, Math.max(100, deadlineTime(state) - Date.now() + 20)));
  };
  check();
  return () => clearTimeout(timer);
}

/** 작품 주소에는 http(s)만 허용합니다. 첨부 주소만 같은 사이트 상대 경로를 받습니다. */
function safeUrl(value, relative = false) {
  if (!value) return null;
  if (/[\u0000-\u0020\u007f]/.test(String(value))) return null;
  try {
    const url = relative ? new URL(String(value), window.location.origin) : new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function validGithub(value) {
  const safe = safeUrl(value);
  if (!safe) return false;
  const url = new URL(safe);
  return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && /^\/[^/]+\/[^/]+(?:\/|$)/.test(url.pathname);
}

function fileIssue(file) {
  if (file.size > FILE_LIMIT) return '30MB를 초과합니다. 이 파일을 제외하고 이메일로 보내 주세요.';
  if (!FILE_EXTENSIONS.includes(String(file.name).split('.').pop().toLowerCase())) return '지원하지 않는 파일 형식입니다. 소스 코드는 ZIP 파일로 묶어 주세요.';
  if (!file.size) return '빈 파일은 첨부할 수 없습니다.';
  return null;
}

function entryLinks(entry) {
  const links = [[entry.deployUrl, '작품 실행하기'], [entry.githubUrl, 'GitHub 저장소 보기']]
    .map(([value, label]) => {
      const url = safeUrl(value);
      return url ? `<a class="btn btn--outline btn--sm" href="${attr(url)}" target="_blank" rel="noopener noreferrer">${label}<span class="sr-only"> (새 창)</span></a>` : '';
    }).join('');
  return `<div class="row">${entry.localOnly ? '<span class="badge badge--soft">로컬 실행 작품</span>' : ''}${links}</div>`;
}

async function attachments(files = []) {
  if (!files.length) return '<p class="field__hint">첨부 파일 없음</p>';
  const rows = await Promise.all(files.map(async (file) => {
    let url = null;
    try { url = safeUrl(await festa.fileUrl(file), true); } catch { /* 파일 한 개의 오류가 전체 접수를 가리지 않습니다. */ }
    return `<li class="fileitem festa-file-row">
      <div class="grow"><span class="fileitem__name">${esc(file.name || '첨부 파일')}</span><span class="field__hint">${esc(fmtBytes(file.size))}</span></div>
      ${url ? `<a class="btn btn--outline btn--sm" href="${attr(url)}" target="_blank" rel="noopener noreferrer">내려받기<span class="sr-only">: ${esc(file.name)} (새 창)</span></a>` : '<span class="field__err">파일 주소를 불러오지 못했습니다.</span>'}
    </li>`;
  }));
  return `<ul class="filelist" aria-label="첨부 파일 목록">${rows.join('')}</ul>`;
}

function mailHelp(email) {
  const value = String(email || '').trim();
  const at = value.lastIndexOf('@');
  const domain = value.slice(at + 1);
  const valid = isEmail(value) && /^[\p{L}\p{N}.-]+$/u.test(domain);
  const recipient = valid ? `${encodeURIComponent(value.slice(0, at))}@${domain}` : '';
  return valid
    ? `30MB를 초과하는 파일은 <a href="mailto:${attr(recipient)}">${esc(value)}</a>로 보내 주세요. 이메일 제목에 작품명과 제출자명을 적어 주세요. 이메일로 보낸 파일은 온라인 접수증에 자동으로 표시되지 않습니다.`
    : '30MB를 초과하는 파일은 이메일로 제출해 주세요. 받을 이메일 주소는 운영자에게 문의해 주세요. 이메일 제목에 작품명과 제출자명을 적어 주세요. 이메일로 보낸 파일은 온라인 접수증에 자동으로 표시되지 않습니다.';
}

function rubricHtml() {
  return `<details class="card card--flat" open>
    <summary><strong>심사 기준 · 총 100점</strong></summary>
    <div class="festa-score-grid" style="margin-top:var(--space-3)">${RUBRIC.map((rule) => `
      <div><h3 style="font-size:1.6rem">${rule.name} <span class="badge badge--soft">${rule.max}점</span></h3><p class="field__hint">${rule.description}</p></div>`).join('')}
    </div>
  </details>`;
}

function shell(mount, admin = false) {
  mount.innerHTML = `<section class="band festa-hero"><div class="wrap">
    <p class="crumb"><a href="#/" style="color:inherit">홈</a><span>/</span>페스타${admin ? ' 관리' : ''}</p>
    <h1 style="font-size:clamp(2.4rem,5vw,3.4rem);color:inherit">${TITLE}</h1>
    <p style="margin-top:var(--space-2)">${admin ? '접수 현황과 심사 결과를 확인하고 운영 단계를 변경합니다.' : '직접 만든 작품을 소개하고, 함께 살펴보며 평가해 주세요.'}</p>
    <div class="row" style="margin-top:var(--space-3)">${admin
      ? '<a class="btn btn--ghostDark" href="#/admin">관리자 홈</a><a class="btn btn--ghostDark" href="#/festa">회원 화면 보기</a><a class="btn btn--ghostDark" href="#/admin/festa/practice" data-testid="festa-practice-link">샘플 작품 10건 · 평가 연습</a>'
      : (isAdmin() ? '<a class="btn btn--ghostDark" href="#/admin/festa">페스타 관리</a>' : '')}</div>
  </div></section><section class="section"><div class="wrap festa-stack" data-festa-root>${spinner()}</div></section>`;
  return mount.querySelector('[data-festa-root]');
}

async function receiptHtml(entry, state, index) {
  const heading = `festaReceiptTitle${index}`;
  return `<section class="card festa-receipt" data-testid="festa-receipt" data-entry-id="${attr(entry.id)}" aria-labelledby="${heading}" tabindex="-1">
    <div class="festa-entry-head"><div><span class="badge badge--open">제출 완료</span><h2 id="${heading}" class="page-title" style="font-size:2.2rem;margin-top:var(--space-2)"><span aria-hidden="true">🎟️</span> 작품 ${index + 1} 접수증</h2></div>
      ${submissionsOpen(state) ? `<button type="button" class="btn btn--outline" data-testid="festa-edit-entry" data-entry-id="${attr(entry.id)}">이 작품 수정</button>` : phaseBadge(state.phase === 'open' ? 'closed' : state.phase)}
    </div>
    <h3 style="margin-top:var(--space-3)">${esc(entry.title)}</h3>
    <p class="page-sub">${esc(entry.author?.institution || '')} · ${esc(entry.author?.name || currentUser()?.name || '')}</p>
    <p class="field__hint">최초 접수 ${esc(fmtDate(entry.createdAt, true))} · 최종 저장 ${esc(fmtDate(entry.updatedAt || entry.createdAt, true))}</p>
    <p class="field__hint">접수 번호: ${esc(entry.id)}</p>
    <p class="festa-description" style="margin-block:var(--space-3)">${esc(entry.description)}</p>
    ${entryLinks(entry)}
    <div style="margin-top:var(--space-3)">${await attachments(entry.files)}</div>
    <p class="field__hint" data-receipt-edit-message>${submissionsOpen(state) ? '이 작품의 수정 버튼을 눌러 내용을 바꿀 수 있습니다. 다른 작품과 접수 번호는 유지됩니다.' : '접수가 마감되어 제출 내용을 수정할 수 없습니다.'}</p>
  </section>`;
}

function editorHtml(entry, email, count, draft = null) {
  const values = draft || entry || {};
  return `<section class="card" data-festa-editor aria-labelledby="festaFormTitle">
    <h2 id="festaFormTitle" class="page-title" style="font-size:2.2rem"><span aria-hidden="true">✍️</span> ${entry ? '선택한 작품 수정' : count ? '두 번째 작품 제출' : '첫 작품 제출'}</h2>
    <p class="page-sub">${entry ? `수정 중인 작품: ${esc(entry.title)} · 접수 번호 ${esc(entry.id)}` : `개인별 최대 2작품을 접수합니다. 현재 ${count}작품이 접수되어 있습니다.`} 이름과 기관은 내 계정 정보로 기록됩니다.</p>
    <form data-testid="festa-entry-form" data-entry-id="${attr(entry?.id || '')}" style="margin-top:var(--space-4)">
      <fieldset style="border:0;padding:0;margin:0;min-width:0" data-festa-fields>
        <label class="field"><span class="field__label"><span aria-hidden="true">💡</span> 작품명 <span class="field__req">*</span></span><input class="input" name="title" required maxlength="160" value="${attr(values.title || '')}" /></label>
        <label class="field"><span class="field__label"><span aria-hidden="true">🌐</span> 배포 주소 <span class="field__req">*</span></span><input class="input" type="text" inputmode="url" name="deployUrl" maxlength="2048" ${values.localOnly ? 'readonly' : 'required'} placeholder="https://example.com" value="${attr(values.localOnly ? 'Local' : values.deployUrl || '')}" aria-describedby="festaDeployHelp" /><span class="field__hint" id="festaDeployHelp">인터넷에서 실행할 수 있는 전체 주소를 입력해 주세요. 로컬 실행을 선택하면 Local로 표시됩니다.</span></label>
        <label class="field"><span class="row"><input type="checkbox" name="localOnly" ${values.localOnly ? 'checked' : ''} /> 로컬에서 동작</span><span class="field__hint">내 컴퓨터에서 실행하는 작품은 체크해 주세요. 체크를 해제하면 입력해 둔 배포 주소가 복구됩니다.</span></label>
        <label class="field"><span class="field__label"><span aria-hidden="true">📦</span> GitHub 저장소 주소 <span class="field__req">*</span></span><input class="input" type="url" name="githubUrl" required maxlength="2048" placeholder="https://github.com/사용자/저장소" value="${attr(values.githubUrl || '')}" /><span class="field__hint">로컬 실행 작품도 GitHub 저장소 주소를 입력해 주세요.</span></label>
        <label class="field"><span class="field__label"><span aria-hidden="true">📝</span> 작품 설명 <span class="field__req">*</span></span><textarea class="input" name="description" required maxlength="10000" rows="16" style="min-height:32rem" aria-describedby="festaDescriptionHelp" placeholder="해결하려는 문제부터 실제 작동 예와 활용 가능성까지 자세히 소개해 주세요.">${esc(values.description || '')}</textarea></label>
        <div class="notice notice--info festa-writing-guide" id="festaDescriptionHelp"><strong>설명 작성 가이드 · 최대 10,000자</strong><ul>
          <li><strong>문제 인식(40점)</strong> — 누가 어떤 업무에서 얼마나 자주 불편을 겪는지 적어 주세요.</li>
          <li><strong>기능 구현 수준(30점)</strong> — 입력 → 처리 → 결과 예와 실행 방법을 설명해 주세요.</li>
          <li><strong>완성도(20점)</strong> — 오류 처리, 테스트, 접근성을 어떻게 확인했는지 적어 주세요.</li>
          <li><strong>확산 가능성(10점)</strong> — 적용 가능한 부서와 도입 조건을 소개해 주세요.</li>
        </ul><p class="field__hint">로컬 작품은 설치·실행 방법과 시연 순서를 꼭 포함해 주세요.</p></div>
        <label class="field"><span class="field__label">첨부 파일</span><input class="input" type="file" multiple accept="${FILE_EXTENSIONS.map((extension) => `.${extension}`).join(',')}" data-testid="festa-upload-input" aria-describedby="festaFileHelp" /><span class="field__hint" id="festaFileHelp">최대 10개, 파일당 30MB(30MiB) 이하. 문서·이미지·동영상·ZIP을 첨부할 수 있습니다. 소스 코드는 ZIP 파일로 묶어 주세요. 파일을 선택한 뒤 아래 저장 버튼을 눌러야 접수에 반영됩니다.</span></label>
        <p class="notice notice--info">${mailHelp(email)}</p>
        <ul class="filelist" data-testid="festa-file-list" aria-label="제출할 첨부 파일" style="margin-block:var(--space-3)"></ul>
        <div class="row"><button class="btn btn--primary" type="submit" data-testid="festa-save-entry">${entry ? '수정 내용 저장' : '새 작품 제출하기'}</button>${count ? '<button class="btn btn--quiet" type="button" data-festa-cancel>접수증으로 돌아가기</button>' : ''}</div>
      </fieldset>
      <div data-testid="festa-form-status" role="status" aria-live="polite" style="margin-top:var(--space-3)"></div>
    </form>
  </section>`;
}

/** 업로드가 일부 실패해도 성공한 파일 키와 입력 내용을 보존해 재시도합니다. */
function bindEditor(root, state, entry, refresh, { draft = null, onCancel } = {}) {
  const form = root.querySelector('[data-testid="festa-entry-form"]');
  if (!form) return;
  const fieldset = form.querySelector('[data-festa-fields]');
  const status = form.querySelector('[data-testid="festa-form-status"]');
  const picker = form.querySelector('[data-testid="festa-upload-input"]');
  const list = form.querySelector('[data-testid="festa-file-list"]');
  let existing = [...(draft?.existing || entry?.files || [])];
  let pending = [...(draft?.pending || [])];
  let busy = false;
  const requestId = draft?.requestId || crypto.randomUUID();
  let previousDeployment = draft?.previousDeployment || (entry?.localOnly ? '' : entry?.deployUrl || '');

  const message = (text, error = false) => {
    status.className = text ? `notice ${error ? 'notice--err' : 'notice--info'}` : '';
    status.setAttribute('role', error ? 'alert' : 'status');
    status.textContent = text;
  };
  const renderFiles = () => {
    list.innerHTML = existing.map((file, index) => `<li class="fileitem festa-file-row"><div class="grow"><span class="fileitem__name">${esc(file.name)}</span><span class="field__hint">${esc(fmtBytes(file.size))} · 접수된 파일</span></div><button type="button" class="btn btn--quiet btn--sm" data-remove-existing="${index}" aria-label="${attr(file.name)} 첨부 제외">제외</button></li>`).join('')
      + pending.map((item, index) => `<li class="fileitem festa-file-row"><div class="grow"><span class="fileitem__name">${esc(item.file.name)}</span><span class="field__hint">${esc(fmtBytes(item.file.size))} · ${item.uploaded ? '업로드 완료 · 제출 전' : '새 첨부'}</span>${item.error ? `<span class="field__err">${esc(item.error)}</span>` : ''}</div><button type="button" class="btn btn--quiet btn--sm" data-remove-pending="${index}" aria-label="${attr(item.file.name)} 선택 취소">제외</button></li>`).join('');
    if (!existing.length && !pending.length) list.innerHTML = '<li class="field__hint">선택한 파일이 없습니다.</li>';
    list.querySelectorAll('[data-remove-existing]').forEach((button) => button.addEventListener('click', () => { if (busy) return; existing.splice(Number(button.dataset.removeExisting), 1); renderFiles(); }));
    list.querySelectorAll('[data-remove-pending]').forEach((button) => button.addEventListener('click', () => { if (busy) return; pending.splice(Number(button.dataset.removePending), 1); renderFiles(); }));
  };
  renderFiles();
  form.elements.localOnly.addEventListener('change', () => {
    const localOnly = form.elements.localOnly.checked;
    form.elements.deployUrl.required = !localOnly;
    form.elements.deployUrl.readOnly = localOnly;
    if (localOnly) {
      previousDeployment = form.elements.deployUrl.value.trim();
      form.elements.deployUrl.value = 'Local';
    } else form.elements.deployUrl.value = previousDeployment;
  });
  form.querySelector('[data-festa-cancel]')?.addEventListener('click', () => {
    onCancel?.();
  });
  picker.addEventListener('change', () => {
    for (const file of Array.from(picker.files || [])) {
      if (pending.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
      pending.push({ file, uploaded: null, error: fileIssue(file) });
    }
    picker.value = '';
    renderFiles();
    if (existing.length + pending.length > MAX_FILES) message('첨부는 최대 10개입니다. 초과한 파일을 제외한 뒤 제출해 주세요.', true);
    else if (pending.some((item) => item.file.size > FILE_LIMIT)) message('30MB를 초과한 파일이 있어 제출할 수 없습니다. 해당 파일을 제외한 뒤 이메일로 보내 주세요.', true);
    else if (pending.some((item) => fileIssue(item.file))) message('첨부할 수 없는 파일이 있습니다. 파일 목록의 안내를 확인하고 해당 파일을 제외해 주세요.', true);
    else message('파일을 선택했습니다. 아래 저장 버튼을 눌러야 제출에 반영됩니다.');
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!submissionsOpen(state)) { message('접수가 마감되어 저장할 수 없습니다. 입력한 내용은 이 화면에서 확인할 수 있습니다.', true); fieldset.disabled = true; return; }
    if (busy || !form.reportValidity()) return;
    const title = form.elements.title.value.trim();
    const description = form.elements.description.value.trim();
    const localOnly = form.elements.localOnly.checked;
    const deployUrl = localOnly ? '' : form.elements.deployUrl.value.trim();
    const githubUrl = form.elements.githubUrl.value.trim();
    if (!title || !description) { message('작품명과 작품 설명을 입력해 주세요.', true); return; }
    if ((deployUrl && !safeUrl(deployUrl)) || (githubUrl && !safeUrl(githubUrl))) { message('주소는 http:// 또는 https://로 시작하는 올바른 URL을 입력해 주세요.', true); return; }
    if (!validGithub(githubUrl)) { message('GitHub 저장소 주소는 https://github.com/사용자/저장소 형식으로 입력해 주세요.', true); return; }
    if (!localOnly && !deployUrl) { message('배포 주소를 입력하거나, 로컬에서 동작하는 작품임을 표시해 주세요.', true); return; }
    if (existing.length + pending.length > MAX_FILES) { message('첨부는 최대 10개입니다. 초과한 파일을 제외해 주세요.', true); return; }
    if (pending.some((item) => item.file.size > FILE_LIMIT)) { message('30MB를 초과한 파일을 제외한 뒤 제출해 주세요. 큰 파일은 위 안내에 따라 이메일로 보내 주세요.', true); return; }
    if (pending.some((item) => fileIssue(item.file))) { message('첨부할 수 없는 파일이 있습니다. 파일 목록의 안내를 확인하고 해당 파일을 제외해 주세요.', true); return; }
    busy = true;
    fieldset.disabled = true;
    form.setAttribute('aria-busy', 'true');
    try {
      for (const [index, item] of pending.entries()) {
        if (item.uploaded) continue;
        if (!submissionsOpen(state)) throw new Error('접수 기한이 지나 파일 업로드가 마감되었습니다.');
        message(`첨부 파일 업로드 중 (${index + 1}/${pending.length}) — ${item.file.name}`);
        item.error = null;
        try { item.uploaded = await festa.upload(item.file); }
        catch (error) { item.error = error.message || '업로드에 실패했습니다.'; }
        renderFiles();
      }
      const failed = pending.filter((item) => !item.uploaded);
      if (failed.length) {
        message(`${failed.length}개 파일을 업로드하지 못해 제출 내용을 저장하지 않았습니다. 성공한 업로드와 입력 내용은 유지됩니다. 실패한 파일을 제외하거나 저장 버튼을 눌러 다시 시도해 주세요.`, true);
        return;
      }
      if (!submissionsOpen(state)) throw new Error('접수 기한이 지나 작품 저장이 마감되었습니다.');
      message('작품을 저장하고 있습니다.');
      const saved = await festa.saveEntry({ id: entry?.id ?? null, ...(entry ? {} : { requestId }), title, description, localOnly, deployUrl, githubUrl, files: [...existing, ...pending.map((item) => item.uploaded)] });
      toastOk(entry ? '수정 내용을 저장했습니다.' : '새 작품을 제출했습니다.');
      try {
        await refresh(saved.entry?.id || entry?.id);
      } catch {
        message('작품은 저장되었습니다. 접수증을 다시 불러오지 못했습니다. 페이지를 새로고침해 접수 내역을 확인해 주세요.');
      }
    } catch (error) {
      message(`저장하지 못했습니다 — ${error.message || '잠시 후 다시 시도해 주세요.'} 입력 내용과 성공한 업로드는 유지됩니다.`, true);
    } finally {
      busy = false;
      fieldset.disabled = !submissionsOpen(state);
      form.removeAttribute('aria-busy');
    }
  });
  return {
    isBusy: () => busy,
    expire() { fieldset.disabled = true; message('접수 기한이 지났습니다. 신규 제출·수정·파일 업로드가 마감되었습니다. 입력한 내용은 이 화면에 유지됩니다.', true); },
    snapshot: () => ({
      title: form.elements.title.value, description: form.elements.description.value,
      localOnly: form.elements.localOnly.checked, deployUrl: form.elements.deployUrl.value,
      githubUrl: form.elements.githubUrl.value, existing: [...existing], pending: [...pending],
      previousDeployment, requestId,
    }),
  };
}

async function judgingCard(entry, index, canScore) {
  const blocked = entry.scoreBlocked || (entry.isMine ? '내 작품은 평가할 수 없습니다.' : '');
  const previous = !blocked && validScores(entry.myScores) ? entry.myScores : null;
  const prefix = `festaScore${index}`;
  return `<article class="card" aria-labelledby="${prefix}Title"><div class="festa-entry-head"><div>
    <h3 id="${prefix}Title">${esc(entry.title)}</h3><p class="page-sub">${esc(entry.author?.institution || '')} · ${esc(entry.author?.name || '참가자')}</p>
    </div>${entry.isMine ? '<span class="badge badge--soft">내 작품</span>' : ''}</div>
    <p class="festa-description" style="margin-block:var(--space-3)">${esc(entry.description)}</p>
    ${entryLinks(entry)}<div style="margin-block:var(--space-3)">${await attachments(entry.files)}</div>
    ${blocked ? `<p class="notice notice--info" data-testid="festa-score-blocked">${esc(blocked)}</p>` : !canScore ? `<div class="notice notice--info" data-testid="festa-score-readonly"><strong>평가가 마감되었습니다.</strong>${previous ? `<p>내가 저장한 평가: ${RUBRIC.map((rule, i) => `${rule.name} ${previous[i]}점`).join(' · ')}</p><p class="festa-total">합계 ${previous.reduce((sum, value) => sum + value, 0)} / 100점</p>` : '<p>이 작품에 저장한 평가가 없습니다.</p>'}</div>` : `
      <form data-testid="festa-score-form" data-entry-id="${attr(entry.id)}" aria-label="${attr(entry.title)} 평가">
        <fieldset style="border:0;padding:0;margin:0;min-width:0"><legend class="field__label">${previous ? '내 평가 수정' : '작품 평가'} · 항목별 정수 점수</legend>
          <div class="festa-score-grid">${RUBRIC.map((rule, i) => `<label class="field" for="${prefix}_${i}"><span class="field__label">${rule.name} (0~${rule.max}점)</span><span class="field__hint" id="${prefix}_${i}Help">${rule.description}</span><input class="input" id="${prefix}_${i}" name="score${i}" type="number" min="0" max="${rule.max}" step="1" inputmode="numeric" required value="${previous ? previous[i] : ''}" aria-describedby="${prefix}_${i}Help" /></label>`).join('')}</div>
          <div class="row row--between"><p class="festa-total" data-testid="festa-score-total" aria-live="polite">${previous ? `합계 ${previous.reduce((sum, score) => sum + score, 0)} / 100점` : '4개 항목의 점수를 입력해 주세요.'}</p><button type="submit" class="btn btn--primary btn--sm" data-testid="festa-score-save">${previous ? '평가 수정' : '평가 저장'}</button></div>
        </fieldset><p data-score-status role="status" aria-live="polite" class="field__hint">${previous ? '평가가 저장되어 있습니다. 심사 중에는 수정할 수 있습니다.' : '0점도 입력할 수 있습니다. 빈 항목은 미평가로 처리됩니다.'}</p>
      </form>`}
  </article>`;
}

function bindJudging(root, state) {
  const eligible = state.entries.filter((entry) => !entry.isMine && !entry.scoreBlocked);
  const progress = root.querySelector('[data-testid="festa-judging-progress"]');
  const updateProgress = () => {
    if (progress) progress.textContent = `내 평가 ${eligible.filter((entry) => validScores(entry.myScores)).length} / ${eligible.length}건 완료 · 심사 중에는 저장한 점수를 수정할 수 있습니다.`;
  };
  updateProgress();
  root.querySelectorAll('[data-testid="festa-score-form"]').forEach((form) => {
    const entry = state.entries.find((item) => item.id === form.dataset.entryId);
    const status = form.querySelector('[data-score-status]');
    const fieldset = form.querySelector('fieldset');
    const total = form.querySelector('[data-testid="festa-score-total"]');
    const scores = () => RUBRIC.map((_, i) => form.elements[`score${i}`].value.trim() === '' ? null : Number(form.elements[`score${i}`].value));
    form.addEventListener('input', () => {
      const values = scores();
      total.textContent = validScores(values) ? `합계 ${values.reduce((sum, value) => sum + value, 0)} / 100점` : '4개 항목에 허용 범위 안의 정수 점수를 입력해 주세요.';
      status.textContent = '변경한 점수는 저장 버튼을 눌러야 반영됩니다.';
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (fieldset.disabled || !form.reportValidity()) return;
      const values = scores();
      if (!validScores(values)) { status.textContent = '4개 항목에 허용 범위 안의 정수 점수를 모두 입력해 주세요.'; return; }
      fieldset.disabled = true;
      form.setAttribute('aria-busy', 'true');
      status.textContent = '평가를 저장하고 있습니다.';
      try {
        await festa.score(entry.id, values);
        entry.myScores = values;
        form.querySelector('[data-testid="festa-score-save"]').textContent = '평가 수정';
        form.querySelector('legend').textContent = '내 평가 수정 · 항목별 정수 점수';
        status.textContent = `평가를 저장했습니다. 합계 ${values.reduce((sum, value) => sum + value, 0)}점 · 심사 중에는 수정할 수 있습니다.`;
        updateProgress();
        toastOk('평가를 저장했습니다.');
      } catch (error) {
        status.textContent = `평가를 저장하지 못했습니다 — ${error.message || '잠시 후 다시 시도해 주세요.'}`;
        toastErr(error.message || '평가를 저장하지 못했습니다.');
      } finally { fieldset.disabled = false; form.removeAttribute('aria-busy'); }
    });
  });
}

export async function festaView(mount) {
  const root = shell(mount);
  const drafts = new Map();
  let activeEditor = null;
  let activeKey = null;
  let stopDeadline = null;
  const refresh = async () => {
    const state = await festa.get();
    state.entries = Array.isArray(state.entries) ? state.entries : [];
    const myEntries = Array.isArray(state.myEntries) ? state.myEntries : state.mine ? [state.mine] : [];
    const entryBlocked = state.entryBlocked || '';
    const receipts = await Promise.all(myEntries.map((entry, index) => receiptHtml(entry, state, index)));
    const canCreate = submissionsOpen(state) && !entryBlocked && myEntries.length < MAX_ENTRIES;
    const showJudging = ['judging', 'finished'].includes(state.phase);
    const cards = showJudging ? await Promise.all(state.entries.map((entry, index) => judgingCard(entry, index, state.phase === 'judging'))) : [];
    if (!root.isConnected) return;
    stopDeadline?.();
    activeEditor = null;
    activeKey = null;
    root.innerHTML = `${deadlineHtml(state)}
      <section class="festa-stack" aria-labelledby="festaMyEntriesTitle"><div class="festa-entry-head"><h2 id="festaMyEntriesTitle" class="page-title" style="font-size:2.2rem"><span aria-hidden="true">🎟️</span> 내 작품 ${myEntries.length} / 2</h2>${canCreate && myEntries.length ? '<button type="button" class="btn btn--primary" data-testid="festa-add-entry"><span aria-hidden="true">＋</span> 두 번째 작품 추가</button>' : ''}</div>
        ${entryBlocked ? `<p class="notice notice--info" data-testid="festa-entry-blocked">${esc(entryBlocked)}</p>` : myEntries.length >= MAX_ENTRIES ? `<p class="notice notice--info" data-entry-limit-message>최대 2작품을 모두 접수했습니다. ${submissionsOpen(state) ? '각 작품의 수정 버튼으로 해당 작품만 수정할 수 있습니다.' : '두 작품의 접수증을 확인할 수 있습니다.'}</p>` : ''}
        <div class="festa-stack" data-testid="festa-my-entries">${receipts.length ? receipts.join('') : `<section class="card"><p class="notice notice--info">${canCreate ? '아직 제출한 작품이 없습니다. 아래에서 첫 작품을 접수해 주세요.' : entryBlocked ? '현재 계정으로 확인할 수 있는 접수증이 없습니다.' : '접수한 작품이 없습니다. 현재는 접수가 마감되었습니다.'}</p></section>`}</div>
      </section><div data-festa-editor-host></div>
      ${rubricHtml()}
      ${showJudging ? `<section aria-labelledby="festaJudgingTitle" class="festa-stack"><div><h2 id="festaJudgingTitle" class="page-title">${state.phase === 'finished' ? '평가 마감 · 접수 작품' : '함께 심사하기'}</h2><p class="page-sub" data-testid="festa-judging-progress">${state.phase === 'finished' ? '평가가 마감되어 점수를 변경할 수 없습니다. 저장한 평가는 각 작품에서 확인할 수 있습니다.' : ''}</p></div><div class="festa-stack" data-testid="festa-judging-list">${cards.length ? cards.join('') : emptyState({ title: '심사할 작품이 없습니다', body: '접수된 작품이 표시되면 심사에 참여할 수 있습니다.' })}</div></section>` : `<p class="notice notice--info">${state.phase === 'open' ? '심사가 시작되면 다른 회원의 작품을 보고 평가할 수 있습니다.' : '접수가 마감되었습니다. 운영자가 심사를 시작하면 이곳에서 작품을 평가할 수 있습니다.'}</p>`}`;
    const host = root.querySelector('[data-festa-editor-host]');
    const rememberDraft = () => { if (activeEditor && activeKey) drafts.set(activeKey, activeEditor.snapshot()); };
    const openEditor = (entry, focus = true) => {
      if (!submissionsOpen(state)) { toastErr('접수가 마감되어 작품을 제출하거나 수정할 수 없습니다.'); return; }
      if (!entry && !canCreate) return;
      if (activeEditor?.isBusy()) { toastErr('작품을 저장하고 있습니다. 저장이 끝난 뒤 다른 작품을 선택해 주세요.'); return; }
      rememberDraft();
      const key = entry?.id || 'new';
      const draft = drafts.get(key) || null;
      activeKey = key;
      host.innerHTML = editorHtml(entry, state.email, myEntries.length, draft);
      activeEditor = bindEditor(host, state, entry, async (savedId) => {
        await refresh();
        drafts.delete(key);
        const receipt = [...root.querySelectorAll('[data-testid="festa-receipt"]')].find((element) => element.dataset.entryId === savedId);
        receipt?.focus();
      }, {
        draft,
        onCancel: () => {
          rememberDraft();
          host.innerHTML = '';
          activeEditor = null;
          activeKey = null;
          const target = entry ? [...root.querySelectorAll('[data-testid="festa-edit-entry"]')].find((button) => button.dataset.entryId === entry.id) : root.querySelector('[data-testid="festa-add-entry"]');
          target?.focus();
        },
      });
      if (focus) { host.querySelector('[name="title"]')?.focus(); host.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    };
    root.querySelectorAll('[data-testid="festa-edit-entry"]').forEach((button) => button.addEventListener('click', () => openEditor(myEntries.find((entry) => entry.id === button.dataset.entryId))));
    root.querySelector('[data-testid="festa-add-entry"]')?.addEventListener('click', () => openEditor(null));
    if (canCreate && !myEntries.length) openEditor(null, false);
    stopDeadline = watchDeadline(root, state, () => {
      root.querySelectorAll('[data-testid="festa-edit-entry"], [data-testid="festa-add-entry"]').forEach((button) => { button.disabled = true; });
      const limitMessage = root.querySelector('[data-entry-limit-message]');
      if (limitMessage) limitMessage.textContent = '최대 2작품을 모두 접수했습니다. 두 작품의 접수증을 확인할 수 있습니다.';
      root.querySelectorAll('[data-receipt-edit-message]').forEach((message) => { message.textContent = '접수가 마감되어 제출 내용을 수정할 수 없습니다.'; });
      activeEditor?.expire();
    });
    if (state.phase === 'judging') bindJudging(root, state);
  };
  try { await refresh(); }
  catch (error) { if (root.isConnected) root.innerHTML = `<p class="notice notice--err" role="alert">페스타 정보를 불러오지 못했습니다 — ${esc(error.message)}</p>`; }
}

async function adminEntry(entry, index) {
  const average = typeof entry.average === 'number' && Number.isFinite(entry.average) ? `${entry.average.toFixed(1)}점 / 100점` : '평가 없음';
  return `<article class="card" aria-labelledby="festaAdminEntry${index}"><div class="festa-entry-head"><div><h3 id="festaAdminEntry${index}">${esc(entry.title)}</h3><p class="page-sub">${esc(entry.author?.institution || '기관 미등록')} · ${esc(entry.author?.name || '이름 없음')}</p><p class="field__hint">${esc(entry.author?.email || '')}</p></div><div><span class="badge badge--soft">평가 ${esc(entry.scoreCount ?? 0)}건</span><p class="festa-total">평균 ${esc(average)}</p></div></div>
    <p class="field__hint">접수 ${esc(fmtDate(entry.createdAt, true))} · 최종 수정 ${esc(fmtDate(entry.updatedAt || entry.createdAt, true))} · 접수 번호 ${esc(entry.id)}</p>
    <p class="festa-description" style="margin-block:var(--space-3)">${esc(entry.description)}</p>${entryLinks(entry)}
    <div style="margin-top:var(--space-3)">${await attachments(entry.files)}</div>
  </article>`;
}

export async function festaAdminView(mount) {
  const root = shell(mount, true);
  if (!isAdmin()) { root.innerHTML = '<p class="notice notice--err" role="alert">관리자만 이용할 수 있습니다.</p>'; return; }
  let stopDeadline = null;
  const refresh = async () => {
    const state = await festa.get();
    const entries = Array.isArray(state.entries) ? state.entries : [];
    const cards = await Promise.all(entries.map(adminEntry));
    const nextPhase = {
      open: { phase: 'closed', label: '접수 마감' },
      closed: { phase: 'judging', label: '평가 시작' },
      judging: { phase: 'finished', label: '평가 마감' },
    }[state.phase];
    if (!root.isConnected) return;
    stopDeadline?.();
    root.innerHTML = `${deadlineHtml(state)}<section class="card" aria-labelledby="festaDeadlineTitle"><h2 id="festaDeadlineTitle" class="page-title" style="font-size:2.2rem"><span aria-hidden="true">🗓️</span> 접수 마감일 설정</h2>
      <p class="page-sub">선택한 날짜의 한국시간 23:59:59까지 접수합니다. 수동으로 접수를 마감하기 전에는 기한이 지나도 날짜를 연장하거나 앞당길 수 있습니다.</p>
      <form data-testid="festa-deadline-form" style="margin-top:var(--space-3)"><div class="row"><label class="field grow"><span class="field__label">접수 마감일 (한국시간)</span><input class="input" type="date" name="deadline" required value="${attr(deadlineOf(state))}" data-testid="festa-deadline-input" ${state.phase === 'open' ? '' : 'disabled'} /></label><button type="submit" class="btn btn--primary" data-testid="festa-deadline-save" ${state.phase === 'open' ? '' : 'disabled'}>마감일 저장</button></div><p data-deadline-status role="status" aria-live="polite" class="field__hint">${state.phase === 'open' ? '날짜가 지나도 평가는 자동으로 시작되지 않습니다. 접수 마감 → 평가 시작을 직접 진행해 주세요.' : '운영자가 접수를 마감한 뒤에는 마감일을 변경할 수 없습니다.'}</p></form>
    </section><section class="card" aria-labelledby="festaPhaseTitle"><div class="festa-entry-head"><h2 id="festaPhaseTitle" class="page-title" style="font-size:2.2rem"><span aria-hidden="true">⚙️</span> 페스타 운영 단계</h2><span data-admin-phase-badge>${state.phase === 'open' && deadlinePassed(state) ? '<span class="badge badge--closed">기한 종료 · 수동 마감 전</span>' : phaseBadge(state.phase)}</span></div>
      <p class="page-sub" data-admin-phase-description>${state.phase === 'open' ? deadlinePassed(state) ? '접수 기한이 지나 신규 제출과 수정이 중지되었습니다. 마감일을 연장하거나 접수 마감을 선택해 주세요.' : '마감 기한까지 1인 최대 2작품을 제출·수정할 수 있습니다. 준비가 끝나면 접수를 마감해 주세요.' : state.phase === 'closed' ? '접수를 수동으로 마감했습니다. 접수 내역을 확인한 뒤 평가를 시작해 주세요.' : state.phase === 'judging' ? '회원 평가가 진행 중입니다. 모든 회원이 본인 작품을 제외한 작품을 평가할 수 있습니다.' : '평가가 마감되었습니다. 접수 내역과 최종 집계를 확인해 주세요.'}</p>
      <div class="row" style="margin-top:var(--space-3)">${nextPhase ? `<button class="btn btn--primary" data-phase="${nextPhase.phase}">${nextPhase.label}</button>` : '<p class="notice notice--info">평가가 마감되었습니다. 접수 내역과 최종 집계를 확인할 수 있습니다.</p>'}</div>
      <p class="field__hint">접수 중 → 접수 마감 → 심사 중 → 평가 마감 순서로 진행합니다. 단계 변경은 되돌릴 수 없으며 모든 회원에게 적용됩니다.</p>
      <p data-phase-status role="status" aria-live="polite"></p>
    </section><section class="card" aria-labelledby="festaContactTitle"><h2 id="festaContactTitle" class="page-title" style="font-size:2.2rem">대용량 파일 수신 안내</h2>
      <p class="page-sub">30MB를 초과하는 파일을 받을 이메일입니다. 저장하면 회원의 제출 안내에 표시됩니다.</p>
      <form data-testid="festa-contact-form" style="margin-top:var(--space-3)"><div class="row"><label class="field grow"><span class="field__label">대용량 파일 수신 이메일</span><input class="input" type="email" name="email" required maxlength="254" value="${attr(state.email || '')}" data-testid="festa-contact-email" placeholder="운영자 이메일" /></label><button type="submit" class="btn btn--primary" data-testid="festa-contact-save">수신 이메일 저장</button></div><p data-contact-status role="status" aria-live="polite" class="field__hint">${state.email ? '' : '아직 수신 이메일이 설정되지 않았습니다. 회원에게 운영자 문의 안내가 표시됩니다.'}</p></form>
    </section>${rubricHtml()}
    <section aria-labelledby="festaAdminListTitle" class="festa-stack"><div class="festa-entry-head"><h2 id="festaAdminListTitle" class="page-title" style="font-size:2.2rem">전체 접수 현황 · ${entries.length}건</h2><button type="button" class="btn btn--quiet btn--sm" data-festa-refresh>현황 새로고침</button></div>
      <p class="notice notice--info">${mailHelp(state.email)}</p>
      <div class="festa-stack" data-testid="festa-admin-list">${cards.length ? cards.join('') : emptyState({ title: '아직 접수된 작품이 없습니다', body: '회원이 작품을 제출하면 접수 정보와 첨부 파일이 이곳에 표시됩니다.' })}</div>
    </section>`;
    root.querySelector('[data-festa-refresh]').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      try { await refresh(); } catch (error) { toastErr(error.message); event.target.disabled = false; }
    });
    const deadlineForm = root.querySelector('[data-testid="festa-deadline-form"]');
    deadlineForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = deadlineForm.elements.deadline;
      const button = deadlineForm.querySelector('[data-testid="festa-deadline-save"]');
      const status = deadlineForm.querySelector('[data-deadline-status]');
      if (state.phase !== 'open' || button.disabled || !deadlineForm.reportValidity()) return;
      const deadline = input.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) { status.textContent = '마감일을 올바르게 선택해 주세요.'; return; }
      button.disabled = true;
      input.disabled = true;
      deadlineForm.setAttribute('aria-busy', 'true');
      status.textContent = '마감일을 저장하고 있습니다.';
      let saved = false;
      try {
        await festa.deadline(deadline);
        saved = true;
        await refresh();
        toastOk('접수 마감일을 저장했습니다.');
      } catch (error) {
        status.textContent = saved ? '마감일은 저장되었습니다. 페이지를 새로고침해 안내를 확인해 주세요.' : `마감일을 저장하지 못했습니다 — ${error.message}`;
      } finally { button.disabled = false; input.disabled = false; deadlineForm.removeAttribute('aria-busy'); }
    });
    const contactForm = root.querySelector('[data-testid="festa-contact-form"]');
    contactForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = contactForm.elements.email.value.trim();
      const button = contactForm.querySelector('[data-testid="festa-contact-save"]');
      const status = contactForm.querySelector('[data-contact-status]');
      if (button.disabled || !contactForm.reportValidity()) return;
      if (!isEmail(email)) { status.textContent = '올바른 이메일 주소를 입력해 주세요.'; return; }
      button.disabled = true;
      contactForm.elements.email.disabled = true;
      contactForm.setAttribute('aria-busy', 'true');
      status.textContent = '수신 이메일을 저장하고 있습니다.';
      let saved = false;
      try {
        await festa.contact(email);
        saved = true;
        await refresh();
        toastOk('대용량 파일 수신 이메일을 저장했습니다.');
      } catch (error) {
        status.textContent = saved ? '이메일은 저장되었습니다. 페이지를 새로고침해 안내를 확인해 주세요.' : `저장하지 못했습니다 — ${error.message}`;
      } finally {
        button.disabled = false;
        contactForm.elements.email.disabled = false;
        contactForm.removeAttribute('aria-busy');
      }
    });
    root.querySelectorAll('[data-phase]').forEach((button) => button.addEventListener('click', async () => {
      const phase = button.dataset.phase;
      const options = {
        closed: { title: '접수를 마감할까요?', body: '작품 신규 제출과 수정이 중지됩니다. 기존 접수 내역은 유지되며, 평가 시작 전까지 회원은 본인의 접수 내역만 볼 수 있습니다. 접수 중으로 되돌릴 수 없습니다.', confirmLabel: '접수 마감' },
        judging: { title: '회원 평가를 시작할까요?', body: '모든 회원에게 접수된 작품과 첨부 파일이 공개됩니다. 회원은 본인 작품을 제외한 작품을 평가할 수 있습니다. 이전 단계로 되돌릴 수 없습니다.', confirmLabel: '평가 시작' },
        finished: { title: '평가를 마감할까요?', body: '모든 회원의 평가 저장과 수정을 중지합니다. 접수 작품과 이미 저장한 평가는 유지되며, 관리자는 최종 집계를 확인할 수 있습니다. 평가를 다시 열 수 없습니다.', confirmLabel: '평가 마감' },
      };
      if (!await confirmModal(options[phase])) return;
      const buttons = [...root.querySelectorAll('[data-phase]')];
      buttons.forEach((item) => { item.disabled = true; });
      const status = root.querySelector('[data-phase-status]');
      status.textContent = '운영 단계를 변경하고 있습니다.';
      let saved = false;
      try {
        await festa.phase(phase);
        saved = true;
        await refresh();
        toastOk(`${PHASES[phase].label} 상태로 변경했습니다.`);
      } catch (error) {
        status.className = 'notice notice--err';
        status.textContent = saved ? '운영 단계는 변경되었습니다. 현황을 다시 불러오지 못했으니 페이지를 새로고침해 확인해 주세요.' : `변경하지 못했습니다 — ${error.message}`;
        if (!saved) buttons.forEach((item) => { item.disabled = false; });
      }
    }));
    stopDeadline = watchDeadline(root, state, () => {
      const badge = root.querySelector('[data-admin-phase-badge]');
      const description = root.querySelector('[data-admin-phase-description]');
      if (badge) badge.innerHTML = '<span class="badge badge--closed">기한 종료 · 수동 마감 전</span>';
      if (description) description.textContent = '접수 기한이 지나 신규 제출과 수정이 중지되었습니다. 마감일을 연장하거나 접수 마감을 선택해 주세요.';
    });
  };
  try { await refresh(); }
  catch (error) { if (root.isConnected) root.innerHTML = `<p class="notice notice--err" role="alert">페스타 관리 정보를 불러오지 못했습니다 — ${esc(error.message)}</p>`; }
}
