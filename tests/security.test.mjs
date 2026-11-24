// Invariants that keep the published plugin safe to install. A change that breaks one fails CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.git' || e.name === 'node_modules' || e.name === 'sift' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(root).map((f) => path.relative(root, f));
const code = files.filter((f) => /\.(m?js|html)$/.test(f) && !f.startsWith('tests/'));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the plugin ships no hooks, MCP servers, agents or binaries that run on their own', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  for (const k of ['hooks', 'mcpServers', 'lspServers', 'commands', 'agents', 'outputStyles']) assert.equal(manifest[k], undefined, `plugin.json must not declare ${k}`);
  for (const f of files) {
    assert.ok(!/^(hooks|\.mcp\.json|agents|commands|bin)(\/|$)/.test(f), `unexpected ${f}`);
    assert.ok(!/\.(exe|dll|so|dylib|node|wasm|sh|bat|ps1)$/.test(f), `unexpected executable ${f}`);
  }
});

test('no dependencies', () => {
  const p = JSON.parse(read('package.json'));
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.ok(!p[k] || !Object.keys(p[k]).length, k);
  assert.ok(!p.scripts || Object.keys(p.scripts).every((k) => k === 'test'), 'only a test script; no install hooks');
});

test('scripts never use a shell, eval, or dynamic code', () => {
  for (const f of code) {
    const s = read(f);
    assert.doesNotMatch(s, /\beval\s*\(|new Function\s*\(|shell\s*:\s*true|\bexecSync\s*\(|\bexec\s*\(\s*[`'"]|child_process['"]\)\.exec\b|import\(\s*[^'"\s]/, f);
    assert.doesNotMatch(s, /\bvm\.(run|compile)|require\(\s*[^'"\s)]/, f);
  }
});

test('the only outside program is gh, and only apply.mjs can run a GitHub write', () => {
  for (const f of code.filter((f) => f.endsWith('.mjs'))) {
    const s = read(f);
    for (const m of s.matchAll(/(?<![.\w])(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?)\(\s*([^,)]+)/g)) {
      const prog = m[1].trim();
      // gh, node itself, and (in open.mjs only) the OS "open this URL" command.
      assert.ok(/^('gh'|process\.execPath)$/.test(prog) || (f.endsWith('open.mjs') && prog === 'cmd'), `${f} runs ${prog}`);
    }
    if (!f.endsWith('apply.mjs') && !f.endsWith('lib/gh.mjs')) assert.doesNotMatch(s, /execFile(Sync)?\(\s*'gh'/, `${f} must not run gh`);
  }
  // gh.mjs only ever sends GraphQL queries, never mutations.
  assert.doesNotMatch(read('skills/triage/scripts/lib/gh.mjs'), /\bmutation\b/);
  // Network access: only the local server and gh. No fetch() to anywhere else.
  for (const f of code) for (const m of read(f).matchAll(/fetch\(\s*([^,)]+)/g)) assert.match(m[1], /127\.0\.0\.1|apiUrl/, `${f} fetches ${m[1]}`);
});

test('skills never pre-approve GitHub writes', () => {
  for (const f of files.filter((f) => f.endsWith('SKILL.md'))) {
    const front = read(f).split('---')[1] || '';
    assert.doesNotMatch(front, /apply\.mjs|Bash\(gh\b|Bash\(\*|Bash\(node \*|Bash\(curl|Write|Edit/, `${f} allowed-tools`);
  }
});

test('the inbox never parses text as HTML and blocks outside requests', () => {
  const v = read('skills/triage/assets/viewer.html');
  assert.doesNotMatch(v, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc|javascript:/);
  assert.doesNotMatch(v, /h\(\s*'(img|iframe|script|object|embed|link|meta|style|form|base)'/);
  const csp = v.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  for (const d of ["default-src 'none'", 'img-src data:', "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"]) assert.ok(csp.includes(d), d);
});
