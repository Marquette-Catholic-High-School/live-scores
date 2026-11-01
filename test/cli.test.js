import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { verifyPassword } from '../server/auth.js';
import { openDatabase } from '../server/db.js';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/cli.js');

describe('CLI', () => {
  let dir;
  let env;

  async function cli(...args) {
    try {
      const { stdout, stderr } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env });
      return { code: 0, stdout, stderr };
    } catch (err) {
      return { code: err.code, stdout: err.stdout, stderr: err.stderr };
    }
  }

  // Runs the CLI with `input` on stdin.
  function cliWithInput(input, ...args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  function readUser(username) {
    const db = openDatabase(path.join(dir, 'live.db'));
    try {
      return db.get('SELECT * FROM users WHERE username = ?', username);
    } finally {
      db.close();
    }
  }

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mchs-cli-test-'));
    env = { PATH: process.env.PATH, DATA_DIR: dir, LOG_LEVEL: 'error', APNS_TEAM_ID: '', APNS_KEY_ID: '', APNS_KEY_PATH: '' };
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('creates users with a given or generated password', async () => {
    const given = await cli('create-user', '--username', 'Admin', '--display-name', 'Site Admin', '--role', 'admin', '--password', 'given-password-1');
    assert.equal(given.code, 0, given.stderr);
    assert.match(given.stdout, /Created admin "admin"/);
    assert.equal(await verifyPassword('given-password-1', readUser('admin').password_hash), true);

    const generated = await cli('create-user', '--username', 'keeper', '--display-name', 'Coach', '--role', 'scorekeeper');
    assert.equal(generated.code, 0, generated.stderr);
    const password = /Generated password \(shown once\): (\S+)/.exec(generated.stdout)?.[1];
    assert.ok(password && password.length >= 20);
    assert.equal(await verifyPassword(password, readUser('keeper').password_hash), true);

    const duplicate = await cli('create-user', '--username', 'KEEPER', '--display-name', 'Again', '--role', 'scorekeeper', '--password', 'another-pass');
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /already exists/);
    const badRole = await cli('create-user', '--username', 'x123', '--display-name', 'X', '--role', 'owner', '--password', 'another-pass');
    assert.equal(badRole.code, 1);
    const shortPassword = await cli('create-user', '--username', 'x123', '--display-name', 'X', '--role', 'admin', '--password', 'short');
    assert.equal(shortPassword.code, 1);
    assert.match(shortPassword.stderr, /at least 8/);
  });

  it('lists, resets and deletes users', async () => {
    const list = await cli('list-users');
    assert.equal(list.code, 0);
    assert.match(list.stdout, /USERNAME/);
    assert.match(list.stdout, /admin\s+admin\s+active\s+Site Admin/);
    assert.match(list.stdout, /keeper\s+scorekeeper/);

    const reset = await cli('reset-password', '--username', 'keeper', '--password', 'brand-new-pass');
    assert.equal(reset.code, 0, reset.stderr);
    assert.equal(await verifyPassword('brand-new-pass', readUser('keeper').password_hash), true);

    const lastAdmin = await cli('delete-user', '--username', 'admin');
    assert.equal(lastAdmin.code, 1);
    assert.match(lastAdmin.stderr, /enabled admin/);
    const deleted = await cli('delete-user', '--username', 'keeper');
    assert.equal(deleted.code, 0);
    assert.equal(readUser('keeper'), undefined);
    assert.equal((await cli('delete-user', '--username', 'ghost')).code, 1);
  });

  it('reads the password from the first line of stdin with --password-stdin', async () => {
    const created = await cliWithInput(' spaced pass phrase \r\nsecond line\n', 'create-user', '--username', 'stdin-user', '--display-name', 'Stdin', '--role', 'scorekeeper', '--password-stdin');
    assert.equal(created.code, 0, created.stderr);
    assert.doesNotMatch(created.stdout, /Generated password/);
    assert.equal(await verifyPassword(' spaced pass phrase ', readUser('stdin-user').password_hash), true, 'only the trailing CRLF is stripped');

    const reset = await cliWithInput('no-newline-at-all', 'reset-password', '--username', 'stdin-user', '--password-stdin');
    assert.equal(reset.code, 0, reset.stderr);
    assert.equal(await verifyPassword('no-newline-at-all', readUser('stdin-user').password_hash), true);
    const lf = await cliWithInput('lf-only-pass\n', 'reset-password', '--username', 'stdin-user', '--password-stdin');
    assert.equal(lf.code, 0, lf.stderr);
    assert.equal(await verifyPassword('lf-only-pass', readUser('stdin-user').password_hash), true);

    for (const input of ['', '\n', '\r\n']) {
      const empty = await cliWithInput(input, 'reset-password', '--username', 'stdin-user', '--password-stdin');
      assert.equal(empty.code, 1, JSON.stringify(input));
      assert.match(empty.stderr, /no password on standard input/);
    }
    assert.equal(await verifyPassword('lf-only-pass', readUser('stdin-user').password_hash), true, 'unchanged after the rejected resets');
    const both = await cliWithInput('x-password\n', 'reset-password', '--username', 'stdin-user', '--password', 'y-password', '--password-stdin');
    assert.equal(both.code, 1);
    assert.match(both.stderr, /either --password or --password-stdin/);
    const short = await cliWithInput('short\n', 'create-user', '--username', 'stdin-short', '--display-name', 'S', '--role', 'admin', '--password-stdin');
    assert.equal(short.code, 1);
    assert.match(short.stderr, /at least 8/);
    assert.match((await cli('--help')).stdout, /--password-stdin/);
  });

  it('reports usage errors and missing APNs configuration', async () => {
    assert.equal((await cli()).code, 2);
    const unknown = await cli('frobnicate');
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown command/);
    const missing = await cli('create-user', '--username', 'abc');
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--display-name is required/);
    const apns = await cli('apns-check');
    assert.equal(apns.code, 1);
    assert.match(apns.stderr, /APNs is not configured/);
  });
});
