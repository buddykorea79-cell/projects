/** 실제 데이터와 분리된 운영 연습 회차. 원본 Camp 작품은 읽기만 합니다. */
import { CONFIG } from '../config.js';
import { isAdmin } from '../auth.js';
import { esc, attr, fmtDate, isEmail } from '../utils.js';
import { spinner, confirmModal } from '../ui.js';

const API = String(CONFIG.r2?.apiBase || '/api').replace(/\/$/, '');
const INSTITUTIONS = ['행정안전부', '한국서부발전'];
const FIELD_NAMES = { title: '작품명', institution: '기관', description: '설명', name: '참가자명', email: '참가자 식별정보', files: '첨부 자료', localOnly: '실행 방식' };
async function api(path, body) {
  const response = await fetch(`${API}/festa/rehearsal${path}`, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '연습 회차를 처리하지 못했습니다.');
  return data;
}
function message(node, text, error = false) {
  node.textContent = text;
  node.className = text ? `notice notice--${error ? 'err' : 'info'}` : '';
  node.setAttribute('role', error ? 'alert' : 'status');
}
function sourceIdentity(source) {
  const email = String(source?.author?.email || '').trim().toLowerCase();
  return isEmail(email) ? email : source.id;
}
function recommended(sources) {
  const authors = new Set();
  return sources.filter((source) => {
    if (!source.eligible || authors.size >= 6) return false;
    const author = sourceIdentity(source);
    if (authors.has(author)) return false;
    authors.add(author); return true;
  }).map((source) => source.id);
}
function sourceHtml(source, selected) {
  return `<article class="fj-rehearsal-source" data-source-id="${attr(source.id)}"><label class="fj-choice"><input type="checkbox" name="sourceId" value="${attr(source.id)}" ${selected ? 'checked' : ''} ${source.eligible ? '' : 'disabled'} /><span><strong>${esc(source.title || '제목 보충 예정')}</strong><span class="field__hint">${esc(source.projectTitle || 'Camp 작품')} · ${esc(source.author?.name || '참가자명 보충 예정')}</span><span class="field__hint">원본 기관: ${esc(source.institution || source.author?.institution || '미지정')}</span>${source.issues?.length ? `<span class="field__hint">${source.issues.map(esc).join(' · ')}</span>` : ''}</span></label><label class="field"><span class="field__label">연습용 출품 기관</span><select class="input" data-source-institution ${source.eligible ? '' : 'disabled'}><option value="">자동 배정</option>${INSTITUTIONS.map((institution) => `<option value="${institution}" ${source.institution === institution ? 'selected' : ''}>${institution}</option>`).join('')}</select></label></article>`;
}
function entriesHtml(entries) {
  return `<div class="fj-stack" data-testid="rehearsal-entries">${entries.map((entry) => {
    const meta = entry.rehearsal || {};
    return `<article class="card card--flat"><div class="fj-head"><div><strong>${esc(entry.title)}</strong><p class="field__hint">${esc(entry.author?.name || '')} · ${esc(entry.institution)}</p></div><span class="badge ${meta.sample ? 'badge--gold' : 'badge--soft'}">${meta.sample ? '가상 작품' : '실제 Camp 작품 복사'}</span></div>${meta.projectTitle ? `<p class="field__hint">원본: ${esc(meta.projectTitle)}</p>` : ''}${meta.syntheticFields?.length ? `<p class="field__hint">연습용으로 보충·배정한 정보: ${meta.syntheticFields.map((key) => esc(FIELD_NAMES[key] || key)).join(' · ')}</p>` : ''}${meta.notice ? `<p class="fj-note">${esc(meta.notice)}</p>` : ''}</article>`;
  }).join('')}</div>`;
}

export async function festaRehearsalAdminView(mount) {
  mount.innerHTML = `<section class="band festa-hero"><div class="wrap"><p class="crumb"><a href="#/admin/festa" style="color:inherit">페스타 관리</a><span>/</span>운영 연습</p><h1 style="color:inherit">본선 평가·발표 연습</h1><p>실제 Camp 작품과 시험용 정보를 사용해 별도 회차에서 운영 흐름을 확인합니다.</p></div></section><section class="section"><div class="wrap festa-jury fj-stack" data-testid="rehearsal-admin">${spinner()}</div></section>`;
  const root = mount.querySelector('[data-testid="rehearsal-admin"]');
  if (!isAdmin()) { root.innerHTML = '<p class="notice notice--err">관리자만 연습 회차를 운영할 수 있습니다.</p>'; return; }
  const load = async (note = '') => {
    const [status, sourceData] = await Promise.all([api('/status'), api('/sources')]);
    const sources = Array.isArray(sourceData.sources) ? sourceData.sources : [];
    const run = status.active ? await api(`/${encodeURIComponent(status.runId)}/jury/admin`) : null;
    if (!root.isConnected) return;
    const panel = run?.panels?.find((item) => item.key === 'final');
    const entries = status.entries || run?.entries || [];
    const runPath = status.active ? `/festa/rehearsal/${encodeURIComponent(status.runId)}` : '';
    const adminAwards = status.active ? `#/admin/festa/rehearsal/${encodeURIComponent(status.runId)}/awards` : '';
    const suggested = new Set(recommended(sources));
    root.innerHTML = `<div class="fj-actions"><a class="btn btn--outline" href="#/admin/festa">페스타 관리</a><button class="btn btn--quiet" data-testid="rehearsal-refresh">현황 새로고침</button></div><p class="notice notice--warn" data-testid="rehearsal-warning">연습 전용 데이터입니다. 원본 Camp 작품과 실제 페스타 접수·점수·수상 결과는 변경하지 않습니다. 예선이 완료된 것으로 가정하며, 예시 본선 점수와 부족한 정보를 보충해 바로 발표까지 시험할 수 있습니다.</p><p data-testid="rehearsal-status" role="status" aria-live="polite">${esc(note)}</p>
      ${status.active ? `<section class="card fj-stack"><div class="fj-head"><div><h2>진행 중인 연습 회차</h2><p class="field__hint">시작 ${esc(fmtDate(status.startedAt, true))} (한국시간)</p></div><span class="badge badge--soft">${panel?.status === 'closed' ? '평가 마감' : '회원 평가 중'}</span></div><p class="fj-note">${esc(status.rehearsal?.notice || '시험용 작품과 예시 점수가 포함된 독립 회차입니다.')}</p><div class="fj-actions"><a class="btn btn--primary" href="#${runPath}/final" data-testid="rehearsal-vote-link">회원 평가 연습</a><a class="btn btn--outline" href="#${runPath}/results" data-testid="rehearsal-results-link">발표 연습</a><a class="btn btn--outline" href="${adminAwards}" data-testid="rehearsal-awards-link">수상 결과·동점 순서 확인</a></div><label class="field"><span class="field__label">이번 회차 회원 평가 주소</span><input class="input" readonly data-testid="rehearsal-vote-url" value="${attr(new URL(`#${runPath}/final`, window.location.href).href)}" /></label><p class="field__hint">초기화 후 새 회차를 시작하면 주소가 달라집니다. 이전 회차에서는 더 이상 평가할 수 없습니다.</p></section><section class="card fj-stack"><h2>연습 작품 ${entries.length}개</h2>${entriesHtml(entries)}</section><section class="card fj-stack"><h2>회원 평가 진행 현황</h2><p>실제 참여 회원 ${(panel?.participants || []).filter((person) => person.member).length}명 · 작품별 본인이 아닌 회원의 유효 평가가 1건 이상이면 마감할 수 있습니다. 예시 평가도 연습 집계에 포함됩니다.</p><div class="fj-table-wrap"><table class="fj-table" data-testid="rehearsal-progress"><thead><tr><th>작품</th><th>평가 수</th><th>평균 / 100점</th></tr></thead><tbody>${(panel?.entryIds || []).map((id) => { const entry = entries.find((item) => item.id === id); const result = panel.results.find((item) => item.entryId === id); return `<tr><td>${esc(entry?.title || id)}</td><td>${esc(result?.scoreCount || 0)}</td><td>${typeof result?.average === 'number' ? result.average.toFixed(1) : '—'}</td></tr>`; }).join('')}</tbody></table></div>${panel?.status === 'open' ? '<button class="btn btn--primary" data-testid="rehearsal-close">연습 평가 마감·발표 준비</button>' : `<p class="notice notice--info">연습 평가가 마감되었습니다. 순위가 확정되면 발표 화면이 열립니다. 수상 구분이 달라지는 완전동점은 수상 결과 화면에서 순서를 확정해 주세요.</p><a class="btn btn--outline" href="${adminAwards}">동점 순서 확인·확정</a>`}</section><section class="card fj-stack"><h2>연습 회차 초기화</h2><p>이 회차의 복사 작품, 예시·회원 점수, 연습 발표를 지웁니다. 원본 작품과 실제 페스타 결과는 유지됩니다.</p><button class="btn btn--danger" data-testid="rehearsal-reset">연습 회차 초기화</button></section>` : `<section class="card fj-stack"><h2>연습할 Camp 작품 선택</h2><p>실제 작품을 최대 6개까지 고릅니다. 같은 참가자의 작품은 하나만 선택할 수 있습니다. 선택한 작품이 6개보다 적으면 빈 자리를 가상 작품으로 채웁니다. 기관·참가자 정보와 예시 점수도 연습용으로 보충합니다.</p><div class="fj-actions"><button type="button" class="btn btn--outline" data-testid="rehearsal-auto">실제 작품 우선 자동 추천</button><span class="festa-total" data-testid="rehearsal-selection-count"></span></div><form data-testid="rehearsal-start-form"><div class="fj-stack">${sources.length ? sources.map((source) => sourceHtml(source, suggested.has(source.id))).join('') : '<p class="notice notice--info">사용할 수 있는 Camp 작품이 없어 가상 작품 6개로 연습합니다.</p>'}</div><p class="field__hint" style="margin-block:var(--space-3)">연습용 기관을 바꾸어도 원본의 기관은 변경되지 않습니다. 기관별 최소 인원은 시험용 배정으로 맞춥니다.</p><button class="btn btn--primary" type="submit" data-testid="rehearsal-start">별도 연습 회차 시작</button></form></section>`}`;
    root.querySelector('[data-testid="rehearsal-refresh"]').addEventListener('click', () => load().catch(showError));
    if (!status.active) {
      const form = root.querySelector('[data-testid="rehearsal-start-form"]');
      const selected = () => [...form.querySelectorAll('[name=sourceId]:checked')];
      const updateCount = () => {
        const count = selected().length;
        root.querySelector('[data-testid="rehearsal-selection-count"]').textContent = `선택 작품 ${count}개 · 가상 보충 ${Math.max(0, 6 - count)}개`;
        root.querySelector('[data-testid="rehearsal-start"]').disabled = count > 6;
      };
      form.addEventListener('change', updateCount); updateCount();
      root.querySelector('[data-testid="rehearsal-auto"]').addEventListener('click', () => { form.querySelectorAll('[name=sourceId]').forEach((input) => { input.checked = suggested.has(input.value); }); updateCount(); });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const inputs = selected();
        const emails = inputs.map((input) => sourceIdentity(sources.find((source) => source.id === input.value)));
        if (inputs.length > 6 || new Set(emails).size !== emails.length) { showError(new Error('서로 다른 참가자의 작품을 최대 6개 선택해 주세요.')); return; }
        if (!await confirmModal({ title: '별도 연습 회차를 시작할까요?', body: `선택한 실제 작품 ${inputs.length}개와 가상 작품 ${6 - inputs.length}개로 연습합니다. 누락 정보와 예시 점수가 시험용으로 보충됩니다.`, confirmLabel: '연습 시작' })) return;
        const button = form.querySelector('button[type=submit]'); button.disabled = true;
        try {
          await api('/start', { confirm: true, expectedRunId: status.lastRunId ?? null, selections: inputs.map((input) => ({ sourceId: input.value, institution: input.closest('[data-source-id]').querySelector('[data-source-institution]').value || undefined })) });
          await load('연습 회차를 시작했습니다. 회원 평가와 발표 흐름을 확인해 주세요.');
        } catch (error) { showError(error); button.disabled = false; }
      });
    }
    root.querySelector('[data-testid="rehearsal-close"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!await confirmModal({ title: '연습 평가를 마감할까요?', body: '이번 회차의 회원 평가를 마감합니다. 순위가 확정되면 연습 발표가 준비되며, 수상 구분이 바뀌는 완전동점은 관리자가 순서를 확정해야 합니다.', confirmLabel: '연습 평가 마감' })) return;
      button.disabled = true;
      try { await api(`/${encodeURIComponent(status.runId)}/jury/status`, { panel: 'final', status: 'closed' }); await load('연습 평가를 마감했습니다. 발표 화면 또는 동점 순서를 확인해 주세요.'); }
      catch (error) { showError(error); button.disabled = false; }
    });
    root.querySelector('[data-testid="rehearsal-reset"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!await confirmModal({ title: '연습 회차를 초기화할까요?', body: '이번 연습 회차의 복사 작품, 예시·회원 점수와 연습 발표가 삭제됩니다. 원본 Camp 작품과 실제 페스타 결과는 유지됩니다. 취소하면 현재 회차를 계속 사용할 수 있습니다.', confirmLabel: '연습 초기화', danger: true })) return;
      button.disabled = true;
      try { await api('/reset', { confirm: true, runId: status.runId }); await load('연습 회차를 초기화했습니다. 새 회차를 시작할 수 있습니다.'); }
      catch (error) { showError(error); button.disabled = false; }
    });
  };
  const showError = (error) => {
    if (!root.isConnected) return;
    const status = root.querySelector('[data-testid="rehearsal-status"]');
    if (status) message(status, error.message, true);
    else root.innerHTML = `<p class="notice notice--err" role="alert">${esc(error.message)}</p>`;
  };
  try { await load(); } catch (error) { showError(error); }
}
