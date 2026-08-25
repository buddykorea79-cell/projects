/** 로그인 · 회원가입 · 내 계정. */
import { CONFIG } from '../config.js';
import {
  currentUser, isSimulated, signup, login, logout, changePassword,
} from '../auth.js';
import { esc, attr, fmtDate, isEmail } from '../utils.js';
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
       <span class="note__icon"></span>
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
          비밀번호를 잊으셨다면 담당자에게 문의하세요. 임시 비밀번호를 발급해 드립니다.
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
            <span class="field__hint">8자 이상. 다른 곳에서 쓰는 비밀번호는 피해주세요.</span>
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
    if (form.password.value.length < 8) { fieldError(form.password, '비밀번호는 8자 이상이어야 합니다.'); ok = false; }
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
              <span class="field__hint">8자 이상</span>
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
    if (form.next.value.length < 8) { fieldError(form.next, '8자 이상이어야 합니다.'); ok = false; }
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
