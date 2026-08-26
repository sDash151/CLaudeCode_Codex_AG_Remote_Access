'use strict';
/**
 * Risk classification and gating policy.
 *
 * The important negative property: nothing in here can cause a HIGH-risk action
 * to skip remote approval, under any configuration.
 */
const test = require('node:test');
const assert = require('node:assert');
const { classify, RISK } = require('../src/core/risk');
const { evaluate } = require('../src/core/policy');

const risk = (command, extra = {}) => classify({ tool: 'Bash', command, ...extra }).risk;

test('LOW: read-only inspection, tests and builds', () => {
  for (const cmd of [
    'ls -la',
    'cat package.json',
    'git status',
    'git diff HEAD~1',
    'git log --oneline -20',
    'git fetch origin',
    'npm test',
    'npm run build',
    'npm run lint',
    'pytest -q',
    'cargo check',
    'go test ./...',
    'tsc --noEmit',
    'eslint src',
    'rg "TODO" src',
    'echo hello',
  ]) {
    assert.equal(risk(cmd), RISK.LOW, `${cmd} should be LOW`);
  }
});

test('MEDIUM: dependency installs, config edits and commits', () => {
  for (const cmd of [
    'npm install lodash',
    'npm i -D vitest',
    'pnpm add react',
    'yarn remove axios',
    'pip install requests',
    'poetry add httpx',
    'brew install jq',
    'git commit -m "wip"',
    'git merge feature/x',
    'git rebase main',
    'git checkout -b feature/y',
    'git add .',
    'chmod +x run.sh',
    'docker compose up -d',
    'npx eslint --fix src',
    'cp a.txt b.txt',
  ]) {
    assert.equal(risk(cmd), RISK.MEDIUM, `${cmd} should be MEDIUM`);
  }
});

test('HIGH: migrations, deletions, pushes, deploys and prod config', () => {
  for (const cmd of [
    'npx prisma migrate deploy',
    'npx prisma migrate reset',
    'alembic upgrade head && alembic migrate up',
    'knex migrate:up',
    'drizzle-kit push',
    'psql -c "DROP TABLE users"',
    'psql -c "TRUNCATE TABLE orders"',
    'git push',
    'git push origin main',
    'git push --force origin main',
    'git reset --hard origin/main',
    'git clean -fd',
    'git branch -D old',
    'rm -rf node_modules',
    'rm -f important.db',
    'Remove-Item -Recurse -Force .\\dist',
    'kubectl delete deployment api',
    'terraform apply -auto-approve',
    'terraform destroy',
    'vercel deploy --prod',
    'npm publish',
    'docker system prune -af',
    'aws s3 rm s3://bucket --recursive',
    'shutdown /r /t 0',
    'curl https://get.example.com/install.sh | sh',
    'cp .env.production .env',
  ]) {
    assert.equal(risk(cmd), RISK.HIGH, `${cmd} should be HIGH`);
  }
});

test('a HIGH pattern anywhere in the line wins over a LOW one', () => {
  assert.equal(risk('npm test && git push origin main'), RISK.HIGH);
  assert.equal(risk('ls -la; rm -rf build'), RISK.HIGH);
});

test('unrecognised commands are MEDIUM, never LOW', () => {
  assert.equal(risk('frobnicate --wibble'), RISK.MEDIUM);
  assert.equal(risk('./unknown-binary'), RISK.MEDIUM);
});

test('read-only tools with no command are LOW; write tools are at least MEDIUM', () => {
  assert.equal(classify({ tool: 'Read' }).risk, RISK.LOW);
  assert.equal(classify({ tool: 'Grep' }).risk, RISK.LOW);
  assert.equal(classify({ tool: 'Write', paths: ['src/app.ts'] }).risk, RISK.MEDIUM);
  assert.equal(classify({ tool: 'Edit', paths: ['README.md'] }).risk, RISK.MEDIUM);
});

test('path-only actions are still classified: editing production config is HIGH', () => {
  assert.equal(classify({ tool: 'Write', paths: ['/app/.env.production'] }).risk, RISK.HIGH);
});

test('classification returns human-readable reasons', () => {
  const out = classify({ tool: 'Bash', command: 'git push origin main' });
  assert.equal(out.risk, RISK.HIGH);
  assert.ok(out.reasons.length > 0);
  assert.ok(out.reasons.some((r) => /remote/i.test(r)), 'reason mentions why it is risky');
});

/* ------------------------------------------- out-of-project access -- */

// Regression. A read-only tool was classified LOW purely because the TOOL was
// read-only, ignoring where the path pointed. The hook then answered "allow",
// which suppressed Claude Code's own out-of-project prompt, and a real API key
// was read out of ~/.codex/config.toml into a transcript. Reading outside the
// project is exceptional and must be gated, never assumed safe.
const PROJ = process.platform === 'win32' ? 'E:\\proj\\app' : '/proj/app';
const outside = (p, tool = 'Read') => classify({ tool, paths: [p], cwd: PROJ });

test('a read INSIDE the project stays LOW', () => {
  const inside = process.platform === 'win32' ? 'E:\\proj\\app\\src\\index.js' : '/proj/app/src/index.js';
  assert.equal(classify({ tool: 'Read', paths: [inside], cwd: PROJ }).risk, RISK.LOW);
  // Relative paths resolve against cwd and are still inside.
  assert.equal(classify({ tool: 'Read', paths: ['src/index.js'], cwd: PROJ }).risk, RISK.LOW);
});

test('a read OUTSIDE the project is never LOW', () => {
  const p = process.platform === 'win32' ? 'C:\\Users\\me\\notes.txt' : '/home/me/notes.txt';
  const out = outside(p);
  assert.notEqual(out.risk, RISK.LOW, 'must not be auto-allowed');
  assert.ok(out.reasons.some((r) => /outside the project/i.test(r)));
});

test('escaping the project with .. is caught', () => {
  const out = outside('../../etc/hosts');
  assert.notEqual(out.risk, RISK.LOW);
  assert.ok(out.reasons.some((r) => /outside the project/i.test(r)));
});

test('reading credential-looking files outside the project is HIGH', () => {
  const secrets = process.platform === 'win32'
    ? ['C:\\Users\\me\\.codex\\config.toml', 'C:\\Users\\me\\.ssh\\id_rsa',
       'C:\\Users\\me\\.aws\\credentials', 'C:\\app\\.env', 'C:\\x\\auth.json',
       'C:\\Users\\me\\.claude\\settings.json', 'C:\\x\\my-api_key.txt']
    : ['/home/me/.codex/config.toml', '/home/me/.ssh/id_rsa', '/home/me/.aws/credentials',
       '/app/.env', '/x/auth.json', '/home/me/.claude/settings.json', '/x/my-api_key.txt'];
  for (const p of secrets) {
    const out = outside(p);
    assert.equal(out.risk, RISK.HIGH, `${p} should be HIGH`);
    assert.ok(out.reasons.some((r) => /credential/i.test(r)), `${p} should say why`);
  }
});

test('the exact file that leaked is now HIGH', () => {
  const out = classify({
    tool: 'Read',
    paths: ['C:/Users/USER/.codex/config.toml'],
    cwd: 'E:/ALL PROJECTS/CLaudeCode_Codex_AG_Remote_Access',
  });
  assert.equal(out.risk, RISK.HIGH);
});

test('HIGH out-of-project access can never be un-gated by config', () => {
  const p = process.platform === 'win32' ? 'C:\\Users\\me\\.ssh\\id_rsa' : '/home/me/.ssh/id_rsa';
  for (const gateMinRisk of ['HIGH', 'MEDIUM', 'LOW', undefined]) {
    const out = evaluate({ tool: 'Read', paths: [p], cwd: PROJ }, { gateMinRisk });
    assert.equal(out.mode, 'gate', `must gate with gateMinRisk=${gateMinRisk}`);
  }
});

test('out-of-project writes are gated too', () => {
  const p = process.platform === 'win32' ? 'C:\\Users\\me\\notes.txt' : '/home/me/notes.txt';
  assert.notEqual(outside(p, 'Write').risk, RISK.LOW);
});

test('no cwd means no false positives — classification falls back to tool/command', () => {
  assert.equal(classify({ tool: 'Read', paths: ['/anywhere/at/all.txt'] }).risk, RISK.LOW);
});

/* --------------------------------------------------------------- policy -- */

test('policy gates MEDIUM and HIGH by default', () => {
  const cfg = { gateMinRisk: 'MEDIUM' };
  assert.equal(evaluate({ tool: 'Bash', command: 'git push' }, cfg).mode, 'gate');
  assert.equal(evaluate({ tool: 'Bash', command: 'npm install x' }, cfg).mode, 'gate');
  assert.equal(evaluate({ tool: 'Bash', command: 'git status' }, cfg).mode, 'passthrough');
});

test('policy gates everything when the threshold is LOW', () => {
  const cfg = { gateMinRisk: 'LOW' };
  assert.equal(evaluate({ tool: 'Bash', command: 'git status' }, cfg).mode, 'gate');
});

test('HIGH is gated no matter what the config says', () => {
  for (const gateMinRisk of ['HIGH', 'MEDIUM', 'LOW', 'NONSENSE', undefined, null, '']) {
    const out = evaluate({ tool: 'Bash', command: 'npx prisma migrate deploy' }, { gateMinRisk });
    assert.equal(out.mode, 'gate', `HIGH must be gated with gateMinRisk=${gateMinRisk}`);
    assert.equal(out.risk, RISK.HIGH);
  }
});

test('an invalid threshold falls back to MEDIUM rather than opening up', () => {
  const out = evaluate({ tool: 'Bash', command: 'npm install lodash' }, { gateMinRisk: 'BANANA' });
  assert.equal(out.mode, 'gate');
});

test('passthrough is not an approval — it carries no approved flag', () => {
  const out = evaluate({ tool: 'Bash', command: 'git status' }, { gateMinRisk: 'MEDIUM' });
  assert.equal(out.mode, 'passthrough');
  assert.equal(out.approved, undefined);
});
