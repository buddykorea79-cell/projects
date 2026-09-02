/** 로그인 · 회원가입 · 내 계정. */
import { CONFIG } from '../config.js';
import { store } from '../store/index.js';
import {
  currentUser, isSimulated, signup, login, logout, changePassword, requestReset, confirmReset,
} from '../auth.js';
import { esc, attr, fmtDate, isEmail, passwordIssue } from '../utils.js';
import {
  toastOk, toastErr, fieldError, clearErrors, focusFirstError, busy, confirmModal,
} from '../ui.js';
import { go, currentQuery } from '../router.js';

/** 로그인 뒤 돌아갈 곳. 외부 주소로 튕기지 않게 내부 경로만 허용합니다. */
function nextPath() {
  const raw = currentQuery().get('next') || '';
  return /^\/[A-Za-z0-9/_-]*$/.test(raw) ? raw : '/';
}

const demoNotice = () => (isSimulated()
  ? `<div class="notice notice--warn" style="margin-bottom:var(--space-4)">
       <span><strong>시연용 계정입니다.</strong> 지금 저장소가 서버 없는 모드라
       회원 정보가 이 브라우저에만 저장됩니다. 실제 운영은 Cloudflare R2 모드에서 하세요.</span>
     </div>`
  : '');

/* ------------------------------------------------------------- 로그인 -- */

export function loginView(mount) {
  if (currentUser()) { go(nextPath(), { replace: true }); return; }

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow" style="max-width:440px">
        <div style="text-align:center;margin-bottom:var(--space-5)">
          <h1 class="page-title">로그인</h1>
          <p class="page-sub">${esc(CONFIG.orgName)} 과제 제출·강의자료 이용</p>
        </div>

        ${demoNotice()}

        <form class="card" id="loginForm" novalidate>
          <label class="field">
            <span class="field__label">이메일</span>
            <input class="input" name="email" type="email" inputmode="email"
                   autocomplete="username" placeholder="you@example.com" />
          </label>
          <label class="field">
            <span class="field__label">비밀번호</span>
            <input class="input" name="password" type="password" autocomplete="current-password" />
          </label>
          <button class="btn btn--primary btn--block btn--lg" type="submit">로그인</button>
        </form>

        <p style="text-align:center;margin-top:var(--space-4);color:var(--text-black-soft);font-size:1.4rem">
          아직 계정이 없으신가요?
          <a href="#/signup">회원가입</a>
        </p>
        <p style="text-align:center;margin-top:var(--space-2);font-size:1.3rem;color:var(--text-black-soft)">
          <a href="#/forgot">비밀번호를 잊으셨나요?</a>
        </p>
      </div>
    </section>`;

  const form = mount.querySelector('#loginForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    let ok = true;
    if (!isEmail(form.email.value)) { fieldError(form.email, '올바른 이메일을 입력하세요.'); ok = false; }
    if (!form.password.value) { fieldError(form.password, '비밀번호를 입력하세요.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '확인 중…');
    try {
      const me = await login(form.email.value, form.password.value);
      toastOk(`${me.name}님, 환영합니다.`);
      go(me.mustChangePassword ? '/account' : nextPath());
      if (me.mustChangePassword) toastErr('임시 비밀번호입니다. 새 비밀번호로 바꿔주세요.');
    } catch (err) {
      busy(btn, false);
      fieldError(form.password, err.message);
      focusFirstError(form);
    }
  });
  form.email.focus();
}

/* ------------------------------------------------------ 비밀번호 찾기 -- */

/**
 * 서버에 메일 발송이 설정돼 있으면(store.mailReset) "초기화 링크를 메일로 보냈다"는
 * 흐름으로, 아니면 "담당자가 전달한다"는 흐름으로 안내합니다. 어느 쪽이든 응답은
 * 계정 존재 여부와 무관하게 같습니다 — 가입 여부를 흘리지 않기 위해서입니다.
 */
export function forgotView(mount) {
  const mailReset = Boolean(store?.mailReset);

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow" style="max-width:440px">
        <div style="text-align:center;margin-bottom:var(--space-5)">
          <h1 class="page-title">비밀번호 찾기</h1>
          <p class="page-sub">가입할 때 쓴 이메일을 알려주세요.</p>
        </div>

        <div class="notice notice--info" style="margin-bottom:var(--space-4)">
          ${mailReset
    ? `아래에 이메일을 입력하고 버튼을 누르면, <strong>등록하신 메일 주소로
          비밀번호 초기화 링크</strong>가 전송됩니다. 링크에서 새 비밀번호를
          직접 정하시면 됩니다.`
    : `요청을 남기면 담당자에게 바로 알림이 갑니다. 담당자가 비밀번호
          재설정 링크나 임시 비밀번호를 직접 전달해 드립니다.`}
        </div>

        <form class="card" id="forgotForm" novalidate>
          <label class="field">
            <span class="field__label">이메일</span>
            <input class="input" name="email" type="email" inputmode="email"
                   autocomplete="username" placeholder="you@example.com" />
          </label>
          <button class="btn btn--primary btn--block btn--lg" type="submit">
            ${mailReset ? '비밀번호 초기화' : '요청 남기기'}</button>
        </form>

        <div id="forgotDone" hidden>
          <div class="card" style="text-align:center">
            ${mailReset
    ? `<h2 class="page-title" style="font-size:1.9rem">초기화 링크를 보냈습니다</h2>
            <p style="color:var(--text-black-soft);margin-top:var(--space-2);font-size:1.5rem">
              가입된 계정이라면 <strong id="forgotEmail"></strong> 주소로<br>
              비밀번호 초기화 링크가 전송되었습니다.<br>
              받은편지함(스팸함 포함)을 확인해 주세요.<br>
              링크는 <strong>60분 동안, 한 번만</strong> 쓸 수 있습니다.
            </p>
            <p style="color:var(--text-black-soft);margin-top:var(--space-2);font-size:1.3rem">
              메일이 오지 않으면 이메일 주소를 다시 확인하시거나 담당자에게 문의해 주세요.
            </p>`
    : `<h2 class="page-title" style="font-size:1.9rem">요청이 접수되었습니다</h2>
            <p style="color:var(--text-black-soft);margin-top:var(--space-2);font-size:1.5rem">
              담당자가 확인한 뒤 재설정 링크나 임시 비밀번호를 전달해 드립니다.<br>
              링크를 받으면 그 화면에서 새 비밀번호를 직접 정하시면 됩니다.
            </p>`}
            <div class="row" style="justify-content:center;margin-top:var(--space-4)">
              <a class="btn btn--outline" href="#/login">로그인 화면으로</a>
            </div>
          </div>
        </div>

        <p style="text-align:center;margin-top:var(--space-4);color:var(--text-black-soft);font-size:1.4rem">
          <a href="#/login">← 로그인으로 돌아가기</a>
        </p>
      </div>
    </section>`;

  const form = mount.querySelector('#forgotForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    if (!isEmail(form.email.value)) {
      fieldError(form.email, '올바른 이메일을 입력하세요.');
      focusFirstError(form);
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, mailReset ? '전송 중…' : '접수 중…');
    try {
      await requestReset(form.email.value);
      // 가입 여부를 알려주지 않기 위해, 계정이 없어도 같은 화면을 보여줍니다.
      const emailSlot = mount.querySelector('#forgotEmail');
      if (emailSlot) emailSlot.textContent = form.email.value.trim();
      form.hidden = true;
      mount.querySelector('#forgotDone').hidden = false;
    } catch (err) {
      busy(btn, false);
      toastErr(`요청을 남기지 못했습니다 — ${err.message}`);
    }
  });
  form.email.focus();
}

/* --------------------------------------------------- 비밀번호 재설정 -- */

/**
 * 재설정 링크(`#/reset?token=…`)가 여는 화면. 링크에 담긴 토큰이 곧 인증이라
 * 로그인 없이 열리고, 새 비밀번호는 본인이 직접 정합니다. 토큰이 만료됐거나
 * 이미 쓰였으면 서버가 거부하고, 그때는 다시 요청하도록 안내합니다.
 */
export function resetView(mount) {
  const token = currentQuery().get('token') || '';

  if (!token) {
    mount.innerHTML = `
      <section class="section"><div class="wrap wrap--narrow" style="max-width:440px">
        <div class="notice notice--warn">
          <strong>재설정 링크가 올바르지 않습니다.</strong><br>
          전달받은 링크 전체를 그대로 열었는지 확인하시고, 안 되면
          <a href="#/forgot">다시 요청</a>해 주세요.
        </div>
      </div></section>`;
    return;
  }

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow" style="max-width:440px">
        <div style="text-align:center;margin-bottom:var(--space-5)">
          <h1 class="page-title">새 비밀번호 설정</h1>
          <p class="page-sub">본인만 아는 새 비밀번호를 정해주세요.</p>
        </div>

        <form class="card" id="resetForm" novalidate>
          <label class="field">
            <span class="field__label">새 비밀번호</span>
            <input class="input" name="password" type="password" autocomplete="new-password" />
            <span class="field__hint">8자 이상, 문자·숫자·특수문자를 모두 포함해야 합니다.</span>
          </label>
          <label class="field">
            <span class="field__label">새 비밀번호 확인</span>
            <input class="input" name="confirm" type="password" autocomplete="new-password" />
          </label>
          <button class="btn btn--primary btn--block btn--lg" type="submit">비밀번호 바꾸기</button>
        </form>

        <div id="resetDone" hidden>
          <div class="card" style="text-align:center">
            <h2 class="page-title" style="font-size:1.9rem">비밀번호가 바뀌었습니다</h2>
            <p style="color:var(--text-black-soft);margin-top:var(--space-2);font-size:1.5rem">
              새 비밀번호로 로그인해 주세요.
            </p>
            <div class="row" style="justify-content:center;margin-top:var(--space-4)">
              <a class="btn btn--primary" href="#/login">로그인하러 가기</a>
            </div>
          </div>
        </div>

        <p style="text-align:center;margin-top:var(--space-4);color:var(--text-black-soft);font-size:1.4rem">
          <a href="#/login">← 로그인으로 돌아가기</a>
        </p>
      </div>
    </section>`;

  const form = mount.querySelector('#resetForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    let ok = true;
    const pwIssue = passwordIssue(form.password.value);
    if (pwIssue) { fieldError(form.password, pwIssue); ok = false; }
    if (form.password.value !== form.confirm.value) {
      fieldError(form.confirm, '비밀번호가 서로 다릅니다.'); ok = false;
    }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '변경 중…');
    try {
      await confirmReset(token, form.password.value);
      toastOk('비밀번호가 바뀌었습니다.');
      form.hidden = true;
      mount.querySelector('#resetDone').hidden = false;
    } catch (err) {
      busy(btn, false);
      fieldError(form.password, err.message);
      focusFirstError(form);
    }
  });
  form.password.focus();
}

/* ----------------------------------------------------------- 회원가입 -- */

export function signupView(mount) {
  if (currentUser()) { go('/', { replace: true }); return; }

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow" style="max-width:520px">
        <div style="text-align:center;margin-bottom:var(--space-5)">
          <h1 class="page-title">회원가입</h1>
          <p class="page-sub">가입하면 바로 이용할 수 있습니다. 승인 절차는 없습니다.</p>
        </div>

        ${demoNotice()}

        <form class="card" id="signupForm" novalidate>
          <label class="field">
            <span class="field__label">기관명<span class="field__req">*</span></span>
            <input class="input" name="institution" autocomplete="organization"
                   placeholder="예) 행정안전부" />
          </label>
          <div class="field-row field-row--2">
            <label class="field">
              <span class="field__label">성명<span class="field__req">*</span></span>
              <input class="input" name="name" autocomplete="name" placeholder="예) 홍길동" />
            </label>
            <label class="field">
              <span class="field__label">이메일<span class="field__req">*</span></span>
              <input class="input" name="email" type="email" inputmode="email"
                     autocomplete="email" placeholder="you@example.com" />
              <span class="field__hint">로그인 아이디로 쓰입니다.</span>
            </label>
          </div>
          <label class="field">
            <span class="field__label">비밀번호<span class="field__req">*</span></span>
            <input class="input" name="password" type="password" autocomplete="new-password" />
            <span class="field__hint">8자 이상, 문자·숫자·특수문자를 모두 포함. 다른 곳에서 쓰는 비밀번호는 피해주세요.</span>
          </label>
          <label class="field">
            <span class="field__label">비밀번호 확인<span class="field__req">*</span></span>
            <input class="input" name="confirm" type="password" autocomplete="new-password" />
          </label>

          <label class="check">
            <input type="checkbox" name="agree" />
            <span>기관명·성명·이메일이 과제 확인과 본인 인증에 쓰이는 데 동의합니다.<span class="field__req">*</span></span>
          </label>

          <button class="btn btn--primary btn--block btn--lg" type="submit">가입하고 시작하기</button>
        </form>

        <p style="text-align:center;margin-top:var(--space-4);color:var(--text-black-soft);font-size:1.4rem">
          이미 계정이 있으신가요? <a href="#/login">로그인</a>
        </p>
      </div>
    </section>`;

  const form = mount.querySelector('#signupForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    let ok = true;
    if (!form.institution.value.trim()) { fieldError(form.institution, '기관명을 입력하세요.'); ok = false; }
    if (!form.name.value.trim()) { fieldError(form.name, '성명을 입력하세요.'); ok = false; }
    if (!isEmail(form.email.value)) { fieldError(form.email, '올바른 이메일을 입력하세요.'); ok = false; }
    const pwIssue = passwordIssue(form.password.value);
    if (pwIssue) { fieldError(form.password, pwIssue); ok = false; }
    if (form.password.value !== form.confirm.value) {
      fieldError(form.confirm, '비밀번호가 서로 다릅니다.'); ok = false;
    }
    if (!form.agree.checked) { fieldError(form.agree.closest('.check'), '동의가 필요합니다.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '가입 중…');
    try {
      const me = await signup({
        institution: form.institution.value,
        name: form.name.value,
        email: form.email.value,
        password: form.password.value,
      });
      toastOk(`${me.name}님, 가입이 완료되었습니다.`);
      go('/');
    } catch (err) {
      busy(btn, false);
      // 서버가 항목별 오류를 주면 그 자리에 표시합니다.
      const fields = err.errors || {};
      let shown = false;
      for (const [key, message] of Object.entries(fields)) {
        if (form[key]) { fieldError(form[key], message); shown = true; }
      }
      if (!shown) fieldError(form.email, err.message);
      focusFirstError(form);
    }
  });
  form.institution.focus();
}

/* ----------------------------------------------------------- 내 계정 -- */

export function accountView(mount) {
  const me = currentUser();
  if (!me) { go('/login?next=/account', { replace: true }); return; }

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--narrow stack-4">
        <div class="page-head">
          <div>
            <h1 class="page-title">내 계정</h1>
            <p class="page-sub">${esc(me.institution)} · ${esc(me.name)}</p>
          </div>
          <button class="btn btn--quiet" data-logout>로그아웃</button>
        </div>

        ${me.mustChangePassword ? `
          <div class="notice notice--warn">
            <strong>임시 비밀번호로 로그인했습니다.</strong> 아래에서 새 비밀번호로 바꿔주세요.
          </div>` : ''}

        <div class="card">
          <div class="kv">
            <div class="kv__row"><div class="kv__k">이메일</div><div class="kv__v">${esc(me.email)}</div></div>
            <div class="kv__row"><div class="kv__k">기관명</div><div class="kv__v">${esc(me.institution || '—')}</div></div>
            <div class="kv__row"><div class="kv__k">성명</div><div class="kv__v">${esc(me.name)}</div></div>
            <div class="kv__row"><div class="kv__k">권한</div><div class="kv__v">${
              me.role === 'admin' ? '<span class="badge badge--gold">관리자</span>' : '일반 회원'
            }</div></div>
            <div class="kv__row"><div class="kv__k">가입일</div><div class="kv__v">${esc(fmtDate(me.createdAt))}</div></div>
          </div>
          <p class="field__hint" style="margin-top:var(--space-3)">
            기관명·성명을 바꾸려면 담당자에게 문의하세요.
          </p>
        </div>

        <form class="card" id="pwForm" novalidate>
          <h2 class="page-title" style="font-size:1.8rem;margin-bottom:var(--space-3)">비밀번호 변경</h2>
          <label class="field">
            <span class="field__label">현재 비밀번호</span>
            <input class="input" name="current" type="password" autocomplete="current-password" />
          </label>
          <div class="field-row field-row--2">
            <label class="field">
              <span class="field__label">새 비밀번호</span>
              <input class="input" name="next" type="password" autocomplete="new-password" />
              <span class="field__hint">8자 이상, 문자·숫자·특수문자 포함</span>
            </label>
            <label class="field">
              <span class="field__label">새 비밀번호 확인</span>
              <input class="input" name="confirm" type="password" autocomplete="new-password" />
            </label>
          </div>
          <div class="row row--end">
            <button class="btn btn--primary" type="submit">변경하기</button>
          </div>
        </form>

        <div class="row">
          <a class="btn btn--outline" href="#/my">내 제출물 보기</a>
          <a class="btn btn--quiet" href="#/">프로젝트 목록</a>
        </div>
      </div>
    </section>`;

  mount.querySelector('[data-logout]').addEventListener('click', async () => {
    const ok = await confirmModal({ title: '로그아웃할까요?', confirmLabel: '로그아웃' });
    if (!ok) return;
    await logout();
    toastOk('로그아웃되었습니다.');
    go('/login');
  });

  const form = mount.querySelector('#pwForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    let ok = true;
    if (!form.current.value) { fieldError(form.current, '현재 비밀번호를 입력하세요.'); ok = false; }
    const pwIssue = passwordIssue(form.next.value);
    if (pwIssue) { fieldError(form.next, pwIssue); ok = false; }
    if (form.next.value !== form.confirm.value) { fieldError(form.confirm, '비밀번호가 서로 다릅니다.'); ok = false; }
    if (!ok) { focusFirstError(form); return; }

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true, '변경 중…');
    try {
      await changePassword(form.current.value, form.next.value);
      toastOk('비밀번호가 바뀌었습니다.');
      accountView(mount);
    } catch (err) {
      busy(btn, false);
      fieldError(form.current, err.message);
      focusFirstError(form);
    }
  });
}
