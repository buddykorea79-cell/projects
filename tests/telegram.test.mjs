/**
 * Hermes(텔레그램 알림 + 재설정 버튼) · 재설정 링크 메일 발송 테스트.
 * 메모리 R2 스텁 위에서 실제 shared/r2api.js + shared/telegram.js + shared/email.js
 * 를 돌리고, global.fetch 를 목으로 바꿔 텔레그램·메일 웹훅 호출을 가로챕니다.
 */
import { MockBucket } from './mock-r2.mjs';
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
  PBKDF2_ITERATIONS: 1000,   // 테스트 속도를 위해 최소치
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CHAT_ID: '424242',
  TELEGRAM_WEBHOOK_SECRET: 'wh-secret',
  EMAIL_WEBHOOK_URL: 'https://script.google.com/macros/s/test-app/exec',
  EMAIL_WEBHOOK_SECRET: 'mail-secret',
};

/** 텔레그램·메일 웹훅으로 나가는 호출만 가로채고, 나머지는 실제 fetch 로 흘려보냅니다. */
let calls = [];
let mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (typeof url === 'string' && url.startsWith('https://api.telegram.org/')) {
    const method = url.split('/').pop();
    const payload = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, payload });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  if (typeof url === 'string' && url.startsWith('https://script.google.com/')) {
    mails.push(init?.body ? JSON.parse(init.body) : {});
    return new Response('ok', { status: 200 });
  }
  return realFetch(url, init);
};

/** 브라우저처럼 쿠키를 들고 다니고, waitUntil 로 넘어온 알림 전송을 매 호출마다 기다립니다. */
function client(useEnv = env) {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, ...headers } };
    if (cookie) init.headers.Cookie = cookie;
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

    const set = res.headers.get('Set-Cookie');
    if (set) {
      const pair = set.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    let data = null;
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('json')) data = await res.json().catch(() => null);
    return { status: res.status, data, res };
  };
  return call;
}

const signup = (c, email, extra = {}) => c('/auth/signup', {
  method: 'POST',
  body: {
    email, password: 'hunter2!hunter2', name: '홍길동', institution: '한국디자인진흥원', ...extra,
  },
});

/** 텔레그램 서버가 직접 부르는 웹훅 호출 — 로그인 세션도 Origin 도 없습니다. */
async function webhook(update, secret) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return handleApi(new Request(`${ORIGIN}/api/telegram/webhook`, {
    method: 'POST', headers, body: JSON.stringify(update),
  }), env, { basePath: '/api' });
}

const resetCallback = (data, chatId, id = 'cb') => ({
  callback_query: { id, data, message: { chat: { id: chatId }, message_id: 1, text: '요청 알림' } },
});

/* ============================================================== 알림 == */

console.log('\n== 알림: 환경변수 없음 ==');

await t('환경변수가 없으면 가입해도 텔레그램을 호출하지 않음', async () => {
  const bareEnv = { BUCKET: bucket, PBKDF2_ITERATIONS: 1000 };
  calls = [];
  mails = [];
  const r = await signup(client(bareEnv), 'noenv@example.com');
  eq(r.status, 200, 'status');
  eq(calls.length, 0, 'calls');
  const forgot = await client(bareEnv)('/auth/forgot', { method: 'POST', body: { email: 'noenv@example.com' } });
  eq(forgot.status, 200, 'forgot status');
  eq(mails.length, 0, '메일 웹훅 미설정이면 발송 없음');
});

console.log('\n== 알림: 가입 ==');

await t('가입하면 sendMessage 로 이름·이메일이 담긴 알림', async () => {
  calls = [];
  const r = await signup(client(), 'bob@example.com', { name: '밥', institution: '테스트기관' });
  eq(r.status, 200, 'status');
  eq(calls.length, 1, 'calls');
  eq(calls[0].method, 'sendMessage', 'method');
  eq(calls[0].payload.chat_id, env.TELEGRAM_CHAT_ID, 'chat_id');
  if (!calls[0].payload.text.includes('밥')) throw new Error('이름 누락');
  if (!calls[0].payload.text.includes('bob@example.com')) throw new Error('이메일 누락');
});

console.log('\n== 알림: 과제 제출 ==');

const admin = client();
await t('관리자로 프로젝트 개설', async () => {
  await signup(admin, ADMIN, { name: '관리자', institution: '운영기관' });
  const got = await admin('/data/projects');
  const put = await admin('/data/projects', {
    method: 'PUT',
    body: { etag: got.data.etag, data: [{ id: 'p1', title: '1차 과제', status: 'open', visibility: 'public' }] },
  });
  eq(put.status, 200, 'put status');
});

await t('제출하면 sendMessage 로 프로젝트 제목·작성자가 담긴 알림', async () => {
  const carol = client();
  await signup(carol, 'carol@example.com', { name: '캐롤', institution: '캐롤기관' });
  calls = [];
  const r = await carol('/submissions', {
    method: 'POST', body: { projectId: 'p1', title: '제출합니다', body: '내용입니다' },
  });
  eq(r.status, 200, 'status');
  eq(calls.length, 1, 'calls');
  if (!calls[0].payload.text.includes('1차 과제')) throw new Error('프로젝트 제목 누락');
  if (!calls[0].payload.text.includes('캐롤')) throw new Error('작성자 누락');
});

console.log('\n== 알림: 비밀번호 재설정 요청 ==');

await t('회원 가입: dave', async () => {
  const dave = client();
  const r = await signup(dave, 'dave@example.com', { name: '데이브', institution: '데이브기관' });
  eq(r.status, 200, 'status');
});

await t('재설정 요청하면 1회용 링크와 버튼이 달린 알림이 감', async () => {
  calls = [];
  mails = [];
  const r = await client()('/auth/forgot', { method: 'POST', body: { email: 'dave@example.com' } });
  eq(r.status, 200, 'status');
  eq(calls.length, 1, 'calls');
  eq(calls[0].method, 'sendMessage', 'method');
  const kb = calls[0].payload.reply_markup?.inline_keyboard;
  if (!kb || kb[0][0].callback_data !== 'reset:dave@example.com') throw new Error('버튼 callback_data 오류');
  if (!calls[0].payload.text.includes(`${ORIGIN}/#/reset?token=`)) throw new Error('재설정 링크 누락');
});

await t('재설정 요청하면 신청자 이메일로도 같은 링크가 발송됨', async () => {
  eq(mails.length, 1, 'mails');
  eq(mails[0].to, 'dave@example.com', '수신자');
  eq(mails[0].secret, 'mail-secret', '웹훅 시크릿');
  const link = calls[0].payload.text.match(/https?:\S+#\/reset\?token=[A-Za-z0-9_-]+/)?.[0];
  if (!link || !mails[0].text.includes(link)) throw new Error('메일과 텔레그램의 링크가 다름');
  if (!mails[0].subject) throw new Error('제목 없음');
});

await t('쿨다운 안에 재요청하면 알림·메일이 다시 가지 않음', async () => {
  calls = [];
  mails = [];
  const r = await client()('/auth/forgot', { method: 'POST', body: { email: 'dave@example.com' } });
  eq(r.status, 200, 'status');
  eq(calls.length, 0, 'calls');
  eq(mails.length, 0, 'mails');
});

await t('가입하지 않은 이메일은 알림·메일 없음 (계정 존재를 흘리지 않음)', async () => {
  calls = [];
  mails = [];
  const r = await client()('/auth/forgot', { method: 'POST', body: { email: 'nobody@example.com' } });
  eq(r.status, 200, 'status');
  eq(calls.length, 0, 'calls');
  eq(mails.length, 0, 'mails');
});

/* ================================================================ 웹훅 == */

console.log('\n== 웹훅: 시크릿 검증 ==');

await t('시크릿 헤더가 없으면 401', async () => {
  const res = await webhook(resetCallback('reset:dave@example.com', 424242), undefined);
  eq(res.status, 401, 'status');
});

await t('시크릿 헤더가 틀리면 401', async () => {
  const res = await webhook(resetCallback('reset:dave@example.com', 424242), 'wrong-secret');
  eq(res.status, 401, 'status');
});

console.log('\n== 웹훅: 재설정 버튼 ==');

let issuedTemp = null;

await t('허용된 채팅의 콜백 → 임시 비밀번호 발급 + 메시지 수정', async () => {
  calls = [];
  const res = await webhook(resetCallback('reset:dave@example.com', 424242, 'cb-1'), env.TELEGRAM_WEBHOOK_SECRET);
  eq(res.status, 200, 'status');

  const ans = calls.find((c) => c.method === 'answerCallbackQuery');
  const edit = calls.find((c) => c.method === 'editMessageText');
  if (!ans) throw new Error('answerCallbackQuery 안 옴');
  if (!edit) throw new Error('editMessageText 안 옴');
  if (edit.payload.reply_markup?.inline_keyboard?.length !== 0) throw new Error('버튼이 제거되지 않음');

  const m = edit.payload.text.match(/임시 비밀번호: <code>([^<]+)<\/code>/);
  if (!m) throw new Error('임시 비밀번호가 메시지에 없음');
  issuedTemp = m[1];
});

await t('발급된 임시 비밀번호로 로그인 가능', async () => {
  const r = await client()('/auth/login', { method: 'POST', body: { email: 'dave@example.com', password: issuedTemp } });
  eq(r.status, 200, 'status');
});

await t('회원 가입: eve (거부 케이스용)', async () => {
  const r = await signup(client(), 'eve@example.com', { name: '이브', institution: '기관' });
  eq(r.status, 200, 'status');
});

await t('허용되지 않은 채팅에서 온 콜백은 거부되고 비밀번호도 안 바뀜', async () => {
  calls = [];
  const res = await webhook(resetCallback('reset:eve@example.com', 999999, 'cb-2'), env.TELEGRAM_WEBHOOK_SECRET);
  eq(res.status, 200, 'status');   // 텔레그램에는 처리 못해도 항상 200

  const ans = calls.find((c) => c.method === 'answerCallbackQuery');
  if (!ans || !ans.payload.show_alert) throw new Error('거부 알림이 없음');
  if (calls.some((c) => c.method === 'editMessageText')) throw new Error('거부됐는데 메시지를 수정함');

  const r = await client()('/auth/login', { method: 'POST', body: { email: 'eve@example.com', password: 'hunter2!hunter2' } });
  eq(r.status, 200, 'status');   // 원래 비밀번호가 그대로 살아있어야 함
});

await t('존재하지 않는 회원에 대한 콜백은 not-found 알림', async () => {
  calls = [];
  const res = await webhook(resetCallback('reset:ghost@example.com', 424242, 'cb-3'), env.TELEGRAM_WEBHOOK_SECRET);
  eq(res.status, 200, 'status');
  const ans = calls.find((c) => c.method === 'answerCallbackQuery');
  if (!ans || !ans.payload.show_alert) throw new Error('not-found 알림이 없음');
});

/* ======================================================== 재설정 링크 == */

console.log('\n== 재설정 링크 (신청자가 새 비밀번호를 직접 설정) ==');

/** 재설정 요청을 보내고, 텔레그램 알림 메시지에서 링크 토큰을 뽑아 옵니다. */
async function requestToken(email) {
  calls = [];
  await client()('/auth/forgot', { method: 'POST', body: { email } });
  const text = calls.find((c) => c.method === 'sendMessage')?.payload.text || '';
  const m = text.match(/#\/reset\?token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('알림에서 토큰을 찾지 못함');
  return m[1];
}

const confirmReset = (token, password) => client()('/auth/reset/confirm', {
  method: 'POST', body: { token, password },
});

let frankToken = null;

await t('회원 가입: frank + 재설정 링크 발급', async () => {
  const r = await signup(client(), 'frank@example.com', { name: '프랭크', institution: '기관' });
  eq(r.status, 200, 'signup status');
  frankToken = await requestToken('frank@example.com');
});

await t('정책 미달 비밀번호(특수문자 없음)는 400', async () => {
  const r = await confirmReset(frankToken, 'weakpass12');
  eq(r.status, 400, 'status');
});

await t('링크로 새 비밀번호 설정 → 새 비밀번호만 로그인 가능', async () => {
  const r = await confirmReset(frankToken, 'newpass12!');
  eq(r.status, 200, 'status');
  const good = await client()('/auth/login', { method: 'POST', body: { email: 'frank@example.com', password: 'newpass12!' } });
  eq(good.status, 200, '새 비밀번호 로그인');
  const old = await client()('/auth/login', { method: 'POST', body: { email: 'frank@example.com', password: 'hunter2!hunter2' } });
  eq(old.status, 401, '옛 비밀번호는 막힘');
});

await t('같은 토큰 재사용은 거부 (1회용)', async () => {
  const r = await confirmReset(frankToken, 'another12!');
  eq(r.status, 400, 'status');
});

await t('엉터리 토큰은 거부', async () => {
  const r = await confirmReset('bogus-token', 'another12!');
  eq(r.status, 400, 'status');
});

await t('만료된 토큰은 거부되고 원래 비밀번호가 유지됨', async () => {
  await signup(client(), 'grace@example.com', { name: '그레이스', institution: '기관' });
  const token = await requestToken('grace@example.com');

  // 명부를 직접 만져 유효 시간을 과거로 돌립니다.
  const obj = await bucket.get('data/members.json');
  const list = JSON.parse(await obj.text());
  list.find((m) => m.email === 'grace@example.com').resetTokenExpiresAt = Date.now() - 1000;
  await bucket.put('data/members.json', JSON.stringify(list));

  const r = await confirmReset(token, 'expired12!');
  eq(r.status, 400, 'status');
  const login = await client()('/auth/login', { method: 'POST', body: { email: 'grace@example.com', password: 'hunter2!hunter2' } });
  eq(login.status, 200, '원래 비밀번호 유지');
});

await t('임시 비밀번호를 발급하면 나가 있던 링크도 무효', async () => {
  await signup(client(), 'henry@example.com', { name: '헨리', institution: '기관' });
  const token = await requestToken('henry@example.com');
  const res = await webhook(resetCallback('reset:henry@example.com', 424242, 'cb-4'), env.TELEGRAM_WEBHOOK_SECRET);
  eq(res.status, 200, 'webhook status');
  const r = await confirmReset(token, 'nolonger12!');
  eq(r.status, 400, '링크가 무효화됨');
});

globalThis.fetch = realFetch;

console.log('\n================ 결과 ================');
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
console.log('모든 검사 통과');
