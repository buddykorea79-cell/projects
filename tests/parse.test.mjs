import { parse } from 'acorn';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, relative } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['assets/js', 'worker', 'shared', 'functions'].flatMap((folder) => {
  const dir = resolve(root, folder);
  return readdirSync(dir, { recursive: true })
    .filter((file) => file.endsWith('.js'))
    .map((file) => resolve(dir, file));
});
let bad = 0;
for (const f of files) {
  try {
    parse(readFileSync(f, 'utf8'), { ecmaVersion: 2023, sourceType: 'module' });
    console.log(`  ok   ${relative(root, f)}`);
  } catch (e) {
    bad++;
    console.log(`  FAIL ${relative(root, f)} — ${e.message}`);
  }
}
// 파서가 실제로 오류를 잡는지 확인
try { parse('export const a = ;', { ecmaVersion: 2023, sourceType: 'module' }); console.log('\n파서 신뢰 불가 — 잘못된 코드를 통과시킴'); process.exit(1); }
catch { console.log('\n파서 정상 (의도적 오류를 잡음)'); }
process.exit(bad ? 1 : 0);
