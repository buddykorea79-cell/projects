/** Google 로그인 · 신규 가입(온보딩) · 최초 프로필 설정 · 내 계정 · 기존 계정 연계. */
import { CONFIG } from '../config.js';
import {
  currentUser, isSimulated, isGoogleEnabled, signupPolicy,
  googleLoginUrl, demoLogin, getOnboardInfo, submitOnboard,
  completeProfile, requestAccountLink, logout,
} from '../auth.js';
import { esc, attr, fmtDate, isEmail } from '../utils.js';
import {
  toastOk, toastErr, fieldError, clearErrors, focusFirstError, busy, confirmModal, spinner,
} from '../ui.js';
import { go, currentQuery } from '../router.js';

/** 로그인 뒤 돌아갈 곳. 외부 주소로 튕기지 않게 내부 경로만 허용합니다. */
function nextPath() {
  const raw = currentQuery().get('next') || '';
  return /^\/[A-Za-z0-9/_-]*$/.test(raw) ? raw : '/';
}

const GOOGLE_G_ICON = `
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M23.49 12.27c0-.82-.07-1.64-.22-2.43H12v4.6h6.46a5.53 5.53 0 0 1-2.4 3.63v3.01h3.88c2.27-2.09 3.55-5.17 3.55-8.81z"/>
    <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.72-4.95H1.28v3.11A12 12 0 0 0 12 24z"/>
    <path fill="#FBBC05" d="M5.28 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.38-2.28V6.61H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l4-3.11z"/>
    <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.23 0 12 0A12 12 0 0 0 1.28 6.61l4 3.11C6.23 6.88 8.88 4.77 12 4.77z"/>
  </svg>`;

const ERROR_MESSAGES = {
  pending: {
    kind: 'info',
    title: '가입 승인 요청이 접수되었습니다',
    body: '담당자(관리자)가 소속·성명(및 기존 계정 연계 요청)을 확인한 뒤 승인하면 바로 로그인할 수 있습니다.',
  },
  not_invited: {
    kind: 'warn',
    title: '사전 등록된 교육생 이메일이 아닙니다',
    body: '사용하실 Google 이메일 주소를 담당자에게 알려주시면 등록 후 바로 로그인할 수 있습니다.',
  },
  blocked: {
    kind: 'err',
    title: '이용이 정지된 계정입니다',
    body: '자세한 사항은 담당자(관리자)에게 문의해 주세요.',
  },
  cancelled: {
    kind: 'info',
    title: 'Google 로그인이 취소되었습니다',
    body: '아래 버튼을 눌러 다시 시도해 주세요.',
  },
  not_configured: {
    kind: 'warn',
    title: 'Google 로그인 설정이 아직 완료되지 않았습니다',
    body: '관리자가 Cloudflare 환경변수(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)를 등록해야 로그인할 수 있습니다.',
  },
  unverified_email: {
    kind: 'err',
    title: '이메일 인증이 완료되지 않은 Google 계정입니다',
    body: 'Google 계정에서 이메일 인증을 마친 뒤 다시 시도해 주세요.',
  },
  google_mismatch: {
    kind: 'err',
    title: '기존 계정 정보와 일치하지 않습니다',
    body: '같은 이메일이 다른 Google 계정에 연결되어 있습니다. 담당자에게 문의해 주세요.',
  },
  invalid_state: {
    kind: 'warn',
    title: '로그인 요청이 만료되었습니다',
    body: '보안을 위해 로그인 유효 시간이 지났습니다. 아래 버튼으로 다시 시도해 주세요.',
  },
  oauth_failed: {
    kind: 'err',
    title: 'Google 로그인을 완료하지 못했습니다',
    body: '잠시 후 다시 시도해 주세요. 문제가 계속되면 담당자에게 문의하세요.',
  },
};

const demoNotice = () => (isSimulated()
  ? `<div class="notice notice--warn" style="margin-bottom:var(--space-4)">
       <span><strong>시연용 계정입니다.</strong> 지금 저장소가 서버 없는 모드라
       회원 정보가 이 브라우저에만 저장됩니다. 실제 운영은 Cloudflare R2 + Google 로그인 모드에서 하세요.</span>
     </div>`
  : '');

/* ------------------------------------------------------------- 로그인 -- */

export function loginView(mount) {
  const me = currentUser();
  if (me) {
    go(me.needsProfile ? `/account?setup=1&next=${encodeURIComponent(nextPath())}` : nextPath(), { replace: true });
    return;
  }

  const next = nextPath();
  const errCode = currentQuery().get('error') || '';
  const errInfo = ERROR_MESSAGES[errCode] || null;
  const simulated = isSimulated();
  const googleReady = isGoogleEnabled();
  const policy = signupPolicy();

  const policyHint = policy === 'allowlist'
    ? '사전 등록된 교육생 Google 계정으로만 로그인할 수 있습니다.'
    : policy === 'open'
      ? 'Google 계정으로 로그인하면 최초 1회 소속·성명 입력 후 바로 이용할 수 있습니다.'
      : '사전 등록된 교육생은 즉시 로그인되며, 처음 접속하는 경우 소속·성명을 입력해 담당자 승인 후 이용할 수 있습니다.';

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow" style="max-width:460px">
        <div style="text-align:center;margin-bottom:var(--space-5)">
          <h1 class="page-title">로그인</h1>
          <p class="page-sub">${esc(CONFIG.orgName)} 과제 제출 · 강의자료 이용</p>
        </div>

        ${demoNotice()}

        ${errInfo ? `
          <div class="notice notice--${attr(errInfo.kind)}" role="alert" style="margin-bottom:var(--space-4)">
            <div>
              <strong>${esc(errInfo.title)}</strong><br>
              <span>${esc(errInfo.body)}</span>
            </div>
          </div>` : ''}

        ${simulated ? `
          <form class="card" id="demoLoginForm" novalidate>
            <p class="field__hint" style="margin-bottom:var(--space-3)">
              로컬 시연 모드입니다. 테스트할 Google 이메일과 소속·성명을 입력하세요.
            </p>
            <label class="field">
              <span class="field__label">이메일<span class="field__req">*</span></span>
              <input class="input" name="email" type="email" inputmode="email" placeholder="you@gmail.com" />
            </label>
            <label class="field">
              <span class="field__label">소속 (기관명)</span>
              <input class="input" name="institution" placeholder="예) 행정안전부" />
            </label>
            <label class="field">
              <span class="field__label">성명</span>
              <input class="input" name="name" placeholder="예) 홍길동" />
            </label>
            <button class="btn btn--google btn--block btn--lg" type="submit">
              ${GOOGLE_G_ICON}
              <span>Google 계정으로 시연 로그인</span>
            </button>
          </form>` : `
          <div class="card" style="text-align:center">
            <p style="font-size:1.5rem;color:var(--text-black-soft);margin-bottom:var(--space-4)">
              별도 비밀번호 없이 <strong>Google 계정</strong>으로 안전하게 로그인합니다.
            </p>
            ${googleReady ? `
              <a class="btn btn--google btn--block btn--lg" id="googleLoginBtn"
                 href="${attr(googleLoginUrl(next))}">
                ${GOOGLE_G_ICON}
                <span>Google 계정으로 로그인</span>
              </a>` : `
              <div class="notice notice--warn" style="text-align:left;margin-bottom:var(--space-3)">
                <span>Google 로그인 설정이 아직 되어 있지 않습니다. 관리자가 Cloudflare에
                <code>GOOGLE_CLIENT_ID</code>와 <code>GOOGLE_CLIENT_SECRET</code>을 등록해 주세요.</span>
              </div>
              <button class="btn btn--google btn--block btn--lg" type="button" disabled>
                ${GOOGLE_G_ICON}
                <span>Google 계정으로 로그인 (설정 필요)</span>
              </button>`}
            <p class="field__hint" style="margin-top:var(--space-4);text-align:left">
              ${esc(policyHint)}
            </p>
          </div>`}

        <p style="text-align:center;margin-top:var(--space-4);color:var(--text-black-soft);font-size:1.4rem">
          <a href="#/">← 홈으로 돌아가기</a>
        </p>
        <p style="text-align:center;margin-top:var(--space-2);color:var(--text-black-mute);font-size:1.3rem">
          <a href="./privacy/">개인정보처리방침</a> · <a href="./terms/">서비스 이용약관</a>
        </p>
      </div>
    </section>`;

  if (simulated) {
    const form = mount.querySelector('#demoLoginForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);
      if (!isEmail(form.email.value)) {
        fieldError(form.email, '올바른 이메일을 입력하세요.');
        focusFirstError(form);
        return;
      }
      const btn = form.querySelector('button[type="submit"]');
      busy(btn, true, '로그인 중…');
      try {
        const user = await demoLogin({
          email: form.email.value,
          name: form.name.value,
          institution: form.institution.value,
        });
        toastOk(`${user.name || user.email}님, 환영합니다.`);
        go(user.needsProfile ? `/account?setup=1&next=${encodeURIComponent(next)}` : next);
      } catch (err) {
        busy(btn, false);
        fieldError(form.email, err.message);
        focusFirstError(form);
      }
    });
    form.email.focus();
  }
}

/* ------------------------------------------- 신규 Google 가입 신청 (온보딩) -- */

/**
 * 사전 미등록 Google 계정이 처음 로그인했을 때 열리는 소속·성명·기존계정 연계 신청 화면.
 * 서버의 서명된 ah_onboard 쿠키가 있어야 열리고, 제출하면 pending(승인 대기) 상태로 저장됩니다.
 */
export async function onboardView(mount) {
  if (currentUser()) { go('/', { replace: true }); return; }

  mount.innerHTML = `<section class="section"><div class="wrap wrap--narrow">${spinner()}</div></section>`;

  let info;
  try {
    info = await getOnboardInfo();
  } catch {
    go('/login?error=invalid_state', { replace: true });
    return;
  }

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow" style="max-width:520px">
        <div style="text-align:center;margin-bottom:var(--space-5)">
          <h1 class="page-title">교육생 가입 신청</h1>
          <p class="page-sub">소속과 성명을 입력해 주시면 담당자 확인 후 바로 이용하실 수 있습니다.</p>
        </div>

        <form class="card" id="onboardForm" novalidate>
          <div class="kv" style="margin-bottom:var(--space-4)">
            <div class="kv__row">
              <div class="kv__k">Google 계정</div>
              <div class="kv__v"><strong>${esc(info.email)}</strong></div>
            </div>
          </div>

          <label class="field">
            <span class="field__label">소속 (기관명)<span class="field__req">*</span></span>
            <input class="input" name="institution" autocomplete="organization"
                   placeholder="예) 행정안전부, 한국서부발전" />
          </label>
          <label class="field">
            <span class="field__label">성명<span class="field__req">*</span></span>
            <input class="input" name="name" autocomplete="name"
                   placeholder="예) 홍길동" value="${attr(info.name || '')}" />
            <span class="field__hint">Google 프로필 이름이 영문·별명이라면 실명으로 고쳐 주세요.</span>
          </label>

          <hr style="border:0;border-top:1px solid var(--line, #e2e0db);margin:var(--space-4) 0" />

          <label class="field">
            <span class="field__label">기존 가입 이메일 <span style="font-weight:400;color:var(--text-black-mute)">(선택 — 기존 회원 정보 연계)</span></span>
            <input class="input" name="legacyEmail" type="email" inputmode="email"
                   placeholder="예) hong@korea.kr 또는 hong@naver.com" />
            <span class="field__hint">
              예전에 <strong>다른 이메일</strong>로 가입해 과제를 제출하신 적이 있다면 입력해 주세요.
              관리자 승인 시 기존 제출물·페스타 기록·권한을 현재 Google 계정으로 연계해 드립니다.
              처음 가입하시는 분은 비워 두시면 됩니다.
            </span>
          </label>

          <label class="check">
            <input type="checkbox" name="agree" />
            <span>소속·성명·이메일이 교육 과정 확인과 본인 인증에 쓰이는 데 동의합니다.<span class="field__req">*</span></span>
          </label>

          <button class="btn btn--primary btn--block btn--lg" type="submit" style="margin-top:var(--space-3)">
            가입 승인 요청하기
          </button>
        </form>

        <div id="onboardDone" hidden>
          <div class="card" style="text-align:center">
            <h2 class="page-title" style="font-size:2rem">가입 승인 요청이 접수되었습니다</h2>
            <p style="color:var(--text-black-soft);margin-top:var(--space-3);font-size:1.5rem;line-height:1.7">
              담당자(관리자)가 입력하신 소속·성명을 확인한 뒤 승인하면<br>
              <strong>Google 계정으로 로그인</strong>을 눌러 바로 이용하실 수 있습니다.
            </p>
            <div class="row" style="justify-content:center;margin-top:var(--space-4)">
              <a class="btn btn--primary" href="#/login">로그인 화면으로</a>
              <a class="btn btn--outline" href="#/">홈으로</a>
            </div>
          </div>
        </div>
      </div>
    </section>`;

  const form = mount.querySelector('#onboardForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    let ok = true;
    if (!form.institution.value.trim()) { fieldError(form.institution, '소속(기관명)을 입력하세요.'); ok = false; }
    if (!form.name.value.trim()) { fieldError(form.name, '성명을 입력하세요.'); ok = false; }
    const legacy = form.legacyEmail.value.trim();
    if (legacy) {
      if (!isEmail(legacy)) { fieldError(form.legacyEmail, '올바른 이메일 주소를 입력하세요.'); ok = false; }
      else if (legacy.toLowerCase() === info.email.toLowerCase()) {
        fieldError(form.legacyEmail, '현재 Google 이메일과 다른 기존 이메일을 입력하세요.'); ok = false;
      }
    }
    if (!form.agree.checked) { fieldError(form.agree.closest('.check'), '동의가 필요합니다.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '요청 전송 중…');
    try {
      const res = await submitOnboard({
        institution: form.institution.value,
        name: form.name.value,
        legacyEmail: legacy,
      });
      if (res?.status === 'active') {
        toastOk('이미 승인된 계정입니다. 다시 로그인해 주세요.');
        go('/login', { replace: true });
        return;
      }
      toastOk('가입 승인 요청이 접수되었습니다.');
      form.hidden = true;
      mount.querySelector('#onboardDone').hidden = false;
    } catch (err) {
      busy(btn, false);
      const fields = err.errors || {};
      let shown = false;
      for (const [key, message] of Object.entries(fields)) {
        if (form[key]) { fieldError(form[key], message); shown = true; }
      }
      if (!shown) toastErr(err.message);
      focusFirstError(form);
    }
  });
  form.institution.focus();
}

/** 예전 북마크(#/signup, #/forgot, #/reset)는 Google 로그인 화면으로 안내합니다. */
export function signupView() {
  const next = currentQuery().get('next');
  go(next ? `/login?next=${encodeURIComponent(nextPath())}` : '/login', { replace: true });
}

export function forgotView() {
  go('/login', { replace: true });
}

export function resetView() {
  go('/login', { replace: true });
}

/* ----------------------------------------------------------- 내 계정 -- */

export function accountView(mount) {
  const me = currentUser();
  if (!me) { go('/login?next=/account', { replace: true }); return; }

  const setup = me.needsProfile || currentQuery().get('setup') === '1';
  const next = nextPath();
  const linkedList = Array.isArray(me.linkedFromEmails) ? me.linkedFromEmails : [];

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow stack-4">
        <div class="page-head">
          <div>
            <h1 class="page-title">${me.needsProfile ? '교육생 정보 입력' : '내 계정'}</h1>
            <p class="page-sub">${esc([me.institution, me.name].filter(Boolean).join(' · ') || me.email)}</p>
          </div>
          <button class="btn btn--quiet" data-logout>로그아웃</button>
        </div>

        ${me.needsProfile ? `
          <div class="notice notice--info">
            <span><strong>Google 로그인이 완료되었습니다.</strong> 과제 제출과 출결 확인에 쓰일
            <strong>소속(기관명)</strong>과 <strong>성명</strong>을 입력해 주세요.</span>
          </div>

          <form class="card" id="profileForm" novalidate>
            <h2 class="page-title" style="font-size:1.8rem;margin-bottom:var(--space-3)">기본 정보 등록</h2>
            <label class="field">
              <span class="field__label">소속 (기관명)<span class="field__req">*</span></span>
              <input class="input" name="institution" autocomplete="organization"
                     placeholder="예) 행정안전부, 한국서부발전" value="${attr(me.institution || '')}" />
            </label>
            <label class="field">
              <span class="field__label">성명<span class="field__req">*</span></span>
              <input class="input" name="name" autocomplete="name"
                     placeholder="예) 홍길동" value="${attr(me.name || '')}" />
              <span class="field__hint">Google 프로필 이름이 영문·별명이라면 실명으로 고쳐 주세요.</span>
            </label>
            <label class="field">
              <span class="field__label">기존 가입 이메일 <span style="font-weight:400;color:var(--text-black-mute)">(선택 — 기존 회원 정보 연계)</span></span>
              <input class="input" name="legacyEmail" type="email" inputmode="email"
                     placeholder="예) hong@korea.kr 또는 hong@naver.com"
                     value="${attr(me.linkRequestedEmail || '')}" />
              <span class="field__hint">
                예전에 다른 이메일로 가입한 기록이 있다면 입력해 주세요. 관리자 승인 후 기존 제출물·권한이 현재 계정으로 연계됩니다.
              </span>
            </label>
            <label class="check">
              <input type="checkbox" name="agree" />
              <span>소속·성명·이메일이 과제 확인과 본인 인증에 쓰이는 데 동의합니다.<span class="field__req">*</span></span>
            </label>
            <div class="row row--end" style="margin-top:var(--space-3)">
              <button class="btn btn--primary btn--lg" type="submit">저장하고 시작하기</button>
            </div>
          </form>` : ''}

        <div class="card">
          <div class="kv">
            <div class="kv__row"><div class="kv__k">로그인 방식</div><div class="kv__v"><span class="badge badge--open">Google 계정 연동</span></div></div>
            <div class="kv__row"><div class="kv__k">이메일</div><div class="kv__v">${esc(me.email)}</div></div>
            <div class="kv__row"><div class="kv__k">소속 (기관명)</div><div class="kv__v">${esc(me.institution || '—')}</div></div>
            <div class="kv__row"><div class="kv__k">성명</div><div class="kv__v">${esc(me.name || '—')}</div></div>
            <div class="kv__row"><div class="kv__k">권한</div><div class="kv__v">${
              me.role === 'admin' ? '<span class="badge badge--gold">관리자</span>' : '일반 회원'
            }</div></div>
            ${linkedList.length ? `
              <div class="kv__row">
                <div class="kv__k">연계된 기존 계정</div>
                <div class="kv__v">${linkedList.map((e) => `<span class="badge badge--soft">${esc(e)}</span>`).join(' ')}</div>
              </div>` : ''}
            <div class="kv__row"><div class="kv__k">가입일</div><div class="kv__v">${esc(fmtDate(me.createdAt))}</div></div>
          </div>
          ${me.needsProfile ? '' : `
            <p class="field__hint" style="margin-top:var(--space-3)">
              소속·성명을 바꾸려면 담당자에게 문의하세요. 비밀번호는 Google 계정에서 관리됩니다.
            </p>`}
        </div>

        ${me.needsProfile ? '' : `
          <div class="card" id="linkCard">
            <h2 class="page-title" style="font-size:1.8rem;margin-bottom:var(--space-2)">기존 회원 정보 연계</h2>
            ${me.linkRequestedEmail ? `
              <div class="notice notice--info" style="margin-bottom:var(--space-3)">
                <span><strong>연계 승인 대기중</strong> — 기존 이메일 <code>${esc(me.linkRequestedEmail)}</code> 의
                제출물·기록을 현재 Google 계정으로 이관해 달라고 신청했습니다. 관리자가 승인하면 자동으로 반영됩니다.</span>
              </div>
              <button class="btn btn--quiet btn--sm" type="button" id="cancelLinkReq">연계 요청 취소</button>` : `
              <p class="field__hint" style="margin-bottom:var(--space-3)">
                Google 로그인 전환 전에 <strong>다른 이메일 주소</strong>로 가입해 과제를 제출하셨다면,
                기존 이메일을 입력해 연계 신청을 남겨주세요. 관리자가 확인 후 승인하면 기존 제출물·페스타·권한이 현재 계정으로 합쳐집니다.
              </p>
              <form id="linkForm" novalidate>
                <label class="field">
                  <span class="field__label">기존 가입 이메일</span>
                  <input class="input" name="legacyEmail" type="email" inputmode="email"
                         placeholder="예) hong@korea.kr 또는 hong@naver.com" />
                </label>
                <div class="row row--end">
                  <button class="btn btn--outline" type="submit">기존 계정 연계 신청</button>
                </div>
              </form>`}
          </div>

          <div class="row">
            <a class="btn btn--outline" href="#/my">내 제출물 보기</a>
            <a class="btn btn--quiet" href="#/">프로젝트 목록</a>
          </div>`}
      </div>
    </section>`;

  mount.querySelector('[data-logout]').addEventListener('click', async () => {
    const ok = await confirmModal({ title: '로그아웃할까요?', confirmLabel: '로그아웃' });
    if (!ok) return;
    await logout();
    toastOk('로그아웃되었습니다.');
    go('/login');
  });

  const profileForm = mount.querySelector('#profileForm');
  if (profileForm) {
    profileForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(profileForm);

      let ok = true;
      if (!profileForm.institution.value.trim()) {
        fieldError(profileForm.institution, '소속(기관명)을 입력하세요.'); ok = false;
      }
      if (!profileForm.name.value.trim()) {
        fieldError(profileForm.name, '성명을 입력하세요.'); ok = false;
      }
      const legacy = profileForm.legacyEmail.value.trim();
      if (legacy) {
        if (!isEmail(legacy)) { fieldError(profileForm.legacyEmail, '올바른 이메일 주소를 입력하세요.'); ok = false; }
        else if (legacy.toLowerCase() === me.email.toLowerCase()) {
          fieldError(profileForm.legacyEmail, '현재 Google 이메일과 다른 기존 이메일을 입력하세요.'); ok = false;
        }
      }
      if (!profileForm.agree.checked) {
        fieldError(profileForm.agree.closest('.check'), '동의가 필요합니다.'); ok = false;
      }
      if (!ok) { focusFirstError(profileForm); return; }

      const btn = profileForm.querySelector('button[type="submit"]');
      busy(btn, true, '저장 중…');
      try {
        const updated = await completeProfile({
          institution: profileForm.institution.value,
          name: profileForm.name.value,
          legacyEmail: legacy,
        });
        toastOk(legacy
          ? `${updated.name}님, 등록이 완료되었습니다. 기존 계정 연계는 관리자 승인 후 반영됩니다.`
          : `${updated.name}님, 등록이 완료되었습니다.`);
        go(setup ? next : '/account', { replace: true });
      } catch (err) {
        busy(btn, false);
        const fields = err.errors || {};
        let shown = false;
        for (const [key, message] of Object.entries(fields)) {
          if (profileForm[key]) { fieldError(profileForm[key], message); shown = true; }
        }
        if (!shown) fieldError(profileForm.institution, err.message);
        focusFirstError(profileForm);
      }
    });
    profileForm.institution.focus();
  }

  const linkForm = mount.querySelector('#linkForm');
  if (linkForm) {
    linkForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(linkForm);
      const legacy = linkForm.legacyEmail.value.trim();
      if (!isEmail(legacy)) {
        fieldError(linkForm.legacyEmail, '올바른 기존 이메일 주소를 입력하세요.');
        focusFirstError(linkForm);
        return;
      }
      if (legacy.toLowerCase() === me.email.toLowerCase()) {
        fieldError(linkForm.legacyEmail, '현재 Google 이메일과 다른 기존 이메일을 입력하세요.');
        focusFirstError(linkForm);
        return;
      }
      const btn = linkForm.querySelector('button[type="submit"]');
      busy(btn, true, '신청 중…');
      try {
        await requestAccountLink(legacy);
        toastOk('기존 계정 연계 신청이 접수되었습니다. 관리자 승인 후 반영됩니다.');
        accountView(mount);
      } catch (err) {
        busy(btn, false);
        fieldError(linkForm.legacyEmail, err.message);
        focusFirstError(linkForm);
      }
    });
  }

  const cancelLinkBtn = mount.querySelector('#cancelLinkReq');
  if (cancelLinkBtn) {
    cancelLinkBtn.addEventListener('click', async () => {
      try {
        await requestAccountLink('');
        toastOk('연계 요청을 취소했습니다.');
        accountView(mount);
      } catch (err) { toastErr(err.message); }
    });
  }
}
