/** 이용안내 — 교육생 / 관리자 / 저장소 설정 FAQ. */
import { CONFIG, STORAGE_LABEL } from '../config.js';
import { currentMode } from '../store/index.js';
import { esc } from '../utils.js';

const FAQ = [
  {
    id: 'signup',
    q: '어떻게 시작하나요?',
    a: '먼저 회원가입을 하세요. 기관명·성명·이메일과 비밀번호만 정하면 되고, 승인 절차 없이 '
     + '바로 이용할 수 있습니다. 이후에는 로그인만 하면 과제 제출과 강의자료 열람이 모두 됩니다.',
  },
  {
    id: 'submit',
    q: '과제는 어떻게 제출하나요?',
    a: '홈에서 프로젝트를 고른 뒤 [과제 제출하기] 를 누릅니다. 제출자 정보는 로그인 정보로 '
     + '자동으로 채워지므로, 제목과 설명을 쓰고 파일을 첨부하면 끝입니다.',
  },
  {
    id: 'edit',
    q: '제출한 내용을 고치거나 지울 수 있나요?',
    a: '[내 제출물] 에서 언제든 수정·삭제할 수 있습니다. 예전에 쓰던 수정코드는 없어졌습니다 — '
     + '로그인만 하면 본인 제출물이 바로 보입니다. 단, 프로젝트가 마감된 뒤에는 잠깁니다.',
  },
  {
    id: 'materials',
    q: '강의자료는 어떻게 받나요?',
    a: '상단 메뉴의 [강의자료] 를 누르면 목록이 나옵니다. 로그인한 회원이면 별도 비밀번호 없이 '
     + '바로 받을 수 있습니다. 자료에 따라 외부 링크로 연결되는 [바로가기] 버튼이 있기도 합니다.',
  },
  {
    id: 'board',
    q: '소통방은 어떻게 쓰나요?',
    a: '상단 [소통방] 에서 회원이면 누구나 글을 남기고 서로 댓글을 달 수 있습니다. '
     + '내가 쓴 글과 댓글은 언제든 고치거나 지울 수 있고, 관리자가 공지로 지정한 글은 '
     + '항상 목록 맨 위에 표시됩니다.',
  },
  {
    id: 'password',
    q: '비밀번호를 잊었어요.',
    a: '메일 발송 기능이 없어서 스스로 재설정할 수는 없습니다. 담당자에게 알려주시면 '
     + '임시 비밀번호를 발급해 드립니다. 로그인한 뒤 [내 계정] 에서 새 비밀번호로 바꾸세요.',
  },
  {
    id: 'files',
    q: '어떤 파일을 첨부할 수 있나요?',
    a: `이미지(jpg·png·gif·webp), 동영상(mp4·webm·mov), 문서(pdf·docx·pptx·xlsx·hwp) 등입니다. `
     + `제출 1건당 최대 ${CONFIG.upload.maxFiles}개, 파일 하나당 ${CONFIG.upload.maxFileMB}MB 까지 올릴 수 있습니다.`,
  },
  {
    id: 'privacy',
    q: '입력한 개인정보는 어떻게 다뤄지나요?',
    a: '기관명·성명·이메일은 과제 확인과 본인 인증에만 씁니다. 비밀번호는 원문이 저장되지 않고 '
     + '해시로만 보관됩니다. 제출물을 공개로 설정한 프로젝트에서도 이메일 주소는 본인과 관리자에게만 '
     + '보입니다. 과정이 끝나면 관리자가 일괄 삭제할 수 있습니다.',
  },
];

export function guideView(mount) {
  const mode = currentMode();

  mount.innerHTML = `
    <section class="section">
      <div class="wrap wrap--mid stack-5">

        <div>
          <h1 class="page-title">이용안내</h1>
          <p class="page-sub">제출 방법과 운영 설정을 한 곳에 모았습니다.</p>
        </div>

        <div class="card">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-2)">자주 묻는 질문</h2>
          <div id="faq">
            ${FAQ.map((item, i) => `
              <div class="expander" data-open="${i === 0}">
                <button class="expander__btn" type="button" aria-expanded="${i === 0}">
                  <span>${esc(item.q)}</span>
                  <svg class="expander__chev" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                </button>
                <div class="expander__body" style="height:${i === 0 ? 'auto' : '0'}">
                  <div class="expander__inner">${esc(item.a)}</div>
                </div>
              </div>`).join('')}
          </div>
        </div>

        <div class="card" id="admin">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">계정과 권한</h2>

          <h3 style="font-size:1.6rem;margin-bottom:8px">비밀번호</h3>
          <p style="color:var(--text-black-soft);line-height:1.8;margin-bottom:var(--space-4)">
            가입할 때 각자 정합니다. 서버가 <code>PBKDF2</code> 로 해시해서 보관하므로
            원문은 어디에도 남지 않고, 코드나 설정 파일에도 들어가지 않습니다.
            바꾸려면 <a href="#/account">내 계정</a> 에서 하시면 됩니다.
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px">관리자</h3>
          <p style="color:var(--text-black-soft);line-height:1.8;margin-bottom:var(--space-4)">
            정해진 이메일로 가입하면 자동으로 관리자가 됩니다. R2 모드에서는 Cloudflare 의
            <code>ADMIN_EMAILS</code> 환경변수로 지정하고, 설정하지 않으면 서버 기본값이 쓰입니다.
            이미 가입한 회원을 관리자로 올리는 것은 <a href="#/admin/members">회원 관리</a> 에서 됩니다.
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px">비밀번호를 잊은 회원</h3>
          <p style="color:var(--text-black-soft);line-height:1.8">
            메일을 보낼 수단이 없어 스스로 재설정할 수는 없습니다. 관리자가
            <a href="#/admin/members">회원 관리</a> 에서 <strong>비밀번호 초기화</strong> 를 누르면
            임시 비밀번호가 화면에 뜹니다. 그 값을 본인에게 직접 전달하세요.
          </p>

          <div class="notice notice--info" style="margin-top:var(--space-4)">
            <strong>어디까지 안전한가.</strong> 비밀번호 확인과 권한 검사는 모두 서버(Worker)에서
            일어나고, 세션은 자바스크립트로 읽을 수 없는 HttpOnly 쿠키로 오갑니다.
            제출물도 서버가 소유해서, 다른 회원의 제출물을 고치거나 지울 수 없습니다.
            다만 <strong>이메일 인증이 없어</strong> 오타가 난 주소로도 가입이 되고,
            서버 없는 시연 모드(브라우저 저장·GitHub)에서는 회원 기능이 흉내일 뿐입니다.
          </div>
        </div>

        <div class="card" id="storage">
          <h2 class="page-title" style="font-size:2rem;margin-bottom:var(--space-3)">저장소 설정</h2>
          <p style="color:var(--text-black-soft);margin-bottom:var(--space-3)">
            현재 모드: <strong>${esc(STORAGE_LABEL[mode])}</strong>
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px">① Cloudflare R2 <span class="badge badge--gold" style="font-size:1.1rem">권장</span></h3>
          <p style="color:var(--text-black-soft);line-height:1.8;margin-bottom:var(--space-4)">
            파일과 색인이 모두 R2 버킷에 저장됩니다. 브라우저는 R2 를 직접 만지지 않고
            같은 도메인의 <code>/api</code> 만 호출하며, 버킷 권한은 서버 바인딩으로만 존재합니다.
            그래서 교육생에게 나눠줄 토큰이 없고, 큰 파일도 그대로 올라갑니다.
            Cloudflare Pages 에 R2 버킷을 <code>BUCKET</code> 이름으로 바인딩하기만 하면 됩니다.
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px">② GitHub 저장소</h3>
          <p style="color:var(--text-black-soft);line-height:1.8;margin-bottom:var(--space-4)">
            레포의 <code>data/</code> 를 데이터베이스로, <code>uploads/</code> 를 파일함으로 씁니다.
            쓰기에 토큰이 필요하고, 교육생 제출까지 받으려면 <code>worker/</code> 의 프록시를
            함께 배포해야 합니다. 파일 크기 제약도 더 큽니다.
          </p>

          <h3 style="font-size:1.6rem;margin-bottom:8px">③ 브라우저 저장</h3>
          <p style="color:var(--text-black-soft);line-height:1.8">
            설정이 전혀 필요 없고 즉시 동작합니다. 대신 데이터가 <strong>그 브라우저에만</strong> 남습니다.
            화면을 확인할 때 쓰세요. 실제 제출을 받을 수는 없습니다.
          </p>
          <div class="notice notice--info" style="margin-top:var(--space-4)">
            자세한 배포 순서는 레포의 <code>docs/SETUP.md</code> 에 단계별로 적혀 있습니다.
          </div>
        </div>

      </div>
    </section>`;

  // 아코디언 — height 를 실측해 부드럽게 여닫습니다.
  mount.querySelectorAll('.expander').forEach((exp) => {
    const btn = exp.querySelector('.expander__btn');
    const body = exp.querySelector('.expander__body');
    const inner = exp.querySelector('.expander__inner');

    btn.addEventListener('click', () => {
      const open = exp.dataset.open === 'true';
      body.style.height = `${open ? inner.offsetHeight : 0}px`;
      requestAnimationFrame(() => {
        body.style.height = `${open ? 0 : inner.offsetHeight}px`;
        exp.dataset.open = String(!open);
        btn.setAttribute('aria-expanded', String(!open));
      });
    });

    body.addEventListener('transitionend', () => {
      if (exp.dataset.open === 'true') body.style.height = 'auto';
    });
  });
}
