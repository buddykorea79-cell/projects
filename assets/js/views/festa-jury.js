/** 심사위원별 초대·비공개 채점. 회원 상호 평가와는 별도의 서버 세션을 사용합니다. */
import { CONFIG } from '../config.js';
import { isAdmin } from '../auth.js';
import { FESTA_RUBRIC as RUBRIC, validFestaScores } from '../festa.js';
import { esc, attr, fmtDate, fmtBytes, isEmail } from '../utils.js';
import { spinner, emptyState, confirmModal, toastOk, toastErr } from '../ui.js';

const PANELS = {
  mois: { label: '1단계 · 행정안전부', institution: '행정안전부' },
  iwest: { label: '1단계 · 한국서부발전', institution: '한국서부발전' },
  final: { label: '2단계 · 최종 심사', institution: '' },
};
const STATUS = { draft: '준비 중', open: '평가 중', closed: '평가 마감' };
const INSTITUTIONS = ['행정안전부', '한국서부발전'];
const API = String(CONFIG.r2?.apiBase || '/api').replace(/\/$/, '');

async function request(path, body) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || `요청 실패 (${response.status})`); error.status = response.status; throw error; }
  return data;
}
const jury = (path, body) => request(`/festa/jury/${path}`, body);
const institutionOf = (entry) => INSTITUTIONS.includes(entry.institution) ? entry.institution : INSTITUTIONS.includes(entry.author?.institution) ? entry.author.institution : '';
const totalOf = (scores) => validFestaScores(scores) ? scores.reduce((sum, score) => sum + score, 0) : null;
const badge = (status) => `<span class="badge ${status === 'open' ? 'badge--open' : status === 'closed' ? 'badge--closed' : 'badge--soft'}">${esc(STATUS[status] || status)}</span>`;

function safeUrl(value) {
  if (!value || /[\u0000-\u0020\u007f]/.test(String(value))) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function linksHtml(entry) {
  return `<div class="fj-actions">${entry.localOnly ? '<span class="badge badge--soft">💻 로컬 실행 작품</span>' : ''}${[[entry.deployUrl, '🌐 작품 실행하기'], [entry.githubUrl, '📦 GitHub 저장소']].map(([raw, title]) => {
    const href = safeUrl(raw);
    return href ? `<a class="btn btn--outline btn--sm" href="${attr(href)}" target="_blank" rel="noopener noreferrer">${title}<span class="sr-only"> (새 창)</span></a>` : '';
  }).join('')}</div>`;
}
function filesHtml(entry, token) {
  if (!entry.files?.length) return '<p class="fj-note">첨부 파일이 없습니다.</p>';
  return `<ul class="fj-files" aria-label="작품 첨부 파일">${entry.files.map((file) => `<li class="fj-file"><div><strong>${esc(file.name || '첨부 파일')}</strong><p class="field__hint">${esc(fmtBytes(file.size))}</p></div><a class="btn btn--outline btn--sm" data-testid="jury-file" href="${attr(`${API}/festa/jury/file/${encodeURIComponent(file.key)}?token=${encodeURIComponent(token)}`)}" target="_blank" rel="noopener noreferrer">내려받기<span class="sr-only">: ${esc(file.name)} (새 창)</span></a></li>`).join('')}</ul>`;
}

/** 이메일 앱의 초안만 엽니다. PIN은 링크와 별도로 전달하도록 본문에 넣지 않습니다. */
function invitationMailto(judge, panel, url) {
  const email = String(judge.email || '').trim();
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1);
  if (!isEmail(email) || !/^[\p{L}\p{N}.-]+$/u.test(domain)) return '';
  const recipient = `${encodeURIComponent(email.slice(0, at))}@${domain}`;
  const subject = `[말하는 대로, 바이브 코딩 페스타] ${PANELS[panel.key].label} 심사위원 초대`;
  const body = `${judge.name} 심사위원님,\n\n말하는 대로, 바이브 코딩 페스타의 ${PANELS[panel.key].label} 평가를 부탁드립니다.\n아래 전용 링크에서 운영자가 별도로 전달한 6자리 PIN으로 입장해 주세요.\n\n${url}\n\n이 링크는 해당 심사위원 전용입니다.\n감사합니다.`;
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function shell(mount, admin) {
  mount.innerHTML = `<section class="band festa-hero"><div class="wrap"><p class="crumb"><a href="${admin ? '#/admin/festa' : '#/'}" style="color:inherit">${admin ? '페스타 관리' : '홈'}</a><span>/</span>심사위원 평가</p><h1 style="font-size:clamp(2.4rem,5vw,3.4rem);color:inherit">${admin ? '심사위원 운영' : '페스타 심사위원 평가'}</h1><p style="margin-top:var(--space-2)">${admin ? '대상 작품과 심사위원을 지정하고, 심사위원별 평가 진행 상황을 확인합니다.' : '초대받은 심사위원 전용 화면입니다. PIN으로 입장한 뒤 작품을 평가해 주세요.'}</p>${admin ? '<div class="row" style="margin-top:var(--space-3)"><a class="btn btn--ghostDark" href="#/admin/festa">페스타 관리</a><a class="btn btn--ghostDark" href="#/admin/festa/awards" data-testid="jury-awards-link">수상 결과 관리</a></div>' : ''}</div></section><section class="section"><div class="wrap festa-jury fj-stack" data-jury-root>${spinner()}</div></section>`;
  return mount.querySelector('[data-jury-root]');
}
function statusText(element, text, error = false) {
  element.textContent = text;
  element.className = text ? `notice ${error ? 'notice--err' : 'notice--info'}` : '';
  element.setAttribute('role', error ? 'alert' : 'status');
}
function eligibleEntries(key, entries) {
  const institution = PANELS[key].institution;
  return entries.filter((entry) => institution ? institutionOf(entry) === institution : INSTITUTIONS.includes(institutionOf(entry)));
}
function rosterIssue(key, ids, entries, opening = false) {
  if (key !== 'final') return opening && !ids.length ? '평가할 작품을 한 건 이상 선택해 주세요.' : '';
  if (ids.length > 6 || (opening && ids.length !== 6)) return '최종 심사는 정확히 6개 작품으로 진행합니다.';
  if (!opening) return '';
  const chosen = entries.filter((entry) => ids.includes(entry.id));
  const authors = chosen.map((entry) => String(entry.author?.email || '').trim().toLowerCase());
  if (authors.some((email) => !email) || new Set(authors).size !== 6) return '서로 다른 제출자 6명의 작품을 선택해 주세요.';
  if (chosen.filter((entry) => institutionOf(entry) === '행정안전부').length < 2 || chosen.filter((entry) => institutionOf(entry) === '한국서부발전').length < 1) return '행정안전부 2작품 이상, 한국서부발전 1작품 이상을 포함해 주세요.';
  return '';
}

function institutionHtml(data) {
  const missing = data.entries.filter((entry) => !institutionOf(entry)).length;
  return `<details class="card" ${missing ? 'open' : ''}><summary><strong>🏢 출품 기관 확인·수정 · 미지정 ${missing}건</strong></summary><p class="field__hint">기관을 확인해야 1단계 평가 대상에 포함할 수 있습니다. 평가 대상이 확정된 작품의 기관은 변경할 수 없습니다.</p><div data-testid="jury-institution-list">${data.entries.length ? data.entries.map((entry, index) => {
    const locked = entry.institutionLocked || data.panels.some((panel) => panel.status !== 'draft' && panel.entryIds?.includes(entry.id));
    return `<form class="fj-assign-row" data-institution-entry="${attr(entry.id)}"><div><strong>${esc(entry.title)}</strong><p class="field__hint">${esc(entry.author?.name || '')} · ${esc(entry.author?.email || '')}</p>${locked ? '<span class="badge badge--soft">대상 확정 · 변경 불가</span>' : ''}</div><label class="field" for="juryInstitution${index}"><span class="field__label">출품 기관</span><select class="input" id="juryInstitution${index}" name="institution" required ${locked ? 'disabled' : ''}><option value="">기관 선택</option>${INSTITUTIONS.map((institution) => `<option value="${institution}" ${institutionOf(entry) === institution ? 'selected' : ''}>${institution}</option>`).join('')}</select></label><button type="submit" class="btn btn--outline btn--sm" ${locked ? 'disabled' : ''}>기관 저장</button><p data-institution-status role="status" aria-live="polite"></p></form>`;
  }).join('') : '<p class="fj-note">등록된 작품이 없습니다.</p>'}</div></details>`;
}

function rosterHtml(panel, entries) {
  const options = eligibleEntries(panel.key, entries);
  const locked = panel.status !== 'draft';
  return `<section class="card fj-stack" aria-labelledby="juryRosterTitle"><div><h3 id="juryRosterTitle">1. 평가 대상 작품</h3><p class="field__hint">${panel.key === 'final' ? '서로 다른 제출자 6명의 작품을 선택합니다. 행정안전부 최소 2작품, 한국서부발전 최소 1작품을 포함해야 평가를 시작할 수 있습니다.' : `${PANELS[panel.key].institution} 작품 중 한 건 이상을 선택합니다.`}${locked ? ' 평가를 시작한 뒤에는 대상을 변경할 수 없습니다.' : ''}</p></div><form data-testid="jury-roster-form"><fieldset style="border:0;padding:0;margin:0;min-width:0" ${locked ? 'disabled' : ''}><legend class="sr-only">평가 대상 선택</legend><div class="fj-choice-list">${options.length ? options.map((entry) => `<label class="fj-choice"><input type="checkbox" name="entryId" value="${attr(entry.id)}" ${panel.entryIds?.includes(entry.id) ? 'checked' : ''} /><span><strong>${esc(entry.title)}</strong><span class="field__hint">${esc(entry.author?.name || '')} · ${esc(institutionOf(entry))}</span></span></label>`).join('') : '<p class="notice notice--info">이 단계에 포함할 수 있는 작품이 없습니다. 위에서 출품 기관을 확인해 주세요.</p>'}</div><div class="fj-head" style="margin-top:var(--space-3)"><p data-testid="jury-roster-count" class="festa-total"></p>${locked ? '' : '<button type="submit" class="btn btn--primary" data-testid="jury-roster-save">대상 작품 저장</button>'}</div></fieldset><p data-roster-status role="status" aria-live="polite" style="margin-top:var(--space-3)"></p></form></section>`;
}

function scoreTable(panel, entries) {
  const rows = Array.isArray(panel.scores) ? panel.scores : [];
  if (!rows.length) return '<p class="fj-note">저장된 평가가 없습니다.</p>';
  return `<div class="fj-table-wrap"><table class="fj-table" data-testid="jury-private-scores"><caption>관리자 전용 · 심사위원별 저장 점수</caption><thead><tr><th>심사위원</th><th>작품</th>${RUBRIC.map((rule) => `<th>${rule.name}</th>`).join('')}<th>합계</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(panel.judges.find((judge) => judge.id === row.judgeId)?.name || '심사위원')}</td><td>${esc(entries.find((entry) => entry.id === row.entryId)?.title || row.entryId)}</td>${RUBRIC.map((_, index) => `<td>${validFestaScores(row.scores) ? row.scores[index] : '—'}</td>`).join('')}<td>${totalOf(row.scores) ?? '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function judgesHtml(panel, secrets) {
  return `<section class="card fj-stack" aria-labelledby="juryJudgesTitle"><div><h3 id="juryJudgesTitle">2. 심사위원과 초대 링크</h3><p class="field__hint">각 심사위원의 이메일은 본인 출품작 평가를 막는 데 사용합니다. 초대 링크와 PIN은 직접 전달해 주세요.</p></div>${panel.status === 'draft' ? `<form data-testid="jury-add-judge-form"><div class="fj-form-grid"><label class="field"><span class="field__label">심사위원 이름</span><input class="input" name="name" maxlength="60" required /></label><label class="field"><span class="field__label">심사위원 이메일</span><input class="input" name="email" type="email" maxlength="254" required /></label></div><button class="btn btn--primary" type="submit">심사위원 추가</button><p data-add-judge-status role="status" aria-live="polite" style="margin-top:var(--space-3)"></p></form>` : '<p class="fj-note">평가를 시작한 뒤에는 심사위원을 추가할 수 없습니다.</p>'}<div class="fj-stack" data-testid="jury-judges">${panel.judges.length ? panel.judges.map((judge) => {
    const secret = secrets.get(`${panel.key}:${judge.id}`);
    const mailto = secret ? invitationMailto(judge, panel, secret.url) : '';
    return `<article class="card card--flat fj-stack" data-judge-id="${attr(judge.id)}"><div class="fj-head"><div><h4>${esc(judge.name)}</h4><p class="field__hint">${esc(judge.email || '')}</p></div><span class="badge ${judge.revoked ? 'badge--closed' : judge.hasInvite ? 'badge--open' : 'badge--soft'}">${judge.revoked ? '접근 해제' : judge.hasInvite ? '초대 발급됨' : '초대 미발급'}</span></div><p class="festa-total" data-judge-progress>평가 ${esc(judge.scoredCount ?? 0)} / ${esc(judge.eligibleCount ?? panel.entryIds.length)}건 완료</p>${judge.expiresAt ? `<p class="field__hint">초대 만료 ${esc(fmtDate(judge.expiresAt, true))} (한국시간)</p>` : ''}
      ${panel.status === 'draft' ? `<details><summary>심사위원 정보 수정·삭제</summary><form data-edit-judge="${attr(judge.id)}" style="margin-top:var(--space-3)"><div class="fj-form-grid"><label class="field"><span class="field__label">심사위원 이름</span><input class="input" name="name" maxlength="60" required value="${attr(judge.name)}" /></label><label class="field"><span class="field__label">심사위원 이메일</span><input class="input" type="email" name="email" maxlength="254" required value="${attr(judge.email)}" /></label></div><p class="field__hint">정보를 바꾸면 기존 초대가 무효가 됩니다. 수정 후 링크와 PIN을 다시 발급해 주세요.</p><div class="fj-actions" style="margin-top:var(--space-2)"><button type="submit" class="btn btn--outline btn--sm">심사위원 정보 저장</button><button type="button" class="btn btn--danger btn--sm" data-remove-judge="${attr(judge.id)}">명단에서 삭제</button></div><p data-edit-judge-status role="status" aria-live="polite"></p></form></details>` : ''}
      ${panel.status !== 'closed' ? `<form data-invite-judge="${attr(judge.id)}"><div class="fj-pin-row"><label class="field"><span class="field__label">설정할 6자리 PIN</span><input class="input" type="password" name="pin" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="new-password" required aria-label="${attr(judge.name)}에게 설정할 6자리 PIN" /></label><button class="btn btn--outline" type="submit">${judge.hasInvite ? '새 링크·PIN 발급' : '초대 링크 발급'}</button></div><p class="field__hint">0으로 시작할 수 있습니다. 재발급하면 이전 링크와 로그인은 사용할 수 없습니다.</p><p data-invite-status role="status" aria-live="polite" style="margin-top:var(--space-2)"></p></form>` : ''}
      ${secret ? `<div class="fj-secret"><label class="field"><span class="field__label">${esc(judge.name)} 전용 초대 링크</span><input class="input" value="${attr(secret.url)}" readonly data-testid="jury-invite-url" /></label><div class="fj-actions"><button type="button" class="btn btn--primary btn--sm" data-copy-judge="${attr(judge.id)}">링크 복사</button>${mailto ? `<a class="btn btn--outline btn--sm" href="${attr(mailto)}" data-mail-judge="${attr(judge.id)}">메일로 전달</a>` : ''}</div><p class="field__hint">메일로 전달을 누르면 받는 사람과 초대 링크가 입력된 이메일 초안이 열립니다. PIN은 본문에 포함되지 않으니 별도로 전달해 주세요. 입력한 PIN은 저장 후 다시 표시되지 않습니다.</p><p data-copy-status role="status" aria-live="polite"></p></div>` : judge.hasInvite && !judge.revoked ? '<p class="field__hint">발급 시 표시한 링크를 사용하세요. 링크를 분실했다면 새 링크와 PIN을 발급해 주세요.</p>' : ''}
      ${judge.hasInvite && !judge.revoked && panel.status !== 'closed' ? `<button type="button" class="btn btn--danger btn--sm" data-revoke-judge="${attr(judge.id)}">이 심사위원의 접근 해제</button>` : ''}
    </article>`;
  }).join('') : '<p class="notice notice--info">등록된 심사위원이 없습니다.</p>'}</div></section>`;
}

export async function festaJuryAdminView(mount) {
  const root = shell(mount, true);
  if (!isAdmin()) { root.innerHTML = '<p class="notice notice--err">관리자만 이용할 수 있습니다.</p>'; return; }
  let selectedPanel = 'mois';
  const secrets = new Map();
  const refresh = async () => {
    const data = await jury('admin');
    data.entries = Array.isArray(data.entries) ? data.entries : [];
    data.panels = Object.keys(PANELS).map((key) => ({ key, label: PANELS[key].label, status: 'draft', entryIds: [], judges: [], results: [], scores: [], ...(data.panels || []).find((panel) => panel.key === key) }));
    const panel = data.panels.find((item) => item.key === selectedPanel);
    if (!root.isConnected) return;
    root.innerHTML = `${institutionHtml(data)}<div class="fj-tabs" role="tablist" aria-label="평가 단계">${data.panels.map((item) => `<button class="btn btn--outline" role="tab" aria-selected="${item.key === selectedPanel}" data-panel="${item.key}">${esc(PANELS[item.key].label)}</button>`).join('')}</div><div class="fj-head"><div><h2 class="page-title" style="font-size:2.4rem">${esc(PANELS[panel.key].label)}</h2><p class="field__hint">단계별 대상과 평가 점수는 각각 관리됩니다.</p></div>${badge(panel.status)}</div>${rosterHtml(panel, data.entries)}${judgesHtml(panel, secrets)}<section class="card fj-stack"><div><h3>3. 평가 시작·마감</h3><p class="field__hint">페스타 접수를 수동으로 마감한 뒤 평가를 시작할 수 있습니다. 모든 심사위원의 유효한 초대가 필요합니다. 시작하면 대상·심사위원 구성이 확정되고, 모든 심사위원이 담당 작품의 점수를 저장해야 이 단계를 마감할 수 있습니다.</p></div><div class="fj-actions">${panel.status === 'draft' ? '<button class="btn btn--primary" data-jury-status="open">이 단계 평가 시작</button>' : panel.status === 'open' ? '<button class="btn btn--outline" data-jury-status="closed">이 단계 평가 마감</button>' : '<p class="notice notice--info">이 단계 평가가 마감되었습니다.</p>'}<button class="btn btn--quiet" data-jury-refresh>진행 현황 새로고침</button></div><p data-panel-status role="status" aria-live="polite"></p></section><section class="card fj-stack"><h3>관리자 전용 평가 결과</h3><p class="fj-note">심사위원 화면에는 다른 심사위원의 점수와 평균이 표시되지 않습니다.</p>${scoreTable(panel, data.entries)}<div class="fj-table-wrap"><table class="fj-table" data-testid="jury-admin-results"><caption>작품별 집계</caption><thead><tr><th>작품</th><th>제출자</th><th>저장된 평가</th><th>평균 / 100점</th></tr></thead><tbody>${panel.entryIds.map((id) => { const entry = data.entries.find((item) => item.id === id); const result = panel.results.find((item) => item.entryId === id); return `<tr><td>${esc(entry?.title || id)}</td><td>${esc(entry?.author?.name || '')}</td><td>${esc(result?.scoreCount ?? 0)}건</td><td>${typeof result?.average === 'number' && Number.isFinite(result.average) ? result.average.toFixed(1) : '—'}</td></tr>`; }).join('')}</tbody></table></div><a class="btn btn--outline" href="#/admin/festa/awards">수상 결과 관리로 이동</a></section>`;
    root.querySelectorAll('[data-panel]').forEach((button) => button.addEventListener('click', () => { selectedPanel = button.dataset.panel; refresh().catch((error) => toastErr(error.message)); }));
    root.querySelector('[data-jury-refresh]').addEventListener('click', () => refresh().catch((error) => toastErr(error.message)));
    root.querySelectorAll('[data-institution-entry]').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button');
      const status = form.querySelector('[data-institution-status]');
      if (button.disabled) return;
      button.disabled = true;
      try { await request('/festa/institution', { entryId: form.dataset.institutionEntry, institution: form.elements.institution.value }); await refresh(); toastOk('출품 기관을 저장했습니다.'); }
      catch (error) { statusText(status, error.message, true); button.disabled = false; }
    }));
    const roster = root.querySelector('[data-testid="jury-roster-form"]');
    const chosenIds = () => [...roster.querySelectorAll('[name="entryId"]:checked')].map((input) => input.value);
    const isDirty = () => JSON.stringify([...chosenIds()].sort()) !== JSON.stringify([...(panel.entryIds || [])].sort());
    const updateCount = () => {
      const ids = chosenIds();
      roster.querySelector('[data-testid="jury-roster-count"]').textContent = `선택 ${ids.length}${panel.key === 'final' ? ' / 6' : ''}작품${isDirty() ? ' · 변경 사항을 저장해 주세요.' : ''}`;
      const button = root.querySelector('[data-jury-status="open"]');
      if (button) button.disabled = isDirty();
    };
    roster.addEventListener('change', updateCount);
    updateCount();
    roster.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = roster.querySelector('[data-testid="jury-roster-save"]');
      if (!button || button.disabled) return;
      const status = roster.querySelector('[data-roster-status]');
      const ids = chosenIds();
      const issue = rosterIssue(panel.key, ids, data.entries);
      if (issue) { statusText(status, issue, true); return; }
      button.disabled = true;
      try { await jury('panel', { panel: panel.key, entryIds: ids }); await refresh(); toastOk('평가 대상을 저장했습니다.'); }
      catch (error) { statusText(status, error.message, true); button.disabled = false; }
    });
    const add = root.querySelector('[data-testid="jury-add-judge-form"]');
    add?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!add.reportValidity()) return;
      const name = add.elements.name.value.trim();
      const email = add.elements.email.value.trim();
      const status = add.querySelector('[data-add-judge-status]');
      const button = add.querySelector('button');
      if (button.disabled) return;
      if (!name || !isEmail(email)) { statusText(status, '이름과 올바른 이메일을 입력해 주세요.', true); return; }
      button.disabled = true;
      try { await jury('judge', { panel: panel.key, name, email }); await refresh(); toastOk('심사위원을 추가했습니다.'); }
      catch (error) { statusText(status, error.message, true); button.disabled = false; }
    });
    root.querySelectorAll('[data-edit-judge]').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]');
      const name = form.elements.name.value.trim();
      const email = form.elements.email.value.trim();
      const status = form.querySelector('[data-edit-judge-status]');
      if (button.disabled) return;
      if (!name || !isEmail(email)) { statusText(status, '이름과 올바른 이메일을 입력해 주세요.', true); return; }
      button.disabled = true;
      try { await jury('judge', { panel: panel.key, judgeId: form.dataset.editJudge, name, email }); secrets.delete(`${panel.key}:${form.dataset.editJudge}`); await refresh(); toastOk('심사위원 정보를 저장했습니다. 초대를 다시 발급해 주세요.'); }
      catch (error) { statusText(status, error.message, true); button.disabled = false; }
    }));
    root.querySelectorAll('[data-remove-judge]').forEach((button) => button.addEventListener('click', async () => {
      if (!await confirmModal({ title: '심사위원을 명단에서 삭제할까요?', body: '아직 평가를 시작하지 않은 단계에서만 삭제할 수 있습니다. 발급된 초대 링크도 사용할 수 없게 됩니다.', confirmLabel: '명단에서 삭제', danger: true })) return;
      button.disabled = true;
      try { await jury('judge/remove', { panel: panel.key, judgeId: button.dataset.removeJudge }); secrets.delete(`${panel.key}:${button.dataset.removeJudge}`); await refresh(); toastOk('심사위원을 삭제했습니다.'); }
      catch (error) { toastErr(error.message); button.disabled = false; }
    }));
    root.querySelectorAll('[data-invite-judge]').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const pin = form.elements.pin.value;
      const status = form.querySelector('[data-invite-status]');
      const button = form.querySelector('button');
      const judgeId = form.dataset.inviteJudge;
      if (button.disabled || !/^[0-9]{6}$/.test(pin)) return;
      if (panel.judges.find((judge) => judge.id === judgeId)?.hasInvite && !await confirmModal({ title: '초대 링크를 다시 발급할까요?', body: '기존 초대 링크와 해당 심사위원의 로그인은 사용할 수 없게 됩니다. 저장된 점수는 유지됩니다.', confirmLabel: '새 링크·PIN 발급' })) return;
      button.disabled = true;
      try {
        const result = await jury('invite', { panel: panel.key, judgeId, pin });
        const url = new URL(window.location.href); url.search = ''; url.hash = `/festa/jury/${encodeURIComponent(result.token)}`;
        secrets.set(`${panel.key}:${judgeId}`, { url: url.href, expiresAt: result.expiresAt });
        await refresh(); toastOk('초대 링크를 발급했습니다. 링크를 복사해 직접 전달해 주세요.');
      } catch (error) { statusText(status, error.message, true); button.disabled = false; }
    }));
    root.querySelectorAll('[data-copy-judge]').forEach((button) => button.addEventListener('click', async () => {
      const holder = button.closest('.fj-secret');
      const input = holder.querySelector('input');
      try { await navigator.clipboard.writeText(input.value); statusText(holder.querySelector('[data-copy-status]'), '초대 링크를 복사했습니다.'); }
      catch { input.focus(); input.select(); statusText(holder.querySelector('[data-copy-status]'), '링크를 선택했습니다. 복사 단축키로 복사해 주세요.'); }
    }));
    root.querySelectorAll('[data-revoke-judge]').forEach((button) => button.addEventListener('click', async () => {
      if (!await confirmModal({ title: '이 심사위원의 접근을 해제할까요?', body: '초대 링크와 로그인으로 더 이상 평가할 수 없습니다. 저장된 점수는 유지됩니다.', confirmLabel: '접근 해제', danger: true })) return;
      button.disabled = true;
      try { await jury('revoke', { panel: panel.key, judgeId: button.dataset.revokeJudge }); secrets.delete(`${panel.key}:${button.dataset.revokeJudge}`); await refresh(); toastOk('접근을 해제했습니다.'); }
      catch (error) { toastErr(error.message); button.disabled = false; }
    }));
    root.querySelector('[data-jury-status]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const next = button.dataset.juryStatus;
      const status = root.querySelector('[data-panel-status]');
      const issue = next === 'open' ? rosterIssue(panel.key, panel.entryIds, data.entries, true) : '';
      if (issue) { statusText(status, issue, true); return; }
      if (!await confirmModal({ title: next === 'open' ? '이 단계 평가를 시작할까요?' : '이 단계 평가를 마감할까요?', body: next === 'open' ? '평가 대상과 심사위원 구성이 확정됩니다. 초대받은 심사위원이 작품과 첨부를 보고 점수를 저장할 수 있습니다.' : '심사위원의 평가와 첨부 접근이 종료됩니다. 저장된 점수는 관리자 결과에 남습니다.', confirmLabel: next === 'open' ? '평가 시작' : '평가 마감' })) return;
      button.disabled = true;
      try { await jury('status', { panel: panel.key, status: next }); await refresh(); toastOk(next === 'open' ? '평가를 시작했습니다.' : '평가를 마감했습니다.'); }
      catch (error) { statusText(status, error.message, true); button.disabled = false; }
    });
  };
  try { await refresh(); } catch (error) { if (root.isConnected) root.innerHTML = `<p class="notice notice--err" role="alert">심사 운영 정보를 불러오지 못했습니다 — ${esc(error.message)}</p>`; }
}

function jurorHeader(session) {
  return `<section class="card"><div class="fj-head"><div><h2 class="page-title" style="font-size:2.3rem">${esc(session.label || PANELS[session.panel]?.label || '심사위원 평가')}</h2><p class="page-sub">${esc(session.judgeName || '')} 심사위원</p></div>${badge(session.status)}</div><p class="field__hint">초대 만료 ${esc(fmtDate(session.expiresAt, true))} (한국시간) · 본인의 저장 점수만 표시됩니다.</p></section>`;
}

export async function festaJurorView(mount, { invite }) {
  const root = shell(mount, false);
  const token = String(invite || '');
  let invitation;
  let session;
  let selectedId = null;
  const drafts = new Map();
  let saving = false;
  try { invitation = await jury(`invitation?token=${encodeURIComponent(token)}`); }
  catch (error) { root.innerHTML = `<p class="notice notice--err" role="alert">초대 링크를 확인할 수 없습니다 — ${esc(error.message)}</p>`; return; }

  const showUnlock = (note = '') => {
    if (!root.isConnected) return;
    root.innerHTML = `<section class="card wrap--narrow" style="width:100%;margin-inline:auto"><h2 class="page-title" style="font-size:2.2rem">${esc(invitation.label || PANELS[invitation.panel]?.label || '심사위원 입장')}</h2><p class="page-sub">${esc(invitation.judgeName)} 심사위원님, 전달받은 6자리 PIN을 입력해 주세요.</p><p class="field__hint">초대 만료 ${esc(fmtDate(invitation.expiresAt, true))} (한국시간)</p><form data-testid="juror-unlock-form" style="margin-top:var(--space-4)"><label class="field"><span class="field__label">6자리 PIN</span><input class="input" type="password" name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus /></label><button type="submit" class="btn btn--primary" data-testid="juror-unlock">심사 화면 입장</button><p data-unlock-status role="status" aria-live="polite" style="margin-top:var(--space-3)">${esc(note)}</p></form><p class="field__hint">사이트 회원가입이나 회원 로그인은 필요하지 않습니다. PIN을 잊었다면 운영자에게 문의해 주세요.</p></section>`;
    const form = root.querySelector('[data-testid="juror-unlock-form"]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      const status = form.querySelector('[data-unlock-status]');
      statusText(status, 'PIN을 확인하고 있습니다.');
      try { await jury('unlock', { token, pin: form.elements.pin.value }); await loadSession(); }
      catch (error) { statusText(status, error.message, true); button.disabled = false; form.elements.pin.focus(); form.elements.pin.select(); }
    });
  };

  const render = () => {
    if (!root.isConnected) return;
    const entries = Array.isArray(session.entries) ? session.entries : [];
    if (session.status !== 'open') {
      root.innerHTML = `${jurorHeader(session)}<p class="notice notice--info" data-testid="juror-closed">${session.status === 'closed' ? '평가가 마감되었습니다. 저장한 점수는 운영자에게 전달되어 있으며, 더 이상 평가를 수정할 수 없습니다.' : '아직 평가가 시작되지 않았습니다. 운영자의 시작 안내 후 다시 접속해 주세요.'}</p>`;
      return;
    }
    const eligible = entries.filter((entry) => !entry.scoreBlocked);
    const completed = eligible.filter((entry) => validFestaScores(entry.myScores)).length;
    if (!entries.some((entry) => entry.id === selectedId)) selectedId = entries.find((entry) => !entry.scoreBlocked && !validFestaScores(entry.myScores))?.id || entries[0]?.id;
    const current = entries.find((entry) => entry.id === selectedId);
    root.innerHTML = `${jurorHeader(session)}<section class="card fj-stack"><div class="fj-head"><h3>작품 목록</h3><span data-testid="juror-progress" class="festa-total">평가 ${completed} / ${eligible.length}건 완료</span></div><div class="fj-progress"><progress max="${Math.max(1, eligible.length)}" value="${completed}" aria-label="평가 완료 현황"></progress><p class="fj-note">현재 작품은 분홍 테두리, 완료 작품은 초록색으로 표시됩니다. 점수는 저장 버튼을 눌러야 반영됩니다.</p></div><nav class="fj-entry-nav" aria-label="심사할 작품 선택" data-testid="juror-entry-list">${entries.map((entry, index) => { const done = !entry.scoreBlocked && validFestaScores(entry.myScores); const active = entry.id === selectedId; return `<button type="button" class="fj-entry-choice ${done ? 'is-complete' : 'is-unscored'}${active ? ' is-current' : ''}" data-juror-entry="${attr(entry.id)}" ${active ? 'aria-current="step"' : ''}><span class="fj-entry-choice__title">${index + 1}. ${esc(entry.title)}</span><span class="fj-entry-choice__status">${active ? '현재 · ' : ''}${entry.scoreBlocked ? '평가 제외' : done ? '✓ 평가 완료' : '○ 미평가'}</span></button>`; }).join('')}</nav></section><div data-juror-detail>${current ? detailHtml(current) : emptyState({ title: '평가할 작품이 없습니다', body: '운영자에게 평가 대상 구성을 확인해 주세요.' })}</div>`;
    root.querySelectorAll('[data-juror-entry]').forEach((button) => button.addEventListener('click', () => {
      if (saving) { toastErr('평가를 저장하고 있습니다. 잠시 기다려 주세요.'); return; }
      selectedId = button.dataset.jurorEntry;
      render();
    }));
    const form = root.querySelector('[data-testid="juror-score-form"]');
    if (!form || !current) return;
    const values = () => RUBRIC.map((_, index) => { const value = form.elements[`score${index}`].value.trim(); return value === '' ? null : Number(value); });
    form.addEventListener('input', () => {
      drafts.set(current.id, RUBRIC.map((_, index) => form.elements[`score${index}`].value));
      const total = totalOf(values());
      root.querySelector('[data-testid="juror-score-total"]').textContent = total === null ? '네 항목의 점수를 모두 입력해 주세요.' : `합계 ${total} / 100점`;
      statusText(form.querySelector('[data-score-status]'), '변경한 점수는 아직 저장되지 않았습니다.');
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving || !form.reportValidity()) return;
      const scores = values();
      const status = form.querySelector('[data-score-status]');
      if (!validFestaScores(scores)) { statusText(status, '네 항목에 허용 범위의 정수 점수를 모두 입력해 주세요.', true); return; }
      saving = true;
      form.querySelector('fieldset').disabled = true;
      statusText(status, '점수를 저장하고 있습니다.');
      try {
        await jury('score', { token, entryId: current.id, scores });
        current.myScores = scores;
        drafts.delete(current.id);
        saving = false;
        render();
        statusText(root.querySelector('[data-score-status]'), `합계 ${totalOf(scores)}점으로 저장했습니다. 평가 중에는 수정할 수 있습니다.`);
      } catch (error) {
        saving = false;
        if (error.status === 401 || error.status === 403) showUnlock('심사 로그인이 만료되었거나 변경되었습니다. PIN으로 다시 입장해 주세요.');
        else if (error.status === 409) {
          try { await loadSession(); if (session.status === 'open') statusText(root.querySelector('[data-score-status]'), error.message, true); }
          catch { statusText(status, error.message, true); form.querySelector('fieldset').disabled = false; }
        } else { statusText(status, error.message, true); form.querySelector('fieldset').disabled = false; }
      }
    });
  };

  const detailHtml = (entry) => {
    const stored = !entry.scoreBlocked && validFestaScores(entry.myScores) ? entry.myScores : null;
    const draft = drafts.get(entry.id);
    const raw = draft || (stored ? stored.map(String) : ['', '', '', '']);
    const total = totalOf(raw.map((value) => value === '' ? null : Number(value)));
    return `<article class="card fj-stack" data-testid="juror-entry-detail"><div><h2 class="page-title" style="font-size:2.3rem">${esc(entry.title)}</h2><p class="page-sub">${esc(entry.author?.name || '')} · ${esc(institutionOf(entry) || entry.author?.institution || '')}</p></div>${linksHtml(entry)}<section aria-label="작품 설명"><h3>📝 작품 설명</h3><div class="fj-description" data-testid="juror-description">${esc(entry.description)}</div></section><section aria-label="첨부 자료"><h3 style="margin-bottom:var(--space-3)">📎 첨부 자료</h3>${filesHtml(entry, token)}</section>${entry.scoreBlocked ? `<p class="notice notice--info" data-testid="juror-score-blocked">${esc(entry.scoreBlocked)}</p>` : `<form data-testid="juror-score-form" data-entry-id="${attr(entry.id)}"><fieldset style="border:0;padding:0;margin:0;min-width:0"><legend style="font-size:1.9rem;font-weight:700">${stored ? '저장한 평가 수정' : '작품 평가'} · 총 100점</legend><div class="fj-score-rows">${RUBRIC.map((rule, index) => `<div class="fj-score-row"><label for="jurorScore${index}"><span class="field__label">${rule.name} · ${rule.max}점</span><span class="field__hint" id="jurorScoreHelp${index}">${rule.description}</span></label><input class="input" id="jurorScore${index}" name="score${index}" type="number" min="0" max="${rule.max}" step="1" inputmode="numeric" required value="${attr(raw[index])}" aria-describedby="jurorScoreHelp${index}" /></div>`).join('')}</div><div class="fj-head" style="margin-top:var(--space-4)"><p class="fj-score-total" data-testid="juror-score-total" aria-live="polite">${total === null ? '네 항목의 점수를 모두 입력해 주세요.' : `합계 ${total} / 100점`}</p><button class="btn btn--primary" type="submit" data-testid="juror-score-save">${stored ? '평가 수정 저장' : '평가 저장'}</button></div></fieldset><p data-score-status role="status" aria-live="polite" style="margin-top:var(--space-3)">${draft ? '입력한 점수는 아직 저장되지 않았습니다.' : stored ? '저장된 평가입니다. 평가가 열려 있는 동안 수정할 수 있습니다.' : '0점도 입력할 수 있습니다. 빈 항목은 미평가로 남습니다.'}</p></form>`}</article>`;
  };
  const loadSession = async () => {
    session = await jury(`session?token=${encodeURIComponent(token)}`);
    if (session.judgeId !== invitation.judgeId || session.panel !== invitation.panel) throw new Error('현재 초대와 로그인 정보가 일치하지 않습니다. PIN을 다시 확인해 주세요.');
    render();
  };
  try { await loadSession(); } catch (error) { showUnlock(error.status === 401 || error.status === 403 ? '' : error.message); }
}
