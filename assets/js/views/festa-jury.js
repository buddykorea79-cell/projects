/** 심사위원별 초대·이메일 로그인 예선 블라인드 심사·회원 본선 평가. */
import { CONFIG } from '../config.js';
import { isAdmin, currentUser, refreshSession } from '../auth.js';
import {
  FESTA_RUBRIC as RUBRIC, validFestaScores, validRawFestaScores,
  convertRawFestaScores, deriveRawFestaScores, rankPrelimRows,
} from '../festa.js';
import { downloadPrelimResultPdf } from '../pdf.js';
import { esc, attr, fmtDate, fmtBytes, isEmail } from '../utils.js';
import { spinner, emptyState, confirmModal, toastOk, toastErr } from '../ui.js';

const PANELS = {
  mois: { label: '행정안전부 1차 평가', prelimLabel: '예선 심사(행정안전부)', institution: '행정안전부' },
  iwest: { label: '한국서부발전 1차 평가', prelimLabel: '예선 심사(한국서부발전)', institution: '한국서부발전' },
  final: { label: '2차 본선 평가', prelimLabel: '2차 본선 평가', institution: '' },
};
const PRELIM_KEYS = ['mois', 'iwest'];
const STATUS = { draft: '준비 중', open: '평가 중', closed: '평가 마감' };
const INSTITUTIONS = ['행정안전부', '한국서부발전'];
const API = String(CONFIG.r2?.apiBase || '/api').replace(/\/$/, '');

async function request(path, body) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const jury = (path, body) => request(`/festa/jury/${path}`, body);
const institutionOf = (entry) => INSTITUTIONS.includes(entry.institution) ? entry.institution : INSTITUTIONS.includes(entry.author?.institution) ? entry.author.institution : '';
const totalOf = (scores) => validFestaScores(scores) ? scores.reduce((sum, score) => sum + score, 0) : null;
const rawTotalOf = (rawScores) => validRawFestaScores(rawScores) ? rawScores.reduce((sum, score) => sum + score, 0) : null;
const badge = (status) => `<span class="badge ${status === 'open' ? 'badge--open' : status === 'closed' ? 'badge--closed' : 'badge--soft'}">${esc(STATUS[status] || status)}</span>`;

function safeUrl(value) {
  if (!value || /[\u0000-\u0020\u007f]/.test(String(value))) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function linksHtml(entry) {
  return `<div class="fj-actions">${entry.rehearsal && !entry.deployUrl ? '<span class="badge badge--soft">배포 주소 미등록</span>' : entry.localOnly ? '<span class="badge badge--soft">💻 로컬 실행 작품</span>' : ''}${[[entry.deployUrl, '🌐 작품 실행하기'], [entry.githubUrl, '📦 GitHub 저장소']].map(([raw, title]) => {
    const href = safeUrl(raw);
    return href ? `<a class="btn btn--outline btn--sm" href="${attr(href)}" target="_blank" rel="noopener noreferrer">${title}<span class="sr-only"> (새 창)</span></a>` : '';
  }).join('')}</div>`;
}
function filesHtml(entry, accessQuery, filePath = '/festa/jury/file') {
  if (!entry.files?.length) return '<p class="fj-note">첨부 파일이 없습니다.</p>';
  return `<ul class="fj-files" aria-label="작품 첨부 파일">${entry.files.map((file) => `<li class="fj-file"><div><strong>${esc(file.name || '첨부 파일')}</strong><p class="field__hint">${esc(fmtBytes(file.size))}</p></div><a class="btn btn--outline btn--sm" data-testid="jury-file" href="${attr(`${API}${filePath}/${encodeURIComponent(file.key)}${accessQuery ? `?${accessQuery}` : ''}`)}" target="_blank" rel="noopener noreferrer">내려받기<span class="sr-only">: ${esc(file.name)} (새 창)</span></a></li>`).join('')}</ul>`;
}

function panelUrl(panel) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = `/festa/jury/${panel}`;
  return url.href;
}

/** 이메일 앱의 초안만 엽니다. PIN은 링크와 별도로 전달하도록 본문에 넣지 않습니다. */
function invitationMailto(judge, panel, url) {
  const email = String(judge.email || '').trim();
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1);
  if (!isEmail(email) || !/^[\p{L}\p{N}.-]+$/u.test(domain)) return '';
  const recipient = `${encodeURIComponent(email.slice(0, at))}@${domain}`;
  const subject = `[말하는 대로, 바이브 코딩 페스타] ${PANELS[panel.key].label} 심사위원 초대`;
  const body = `${judge.name} 심사위원님,\n\n말하는 대로, 바이브 코딩 페스타의 ${PANELS[panel.key].label} 평가를 부탁드립니다.\n등록된 이메일로 사이트에 로그인한 뒤 '바이브 코딩 페스타' 메뉴에서 바로 예선 심사를 진행하시거나,\n아래 공용 심사 주소에서 운영자가 별도로 전달한 본인의 6자리 개인 코드로 입장해 주세요.\n\n${url}\n\n개인 코드는 다른 사람과 공유하지 마세요.\n감사합니다.`;
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function shell(mount, admin, heroTitle = '', heroSub = '') {
  mount.innerHTML = `<section class="band festa-hero fj-hero"><div class="wrap"><p class="crumb"><a href="${admin ? '#/admin/festa' : '#/festa'}" style="color:inherit">${admin ? '접수 현황' : '바이브 코딩 페스타'}</a><span>/</span>${esc(heroTitle || (admin ? '심사위원 운영' : '심사위원 평가'))}</p><h1 style="font-size:clamp(2.4rem,5vw,3.4rem);color:inherit">${esc(heroTitle || (admin ? '심사위원 운영' : '페스타 심사위원 평가'))}</h1><p style="margin-top:var(--space-2)">${esc(heroSub || (admin ? '대상 작품과 심사위원을 지정하고, 심사위원별 평가 진행 상황과 환산 결과를 확인합니다.' : '블라인드 방식으로 담당 작품을 공정하게 평가해 주세요.'))}</p>${admin ? '<div class="row" style="margin-top:var(--space-3)"><a class="btn btn--ghostDark" href="#/admin/festa">접수 현황</a><a class="btn btn--ghostDark is-active" href="#/admin/festa/jury" aria-current="page">심사위원·평가 대상 관리</a><a class="btn btn--ghostDark" href="#/admin/festa/awards" data-testid="jury-awards-link">수상작 확정·발표</a><a class="btn btn--ghostDark" href="#/admin/festa/rehearsal">AI Build Camp 본선 테스트·초기화</a><a class="btn btn--ghostDark" href="#/admin/festa/practice">샘플 작품 10건 · 평가 연습</a></div>' : ''}</div></section><section class="section"><div class="wrap festa-jury fj-stack" data-jury-root>${spinner()}</div></section>`;
  return mount.querySelector('[data-jury-root]');
}
function statusText(element, text, error = false) {
  if (!element) return;
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

function formatScoreCell(row, index, mode) {
  const conv = validFestaScores(row.scores) ? row.scores[index] : null;
  const raw = validRawFestaScores(row.rawScores) ? row.rawScores[index] : deriveRawFestaScores(row.scores)?.[index] ?? null;
  if (mode === 'raw') return raw !== null ? `${raw} / 10` : '—';
  if (mode === 'both' && raw !== null && conv !== null) return `${raw} → <strong>${conv}점</strong>`;
  return conv !== null ? `${conv}점` : '—';
}

function formatTotalCell(row, mode) {
  const convTotal = totalOf(row.scores);
  const rawArr = validRawFestaScores(row.rawScores) ? row.rawScores : deriveRawFestaScores(row.scores);
  const rawSum = rawTotalOf(rawArr);
  if (mode === 'raw') return rawSum !== null ? `${rawSum} / 40` : '—';
  if (mode === 'both' && rawSum !== null && convTotal !== null) return `${rawSum} → <strong>${convTotal}점</strong>`;
  return convTotal !== null ? `<strong>${convTotal}점</strong>` : '—';
}

function scoreTable(panel, entries, mode = 'converted') {
  const rows = Array.isArray(panel.scores) ? panel.scores : [];
  if (!rows.length) return '<p class="fj-note">저장된 평가가 없습니다.</p>';
  const isPrelim = PRELIM_KEYS.includes(panel.key);
  return `${isPrelim ? `<div class="fj-mode-bar" role="group" aria-label="점수 표시 변환" data-testid="admin-score-mode-bar">
    <span class="field__hint">점수 표시 기준:</span>
    <button type="button" class="btn btn--outline btn--sm ${mode === 'converted' ? 'is-selected' : ''}" data-admin-score-mode="converted">심사기준 환산점수 (100점)</button>
    <button type="button" class="btn btn--outline btn--sm ${mode === 'raw' ? 'is-selected' : ''}" data-admin-score-mode="raw">선택 원점수 (1~10점)</button>
    <button type="button" class="btn btn--outline btn--sm ${mode === 'both' ? 'is-selected' : ''}" data-admin-score-mode="both">원점수 → 환산점수</button>
  </div>` : ''}<div class="fj-table-wrap"><table class="fj-table" data-testid="jury-private-scores"><caption>관리자 전용 · 참여자별 저장 점수${isPrelim ? ' (환산식: 40·30·20·10 = 원점수 × 4·3·2·1)' : ''}</caption><thead><tr><th>평가 참여자</th><th>작품</th>${RUBRIC.map((rule) => `<th>${rule.name}${mode === 'raw' ? ' (1~10)' : ` (${rule.max}점)`}</th>`).join('')}<th>${mode === 'raw' ? '원점수 합계' : '환산 합계 (100점)'}</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc([...(panel.participants || []), ...panel.judges].find((judge) => judge.id === row.judgeId)?.name || '평가 참여자')}</td><td>${esc(entries.find((entry) => entry.id === row.entryId)?.title || row.entryId)}</td>${RUBRIC.map((_, index) => `<td>${isPrelim ? formatScoreCell(row, index, mode) : (validFestaScores(row.scores) ? row.scores[index] : '—')}</td>`).join('')}<td>${isPrelim ? formatTotalCell(row, mode) : (totalOf(row.scores) ?? '—')}</td></tr>`).join('')}</tbody></table></div>`;
}

function judgesHtml(panel) {
  const url = panelUrl(panel.key);
  if (panel.key === 'final') return `<section class="card fj-stack" data-testid="jury-member-setup"><h3>2. 회원 본선 평가</h3><p>로그인한 회원 누구나 별도 코드 없이 참여합니다. 본인 작품은 평가에서 제외되며, 평가를 저장한 회원만 참여 현황에 집계됩니다. 참여자가 모든 작품을 평가할 필요는 없습니다.</p><div class="fj-secret"><label class="field"><span class="field__label">회원 본선 평가 주소</span><input class="input" value="${attr(url)}" readonly data-testid="jury-panel-url" /></label><button type="button" class="btn btn--primary btn--sm" data-copy-panel>평가 주소 복사</button><p data-copy-status role="status" aria-live="polite"></p></div><h4>평가 참여 현황 · ${(panel.participants || []).length}명</h4><p class="field__hint">각 작품에 본인이 아닌 회원의 평가가 1건 이상 저장되면 운영자가 마감할 수 있습니다.</p><div class="fj-stack" data-testid="jury-member-participants">${(panel.participants || []).length ? panel.participants.map((person) => `<div class="fj-head"><div><strong>${esc(person.name)}</strong><p class="field__hint">${esc(person.email)}</p></div><span class="festa-total">${esc(person.scoredCount)} / ${esc(person.eligibleCount)}건 평가</span></div>`).join('') : '<p class="fj-note">아직 평가를 저장한 회원이 없습니다.</p>'}</div></section>`;
  return `<section class="card fj-stack" aria-labelledby="juryJudgesTitle"><div><h3 id="juryJudgesTitle">2. 심사위원 등록 · 이메일 로그인 및 개인 코드</h3><p class="field__hint">심사위원이 등록된 이메일로 사이트에 로그인하면 <strong>바이브 코딩 페스타</strong> 주 메뉴에서 <strong>${esc(PANELS[panel.key].prelimLabel)}</strong> 메뉴가 자동으로 표시되어 바로 심사할 수 있습니다. (비회원 심사위원은 아래 공용 주소 + 6자리 개인 코드로도 입장할 수 있습니다.)</p></div><div class="fj-secret"><label class="field"><span class="field__label">${esc(PANELS[panel.key].label)} 공용 심사 주소</span><input class="input" value="${attr(url)}" readonly data-testid="jury-panel-url" /></label><div class="fj-actions" style="margin-top:var(--space-2)"><button type="button" class="btn btn--primary btn--sm" data-copy-panel>공용 주소 복사</button><a class="btn btn--outline btn--sm" href="#/festa/prelim/${attr(panel.key)}" data-testid="admin-preview-prelim">${esc(PANELS[panel.key].prelimLabel)} 화면 보기</a></div><p class="field__hint">개인 코드를 발급하거나 재발급해도 이 주소는 바뀌지 않습니다.</p><p data-copy-status role="status" aria-live="polite"></p></div>${panel.status === 'draft' ? `<form data-testid="jury-add-judge-form"><div class="fj-form-grid"><label class="field"><span class="field__label">심사위원 이름</span><input class="input" name="name" maxlength="60" required /></label><label class="field"><span class="field__label">심사위원 이메일</span><input class="input" name="email" type="email" maxlength="254" required /></label></div><button class="btn btn--primary" type="submit">심사위원 추가</button><p data-add-judge-status role="status" aria-live="polite" style="margin-top:var(--space-3)"></p></form>` : '<p class="fj-note">평가를 시작한 뒤에는 심사위원을 추가할 수 없습니다.</p>'}<div class="fj-stack" data-testid="jury-judges">${panel.judges.length ? panel.judges.map((judge) => {
    const mailto = invitationMailto(judge, panel, url);
    return `<article class="card card--flat fj-stack" data-judge-id="${attr(judge.id)}"><div class="fj-head"><div><h4>${esc(judge.name)}</h4><p class="field__hint">${esc(judge.email || '')}</p></div><div class="fj-actions">${judge.completed ? '<span class="badge badge--open">✓ 심사 완료·서명됨</span>' : ''}<span class="badge ${judge.revoked ? 'badge--closed' : judge.hasInvite ? 'badge--open' : 'badge--soft'}">${judge.revoked ? '접근 해제' : judge.hasCommonCode ? '개인 코드 발급됨' : judge.hasInvite ? '기존 개별 링크' : '이메일 로그인 / 코드 미발급'}</span></div></div><p class="festa-total" data-judge-progress>평가 ${esc(judge.scoredCount ?? 0)} / ${esc(judge.eligibleCount ?? panel.entryIds.length)}건 완료</p>${judge.completed ? `<div class="fj-actions"><button type="button" class="btn btn--outline btn--sm" data-admin-judge-pdf="${attr(judge.id)}">📄 서명 결과 PDF 다운로드</button><span class="field__hint">완료 시각 ${esc(fmtDate(judge.completedAt, true))}</span></div>` : ''}${judge.expiresAt ? `<p class="field__hint">초대 만료 ${esc(fmtDate(judge.expiresAt, true))} (한국시간)</p>` : ''}
      ${panel.status === 'draft' ? `<details><summary>심사위원 정보 수정·삭제</summary><form data-edit-judge="${attr(judge.id)}" style="margin-top:var(--space-3)"><div class="fj-form-grid"><label class="field"><span class="field__label">심사위원 이름</span><input class="input" name="name" maxlength="60" required value="${attr(judge.name)}" /></label><label class="field"><span class="field__label">심사위원 이메일</span><input class="input" type="email" name="email" maxlength="254" required value="${attr(judge.email)}" /></label></div><p class="field__hint">정보를 바꾸면 기존 코드와 로그인이 무효가 됩니다. 수정 후 개인 코드를 다시 발급해 주세요.</p><div class="fj-actions" style="margin-top:var(--space-2)"><button type="submit" class="btn btn--outline btn--sm">심사위원 정보 저장</button><button type="button" class="btn btn--danger btn--sm" data-remove-judge="${attr(judge.id)}">명단에서 삭제</button></div><p data-edit-judge-status role="status" aria-live="polite"></p></form></details>` : ''}
      ${panel.status !== 'closed' ? `<form data-invite-judge="${attr(judge.id)}"><div class="fj-pin-row"><label class="field"><span class="field__label">설정할 6자리 개인 코드</span><input class="input" type="password" name="pin" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="new-password" required aria-label="${attr(judge.name)}에게 설정할 6자리 개인 코드" /></label><button class="btn btn--outline" type="submit">${judge.hasInvite ? '개인 코드 재발급' : '개인 코드 발급'}</button></div><p class="field__hint">0으로 시작할 수 있습니다. 같은 단계의 다른 심사위원과 다른 코드를 사용하세요. 재발급하면 이전 개인 코드·개별 링크·로그인은 무효가 되며 공용 주소는 유지됩니다.</p><p data-invite-status role="status" aria-live="polite" style="margin-top:var(--space-2)"></p></form>` : ''}
      <div class="fj-secret"><label class="field"><span class="field__label">${esc(judge.name)}에게 전달할 공용 심사 주소</span><input class="input" value="${attr(url)}" readonly data-testid="jury-invite-url" /></label><div class="fj-actions"><button type="button" class="btn btn--primary btn--sm" data-copy-judge="${attr(judge.id)}">주소 복사</button>${mailto ? `<a class="btn btn--outline btn--sm" href="${attr(mailto)}" data-mail-judge="${attr(judge.id)}">메일로 전달</a>` : ''}</div><p class="field__hint">메일에는 공용 심사 주소만 포함됩니다. 개인 코드는 본인에게 별도로 직접 전달해 주세요. 저장한 코드는 다시 표시되지 않습니다.</p>${judge.hasInvite && !judge.revoked && !judge.hasCommonCode ? '<p class="notice notice--warn" data-testid="jury-legacy-code">기존 개별 초대 링크는 계속 사용할 수 있습니다. 이 공용 주소로 입장하려면 개인 코드를 재발급해 주세요.</p>' : !judge.hasInvite || judge.revoked ? '<p class="field__hint">공용 주소로 입장하려면 먼저 이 심사위원의 개인 코드를 발급해 주세요.</p>' : ''}<p data-copy-status role="status" aria-live="polite"></p></div>
      ${judge.hasInvite && !judge.revoked && panel.status !== 'closed' ? `<button type="button" class="btn btn--danger btn--sm" data-revoke-judge="${attr(judge.id)}">이 심사위원의 접근 해제</button>` : ''}
    </article>`;
  }).join('') : '<p class="notice notice--info">등록된 심사위원이 없습니다.</p>'}</div></section>`;
}

export async function festaJuryAdminView(mount) {
  const root = shell(mount, true);
  if (!isAdmin()) { root.innerHTML = '<p class="notice notice--err">관리자만 이용할 수 있습니다.</p>'; return; }
  let selectedPanel = 'mois';
  let adminScoreMode = 'converted';
  const refresh = async () => {
    const data = await jury('admin');
    data.entries = Array.isArray(data.entries) ? data.entries : [];
    data.panels = Object.keys(PANELS).map((key) => ({ key, label: PANELS[key].label, status: 'draft', entryIds: [], judges: [], results: [], scores: [], ...(data.panels || []).find((panel) => panel.key === key) }));
    const panel = data.panels.find((item) => item.key === selectedPanel);
    if (!root.isConnected) return;
    root.innerHTML = `${institutionHtml(data)}<div class="fj-tabs" role="tablist" aria-label="평가 단계">${data.panels.map((item) => `<button class="btn btn--outline" role="tab" aria-selected="${item.key === selectedPanel}" data-panel="${item.key}">${esc(PANELS[item.key].label)}</button>`).join('')}</div><div class="fj-head"><div><h2 class="page-title" style="font-size:2.4rem">${esc(PANELS[panel.key].label)}</h2><p class="field__hint">단계별 대상과 평가 점수는 각각 관리됩니다.</p></div>${badge(panel.status)}</div>${rosterHtml(panel, data.entries)}${judgesHtml(panel)}<section class="card fj-stack"><div><h3>3. 평가 시작·마감</h3><p class="field__hint">${panel.key === 'final' ? '페스타 접수를 수동으로 마감한 뒤 본선 대상 6작품을 확정하면 회원 평가를 시작할 수 있습니다. 각 작품에 유효한 비본인 평가가 1건 이상 있으면 마감할 수 있습니다.' : '페스타 접수를 수동으로 마감한 뒤 평가를 시작할 수 있습니다. 사이트 가입 이메일 또는 유효한 개인 코드가 필요합니다. 시작하면 대상·심사위원 구성이 확정되고, 모든 심사위원이 담당 작품의 점수를 저장해야 이 단계를 마감할 수 있습니다.'}</p></div><div class="fj-actions">${panel.status === 'draft' ? '<button class="btn btn--primary" data-jury-status="open">이 단계 평가 시작</button>' : panel.status === 'open' ? '<button class="btn btn--outline" data-jury-status="closed">이 단계 평가 마감</button>' : `<p class="notice notice--info">이 단계 평가가 마감되었습니다.</p>${panel.key === 'final' ? '<a class="btn btn--primary" href="#/festa/results" data-testid="jury-results-link">공개 발표 화면</a><a class="btn btn--outline" href="#/admin/festa/awards">수상 결과 관리·동점 확정</a>' : ''}`}<button class="btn btn--quiet" data-jury-refresh>진행 현황 새로고침</button></div><p data-panel-status role="status" aria-live="polite"></p></section><section class="card fj-stack"><h3>관리자 전용 평가 결과</h3><p class="fj-note">심사위원 화면에는 다른 심사위원의 점수와 평균이 표시되지 않습니다. 예선 1~10점 원점수는 심사기준(40·30·20·10) 환산점수로 자동 변환·비교할 수 있습니다.</p>${scoreTable(panel, data.entries, adminScoreMode)}<div class="fj-table-wrap"><table class="fj-table" data-testid="jury-admin-results"><caption>작품별 집계 (환산점수 기준 · 총 100점)</caption><thead><tr><th>순위</th><th>작품</th><th>제출자</th><th>저장된 평가</th><th>평균 / 100점</th></tr></thead><tbody>${[...panel.entryIds].map((id) => {
      const entry = data.entries.find((item) => item.id === id);
      const result = panel.results.find((item) => item.entryId === id);
      return { id, entry, result, avg: typeof result?.average === 'number' && Number.isFinite(result.average) ? result.average : null };
    }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1)).map(({ id, entry, result, avg }, idx) => `<tr><td>${avg !== null ? `${idx + 1}위` : '—'}</td><td>${esc(entry?.title || id)}</td><td>${esc(entry?.author?.name || '')}</td><td>${esc(result?.scoreCount ?? 0)}건</td><td>${avg !== null ? avg.toFixed(1) : '—'}</td></tr>`).join('')}</tbody></table></div><a class="btn btn--outline" href="#/admin/festa/awards">수상 결과 관리로 이동</a></section>`;
    root.querySelectorAll('[data-panel]').forEach((button) => button.addEventListener('click', () => { selectedPanel = button.dataset.panel; refresh().catch((error) => toastErr(error.message)); }));
    root.querySelectorAll('[data-admin-score-mode]').forEach((button) => button.addEventListener('click', () => {
      adminScoreMode = button.dataset.adminScoreMode;
      refresh().catch((error) => toastErr(error.message));
    }));
    root.querySelectorAll('[data-admin-judge-pdf]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const res = await jury(`admin/completion?panel=${encodeURIComponent(panel.key)}&judgeId=${encodeURIComponent(button.dataset.adminJudgePdf)}`);
        await downloadPrelimResultPdf(res.completion, { scoreMode: adminScoreMode === 'raw' ? 'both' : adminScoreMode });
        toastOk('심사위원 결과 PDF를 다운로드했습니다.');
      } catch (error) {
        toastErr(error.message);
      } finally {
        button.disabled = false;
      }
    }));
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
      try { await jury('judge', { panel: panel.key, judgeId: form.dataset.editJudge, name, email }); await refresh(); toastOk('심사위원 정보를 저장했습니다.'); }
      catch (error) { statusText(status, error.message, true); button.disabled = false; }
    }));
    root.querySelectorAll('[data-remove-judge]').forEach((button) => button.addEventListener('click', async () => {
      if (!await confirmModal({ title: '심사위원을 명단에서 삭제할까요?', body: '아직 평가를 시작하지 않은 단계에서만 삭제할 수 있습니다. 발급된 초대 링크도 사용할 수 없게 됩니다.', confirmLabel: '명단에서 삭제', danger: true })) return;
      button.disabled = true;
      try { await jury('judge/remove', { panel: panel.key, judgeId: button.dataset.removeJudge }); await refresh(); toastOk('심사위원을 삭제했습니다.'); }
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
      if (panel.judges.find((judge) => judge.id === judgeId)?.hasInvite && !await confirmModal({ title: '개인 코드를 다시 발급할까요?', body: '이전 개인 코드·개별 초대 링크·로그인은 무효가 됩니다. 공용 주소와 저장된 점수는 유지됩니다.', confirmLabel: '개인 코드 재발급' })) return;
      button.disabled = true;
      try {
        await jury('invite', { panel: panel.key, judgeId, pin });
        await refresh(); toastOk('개인 코드를 발급했습니다. 공용 주소와 개인 코드를 별도로 전달해 주세요.');
      } catch (error) { statusText(status, error.message, true); button.disabled = false; }
    }));
    root.querySelectorAll('[data-copy-judge], [data-copy-panel]').forEach((button) => button.addEventListener('click', async () => {
      const holder = button.closest('.fj-secret');
      const input = holder.querySelector('input');
      try { await navigator.clipboard.writeText(input.value); statusText(holder.querySelector('[data-copy-status]'), '공용 심사 주소를 복사했습니다.'); }
      catch { input.focus(); input.select(); statusText(holder.querySelector('[data-copy-status]'), '링크를 선택했습니다. 복사 단축키로 복사해 주세요.'); }
    }));
    root.querySelectorAll('[data-revoke-judge]').forEach((button) => button.addEventListener('click', async () => {
      if (!await confirmModal({ title: '이 심사위원의 접근을 해제할까요?', body: '초대 링크와 로그인으로 더 이상 평가할 수 없습니다. 저장된 점수는 유지됩니다.', confirmLabel: '접근 해제', danger: true })) return;
      button.disabled = true;
      try { await jury('revoke', { panel: panel.key, judgeId: button.dataset.revokeJudge }); await refresh(); toastOk('접근을 해제했습니다.'); }
      catch (error) { toastErr(error.message); button.disabled = false; }
    }));
    root.querySelector('[data-jury-status]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const next = button.dataset.juryStatus;
      const status = root.querySelector('[data-panel-status]');
      const issue = next === 'open' ? rosterIssue(panel.key, panel.entryIds, data.entries, true) : '';
      if (issue) { statusText(status, issue, true); return; }
      if (!await confirmModal({ title: next === 'open' ? '이 단계 평가를 시작할까요?' : '이 단계 평가를 마감할까요?', body: next === 'open' ? panel.key === 'final' ? '본선 대상 6작품이 확정됩니다. 로그인한 회원이 본인 작품을 제외한 작품을 평가할 수 있습니다.' : '평가 대상과 심사위원 구성이 확정됩니다. 등록된 심사위원이 블라인드로 작품과 첨부를 보고 점수를 저장할 수 있습니다.' : panel.key === 'final' ? '심사위원 평가가 종료되고, 순위가 확정되면 발표 주소가 즉시 열립니다. 수상 구분이 바뀌는 완전동점은 관리자가 순서를 확정한 후 발표됩니다.' : '심사위원의 평가와 첨부 접근이 종료됩니다. 저장된 점수는 관리자 결과에 남습니다.', confirmLabel: next === 'open' ? '평가 시작' : '평가 마감' })) return;
      button.disabled = true;
      try { await jury('status', { panel: panel.key, status: next }); await refresh(); toastOk(next === 'open' ? '평가를 시작했습니다.' : '평가를 마감했습니다.'); }
      catch (error) { statusText(status, error.message, true); button.disabled = false; }
    });
  };
  try { await refresh(); } catch (error) { if (root.isConnected) root.innerHTML = `<p class="notice notice--err" role="alert">심사 운영 정보를 불러오지 못했습니다 — ${esc(error.message)}</p>`; }
}

/* --------------------------------------------------- 서명 패드 헬퍼 -- */

function bindSignaturePad(canvas, clearBtn, initialDataUrl = '') {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  let drawing = false;
  let hasInk = false;
  let lastX = 0;
  let lastY = 0;

  const resetWhite = () => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };
  resetWhite();

  if (initialDataUrl && initialDataUrl.startsWith('data:image/png;base64,')) {
    const img = new Image();
    img.onload = () => {
      resetWhite();
      ctx.drawImage(img, 0, 0, W, H);
      hasInk = true;
    };
    img.src = initialDataUrl;
  }

  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * W,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * H,
    };
  };

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    const pt = point(event);
    drawing = true;
    hasInk = true;
    lastX = pt.x;
    lastY = pt.y;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = '#111111';
    ctx.fill();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    event.preventDefault();
    const pt = point(event);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    lastX = pt.x;
    lastY = pt.y;
  });

  const stop = (event) => {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  clearBtn?.addEventListener('click', () => {
    resetWhite();
    hasInk = false;
  });

  return {
    hasSignature: () => hasInk,
    toDataUrl: () => (hasInk ? canvas.toDataURL('image/png') : ''),
    clear: () => { resetWhite(); hasInk = false; },
  };
}

/* ------------------------------------------- 예선 블라인드 심사 공통 -- */

function scoreModeBarHtml(mode) {
  return `<div class="fj-mode-bar" role="group" aria-label="점수 환산 표시 전환" data-testid="prelim-score-mode-bar">
    <span class="field__hint">점수 표시:</span>
    <button type="button" class="btn btn--outline btn--sm ${mode === 'both' ? 'is-selected' : ''}" data-score-mode="both">환산점수 (원점수 함께)</button>
    <button type="button" class="btn btn--outline btn--sm ${mode === 'converted' ? 'is-selected' : ''}" data-score-mode="converted">심사기준 환산점수 (100점)</button>
    <button type="button" class="btn btn--outline btn--sm ${mode === 'raw' ? 'is-selected' : ''}" data-score-mode="raw">선택 원점수 (1~10점)</button>
  </div>`;
}

function rankedTableHtml(rankedRows, mode = 'both') {
  return `<div class="fj-table-wrap">
    <table class="fj-table fj-ranked-table" data-testid="prelim-ranked-table">
      <caption>순위별 예선 평가 결과 (블라인드 · 소속·성명 비공개)</caption>
      <thead>
        <tr>
          <th>순위</th>
          <th>작품명</th>
          ${RUBRIC.map((rule) => `<th>${rule.name}<br><span class="field__hint">${mode === 'raw' ? '1~10점' : `${rule.max}점 (×${rule.weight})`}</span></th>`).join('')}
          <th>${mode === 'raw' ? '원점수 합계 (40)' : '환산 총점 (100)'}</th>
        </tr>
      </thead>
      <tbody>
        ${rankedRows.map((row) => `<tr>
          <td><span class="badge ${row.rank <= 3 ? 'badge--gold' : 'badge--soft'}">${row.rank}위</span></td>
          <td><strong>${esc(row.title)}</strong></td>
          ${RUBRIC.map((_, i) => `<td>${formatScoreCell(row, i, mode)}</td>`).join('')}
          <td>${formatTotalCell(row, mode)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function effectiveRawOf(entry, drafts) {
  const draft = drafts.get(entry.id);
  if (draft) return draft;
  if (validRawFestaScores(entry.myRawScores)) return [...entry.myRawScores];
  const derived = deriveRawFestaScores(entry.myScores);
  return derived ? [...derived] : [null, null, null, null];
}

function prelimScoreFormHtml(entry, rawValues) {
  const valid = validRawFestaScores(rawValues);
  const converted = valid ? convertRawFestaScores(rawValues) : null;
  const total = converted ? totalOf(converted) : null;
  const rawSum = valid ? rawTotalOf(rawValues) : null;
  const stored = !entry.scoreBlocked && (validRawFestaScores(entry.myRawScores) || validFestaScores(entry.myScores));

  return `<form data-testid="juror-score-form" data-entry-id="${attr(entry.id)}">
    <fieldset style="border:0;padding:0;margin:0;min-width:0">
      <legend style="font-size:1.9rem;font-weight:700">${stored ? '저장한 예선 평가 수정' : '예선 작품 평가'} · 각 항목 1~10 선택</legend>
      <p class="field__hint" style="margin-top:var(--space-1)">각 항목을 1점(최저)부터 10점(최고)까지 선택하세요. 평가 결과에서는 심사기준 배점(40·30·20·10)에 따라 100점 만점 환산점수로 자동 변환됩니다.</p>
      <div class="fj-score-rows fj-score-rows--scale" style="margin-top:var(--space-3)">
        ${RUBRIC.map((rule, index) => {
          const picked = rawValues[index];
          const conv = Number.isInteger(picked) && picked >= 1 && picked <= 10 ? picked * rule.weight : null;
          return `<div class="fj-scale-row" data-criterion-row="${index}">
            <div class="fj-scale-head">
              <div>
                <span class="field__label">${index + 1}. ${rule.name} <span class="badge badge--soft">배점 ${rule.max}점 · ×${rule.weight}</span></span>
                <p class="field__hint" id="jurorScoreHelp${index}">${rule.description}</p>
              </div>
              <div class="fj-scale-readout" data-criterion-readout="${index}">
                ${picked ? `<strong>${picked} / 10</strong> <span class="field__hint">(환산 ${conv}/${rule.max}점)</span>` : '<span class="field__hint">미선택</span>'}
              </div>
            </div>
            <input type="hidden" name="score${index}" value="${picked ?? ''}" />
            <div class="fj-scale-picker" role="radiogroup" aria-label="${attr(rule.name)} 1~10점 선택" aria-describedby="jurorScoreHelp${index}">
              ${Array.from({ length: 10 }, (_, n) => {
                const v = n + 1;
                const active = picked === v;
                return `<button type="button" class="fj-scale-btn ${active ? 'is-picked' : ''}" data-pick-criterion="${index}" data-pick-value="${v}" role="radio" aria-checked="${active}" data-testid="scale-${index}-${v}">${v}</button>`;
              }).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="fj-head" style="margin-top:var(--space-4)">
        <p class="fj-score-total" data-testid="juror-score-total" aria-live="polite">
          ${valid ? `원점수 ${rawSum} / 40점 · 환산 ${total} / 100점` : '네 항목 모두 1~10 숫자를 선택해 주세요.'}
        </p>
        <button class="btn btn--primary" type="submit" data-testid="juror-score-save">${stored ? '이 작품 점수 수정 저장' : '이 작품 점수 저장'}</button>
      </div>
    </fieldset>
    <p data-score-status role="status" aria-live="polite" style="margin-top:var(--space-3)">${stored ? '저장된 평가입니다. 모든 작품을 심사한 뒤 아래 [심사 완료] 버튼을 눌러 순위 확인 및 서명을 진행해 주세요.' : '항목별 숫자를 선택한 뒤 [이 작품 점수 저장]을 누르세요.'}</p>
  </form>`;
}

/** 이메일 로그인 심사위원 & 관리자용 예선 심사 화면 (`/festa/prelim/:panel`) */
export async function festaPrelimView(mount, { panel }) {
  if (!PRELIM_KEYS.includes(panel)) {
    mount.innerHTML = `<section class="section"><div class="wrap">${emptyState({
      title: '예선 심사 기관을 확인해 주세요',
      body: '행정안전부 또는 한국서부발전 예선 심사 주소로 이동해 주세요.',
      action: '<a class="btn btn--primary" href="#/festa">바이브 코딩 페스타로 돌아가기</a>',
    })}</div></section>`;
    return;
  }
  const title = PANELS[panel].prelimLabel;
  const root = shell(mount, false, title, '소속과 성명이 비공개된 블라인드 방식으로 4개 항목(1~10점)을 심사합니다.');
  let session = null;
  let selectedId = null;
  let step = 'score'; // 'score' | 'review' | 'completed'
  let scoreMode = 'both';
  let saving = false;
  let incompleteReport = null;
  const drafts = new Map();
  let signerDraft = { affiliation: '', position: '', name: '', signatureDataUrl: '' };

  const load = async () => {
    session = await jury(`prelim?panel=${encodeURIComponent(panel)}`);
    if (!signerDraft.affiliation && session.defaultAffiliation) signerDraft.affiliation = session.defaultAffiliation;
    if (!signerDraft.name && session.defaultName) signerDraft.name = session.defaultName;
    if (session.completion) {
      step = 'completed';
    } else if (step === 'completed') {
      step = 'score';
    }
    render();
  };

  const renderHeader = () => `<section class="card">
    <div class="fj-head">
      <div>
        <div class="fj-actions" style="margin-bottom:var(--space-2)">
          <span class="badge badge--soft">블라인드 심사 · 소속·성명 비공개</span>
          ${session.adminPreview ? '<span class="badge badge--gold">관리자 동일 화면 점검 모드</span>' : ''}
          ${session.completion ? '<span class="badge badge--open">✓ 심사 완료·저장됨</span>' : ''}
        </div>
        <h2 class="page-title" style="font-size:2.3rem">${esc(title)}</h2>
        <p class="page-sub" data-testid="juror-identity">${esc(session.judgeName || currentUser()?.name || '')} ${session.adminPreview ? '(관리자)' : '심사위원'}</p>
      </div>
      ${badge(session.status)}
    </div>
    ${session.adminPreview ? '<p class="notice notice--info" style="margin-top:var(--space-3)">관리자는 심사위원과 동일한 블라인드 예선 심사 화면을 확인·테스트할 수 있습니다. 관리자가 별도 심사위원으로 등록되지 않은 경우 테스트 저장 결과는 공식 심사위원 집계와 분리되어 저장됩니다.</p>' : ''}
    <div class="fj-actions" style="margin-top:var(--space-3)">
      <a class="btn btn--outline btn--sm" href="#/festa">← 바이브 코딩 페스타</a>
      <a class="btn btn--outline btn--sm" href="#/festa/prelim/${panel === 'mois' ? 'iwest' : 'mois'}">${panel === 'mois' ? '예선 심사(한국서부발전)로 전환' : '예선 심사(행정안전부)로 전환'}</a>
    </div>
  </section>`;

  const renderCompleted = () => {
    const comp = session.completion;
    root.innerHTML = `${renderHeader()}
      <section class="card fj-stack" data-testid="prelim-completed-view">
        <div class="notice notice--info">
          <strong>예선 심사가 완료되어 결과값이 안전하게 저장되었습니다.</strong>
          <p>아래에서 심사기준 환산점수와 순위를 확인하고, 심사위원 서명이 포함된 공식 PDF 결과표를 다운로드할 수 있습니다.</p>
        </div>
        <div class="fj-head">
          <div>
            <h3 class="page-title" style="font-size:2.1rem">저장된 예선 심사 결과표</h3>
            <p class="field__hint">완료 일시: ${esc(fmtDate(comp.completedAt, true))} (한국시간) · 총 ${(comp.rankedResults || []).length}작품</p>
          </div>
          <div class="fj-actions">
            <button type="button" class="btn btn--primary" data-testid="prelim-pdf-download">📄 PDF 다운로드</button>
            <button type="button" class="btn btn--outline" data-testid="prelim-print">인쇄하기</button>
            ${session.canScore ? '<button type="button" class="btn btn--quiet" data-testid="prelim-reopen-edit">평가 다시 수정하기</button>' : ''}
          </div>
        </div>
        ${scoreModeBarHtml(scoreMode)}
        ${rankedTableHtml(comp.rankedResults || [], scoreMode)}
        <section class="card card--flat fj-signer-summary" data-testid="prelim-signer-summary">
          <h4>심사위원 확인 및 서명</h4>
          <div class="fj-signer-grid">
            <div><span class="field__label">소속</span><p>${esc(comp.affiliation)}</p></div>
            <div><span class="field__label">직급</span><p>${esc(comp.position)}</p></div>
            <div><span class="field__label">성명</span><p>${esc(comp.name)}</p></div>
            <div><span class="field__label">서명</span><div class="fj-sig-preview">${comp.signatureDataUrl ? `<img src="${attr(comp.signatureDataUrl)}" alt="${attr(comp.name)} 심사위원 서명" />` : '<span>서명 없음</span>'}</div></div>
          </div>
        </section>
      </section>`;

    root.querySelectorAll('[data-score-mode]').forEach((btn) => btn.addEventListener('click', () => {
      scoreMode = btn.dataset.scoreMode;
      render();
    }));
    root.querySelector('[data-testid="prelim-pdf-download"]').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'PDF 생성 중…';
      try {
        await downloadPrelimResultPdf(comp, { scoreMode });
        toastOk('예선 심사 결과 PDF를 다운로드했습니다.');
      } catch (error) {
        toastErr(`PDF 생성 실패: ${error.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
    root.querySelector('[data-testid="prelim-print"]').addEventListener('click', () => window.print());
    root.querySelector('[data-testid="prelim-reopen-edit"]')?.addEventListener('click', () => {
      step = 'score';
      render();
    });
  };

  const renderReview = (eligible) => {
    const rows = rankPrelimRows(eligible.map((entry, idx) => {
      const rawScores = effectiveRawOf(entry, drafts);
      const scores = convertRawFestaScores(rawScores);
      return { entryId: entry.id, title: entry.title, rawScores, scores, total: totalOf(scores), order: idx };
    }));
    root.innerHTML = `${renderHeader()}
      <section class="card fj-stack" data-testid="prelim-review-view">
        <div class="fj-head">
          <div>
            <h3 class="page-title" style="font-size:2.2rem">심사 완료 확인 · 순위별 정렬 결과</h3>
            <p class="page-sub">모든 작품의 4개 항목 심사가 완료되었습니다. 환산점수 순위를 최종 확인하고 아래 서명란에 직접 서명한 뒤 [심사 완료 동의]를 눌러 주세요.</p>
          </div>
          <button type="button" class="btn btn--outline" data-testid="prelim-back-to-score">← 점수로 돌아가 수정</button>
        </div>
        ${scoreModeBarHtml(scoreMode)}
        ${rankedTableHtml(rows, scoreMode)}
        <form class="card card--flat fj-stack" data-testid="prelim-signer-form">
          <div>
            <h4 style="font-size:1.8rem">심사위원 정보 및 직접 서명</h4>
            <p class="field__hint">입력한 소속·직급·성명과 직접 작성한 서명은 저장된 결과표 및 다운로드 PDF에 그대로 반영됩니다.</p>
          </div>
          <div class="fj-signer-inputs">
            <label class="field">
              <span class="field__label">소속 <span class="field__req">*</span></span>
              <input class="input" name="affiliation" required maxlength="100" placeholder="예: 행정안전부 디지털정부국" value="${attr(signerDraft.affiliation)}" />
            </label>
            <label class="field">
              <span class="field__label">직급 <span class="field__req">*</span></span>
              <input class="input" name="position" required maxlength="100" placeholder="예: 서기관 / 팀장 / 교수" value="${attr(signerDraft.position)}" />
            </label>
            <label class="field">
              <span class="field__label">성명 <span class="field__req">*</span></span>
              <input class="input" name="name" required maxlength="80" placeholder="심사위원 성명" value="${attr(signerDraft.name)}" />
            </label>
          </div>
          <div class="field">
            <div class="fj-head">
              <span class="field__label">서명란 (직접 서명) <span class="field__req">*</span></span>
              <button type="button" class="btn btn--quiet btn--sm" data-testid="prelim-sig-clear">서명 지우기</button>
            </div>
            <div class="fj-sig-box">
              <canvas class="fj-sig-canvas" width="560" height="180" data-testid="prelim-signature-canvas" aria-label="심사위원 직접 서명란"></canvas>
            </div>
            <span class="field__hint">마우스, 터치 또는 펜으로 위 네모 칸에 직접 서명해 주세요.</span>
          </div>
          <div class="notice notice--info">
            본 심사위원은 모든 작품의 4개 항목에 대해 공정하게 심사를 마쳤으며, 위 순위 및 환산점수 결과에 이상이 없음을 확인하고 심사 완료에 동의합니다.
          </div>
          <div class="fj-actions">
            <button type="submit" class="btn btn--primary" data-testid="prelim-agree-submit">심사 완료 동의 및 결과 저장</button>
            <button type="button" class="btn btn--outline" data-testid="prelim-back-to-score-2">다시 수정하기</button>
          </div>
          <p data-complete-status role="status" aria-live="polite"></p>
        </form>
      </section>`;

    const form = root.querySelector('[data-testid="prelim-signer-form"]');
    const canvas = form.querySelector('[data-testid="prelim-signature-canvas"]');
    const clearBtn = form.querySelector('[data-testid="prelim-sig-clear"]');
    const pad = bindSignaturePad(canvas, clearBtn, signerDraft.signatureDataUrl);

    const saveSignerDraft = () => {
      signerDraft = {
        affiliation: form.elements.affiliation.value,
        position: form.elements.position.value,
        name: form.elements.name.value,
        signatureDataUrl: pad.toDataUrl(),
      };
    };

    root.querySelectorAll('[data-score-mode]').forEach((btn) => btn.addEventListener('click', () => {
      saveSignerDraft();
      scoreMode = btn.dataset.scoreMode;
      render();
    }));
    const back = () => { saveSignerDraft(); step = 'score'; render(); };
    root.querySelector('[data-testid="prelim-back-to-score"]').addEventListener('click', back);
    root.querySelector('[data-testid="prelim-back-to-score-2"]').addEventListener('click', back);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving || !form.reportValidity()) return;
      const status = form.querySelector('[data-complete-status]');
      const affiliation = form.elements.affiliation.value.trim();
      const position = form.elements.position.value.trim();
      const name = form.elements.name.value.trim();
      if (!affiliation || !position || !name) {
        statusText(status, '심사위원 소속, 직급, 성명을 모두 입력해 주세요.', true);
        return;
      }
      if (!pad.hasSignature()) {
        statusText(status, '서명란에 직접 서명을 작성해 주세요.', true);
        canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const items = eligible.map((entry) => ({
        entryId: entry.id,
        rawScores: effectiveRawOf(entry, drafts),
      }));
      if (items.some((item) => !validRawFestaScores(item.rawScores))) {
        statusText(status, '모든 작품의 4개 항목이 1~10 범위로 정상 입력되었는지 다시 확인해 주세요.', true);
        return;
      }
      const signatureDataUrl = pad.toDataUrl();
      signerDraft = { affiliation, position, name, signatureDataUrl };
      saving = true;
      const submitBtn = form.querySelector('[data-testid="prelim-agree-submit"]');
      submitBtn.disabled = true;
      statusText(status, '모든 점수와 서명을 검증하고 결과를 저장하고 있습니다.');
      try {
        const res = await jury('prelim/complete', {
          panel,
          items,
          signer: { affiliation, position, name, signatureDataUrl },
        });
        for (const item of res.completion.rankedResults) {
          const target = session.entries.find((e) => e.id === item.entryId);
          if (target) {
            target.myRawScores = [...item.rawScores];
            target.myScores = [...item.scores];
          }
          drafts.delete(item.entryId);
        }
        session.completion = res.completion;
        step = 'completed';
        toastOk('예선 심사 결과가 저장되었습니다. 이제 PDF로 다운로드할 수 있습니다.');
        render();
      } catch (error) {
        statusText(status, error.message, true);
        submitBtn.disabled = false;
      } finally {
        saving = false;
      }
    });
  };

  const render = () => {
    if (!root.isConnected || !session) return;
    const entries = Array.isArray(session.entries) ? session.entries : [];
    if (step === 'completed' && session.completion) {
      renderCompleted();
      return;
    }
    if (!session.canScore) {
      root.innerHTML = `${renderHeader()}<p class="notice notice--info" data-testid="juror-closed">${session.status === 'closed' ? '예선 평가가 마감되었습니다.' : '아직 예선 평가가 시작되지 않았습니다. 운영자가 평가를 시작한 뒤 다시 접속해 주세요.'}</p>`;
      return;
    }
    const eligible = entries.filter((entry) => !entry.scoreBlocked);
    if (step === 'review' && eligible.length) {
      renderReview(eligible);
      return;
    }

    const completedCount = eligible.filter((entry) => validRawFestaScores(effectiveRawOf(entry, drafts))).length;
    const savedCount = eligible.filter((entry) => validRawFestaScores(entry.myRawScores) || validFestaScores(entry.myScores)).length;
    if (!entries.some((entry) => entry.id === selectedId)) {
      selectedId = entries.find((entry) => !entry.scoreBlocked && !validRawFestaScores(effectiveRawOf(entry, drafts)))?.id || entries[0]?.id;
    }
    const current = entries.find((entry) => entry.id === selectedId);
    const currentIndex = entries.findIndex((entry) => entry.id === selectedId);
    const currentRaw = current ? effectiveRawOf(current, drafts) : [null, null, null, null];

    root.innerHTML = `${renderHeader()}
      <section class="card fj-stack">
        <div class="fj-head">
          <div>
            <h3>심사 대상 작품 목록 (블라인드)</h3>
            <p class="fj-note">소속과 성명은 비공개 처리되어 있습니다. 모든 작품의 4개 항목(1~10점)을 선택한 뒤 아래 [심사 완료]를 눌러 주세요.</p>
          </div>
          <span data-testid="juror-progress" class="festa-total">작성 ${completedCount} / ${eligible.length}건 (저장 ${savedCount}건)</span>
        </div>
        <div class="fj-progress">
          <progress max="${Math.max(1, eligible.length)}" value="${completedCount}" aria-label="예선 심사 진행 현황"></progress>
        </div>
        <nav class="fj-entry-nav" aria-label="심사할 작품 선택" data-testid="juror-entry-list">
          ${entries.map((entry, index) => {
            const raw = effectiveRawOf(entry, drafts);
            const hasFull = !entry.scoreBlocked && validRawFestaScores(raw);
            const isSaved = !entry.scoreBlocked && (validRawFestaScores(entry.myRawScores) || validFestaScores(entry.myScores)) && !drafts.has(entry.id);
            const convTotal = hasFull ? totalOf(convertRawFestaScores(raw)) : null;
            const active = entry.id === selectedId;
            return `<button type="button" class="fj-entry-choice ${hasFull ? 'is-complete' : 'is-unscored'}${active ? ' is-current' : ''}" data-juror-entry="${attr(entry.id)}" ${active ? 'aria-current="step"' : ''}>
              <span class="fj-entry-choice__title">${index + 1}. ${esc(entry.title)}</span>
              <span class="fj-entry-choice__status">${active ? '현재 · ' : ''}${entry.scoreBlocked ? '평가 제외' : hasFull ? `${isSaved ? '✓ 저장됨' : '● 선택 완료'} (${convTotal}점)` : '○ 미심사'}</span>
            </button>`;
          }).join('')}
        </nav>
        ${incompleteReport ? `<div class="notice notice--warn" role="alert" data-testid="prelim-incomplete-alert">
          <div>
            <strong>아직 모든 항목의 심사가 완료되지 않았습니다 (${incompleteReport.length}개 작품 미완료)</strong>
            <ul class="fj-incomplete-list">${incompleteReport.map((item) => `<li><button type="button" class="btn btn--quiet btn--sm" data-jump-entry="${attr(item.entryId)}">${item.index + 1}. ${esc(item.title)}</button> — 미입력 항목: ${item.missing.map(esc).join(', ')}</li>`).join('')}</ul>
          </div>
        </div>` : ''}
        <div class="fj-head" style="padding-top:var(--space-2);border-top:1px solid var(--hairline)">
          <p class="field__hint">모든 작품의 4개 항목을 선택한 뒤 [심사 완료]를 누르면 누락 점검 후 순위별로 정렬된 결과표를 확인하고 서명·저장할 수 있습니다.</p>
          <div class="fj-actions">
            ${session.completion ? '<button type="button" class="btn btn--outline" data-testid="prelim-view-saved">저장된 결과·PDF 보기</button>' : ''}
            <button type="button" class="btn btn--festa" data-testid="prelim-complete-btn" ${eligible.length ? '' : 'disabled'}>심사 완료 (전체 점검 · 순위 확인)</button>
          </div>
        </div>
      </section>
      <div data-juror-detail>
        ${current ? `<article class="card fj-stack" data-testid="juror-entry-detail">
          <div>
            <span class="badge badge--soft">작품 ${currentIndex + 1} · 블라인드 심사</span>
            <h2 class="page-title" style="font-size:2.3rem;margin-top:var(--space-2)">${esc(current.title)}</h2>
          </div>
          ${linksHtml(current)}
          <section aria-label="작품 설명"><h3>📝 작품 설명</h3><div class="fj-description" data-testid="juror-description">${esc(current.description)}</div></section>
          <section aria-label="첨부 자료"><h3 style="margin-bottom:var(--space-3)">📎 첨부 자료</h3>${filesHtml(current, `panel=${encodeURIComponent(panel)}`, '/festa/jury/prelim/file')}</section>
          ${current.scoreBlocked ? `<p class="notice notice--info" data-testid="juror-score-blocked">${esc(current.scoreBlocked)}</p>` : prelimScoreFormHtml(current, currentRaw)}
        </article>` : emptyState({ title: '심사할 작품이 없습니다', body: '운영자가 해당 기관의 예선 평가 대상 작품을 배정하면 이곳에 표시됩니다.' })}
      </div>`;

    root.querySelectorAll('[data-juror-entry], [data-jump-entry]').forEach((btn) => btn.addEventListener('click', () => {
      if (saving) { toastErr('점수를 저장하고 있습니다. 잠시 기다려 주세요.'); return; }
      selectedId = btn.dataset.jurorEntry || btn.dataset.jumpEntry;
      render();
      root.querySelector('[data-testid="juror-entry-detail"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

    root.querySelector('[data-testid="prelim-view-saved"]')?.addEventListener('click', () => {
      step = 'completed';
      render();
    });

    root.querySelector('[data-testid="prelim-complete-btn"]')?.addEventListener('click', () => {
      const missing = [];
      entries.forEach((entry, index) => {
        if (entry.scoreBlocked) return;
        const raw = effectiveRawOf(entry, drafts);
        const missingNames = RUBRIC.map((rule, i) => (Number.isInteger(raw[i]) && raw[i] >= 1 && raw[i] <= 10 ? null : rule.name)).filter(Boolean);
        if (missingNames.length) missing.push({ entryId: entry.id, index, title: entry.title, missing: missingNames });
      });
      if (missing.length) {
        incompleteReport = missing;
        toastErr(`미심사 작품 ${missing.length}건이 있습니다. 모든 항목을 1~10으로 선택해 주세요.`);
        render();
        root.querySelector('[data-testid="prelim-incomplete-alert"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      incompleteReport = null;
      step = 'review';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const form = root.querySelector('[data-testid="juror-score-form"]');
    if (!form || !current) return;

    const updateReadout = (raw) => {
      const valid = validRawFestaScores(raw);
      const totalEl = root.querySelector('[data-testid="juror-score-total"]');
      if (totalEl) {
        totalEl.textContent = valid
          ? `원점수 ${rawTotalOf(raw)} / 40점 · 환산 ${totalOf(convertRawFestaScores(raw))} / 100점`
          : '네 항목 모두 1~10 숫자를 선택해 주세요.';
      }
    };

    form.querySelectorAll('[data-pick-criterion]').forEach((btn) => btn.addEventListener('click', () => {
      if (saving) return;
      const ci = Number(btn.dataset.pickCriterion);
      const val = Number(btn.dataset.pickValue);
      const next = [...effectiveRawOf(current, drafts)];
      next[ci] = val;
      drafts.set(current.id, next);
      incompleteReport = null;
      form.elements[`score${ci}`].value = String(val);
      const rowEl = form.querySelector(`[data-criterion-row="${ci}"]`);
      rowEl.querySelectorAll('[data-pick-criterion]').forEach((b) => {
        const picked = Number(b.dataset.pickValue) === val;
        b.classList.toggle('is-picked', picked);
        b.setAttribute('aria-checked', String(picked));
      });
      const readout = form.querySelector(`[data-criterion-readout="${ci}"]`);
      if (readout) {
        readout.innerHTML = `<strong>${val} / 10</strong> <span class="field__hint">(환산 ${val * RUBRIC[ci].weight}/${RUBRIC[ci].max}점)</span>`;
      }
      updateReadout(next);
      statusText(form.querySelector('[data-score-status]'), '선택한 점수는 아직 서버에 저장되지 않았습니다. [이 작품 점수 저장] 또는 마지막 [심사 완료]를 눌러 주세요.');
    }));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      const rawScores = effectiveRawOf(current, drafts);
      const status = form.querySelector('[data-score-status]');
      if (!validRawFestaScores(rawScores)) {
        statusText(status, '네 항목 모두 1~10 사이의 숫자를 선택해 주세요.', true);
        return;
      }
      saving = true;
      form.querySelector('fieldset').disabled = true;
      statusText(status, '점수를 저장하고 있습니다.');
      try {
        const res = await jury('prelim/score', { panel, entryId: current.id, rawScores });
        current.myRawScores = [...res.myRawScores];
        current.myScores = [...res.myScores];
        session.completion = null;
        drafts.delete(current.id);
        saving = false;
        render();
        statusText(root.querySelector('[data-score-status]'), `원점수 ${rawTotalOf(rawScores)}/40점 · 환산 ${totalOf(res.myScores)}/100점으로 저장했습니다.`);
      } catch (error) {
        saving = false;
        statusText(status, error.message, true);
        form.querySelector('fieldset').disabled = false;
      }
    });
  };

  try {
    await load();
  } catch (error) {
    if (root.isConnected) {
      root.innerHTML = `<div class="card fj-stack"><p class="notice notice--err" role="alert">${esc(error.message)}</p><div><a class="btn btn--outline" href="#/festa">바이브 코딩 페스타로 돌아가기</a></div></div>`;
    }
  }
}

/* ------------------------------------------- PIN 공용 주소 / 회원 본선 -- */

function jurorHeader(session, memberMode = false, runId = '') {
  if (memberMode) return `<section class="card fj-stack fj-member-heading"><div class="fj-head"><div><p class="fj-note">${runId ? '연습 전용 · 실제 결과에 반영되지 않습니다' : '말하는 대로, 바이브 코딩 페스타'}</p><h1 class="page-title">${runId ? '연습 · ' : ''}2차 본선 회원 평가</h1><p class="page-sub" data-testid="juror-identity">${esc(session.judgeName || currentUser()?.name || '')} 님으로 참여합니다.</p></div>${badge(session.status)}</div><p class="fj-note">회원 누구나 원하는 작품을 평가할 수 있습니다. 평가를 저장하면 참여자로 집계되며, 본인 작품은 평가할 수 없습니다. 본인의 저장 점수만 표시됩니다.</p>${runId ? '<p class="notice notice--warn">테스트 회차입니다. 예선 통과 가정과 예시 점수가 포함될 수 있으며 실제 접수·평가·수상 결과와 분리됩니다.</p>' : ''}<div class="fj-actions"><button type="button" class="btn btn--outline btn--sm" data-testid="member-final-refresh">진행 상태 새로고침</button><a class="btn btn--quiet btn--sm" href="${runId ? `#/festa/rehearsal/${encodeURIComponent(runId)}/results` : '#/festa/results'}">${runId ? '연습 발표 화면' : '발표 화면'}</a></div><p data-member-refresh-status role="status" aria-live="polite"></p></section>`;

  return `<section class="card"><div class="fj-head"><div><div class="fj-actions" style="margin-bottom:var(--space-2)"><span class="badge badge--soft">블라인드 심사 · 소속·성명 비공개</span>${session.completion ? '<span class="badge badge--open">✓ 심사 완료·저장됨</span>' : ''}</div><h2 class="page-title" style="font-size:2.3rem">${esc(PANELS[session.panel]?.prelimLabel || PANELS[session.panel]?.label || session.label || '심사위원 평가')}</h2><p class="page-sub" data-testid="juror-identity">${esc(session.judgeName || '')} 심사위원</p></div>${badge(session.status)}</div><p class="field__hint">초대 만료 ${esc(fmtDate(session.expiresAt, true))} (한국시간) · 본인의 저장 점수만 표시됩니다.</p><div class="fj-actions" style="margin-top:var(--space-3)"><button class="btn btn--outline btn--sm" type="button" data-testid="juror-signout">심사 종료·위원 전환</button></div><p class="field__hint">공유 PC에서는 평가를 저장한 뒤 심사를 종료해 주세요. 저장한 점수는 유지됩니다.</p><p data-signout-status role="status" aria-live="polite"></p></section>`;
}

export async function festaMemberFinalView(mount, { runId = '' } = {}) {
  return festaJurorView(mount, { invite: 'final', memberMode: true, runId });
}

export async function festaJurorView(mount, { invite, memberMode = false, runId = '' }) {
  memberMode ||= invite === 'final';
  const root = shell(mount, false);
  if (memberMode) {
    root.classList.add('fj-member');
    mount.querySelector('.fj-hero h1').textContent = runId ? '연습 · 2차 본선 회원 평가' : '2차 본선 회원 평가';
    mount.querySelector('.fj-hero .wrap > p:last-child').textContent = '로그인한 회원은 별도 개인 코드 없이 참여할 수 있습니다.';
  }
  const memberBase = runId ? `/festa/rehearsal/${encodeURIComponent(runId)}/jury` : '/festa/jury';
  const returnPath = runId ? `/festa/rehearsal/${encodeURIComponent(runId)}/final` : '/festa/jury/final';
  const showMemberLogin = (note = '') => {
    root.innerHTML = `<section class="card wrap--narrow fj-unlock" data-testid="member-final-login"><p class="fj-note">${runId ? '연습 전용 · ' : ''}말하는 대로, 바이브 코딩 페스타</p><h2 class="page-title">2차 본선 회원 평가</h2><p class="page-sub">Google 계정으로 로그인하면 개인 코드 없이 평가에 참여할 수 있습니다.</p>${note ? `<p class="notice notice--info">${esc(note)}</p>` : ''}<div class="fj-actions" style="margin-top:var(--space-4)"><a class="btn btn--primary" data-testid="member-final-login-link" href="#/login?next=${attr(encodeURIComponent(returnPath))}">Google 로그인하고 평가하기</a></div></section>`;
  };
  if (memberMode && !currentUser()) { showMemberLogin(); return; }
  const token = String(invite || '');
  const sharedPanel = Object.hasOwn(PANELS, token) ? token : '';
  let invitation = sharedPanel ? { panel: sharedPanel, label: PANELS[sharedPanel].label } : null;
  let session;
  let expectedJudgeId = null;
  let selectedId = null;
  let step = 'score'; // 'score' | 'review' | 'completed' (for prelim PIN mode)
  let scoreMode = 'both';
  let incompleteReport = null;
  const drafts = new Map();
  let signerDraft = { affiliation: '', position: '', name: '', signatureDataUrl: '' };
  let saving = false;
  if (!memberMode && !sharedPanel) {
    try { invitation = await jury(`invitation?token=${encodeURIComponent(token)}`); if (invitation.panel === 'final') return festaMemberFinalView(mount); }
    catch (error) { root.innerHTML = `<p class="notice notice--err" role="alert">초대 링크를 확인할 수 없습니다 — ${esc(error.message)}</p>`; return; }
  }
  const access = () => sharedPanel ? { panel: sharedPanel, ...(expectedJudgeId ? { judgeId: expectedJudgeId } : {}) } : { token };
  const accessQuery = () => new URLSearchParams(access()).toString();

  const showUnlock = (note = '') => {
    if (!root.isConnected) return;
    if (memberMode) { showMemberLogin(note); return; }
    session = null; expectedJudgeId = null; selectedId = null; drafts.clear(); step = 'score'; incompleteReport = null;
    root.innerHTML = `<section class="card wrap--narrow fj-unlock" data-testid="juror-code-screen"><p class="fj-note">말하는 대로, 바이브 코딩 페스타</p><h2 class="page-title" data-testid="juror-panel-title">${esc(PANELS[invitation.panel]?.label || invitation.label || '심사위원 입장')}</h2><p class="page-sub">${sharedPanel ? '운영자에게 전달받은 본인의 6자리 개인 코드를 입력해 주세요.' : `${esc(invitation.judgeName)} 심사위원님, 전달받은 6자리 개인 코드(PIN)를 입력해 주세요.`}</p>${invitation.expiresAt ? `<p class="field__hint">초대 만료 ${esc(fmtDate(invitation.expiresAt, true))} (한국시간)</p>` : ''}<form data-testid="juror-unlock-form" style="margin-top:var(--space-4)"><label class="field"><span class="field__label">6자리 개인 코드</span><input class="input fj-code-input" type="password" name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required autofocus aria-describedby="juror-code-help" /></label><button type="submit" class="btn btn--primary" data-testid="juror-unlock">심사 화면 입장</button><p data-unlock-status role="status" aria-live="polite" style="margin-top:var(--space-3)">${esc(note)}</p></form><p class="field__hint" id="juror-code-help">회원가입이나 회원 로그인 없이 입장합니다. 등록된 이메일로 사이트에 로그인한 경우 '바이브 코딩 페스타' 메뉴에서도 바로 예선 심사를 진행할 수 있습니다.</p></section>`;
    const form = root.querySelector('[data-testid="juror-unlock-form"]');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      const status = form.querySelector('[data-unlock-status]');
      statusText(status, '개인 코드를 확인하고 있습니다.');
      try {
        const result = await jury('unlock', { ...(sharedPanel ? { panel: sharedPanel } : { token }), pin: form.elements.pin.value });
        expectedJudgeId = result.judgeId;
        await loadSession();
      } catch (error) { statusText(status, error.message, true); button.disabled = false; form.elements.pin.focus(); form.elements.pin.select(); }
    });
  };

  const bindSignout = () => {
    if (memberMode) {
      root.querySelector('[data-testid="member-final-refresh"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        if (saving || button.disabled) return;
        button.disabled = true;
        try { await loadSession(); }
        catch (error) { if (error.status === 401) { await refreshSession(); showMemberLogin('로그인 세션이 만료되었습니다. 다시 로그인해 주세요.'); } else { statusText(root.querySelector('[data-member-refresh-status]'), error.message, true); button.disabled = false; } }
      });
      return;
    }
    root.querySelector('[data-testid="juror-signout"]')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (saving || button.disabled) return;
      if (drafts.size && !await confirmModal({ title: '저장하지 않은 점수가 있습니다', body: '종료하면 아직 저장하지 않은 입력은 사라집니다. 저장한 평가는 유지됩니다.', confirmLabel: '심사 종료' })) return;
      button.disabled = true;
      try { await jury('logout', { panel: session.panel, judgeId: session.judgeId }); showUnlock('심사 로그인을 종료했습니다. 다음 심사위원은 본인의 개인 코드로 입장해 주세요.'); }
      catch (error) {
        if (error.status === 401 || error.status === 403) showUnlock('다른 심사위원으로 로그인이 변경되었습니다. 본인의 개인 코드로 다시 입장해 주세요.');
        else { statusText(root.querySelector('[data-signout-status]'), error.message, true); button.disabled = false; }
      }
    });
  };

  const renderPinPrelimCompleted = () => {
    const comp = session.completion;
    root.innerHTML = `${jurorHeader(session, false, runId)}
      <section class="card fj-stack" data-testid="prelim-completed-view">
        <div class="notice notice--info"><strong>예선 심사가 완료되어 결과값이 저장되었습니다.</strong></div>
        <div class="fj-head">
          <div><h3 class="page-title" style="font-size:2.1rem">저장된 예선 심사 결과표</h3><p class="field__hint">완료 일시: ${esc(fmtDate(comp.completedAt, true))}</p></div>
          <div class="fj-actions">
            <button type="button" class="btn btn--primary" data-testid="prelim-pdf-download">📄 PDF 다운로드</button>
            <button type="button" class="btn btn--outline" data-testid="prelim-print">인쇄하기</button>
            ${session.status === 'open' ? '<button type="button" class="btn btn--quiet" data-testid="prelim-reopen-edit">평가 다시 수정하기</button>' : ''}
          </div>
        </div>
        ${scoreModeBarHtml(scoreMode)}
        ${rankedTableHtml(comp.rankedResults || [], scoreMode)}
        <section class="card card--flat fj-signer-summary">
          <h4>심사위원 확인 및 서명</h4>
          <div class="fj-signer-grid">
            <div><span class="field__label">소속</span><p>${esc(comp.affiliation)}</p></div>
            <div><span class="field__label">직급</span><p>${esc(comp.position)}</p></div>
            <div><span class="field__label">성명</span><p>${esc(comp.name)}</p></div>
            <div><span class="field__label">서명</span><div class="fj-sig-preview">${comp.signatureDataUrl ? `<img src="${attr(comp.signatureDataUrl)}" alt="${attr(comp.name)} 심사위원 서명" />` : '<span>서명 없음</span>'}</div></div>
          </div>
        </section>
      </section>`;
    bindSignout();
    root.querySelectorAll('[data-score-mode]').forEach((btn) => btn.addEventListener('click', () => { scoreMode = btn.dataset.scoreMode; render(); }));
    root.querySelector('[data-testid="prelim-pdf-download"]').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try { await downloadPrelimResultPdf(comp, { scoreMode }); toastOk('PDF를 다운로드했습니다.'); }
      catch (error) { toastErr(error.message); } finally { btn.disabled = false; }
    });
    root.querySelector('[data-testid="prelim-print"]').addEventListener('click', () => window.print());
    root.querySelector('[data-testid="prelim-reopen-edit"]')?.addEventListener('click', () => { step = 'score'; render(); });
  };

  const renderPinPrelimReview = (eligible) => {
    const rows = rankPrelimRows(eligible.map((entry, idx) => {
      const rawScores = effectiveRawOf(entry, drafts);
      const scores = convertRawFestaScores(rawScores);
      return { entryId: entry.id, title: entry.title, rawScores, scores, total: totalOf(scores), order: idx };
    }));
    root.innerHTML = `${jurorHeader(session, false, runId)}
      <section class="card fj-stack" data-testid="prelim-review-view">
        <div class="fj-head">
          <div><h3 class="page-title" style="font-size:2.2rem">심사 완료 확인 · 순위별 정렬 결과</h3><p class="page-sub">모든 작품의 4개 항목이 심사되었습니다. 순위를 확인하고 아래 서명 후 [심사 완료 동의]를 눌러 주세요.</p></div>
          <button type="button" class="btn btn--outline" data-testid="prelim-back-to-score">← 점수로 돌아가 수정</button>
        </div>
        ${scoreModeBarHtml(scoreMode)}
        ${rankedTableHtml(rows, scoreMode)}
        <form class="card card--flat fj-stack" data-testid="prelim-signer-form">
          <h4>심사위원 정보 및 직접 서명</h4>
          <div class="fj-signer-inputs">
            <label class="field"><span class="field__label">소속 <span class="field__req">*</span></span><input class="input" name="affiliation" required maxlength="100" value="${attr(signerDraft.affiliation)}" /></label>
            <label class="field"><span class="field__label">직급 <span class="field__req">*</span></span><input class="input" name="position" required maxlength="100" value="${attr(signerDraft.position)}" /></label>
            <label class="field"><span class="field__label">성명 <span class="field__req">*</span></span><input class="input" name="name" required maxlength="80" value="${attr(signerDraft.name || session.judgeName || '')}" /></label>
          </div>
          <div class="field">
            <div class="fj-head"><span class="field__label">서명란 (직접 서명) <span class="field__req">*</span></span><button type="button" class="btn btn--quiet btn--sm" data-testid="prelim-sig-clear">서명 지우기</button></div>
            <div class="fj-sig-box"><canvas class="fj-sig-canvas" width="560" height="180" data-testid="prelim-signature-canvas" aria-label="심사위원 직접 서명란"></canvas></div>
          </div>
          <div class="fj-actions"><button type="submit" class="btn btn--primary" data-testid="prelim-agree-submit">심사 완료 동의 및 결과 저장</button></div>
          <p data-complete-status role="status" aria-live="polite"></p>
        </form>
      </section>`;
    bindSignout();
    const form = root.querySelector('[data-testid="prelim-signer-form"]');
    const canvas = form.querySelector('[data-testid="prelim-signature-canvas"]');
    const pad = bindSignaturePad(canvas, form.querySelector('[data-testid="prelim-sig-clear"]'), signerDraft.signatureDataUrl);
    const saveDraft = () => {
      signerDraft = { affiliation: form.elements.affiliation.value, position: form.elements.position.value, name: form.elements.name.value, signatureDataUrl: pad.toDataUrl() };
    };
    root.querySelectorAll('[data-score-mode]').forEach((btn) => btn.addEventListener('click', () => { saveDraft(); scoreMode = btn.dataset.scoreMode; render(); }));
    root.querySelector('[data-testid="prelim-back-to-score"]').addEventListener('click', () => { saveDraft(); step = 'score'; render(); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving || !form.reportValidity()) return;
      const status = form.querySelector('[data-complete-status]');
      if (!pad.hasSignature()) { statusText(status, '서명란에 직접 서명을 작성해 주세요.', true); return; }
      const items = eligible.map((entry) => ({ entryId: entry.id, rawScores: effectiveRawOf(entry, drafts) }));
      const signer = { affiliation: form.elements.affiliation.value.trim(), position: form.elements.position.value.trim(), name: form.elements.name.value.trim(), signatureDataUrl: pad.toDataUrl() };
      saving = true;
      form.querySelector('[data-testid="prelim-agree-submit"]').disabled = true;
      try {
        const res = await jury('complete', { ...access(), items, signer });
        for (const item of res.completion.rankedResults) {
          const target = session.entries.find((e) => e.id === item.entryId);
          if (target) { target.myRawScores = [...item.rawScores]; target.myScores = [...item.scores]; }
          drafts.delete(item.entryId);
        }
        session.completion = res.completion;
        step = 'completed';
        toastOk('예선 심사 결과가 저장되었습니다.');
        render();
      } catch (error) {
        statusText(status, error.message, true);
        form.querySelector('[data-testid="prelim-agree-submit"]').disabled = false;
      } finally { saving = false; }
    });
  };

  const render = () => {
    if (!root.isConnected) return;
    const isPrelim = !memberMode && PRELIM_KEYS.includes(session.panel);
    if (isPrelim && step === 'completed' && session.completion) {
      renderPinPrelimCompleted();
      return;
    }
    const entries = Array.isArray(session.entries) ? session.entries : [];
    if (session.status !== 'open') {
      root.innerHTML = `${jurorHeader(session, memberMode, runId)}<p class="notice notice--info" data-testid="juror-closed">${session.status === 'closed' ? '평가가 마감되었습니다. 저장한 점수는 운영자에게 전달되어 있으며, 더 이상 평가를 수정할 수 없습니다.' : '아직 평가가 시작되지 않았습니다. 운영자의 시작 안내 후 다시 접속해 주세요.'}</p>${isPrelim && session.completion ? '<div class="fj-actions"><button type="button" class="btn btn--primary" data-testid="prelim-view-saved">저장된 결과·PDF 보기</button></div>' : ''}`;
      bindSignout();
      root.querySelector('[data-testid="prelim-view-saved"]')?.addEventListener('click', () => { step = 'completed'; render(); });
      return;
    }
    const eligible = entries.filter((entry) => !entry.scoreBlocked);
    if (isPrelim && step === 'review' && eligible.length) {
      renderPinPrelimReview(eligible);
      return;
    }
    const completed = isPrelim
      ? eligible.filter((entry) => validRawFestaScores(effectiveRawOf(entry, drafts))).length
      : eligible.filter((entry) => validFestaScores(entry.myScores)).length;
    if (!entries.some((entry) => entry.id === selectedId)) {
      selectedId = entries.find((entry) => !entry.scoreBlocked && (isPrelim ? !validRawFestaScores(effectiveRawOf(entry, drafts)) : !validFestaScores(entry.myScores)))?.id || entries[0]?.id;
    }
    const current = entries.find((entry) => entry.id === selectedId);
    const currentIndex = entries.findIndex((entry) => entry.id === selectedId);
    root.innerHTML = `${jurorHeader(session, memberMode, runId)}<section class="card fj-stack"><div class="fj-head"><h3>작품 목록${isPrelim ? ' (블라인드)' : ''}</h3><span data-testid="juror-progress" class="festa-total">평가 ${completed} / ${eligible.length}건 완료</span></div><div class="fj-progress"><progress max="${Math.max(1, eligible.length)}" value="${completed}" aria-label="평가 완료 현황"></progress><p class="fj-note">현재 작품은 분홍 테두리, 완료 작품은 초록색으로 표시됩니다. 점수는 저장 버튼을 눌러야 반영됩니다.</p></div><nav class="fj-entry-nav" aria-label="심사할 작품 선택" data-testid="juror-entry-list">${entries.map((entry, index) => {
      const done = !entry.scoreBlocked && (isPrelim ? validRawFestaScores(effectiveRawOf(entry, drafts)) : validFestaScores(entry.myScores));
      const active = entry.id === selectedId;
      return `<button type="button" class="fj-entry-choice ${done ? 'is-complete' : 'is-unscored'}${active ? ' is-current' : ''}" data-juror-entry="${attr(entry.id)}" ${active ? 'aria-current="step"' : ''}><span class="fj-entry-choice__title">${index + 1}. ${esc(entry.title)}</span><span class="fj-entry-choice__status">${active ? '현재 · ' : ''}${entry.scoreBlocked ? '평가 제외' : done ? '✓ 평가 완료' : '○ 미평가'}</span></button>`;
    }).join('')}</nav>${isPrelim && incompleteReport ? `<div class="notice notice--warn" role="alert" data-testid="prelim-incomplete-alert"><div><strong>미완료 작품 ${incompleteReport.length}건</strong><ul class="fj-incomplete-list">${incompleteReport.map((item) => `<li><button type="button" class="btn btn--quiet btn--sm" data-jump-entry="${attr(item.entryId)}">${item.index + 1}. ${esc(item.title)}</button> — ${item.missing.map(esc).join(', ')}</li>`).join('')}</ul></div></div>` : ''}${isPrelim ? `<div class="fj-actions">${session.completion ? '<button type="button" class="btn btn--outline" data-testid="prelim-view-saved">저장된 결과·PDF 보기</button>' : ''}<button type="button" class="btn btn--festa" data-testid="prelim-complete-btn">심사 완료 (전체 점검 · 순위 확인)</button></div>` : ''}</section><div data-juror-detail>${current ? (isPrelim ? prelimDetailHtml(current, currentIndex) : detailHtml(current)) : emptyState({ title: '평가할 작품이 없습니다', body: '운영자에게 평가 대상 구성을 확인해 주세요.' })}</div>`;
    bindSignout();
    root.querySelectorAll('[data-juror-entry], [data-jump-entry]').forEach((button) => button.addEventListener('click', () => {
      if (saving) { toastErr('평가를 저장하고 있습니다. 잠시 기다려 주세요.'); return; }
      selectedId = button.dataset.jurorEntry || button.dataset.jumpEntry;
      render();
    }));
    root.querySelector('[data-testid="prelim-view-saved"]')?.addEventListener('click', () => { step = 'completed'; render(); });
    root.querySelector('[data-testid="prelim-complete-btn"]')?.addEventListener('click', () => {
      const missing = [];
      entries.forEach((entry, index) => {
        if (entry.scoreBlocked) return;
        const raw = effectiveRawOf(entry, drafts);
        const missingNames = RUBRIC.map((rule, i) => (Number.isInteger(raw[i]) && raw[i] >= 1 && raw[i] <= 10 ? null : rule.name)).filter(Boolean);
        if (missingNames.length) missing.push({ entryId: entry.id, index, title: entry.title, missing: missingNames });
      });
      if (missing.length) {
        incompleteReport = missing;
        toastErr(`미심사 작품 ${missing.length}건이 있습니다.`);
        render();
        return;
      }
      incompleteReport = null;
      step = 'review';
      render();
    });

    const form = root.querySelector('[data-testid="juror-score-form"]');
    if (!form || !current) return;

    if (isPrelim) {
      form.querySelectorAll('[data-pick-criterion]').forEach((btn) => btn.addEventListener('click', () => {
        if (saving) return;
        const ci = Number(btn.dataset.pickCriterion);
        const val = Number(btn.dataset.pickValue);
        const next = [...effectiveRawOf(current, drafts)];
        next[ci] = val;
        drafts.set(current.id, next);
        incompleteReport = null;
        form.elements[`score${ci}`].value = String(val);
        const rowEl = form.querySelector(`[data-criterion-row="${ci}"]`);
        rowEl.querySelectorAll('[data-pick-criterion]').forEach((b) => {
          const picked = Number(b.dataset.pickValue) === val;
          b.classList.toggle('is-picked', picked);
          b.setAttribute('aria-checked', String(picked));
        });
        const readout = form.querySelector(`[data-criterion-readout="${ci}"]`);
        if (readout) readout.innerHTML = `<strong>${val} / 10</strong> <span class="field__hint">(환산 ${val * RUBRIC[ci].weight}/${RUBRIC[ci].max}점)</span>`;
        const valid = validRawFestaScores(next);
        root.querySelector('[data-testid="juror-score-total"]').textContent = valid
          ? `원점수 ${rawTotalOf(next)} / 40점 · 환산 ${totalOf(convertRawFestaScores(next))} / 100점`
          : '네 항목 모두 1~10 숫자를 선택해 주세요.';
        statusText(form.querySelector('[data-score-status]'), '변경한 점수는 아직 저장되지 않았습니다.');
      }));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (saving) return;
        const rawScores = effectiveRawOf(current, drafts);
        const status = form.querySelector('[data-score-status]');
        if (!validRawFestaScores(rawScores)) { statusText(status, '네 항목 모두 1~10 사이의 숫자를 선택해 주세요.', true); return; }
        saving = true;
        form.querySelector('fieldset').disabled = true;
        statusText(status, '점수를 저장하고 있습니다.');
        try {
          const res = await jury('score', { ...access(), entryId: current.id, rawScores });
          current.myRawScores = [...res.myRawScores];
          current.myScores = [...res.myScores];
          session.completion = null;
          drafts.delete(current.id);
          saving = false;
          render();
          statusText(root.querySelector('[data-score-status]'), `원점수 ${rawTotalOf(rawScores)}/40점 · 환산 ${totalOf(res.myScores)}/100점으로 저장했습니다.`);
        } catch (error) {
          saving = false;
          if (error.status === 401 || error.status === 403) showUnlock('심사 로그인이 만료되었거나 변경되었습니다. 본인의 개인 코드로 다시 입장해 주세요.');
          else if (error.status === 409) {
            try { await loadSession(); if (session.status === 'open') statusText(root.querySelector('[data-score-status]'), error.message, true); }
            catch { statusText(status, error.message, true); form.querySelector('fieldset').disabled = false; }
          } else { statusText(status, error.message, true); form.querySelector('fieldset').disabled = false; }
        }
      });
      return;
    }

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
        if (memberMode) await request(`${memberBase}/member-score`, { entryId: current.id, scores, expectedMemberId: session.judgeId });
        else await jury('score', { ...access(), entryId: current.id, scores });
        current.myScores = scores;
        drafts.delete(current.id);
        saving = false;
        render();
        statusText(root.querySelector('[data-score-status]'), `합계 ${totalOf(scores)}점으로 저장했습니다. 평가 중에는 수정할 수 있습니다.`);
      } catch (error) {
        saving = false;
        if (memberMode && error.status === 401) { await refreshSession(); showMemberLogin('로그인 세션이 만료되었습니다. 다시 로그인해 주세요.'); }
        else if (!memberMode && (error.status === 401 || error.status === 403)) showUnlock('심사 로그인이 만료되었거나 변경되었습니다. 본인의 개인 코드로 다시 입장해 주세요.');
        else if (error.status === 409) {
          try { await loadSession(); if (session.status === 'open') statusText(root.querySelector('[data-score-status]'), error.message, true); }
          catch { statusText(status, error.message, true); form.querySelector('fieldset').disabled = false; }
        } else { statusText(status, error.message, true); form.querySelector('fieldset').disabled = false; }
      }
    });
  };

  const prelimDetailHtml = (entry, index) => {
    const raw = effectiveRawOf(entry, drafts);
    return `<article class="card fj-stack" data-testid="juror-entry-detail">
      <div><span class="badge badge--soft">작품 ${index + 1} · 블라인드 심사</span><h2 class="page-title" style="font-size:2.3rem;margin-top:var(--space-2)">${esc(entry.title)}</h2></div>
      ${linksHtml(entry)}
      <section aria-label="작품 설명"><h3>📝 작품 설명</h3><div class="fj-description" data-testid="juror-description">${esc(entry.description)}</div></section>
      <section aria-label="첨부 자료"><h3 style="margin-bottom:var(--space-3)">📎 첨부 자료</h3>${filesHtml(entry, accessQuery(), '/festa/jury/file')}</section>
      ${entry.scoreBlocked ? `<p class="notice notice--info" data-testid="juror-score-blocked">${esc(entry.scoreBlocked)}</p>` : prelimScoreFormHtml(entry, raw)}
    </article>`;
  };

  const detailHtml = (entry) => {
    const stored = !entry.scoreBlocked && validFestaScores(entry.myScores) ? entry.myScores : null;
    const draft = drafts.get(entry.id);
    const raw = draft || (stored ? stored.map(String) : ['', '', '', '']);
    const total = totalOf(raw.map((value) => value === '' ? null : Number(value)));
    return `<article class="card fj-stack" data-testid="juror-entry-detail">${runId ? `<p class="badge badge--gold">연습용 · ${entry.rehearsal?.sample ? '가상 작품' : '실제 Camp 작품 사본'}</p>` : ''}<div><h2 class="page-title" style="font-size:2.3rem">${esc(entry.title)}</h2><p class="page-sub">${esc(entry.author?.name || '')} · ${esc(institutionOf(entry) || entry.author?.institution || '')}</p></div>${linksHtml(entry)}<section aria-label="작품 설명"><h3>📝 작품 설명</h3><div class="fj-description" data-testid="juror-description">${esc(entry.description)}</div></section><section aria-label="첨부 자료"><h3 style="margin-bottom:var(--space-3)">📎 첨부 자료</h3>${filesHtml(entry, memberMode ? '' : accessQuery(), memberMode ? `${memberBase}/member-file` : '/festa/jury/file')}</section>${entry.scoreBlocked ? `<p class="notice notice--info" data-testid="juror-score-blocked">${esc(entry.scoreBlocked)}</p>` : `<form data-testid="juror-score-form" data-entry-id="${attr(entry.id)}"><fieldset style="border:0;padding:0;margin:0;min-width:0"><legend style="font-size:1.9rem;font-weight:700">${stored ? '저장한 평가 수정' : '작품 평가'} · 총 100점</legend><div class="fj-score-rows">${RUBRIC.map((rule, index) => `<div class="fj-score-row"><label for="jurorScore${index}"><span class="field__label">${rule.name} · ${rule.max}점</span><span class="field__hint" id="jurorScoreHelp${index}">${rule.description}</span></label><input class="input" id="jurorScore${index}" name="score${index}" type="number" min="0" max="${rule.max}" step="1" inputmode="numeric" required value="${attr(raw[index])}" aria-describedby="jurorScoreHelp${index}" /></div>`).join('')}</div><div class="fj-head" style="margin-top:var(--space-4)"><p class="fj-score-total" data-testid="juror-score-total" aria-live="polite">${total === null ? '네 항목의 점수를 모두 입력해 주세요.' : `합계 ${total} / 100점`}</p><button class="btn btn--primary" type="submit" data-testid="juror-score-save">${stored ? '평가 수정 저장' : '평가 저장'}</button></div></fieldset><p data-score-status role="status" aria-live="polite" style="margin-top:var(--space-3)">${draft ? '입력한 점수는 아직 저장되지 않았습니다.' : stored ? '저장된 평가입니다. 평가가 열려 있는 동안 수정할 수 있습니다.' : '0점도 입력할 수 있습니다. 빈 항목은 미평가로 남습니다.'}</p></form>`}</article>`;
  };
  const loadSession = async () => {
    const next = memberMode ? await request(`${memberBase}/member-final`) : await jury(`session?${accessQuery()}`);
    if (!memberMode && (next.panel !== invitation.panel || next.judgeId !== (expectedJudgeId || invitation.judgeId))) throw new Error('현재 개인 코드와 로그인 정보가 일치하지 않습니다. 코드를 다시 확인해 주세요.');
    if (memberMode && session && session.judgeId !== next.judgeId) { drafts.clear(); selectedId = null; }
    session = next;
    expectedJudgeId = next.judgeId;
    if (!memberMode && next.defaultName && !signerDraft.name) signerDraft.name = next.defaultName;
    if (!memberMode && next.completion && next.status !== 'open') step = 'completed';
    render();
  };
  if (sharedPanel && !memberMode) showUnlock();
  else try { await loadSession(); } catch (error) {
    if (memberMode && error.status !== 401) root.innerHTML = `<p class="notice notice--err" data-testid="member-final-unavailable" role="alert">${esc(error.message)}</p>`;
    else { if (memberMode) await refreshSession(); showUnlock(error.status === 401 || error.status === 403 ? '' : error.message); }
  }
}
