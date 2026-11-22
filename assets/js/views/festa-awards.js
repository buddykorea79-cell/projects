/** 최종 시상 검토·발행 및 공개 시상식 화면. 공개 화면은 발행 스냅샷만 읽습니다. */
import { CONFIG } from '../config.js';
import { store } from '../store/index.js';
import { currentUser, isAdmin } from '../auth.js';
import { currentPath, currentQuery } from '../router.js';
import { esc, attr } from '../utils.js';
import { confirmModal, spinner, emptyState } from '../ui.js';

const GROUPS = [
  { key: 'grand', name: '최우수상' }, { key: 'excellence', name: '우수상' }, { key: 'encouragement', name: '장려상' },
];
const STAGES = ['encouragement', 'excellence', 'grand'];
function awardPaths(runId) {
  const rehearsal = runId !== undefined;
  const scope = rehearsal ? `/festa/rehearsal/${encodeURIComponent(runId)}` : '/festa';
  return { rehearsal, api: `${scope}/awards`, results: `#${scope}/results`, list: `#${scope}/awards`,
    manage: rehearsal ? '#/admin/festa/rehearsal' : '#/admin/festa/jury' };
}
async function api(paths, suffix = '', body) {
  const base = String(store?.base || CONFIG.r2?.apiBase || '/api').replace(/\/$/, '');
  const response = await fetch(`${base}${paths.api}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.message || '수상 정보를 불러오지 못했습니다.');
    error.status = response.status; throw error;
  }
  return result;
}
function card(row) {
  return `<article class="festa-awards-card festa-awards-card--${attr(row.award)}" data-testid="awards-recipient" data-award="${attr(row.award)}">
    <p class="festa-awards-certificate">${esc(row.certificate)}</p>
    <h3 class="festa-awards-name">${esc(row.name)}</h3><p class="festa-awards-institution">${esc(row.institution)}</p>
    <p class="festa-awards-project">${esc(row.projectTitle)}</p><p class="festa-awards-prize">${esc(row.prizeText)}</p>
  </article>`;
}
function allRecipients(publication) {
  return GROUPS.map((group) => `<section class="festa-awards-group" aria-labelledby="award-${group.key}">
    <h2 id="award-${group.key}" class="festa-awards-group-title">${group.name}</h2>
    <div class="festa-awards-grid festa-awards-grid--${group.key}">${publication.recipients.filter((row) => row.award === group.key).map(card).join('')}</div>
  </section>`).join('');
}

export async function festaAwardsView(mount, { runId } = {}) {
  const paths = awardPaths(runId);
  const pagePath = currentPath();
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;
  let publication;
  try { publication = await api(paths); }
  catch (error) {
    if (pagePath !== currentPath()) return;
    mount.innerHTML = `<section class="section"><div class="wrap" data-testid="awards-unpublished">${emptyState({
      title: error.status === 404 ? '수상 결과 발표를 기다려 주세요' : '발표 자료를 불러오지 못했습니다',
      body: error.status === 404 ? (paths.rehearsal ? '관리자가 테스트 본선을 마감하고 수상 순서를 확정하면 연습 발표가 열립니다.' : '2차 심사 마감과 수상 순서 확정 후 발표가 열립니다.') : error.message,
      action: '<button class="btn btn--primary" data-testid="awards-retry">발표 상태 다시 확인</button> <a class="btn btn--outline" href="#/">홈으로 돌아가기</a>',
    })}</div></section>`;
    mount.querySelector('[data-testid="awards-retry"]').addEventListener('click', () => festaAwardsView(mount, { runId }));
    return;
  }
  if (pagePath !== currentPath()) return;
  const presentation = currentPath().endsWith('/results') || currentQuery().get('mode') === 'present';
  const sequence = STAGES.flatMap((award) => publication.recipients.filter((row) => row.award === award));
  let position = -1;
  let revealed = false;
  let lockedUntil = 0;
  let unlockTimer;
  let checking = false;
  const action = async (event, change) => {
    if (checking || performance.now() < lockedUntil || event.detail > 1) return;
    if (paths.rehearsal) {
      // 다른 창에서 연습 회차를 초기화했다면 예전 발표 자료로 다음 수상자를 공개하지 않습니다.
      checking = true;
      try { await api(paths); }
      catch {
        if (pagePath === currentPath()) await festaAwardsView(mount, { runId });
        return;
      } finally { checking = false; }
      if (pagePath !== currentPath()) return;
    }
    lockedUntil = performance.now() + 1150;
    change();
    render('awards-next');
  };
  const render = (focusTarget = '') => {
    clearTimeout(unlockTimer);
    const recipient = sequence[position];
    const ending = position >= sequence.length;
    const award = recipient?.award || (ending ? 'ending' : 'intro');
    const group = GROUPS.find((item) => item.key === award);
    const groupEntries = sequence.filter((row) => row.award === award);
    const groupPosition = recipient ? groupEntries.indexOf(recipient) + 1 : 0;
    const nextLabel = position < 0 ? '시상식 시작' : ending ? '전체 수상자 보기' : !revealed ? '수상자 공개' : position === sequence.length - 1 ? '시상식 마치기' : '다음 수상자';
    const curtainTitle = position < 0 ? '시상식을 시작합니다' : group?.name || '';
    const curtainBody = position < 0 ? '장려상 세 분, 우수상 두 분, 최우수상 한 분을 차례로 발표합니다.' : `${groupPosition === 1 ? '첫 번째' : groupPosition === 2 ? '두 번째' : '세 번째'} 수상자를 공개합니다.`;
    mount.innerHTML = `<div class="festa-awards ${presentation ? 'festa-awards--presentation' : ''}" data-testid="awards-public" data-award="${attr(award)}" data-position="${position}" data-revealed="${revealed}">
      <header class="festa-awards-heading"><p class="festa-awards-eyebrow">${paths.rehearsal ? 'AI Build Camp 테스트 · ' : ''}${esc(publication.title)}</p>
        <div class="festa-awards-mark" aria-hidden="true">✦</div><h1>${presentation ? '시상식' : '최종 수상 결과'}</h1>
        <p>${presentation ? '장려상 · 우수상 · 최우수상' : '수상하신 모든 분께 축하의 말씀을 전합니다.'}</p>
      </header>
      <nav class="festa-awards-controls" aria-label="수상 결과 보기 방식">
        ${presentation ? '' : `<a class="btn btn--primary" data-testid="awards-present" href="${attr(paths.results)}">시상식 발표 시작</a>`}
        <a class="btn btn--quiet" href="#/">홈으로</a>
      </nav>
      ${presentation ? `<section class="festa-awards-stage" data-testid="awards-stage" aria-label="시상식 진행">
        <p class="festa-ceremony-progress" data-testid="awards-progress">${recipient ? `${group.name} · ${groupPosition} / ${groupEntries.length}<span>${position + 1} / ${sequence.length}</span>` : ending ? '시상식 종료' : '수상자 발표'}</p>
        <div class="festa-ceremony-frame" id="festa-ceremony-current" aria-live="polite" aria-atomic="true">
          ${ending ? '<div class="festa-ceremony-ending" data-testid="awards-ending"><div class="festa-ceremony-seal" aria-hidden="true">✦</div><h2>수상을 축하드립니다</h2><p>모든 수상자와 참가자 여러분께 감사드립니다.</p></div>'
    : revealed ? `<div class="festa-ceremony-reveal"><h2 class="festa-awards-stage-label">${group.name}</h2>${card(recipient)}</div>`
      : `<div class="festa-awards-curtain" data-testid="awards-curtain"><div class="festa-ceremony-seal" aria-hidden="true">✦</div><h2>${curtainTitle}</h2><p>${curtainBody}</p></div>`}
        </div>
        <div class="festa-awards-stage-controls"><button class="btn btn--outline" data-testid="awards-prev" data-ceremony-action ${position < 0 ? 'disabled' : ''}>이전</button>
          ${ending ? `<a class="btn btn--primary" data-testid="awards-next" data-ceremony-action aria-describedby="festa-ceremony-current" href="${attr(paths.list)}">${nextLabel}</a>` : `<button class="btn btn--primary" data-testid="awards-next" data-ceremony-action aria-describedby="festa-ceremony-current">${nextLabel}</button>`}
          <button class="btn btn--quiet" data-testid="awards-restart" data-ceremony-action>처음부터</button></div>
      </section>` : `<div class="festa-awards-all" data-testid="awards-all">${allRecipients(publication)}</div>`}
      <p class="festa-awards-footer">말하는 대로, 바이브 코딩 페스타</p>
    </div>`;
    const root = mount.querySelector('[data-testid="awards-public"]');
    if (!ending) mount.querySelector('[data-testid="awards-next"]')?.addEventListener('click', (event) => action(event, () => {
      if (position < 0 || revealed) { position += 1; revealed = false; } else revealed = true;
    }));
    else mount.querySelector('[data-testid="awards-next"]').addEventListener('click', (event) => {
      if (performance.now() < lockedUntil || event.detail > 1) event.preventDefault();
    });
    mount.querySelector('[data-testid="awards-prev"]')?.addEventListener('click', (event) => action(event, () => {
      if (revealed) revealed = false; else position = Math.max(-1, position - 1);
    }));
    mount.querySelector('[data-testid="awards-restart"]')?.addEventListener('click', (event) => action(event, () => { position = -1; revealed = false; }));
    root.addEventListener('keydown', (event) => {
      if (event.repeat && ['Enter', ' '].includes(event.key)) event.preventDefault();
    });
    const lockButtons = () => root.querySelectorAll('[data-ceremony-action]').forEach((button) => button.setAttribute('aria-disabled', String(performance.now() < lockedUntil)));
    lockButtons();
    if (performance.now() < lockedUntil) unlockTimer = setTimeout(() => { if (root.isConnected) lockButtons(); }, lockedUntil - performance.now() + 1);
    window.scrollTo(0, 0);
    if (focusTarget) mount.querySelector(`[data-testid="${focusTarget}"]`)?.focus({ preventScroll: true });
  };
  render();
}

export async function festaAwardsAdminView(mount, { runId } = {}) {
  const paths = awardPaths(runId);
  if (!currentUser() || !isAdmin()) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({ title: '관리자만 이용할 수 있습니다', body: '최종 시상 검토는 관리자 전용입니다.' })}</div></section>`;
    return;
  }
  let plan;
  const shell = () => {
    mount.innerHTML = `<section class="band festa-hero"><div class="wrap"><p class="crumb"><a href="#/admin/festa" style="color:inherit">페스타 관리</a><span>/</span>최종 시상</p>
      <h1>${paths.rehearsal ? 'AI Build Camp 테스트 수상 결과' : '최종 수상 결과 검토'}</h1><p style="margin-top:var(--space-3)">${paths.rehearsal ? '이 회차의 예시 점수와 회원 평가로 테스트 수상 결과를 확인합니다.' : '최종 심사와 기관별 수상 조건을 확인한 뒤 발표 자료를 공개합니다.'}</p></div></section>
      <section class="section"><div class="wrap festa-stack" data-testid="awards-admin-root">${spinner()}</div></section>`;
  };
  const render = (message = '') => {
    const root = mount.querySelector('[data-testid="awards-admin-root"]');
    root.innerHTML = `<div class="row"><a class="btn btn--outline" href="${attr(paths.manage)}">${paths.rehearsal ? '테스트 회차 관리' : '심사위원·최종 후보 설정'}</a><a class="btn btn--outline" href="#/admin/festa">페스타 관리</a><button class="btn btn--quiet" data-testid="awards-refresh">다시 검토</button></div>
      ${plan.published ? `<p class="notice notice--info">${paths.rehearsal ? '테스트 회차 수상 결과를 확정했습니다.' : '수상 결과를 공개했습니다. 공개된 발표 자료는 확정 당시의 결과로 고정됩니다.'}</p><div class="row"><a class="btn btn--primary" href="${attr(paths.results)}" data-testid="awards-present-link">시상식 발표 시작</a><a class="btn btn--outline" href="${attr(paths.list)}" data-testid="awards-public-link">전체 수상자 보기</a></div>` : ''}
      <section class="card"><h2 class="page-title" style="font-size:2.2rem">선정 기준</h2>
        <p>행정안전부 상위 2명과 한국서부발전 상위 1명을 선정하고, 이 세 명의 최종 심사 평균 순으로 최우수상 1명과 우수상 2명을 결정합니다. 나머지 세 명은 장려상입니다.</p>
        <p class="field__hint" style="margin-top:var(--space-3)">${esc(plan.tieRule)}</p></section>
      ${plan.issues.length ? `<section class="notice notice--warn" data-testid="awards-issues"><div><strong>공개 전에 확인해 주세요</strong><ul style="padding-left:2rem;list-style:disc">${plan.issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul></div></section>` : '<p class="notice notice--info" data-testid="awards-ready">최종 심사가 완료되어 수상 결과를 공개할 수 있습니다.</p>'}
      <section class="card"><h2 class="page-title" style="font-size:2.2rem">최종 심사 검토 · 관리자 전용</h2><p class="field__hint">아래 평균과 심사 완료 수는 공개 발표 화면에 표시되지 않습니다.</p>
        <div class="table-wrap" style="margin-top:var(--space-3)"><table class="table" data-testid="awards-ranking"><thead><tr><th>기관</th><th>성명 · 작품</th><th>최종 평균</th><th>문항별 평균</th><th>심사 완료</th></tr></thead><tbody>
          ${plan.ranking.map((row) => `<tr><td>${esc(row.institution)}</td><td><strong>${esc(row.name)}</strong><br>${esc(row.projectTitle)}</td><td>${row.average === null ? '—' : esc(row.average)}</td><td>${row.criterionAverages ? row.criterionAverages.map(esc).join(' / ') : '—'}</td><td>${esc(row.ballotCount)}건</td></tr>`).join('')}
        </tbody></table></div></section>
      ${plan.ties.length ? `<section class="card"><h2 class="page-title" style="font-size:2.2rem">완전동점 순서 확인</h2><p>총점과 네 문항 평균이 모두 같은 경우에만 적용됩니다. 점수가 다른 후보의 순위는 바뀌지 않습니다.</p>
        <ul class="field__hint" style="margin-block:var(--space-3)">${plan.ties.map((tie) => `<li>${esc(tie.reason)}: ${tie.entryIds.map((id) => esc(plan.ranking.find((row) => row.entryId === id)?.name || '')).join(' · ')}</li>`).join('')}</ul>
        <form data-testid="awards-tie-form"><div class="festa-form-grid">${Array.from({ length: 6 }, (_, index) => `<label class="field"><span class="field__label">동점 우선순위 ${index + 1}</span><select class="input" name="order${index}" required><option value="">후보 선택</option>${plan.ranking.map((row) => `<option value="${attr(row.entryId)}" ${plan.tieOrder[index] === row.entryId ? 'selected' : ''}>${esc(row.institution)} · ${esc(row.name)} · ${esc(row.projectTitle)}</option>`).join('')}</select></label>`).join('')}</div>
          <button type="submit" class="btn btn--outline" data-testid="awards-preview-order">이 순서로 다시 검토</button><p role="status" data-tie-status></p></form></section>` : ''}
      ${plan.ready ? `<section class="card" data-testid="awards-recipient-preview"><h2 class="page-title" style="font-size:2.2rem">공개 예정 수상자</h2><div class="festa-awards-preview-list">${plan.recipients.map((row) => `<article><span class="badge badge--gold">${esc(row.awardName)}</span><strong>${esc(row.institution)} · ${esc(row.name)}</strong><span>${esc(row.projectTitle)}</span><span>${esc(row.certificate)} · ${esc(row.prizeText)}</span></article>`).join('')}</div></section>` : ''}
      <div class="card"><p>${paths.rehearsal ? '확정하면 이 회차의 발표 주소에서 로그인한 회원이 테스트 수상자를 확인할 수 있습니다.' : '확정하여 공개하면 누구나 수상자의 기관·성명·작품명·상훈·상품을 확인할 수 있습니다. 점수와 심사위원 정보는 공개하지 않습니다.'}</p>
        <button class="btn btn--primary" style="margin-top:var(--space-3)" data-testid="awards-publish" ${!plan.ready || plan.published ? 'disabled' : ''}>수상 결과 확정·공개</button>
        <p role="status" aria-live="polite" data-testid="awards-admin-status" style="margin-top:var(--space-3)">${esc(message)}</p></div>`;
    root.querySelector('[data-testid="awards-refresh"]').addEventListener('click', load);
    const tieForm = root.querySelector('[data-testid="awards-tie-form"]');
    tieForm?.addEventListener('input', () => {
      root.querySelector('[data-testid="awards-publish"]').disabled = true;
      tieForm.querySelector('[data-tie-status]').textContent = '변경한 순서로 다시 검토한 후 공개할 수 있습니다.';
    });
    tieForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!tieForm.reportValidity()) return;
      const tieOrder = Array.from({ length: 6 }, (_, index) => tieForm.elements[`order${index}`].value);
      if (new Set(tieOrder).size !== 6) { tieForm.querySelector('[data-tie-status]').textContent = '후보 6명을 한 번씩만 선택해 주세요.'; return; }
      try { plan = await api(paths, '/preview', { tieOrder }); render('동점 순서를 반영한 결과입니다. 공개 예정 수상자를 확인해 주세요.'); }
      catch (error) { tieForm.querySelector('[data-tie-status]').textContent = error.message; }
    });
    root.querySelector('[data-testid="awards-publish"]').addEventListener('click', async () => {
      if (!plan.ready || plan.published) return;
      const confirmed = await confirmModal({ title: '수상 결과를 확정하여 공개할까요?',
        body: paths.rehearsal ? '확정한 테스트 수상자 6명을 이 회차의 발표 화면에서 한 명씩 공개할 수 있습니다.' : '위에서 검토한 수상자 6명의 기관·성명·작품명·상훈·상품이 공개됩니다. 발표 자료는 확정 후 고정됩니다.', confirmLabel: '확정하고 공개' });
      if (!confirmed) return;
      const button = root.querySelector('[data-testid="awards-publish"]');
      button.disabled = true;
      try {
        plan.publication = await api(paths, '/publish', { revision: plan.revision, ...(plan.tieOrder.length ? { tieOrder: plan.tieOrder } : {}), confirm: true });
        plan.published = true; render('수상 결과를 공개했습니다. 공개 발표 화면에서 확인할 수 있습니다.');
      } catch (error) {
        root.querySelector('[data-testid="awards-admin-status"]').textContent = error.message;
        button.disabled = false;
      }
    });
  };
  async function load() {
    shell();
    try { plan = await api(paths, '/preview'); render(); }
    catch (error) { mount.querySelector('[data-testid="awards-admin-root"]').innerHTML = `<p class="notice notice--err">${esc(error.message)}</p><a class="btn btn--outline" href="${attr(paths.manage)}">심사 설정으로 돌아가기</a>`; }
  }
  await load();
}
