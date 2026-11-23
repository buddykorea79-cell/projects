/**
 * Hermes(텔레그램 알림 + 가입 승인/거절 버튼) 테스트.
 * 메모리 R2 스텁 위에서 실제 shared/r2api.js + shared/telegram.js 를 돌립니다.
 */
import { MockBucket, TEST_GOOGLE_ENV, mockGoogleLogin } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';

const ORIGIN = 'https://site.test';
const ADMIN = 'aireader@mois.go.kr';

const fails = [];
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

const bucket = new MockBucket();
const env = {
  BUCKET: bucket,
  ...TEST_GOOGLE_ENV,
  SIGNUP_POLICY: 'approval',
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CHAT_ID: '424242',
  TELEGRAM_WEBHOOK_SECRET: 'wh-secret',
};

let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && url.startsWith('https://api.telegram.org/')) {
    const method = url.split('/').pop();
    const payload = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, payload });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  return realFetch(url, init);
};

function client(useEnv = env) {
  const jar = new Map();
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, ...headers } };
    if (jar.size) init.headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const pending = [];
    const res = await handleApi(new Request(`${ORIGIN}/api${path}`, init), useEnv, {
      basePath: '/api',
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);

    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie')] : []);
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (!v || /Max-Age=0\b/i.test(sc)) jar.delete(k);
      else jar.set(k, v);
    }
    let data = null;
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('json')) data = await res.json().catch(() => null);
    return { status: res.status, data, res };
  };
  return call;
}

async function webhook(update, secret) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return handleApi(new Request(`${ORIGIN}/api/telegram/webhook`, {
    method: 'POST', headers, body: JSON.stringify(update),
  }), env, { basePath: '/api' });
}

const cbUpdate = (data, chatId, id = 'cb1') => ({
  callback_query: { id, data, message: { chat: { id: chatId }, message_id: 1, text: '승인 요청' } },
});

console.log('\n== 알림: 환경변수 없음 ==');

await t('텔레그램 환경변수가 없으면 로그인해도 호출하지 않음', async () => {
  const bareEnv = { BUCKET: bucket, ...TEST_GOOGLE_ENV, SIGNUP_POLICY: 'approval' };
  calls = [];
  await mockGoogleLogin(client(bareEnv), { email: ADMIN, name: '관리자', institution: '행정안전부' });
  eq(calls.length, 0, '호출 없음');
});

console.log('\n== 알림: 신규 승인 요청 + 웹훅 승인/거절 ==');

await t('미등록 Google 로그인 시도 시 승인/거절 버튼이 담긴 텔레그램 알림 전송', async () => {
  calls = [];
  const res = await mockGoogleLogin(client(), {
    email: 'student1@gmail.com', name: '김교육', completeProfile: false,
  });
  if (!res.callbackLocation.includes('error=pending')) throw new Error(res.callbackLocation);
  eq(calls.length, 1, '알림 1건');
  eq(calls[0].method, 'sendMessage', 'sendMessage');
  if (!calls[0].payload.text.includes('student1@gmail.com')) throw new Error('이메일 누락');
  const buttons = calls[0].payload.reply_markup?.inline_keyboard?.[0] || [];
  eq(buttons[0]?.callback_data, 'approve:student1@gmail.com', '승인 버튼');
  eq(buttons[1]?.callback_data, 'reject:student1@gmail.com', '거절 버튼');
});

await t('웹훅 시크릿이 틀리면 401 거부', async () => {
  eq((await webhook(cbUpdate('approve:student1@gmail.com', '424242'), 'wrong')).status, 401, 'wrong secret');
  eq((await webhook(cbUpdate('approve:student1@gmail.com', '424242'))).status, 401, 'no secret');
});

await t('허용되지 않은 채팅 ID 의 승인 버튼 클릭은 무시', async () => {
  calls = [];
  const res = await webhook(cbUpdate('approve:student1@gmail.com', '999999'), 'wh-secret');
  eq(res.status, 200, '200');
  const answer = calls.find((c) => c.method === 'answerCallbackQuery');
  if (!answer?.payload?.text?.includes('허용되지 않은')) throw new Error('거부 응답 없음');
});

await t('관리자 채팅에서 승인 버튼을 누르면 회원이 active 로 전환되고 로그인 가능', async () => {
  calls = [];
  const res = await webhook(cbUpdate('approve:student1@gmail.com', '424242'), 'wh-secret');
  eq(res.status, 200, '200');
  const edit = calls.find((c) => c.method === 'editMessageText');
  if (!edit?.payload?.text?.includes('승인 완료')) throw new Error('승인 완료 메시지 없음');

  const c = client();
  const loginRes = await mockGoogleLogin(c, {
    email: 'student1@gmail.com', name: '김교육', institution: '행정안전부',
  });
  eq(loginRes.profile.status, 200, '승인 후 로그인 성공');
});

await t('관리자 채팅에서 거절 버튼을 누르면 pending 요청이 삭제됨', async () => {
  await mockGoogleLogin(client(), { email: 'rejectme@gmail.com', name: '거절대상', completeProfile: false });
  calls = [];
  const res = await webhook(cbUpdate('reject:rejectme@gmail.com', '424242'), 'wh-secret');
  eq(res.status, 200, '200');
  const edit = calls.find((c) => c.method === 'editMessageText');
  if (!edit?.payload?.text?.includes('거절 완료')) throw new Error('거절 완료 메시지 없음');

  const admin = client();
  await mockGoogleLogin(admin, { email: ADMIN, completeProfile: false });
  const list = await admin('/auth/members');
  if (list.data.data.some((m) => m.email === 'rejectme@gmail.com')) {
    throw new Error('거절된 요청이 삭제되지 않음');
  }
});

console.log('\n================ 결과 ================');
if (fails.length) {
  console.log(`실패 ${fails.length}건:\n - ${fails.join('\n - ')}`);
  process.exit(1);
}
console.log('모든 검사 통과');
