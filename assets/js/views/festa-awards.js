/** 최종 시상 검토·발행 및 공개 시상식 화면. 공개 화면은 발행 스냅샷만 읽습니다. */
import { CONFIG } from '../config.js';
import { store } from '../store/index.js';
import { currentUser, isAdmin } from '../auth.js';
import { currentQuery } from '../router.js';
import { esc, attr } from '../utils.js';
import { confirmModal, spinner, emptyState } from '../ui.js';

const GROUPS = [
  { key: 'grand', name: '최우수상' }, { key: 'excellence', name: '우수상' }, { key: 'encouragement', name: '장려상' },
];
const STAGES = ['encouragement', 'excellence', 'grand'];
async function api(suffix = '', body) {
  const base = String(store?.base || CONFIG.r2?.apiBase || '/api').replace(/\/$/, '');
  const response = await fetch(`${base}/festa/awards${suffix}`, {
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

export async function festaAwardsView(mount) {
  mount.innerHTML = `<section class="section"><div class="wrap">${spinner()}</div></section>`;
  let publication;
  try { publication = await api(); }
  catch (error) {
    mount.innerHTML = `<section class="section"><div class="wrap" data-testid="awards-unpublished">${emptyState({
      title: error.status === 404 ? '수상 결과 발표를 기다려 주세요' : '발표 자료를 불러오지 못했습니다',
      body: error.status === 404 ? '운영자가 최종 결과를 확정하면 이곳에서 수상 작품을 확인할 수 있습니다.' : error.message,
      action: '<a class="btn btn--outline" href="#/">홈으로 돌아가기</a>',
    })}</div></section>`;
    return;
  }
  let presentation = currentQuery().get('mode') === 'present';
  let stage = -1;
  const render = (focusTarget = '') => {
    const group = stage < 0 ? null : GROUPS.find((item) => item.key === STAGES[stage]);
    const selected = group ? publication.recipients.filter((row) => row.award === group.key) : [];
    mount.innerHTML = `<div class="festa-awards ${presentation ? 'festa-awards--presentation' : ''}" data-testid="awards-public">
      <header class="festa-awards-heading"><p class="festa-awards-eyebrow">${esc(publication.title)}</p>
        <div class="festa-awards-mark" aria-hidden="true">✦</div><h1>${presentation ? '시상식' : '최종 수상 결과'}</h1>
        <p>수상하신 모든 분께 축하의 말씀을 전합니다.</p>
      </header>
      <nav class="festa-awards-controls" aria-label="수상 결과 보기 방식">
        <button class="btn ${!presentation ? 'btn--primary' : 'btn--outline'}" data-testid="awards-show-all" aria-pressed="${!presentation}">전체 수상자</button>
        <button class="btn ${presentation ? 'btn--primary' : 'btn--outline'}" data-testid="awards-present" aria-pressed="${presentation}">시상식 발표</button>
        <a class="btn btn--quiet" href="#/">홈으로</a>
      </nav>
      ${presentation ? `<section class="festa-awards-stage" data-testid="awards-stage" aria-live="polite" aria-atomic="true">
        ${group ? `<p class="festa-awards-stage-label">${group.name}</p><div class="festa-awards-grid festa-awards-grid--${group.key}">${selected.map(card).join('')}</div>`
    : '<div class="festa-awards-curtain"><h2>수상자를 발표합니다</h2><p>장려상 · 우수상 · 최우수상 순으로 발표합니다.</p></div>'}
        <div class="festa-awards-stage-controls"><button class="btn btn--outline" data-testid="awards-prev" ${stage < 0 ? 'disabled' : ''}>이전</button>
          <button class="btn btn--primary" data-testid="awards-next">${stage < 2 ? `${GROUPS.find((item) => item.key === STAGES[stage + 1]).name} 발표` : '전체 수상자 보기'}</button>
          <button class="btn btn--quiet" data-testid="awards-restart">처음부터</button></div>
      </section>` : `<div class="festa-awards-all" data-testid="awards-all">${allRecipients(publication)}</div>`}
      <p class="festa-awards-footer">말하는 대로, 바이브 코딩 페스타</p>
    </div>`;
    mount.querySelector('[data-testid="awards-show-all"]').addEventListener('click', () => { presentation = false; render('awards-show-all'); });
    mount.querySelector('[data-testid="awards-present"]').addEventListener('click', () => { presentation = true; stage = -1; render('awards-next'); });
    mount.querySelector('[data-testid="awards-next"]')?.addEventListener('click', () => {
      if (stage === 2) presentation = false; else stage += 1;
      render(presentation ? 'awards-next' : 'awards-show-all');
    });
    mount.querySelector('[data-testid="awards-prev"]')?.addEventListener('click', () => { stage = Math.max(-1, stage - 1); render(stage < 0 ? 'awards-next' : 'awards-prev'); });
    mount.querySelector('[data-testid="awards-restart"]')?.addEventListener('click', () => { stage = -1; render('awards-next'); });
    window.scrollTo(0, 0);
    if (focusTarget) mount.querySelector(`[data-testid="${focusTarget}"]`)?.focus({ preventScroll: true });
  };
  render();
}

export async function festaAwardsAdminView(mount) {
  if (!currentUser() || !isAdmin()) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({ title: '관리자만 이용할 수 있습니다', body: '최종 시상 검토는 관리자 전용입니다.' })}</div></section>`;
    return;
  }
  let plan;
  const shell = () => {
    mount.innerHTML = `<section class="band festa-hero"><div class="wrap"><p class="crumb"><a href="#/admin/festa" style="color:inherit">페스타 관리</a><span>/</span>최종 시상</p>
      <h1>최종 수상 결과 검토</h1><p style="margin-top:var(--space-3)">최종 심사와 기관별 수상 조건을 확인한 뒤 발표 자료를 공개합니다.</p></div></section>
      <section class="section"><div class="wrap festa-stack" data-testid="awards-admin-root">${spinner()}</div></section>`;
  };
  const render = (message = '') => {
    const root = mount.querySelector('[data-testid="awards-admin-root"]');
    root.innerHTML = `<div class="row"><a class="btn btn--outline" href="#/admin/festa/jury">심사위원·최종 후보 설정</a><a class="btn btn--outline" href="#/admin/festa">페스타 관리</a><button class="btn btn--quiet" data-testid="awards-refresh">다시 검토</button></div>
      ${plan.published ? '<p class="notice notice--info">수상 결과를 공개했습니다. 공개된 발표 자료는 확정 당시의 결과로 고정됩니다.</p><div class="row"><a class="btn btn--primary" href="#/festa/awards?mode=present" data-testid="awards-present-link">시상식 발표 시작</a><a class="btn btn--outline" href="#/festa/awards" data-testid="awards-public-link">전체 수상자 보기</a></div>' : ''}
      <section class="card"><h2 class="page-title" style="font-size:2.2rem">선정 기준</h2>
        <p>행정안전부 상위 2명과 한국서부발전 상위 1명을 선정하고, 이 세 명의 최종 심사 평균 순으로 최우수상 1명과 우수상 2명을 결정합니다. 나머지 세 명은 장려상입니다.</p>
        <p class="field__hint" style="margin-top:var(--space-3)">${esc(plan.tieRule)}</p></section>
      ${plan.issues.length ? `<section class="notice notice--warn" data-testid="awards-issues"><div><strong>공개 전에 확인해 주세요</strong><ul style="padding-left:2rem;list-style:disc">${plan.issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul></div></section>` : '<p class="notice notice--info" data-testid="awards-ready">최종 심사가 완료되어 수상 결과를 공개할 수 있습니다.</p>'}
      <section class="card"><h2 class="page-title" style="font-size:2.2rem">최종 심사 검토 · 관리자 전용</h2><p class="field__hint">아래 평균과 심사 완료 수는 공개 발표 화면에 표시되지 않습니다.</p>
        <div class="table-wrap" style="margin-top:var(--space-3)"><table class="table" data-testid="awards-ranking"><thead><tr><th>기관</th><th>성명 · 작품</th><th>최종 평균</th><th>문항별 평균</th><th>심사 완료</th></tr></thead><tbody>
          ${plan.ranking.map((row) => `<tr><td>${esc(row.institution)}</td><td><strong>${esc(row.name)}</strong><br>${esc(row.projectTitle)}</td><td>${row.average === null ? '—' : esc(row.average)}</td><td>${row.criterionAverages ? row.criterionAverages.map(esc).join(' / ') : '—'}</td><td>${row.ballotCount} / ${row.eligibleCount}</td></tr>`).join('')}
        </tbody></table></div></section>
      ${plan.ties.length ? `<section class="card"><h2 class="page-title" style="font-size:2.2rem">완전동점 순서 확인</h2><p>총점과 네 문항 평균이 모두 같은 경우에만 적용됩니다. 점수가 다른 후보의 순위는 바뀌지 않습니다.</p>
        <ul class="field__hint" style="margin-block:var(--space-3)">${plan.ties.map((tie) => `<li>${esc(tie.reason)}: ${tie.entryIds.map((id) => esc(plan.ranking.find((row) => row.entryId === id)?.name || '')).join(' · ')}</li>`).join('')}</ul>
        <form data-testid="awards-tie-form"><div class="festa-form-grid">${Array.from({ length: 6 }, (_, index) => `<label class="field"><span class="field__label">동점 우선순위 ${index + 1}</span><select class="input" name="order${index}" required><option value="">후보 선택</option>${plan.ranking.map((row) => `<option value="${attr(row.entryId)}" ${plan.tieOrder[index] === row.entryId ? 'selected' : ''}>${esc(row.institution)} · ${esc(row.name)} · ${esc(row.projectTitle)}</option>`).join('')}</select></label>`).join('')}</div>
          <button type="submit" class="btn btn--outline" data-testid="awards-preview-order">이 순서로 다시 검토</button><p role="status" data-tie-status></p></form></section>` : ''}
      ${plan.ready ? `<section class="card" data-testid="awards-recipient-preview"><h2 class="page-title" style="font-size:2.2rem">공개 예정 수상자</h2><div class="festa-awards-preview-list">${plan.recipients.map((row) => `<article><span class="badge badge--gold">${esc(row.awardName)}</span><strong>${esc(row.institution)} · ${esc(row.name)}</strong><span>${esc(row.projectTitle)}</span><span>${esc(row.certificate)} · ${esc(row.prizeText)}</span></article>`).join('')}</div></section>` : ''}
      <div class="card"><p>확정하여 공개하면 누구나 수상자의 기관·성명·작품명·상훈·상품을 확인할 수 있습니다. 점수와 심사위원 정보는 공개하지 않습니다.</p>
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
      try { plan = await api('/preview', { tieOrder }); render('동점 순서를 반영한 결과입니다. 공개 예정 수상자를 확인해 주세요.'); }
      catch (error) { tieForm.querySelector('[data-tie-status]').textContent = error.message; }
    });
    root.querySelector('[data-testid="awards-publish"]').addEventListener('click', async () => {
      if (!plan.ready || plan.published) return;
      const confirmed = await confirmModal({ title: '수상 결과를 확정하여 공개할까요?',
        body: '위에서 검토한 수상자 6명의 기관·성명·작품명·상훈·상품이 공개됩니다. 발표 자료는 확정 후 고정됩니다.', confirmLabel: '확정하고 공개' });
      if (!confirmed) return;
      const button = root.querySelector('[data-testid="awards-publish"]');
      button.disabled = true;
      try {
        plan.publication = await api('/publish', { revision: plan.revision, ...(plan.tieOrder.length ? { tieOrder: plan.tieOrder } : {}), confirm: true });
        plan.published = true; render('수상 결과를 공개했습니다. 공개 발표 화면에서 확인할 수 있습니다.');
      } catch (error) {
        root.querySelector('[data-testid="awards-admin-status"]').textContent = error.message;
        button.disabled = false;
      }
    });
  };
  async function load() {
    shell();
    try { plan = await api('/preview'); render(); }
    catch (error) { mount.querySelector('[data-testid="awards-admin-root"]').innerHTML = `<p class="notice notice--err">${esc(error.message)}</p><a class="btn btn--outline" href="#/admin/festa/jury">심사 설정으로 돌아가기</a>`; }
  }
  await load();
}
