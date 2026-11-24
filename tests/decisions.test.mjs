import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDecisions, command } from '../skills/triage/scripts/lib/decisions.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'triage', 'scripts');

test('validation keeps good decisions and rejects bad ones', () => {
  const { value, errors } = validateDecisions({
    decisions: {
      i1: { action: 'close', reason: 'completed', text: 'Fixed in 1.2' },
      i2: { action: 'duplicate', of: 1 },
      i3: { action: 'merge' }, // PR-only action on an issue
      p4: { action: 'merge', method: 'rebase' },
      i5: { action: 'duplicate', of: 5 }, // duplicate of itself
      i6: { action: 'comment', text: '', note: 'draft something polite' },
      i7: { action: 'comment', text: '' },
      'x9; rm -rf': { action: 'close' },
      p8: { action: 'label', add: ['bug', ''], remove: [] },
    },
  }, 'o/r');
  assert.deepEqual(Object.keys(value.decisions).sort(), ['i1', 'i2', 'i6', 'p4', 'p8']);
  assert.equal(value.decisions.i6.needsDraft, true);
  assert.equal(value.decisions.p4.method, 'rebase');
  assert.deepEqual(value.decisions.p8.add, ['bug']);
  assert.equal(errors.length, 4);
});

test('commands are argv arrays; hostile text stays one argument', () => {
  const evil = "x'; rm -rf / #";
  const argv = command({ kind: 'issue', number: 7, action: 'close', reason: 'not planned', text: evil }, 'o/r');
  assert.deepEqual(argv, ['issue', 'close', '7', '-R', 'o/r', '--reason', 'not planned', '--comment', evil]);
  assert.deepEqual(command({ kind: 'issue', number: 7, action: 'duplicate', of: 3 }, 'o/r').slice(-1), ['Duplicate of #3']);
  assert.equal(command({ kind: 'issue', number: 7, action: 'keep' }, 'o/r'), null);
  assert.equal(command({ kind: 'issue', number: 7, action: 'comment', text: '', needsDraft: true }, 'o/r'), undefined);
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-test-'));
  const dir = path.join(base, 'sift', 'o__r');
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(dir, '.cache', 'meta.json'), JSON.stringify({ repo: 'o/r' }));
  fs.writeFileSync(path.join(dir, '.cache', 'items.json'), JSON.stringify({ i1: { key: 'i1', title: 'One', updatedAt: '2020-01-01T00:00:00Z' }, i2: { key: 'i2', title: 'Two', updatedAt: '2020-01-01T00:00:00Z' } }));
  return { base, dir };
}

function req(port, method, p, { host = `127.0.0.1:${port}`, origin, body, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, ...(origin ? { origin } : {}), ...(body ? { 'content-type': type } : {}) } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.end(body); else r.end();
  });
}

test('server: saves decisions, refuses other origins, hosts and paths', async () => {
  const { base, dir } = fixture();
  const port = 4600 + Math.floor(Math.random() * 300);
  const srv = spawn(process.execPath, [path.join(scripts, 'serve.mjs'), '--base', base, '--port', String(port)], { stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    const actual = JSON.parse(fs.readFileSync(path.join(base, 'sift', '.server.json'), 'utf8')).port;
    const body = JSON.stringify({ decisions: { i1: { action: 'close' } } });
    assert.equal((await req(actual, 'PUT', '/api/decisions/o__r', { body, origin: 'https://evil.example' })).status, 403);
    assert.equal((await req(actual, 'PUT', '/api/decisions/o__r', { body, host: 'evil.example' })).status, 403);
    assert.equal((await req(actual, 'PUT', '/api/decisions/o__r', { body, type: 'text/plain' })).status, 415);
    assert.equal((await req(actual, 'GET', '/o__r/.cache/meta.json')).status, 404);
    assert.equal((await req(actual, 'GET', '/o__r/..%2F..%2Fetc%2Fpasswd')).status, 404);
    assert.equal((await req(actual, 'GET', '/o__r/')).status, 200);
    const ok = await req(actual, 'PUT', '/api/decisions/o__r', { body, origin: `http://127.0.0.1:${actual}` });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8')).decisions.i1.action, 'close');
  } finally {
    srv.kill();
  }
});

test('apply runs only confirmed keys through gh, records results, never sends an undrafted comment', () => {
  const { base, dir } = fixture();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sift-gh-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho done\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify({ decisions: {
    i1: { action: 'close', kind: 'issue', number: 1, reason: 'not planned', text: 'bye', status: 'pending' },
    i2: { action: 'comment', kind: 'issue', number: 2, text: '', needsDraft: true, note: 'draft it', status: 'pending' },
  } }));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const out = execFileSync(process.execPath, [path.join(scripts, 'apply.mjs'), 'o/r', '--base', base, '--keys', 'i1,i2'], { env, encoding: 'utf8' });
  assert.match(out, /SKIP\s+i2/);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^issue close 1 -R o\/r --reason not planned --comment bye$/);
  const d = JSON.parse(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8')).decisions;
  assert.equal(d.i1.status, 'done');
  assert.equal(d.i2.status, 'pending');
});
