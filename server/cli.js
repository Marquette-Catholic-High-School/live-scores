// Administration CLI. Reads the same configuration as the server, e.g.
//   sudo -u mchslive node --env-file=/etc/mchs-live/mchs-live.env server/cli.js list-users

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ApnsClient } from './apns.js';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { HttpError } from './errors.js';
import { createLogger } from './log.js';
import { ROLES, UserService } from './users.js';

const USAGE = `Usage: node server/cli.js <command> [options]

Commands:
  create-user --username <name> --display-name <name> --role admin|scorekeeper [--password <password> | --password-stdin]
  reset-password --username <name> [--password <password> | --password-stdin]
  list-users
  delete-user --username <name>
  apns-check

--password-stdin reads the password from the first line of standard input,
which keeps it out of the process list and shell history, e.g.
  printf '%s\\n' "$PASSWORD" | node server/cli.js reset-password --username admin --password-stdin
With neither option you are prompted for it (on a terminal); without a
terminal a strong random password is generated and printed once.
Resetting a password signs that user out everywhere.
`;

class CliError extends Error {}

const OPTIONS = {
  username: { type: 'string' },
  'display-name': { type: 'string' },
  role: { type: 'string' },
  password: { type: 'string' },
  'password-stdin': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u0003' || (char === '\u0004' && value === '')) {
          cleanup();
          reject(new CliError('Canceled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    }
    stdin.on('data', onData);
  });
}

// The first line of stdin, without its trailing \n or \r\n (nothing else is
// trimmed: spaces may be part of a password).
async function readPasswordFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    if (chunk.includes(0x0a)) break;
  }
  let line = Buffer.concat(chunks).toString('utf8');
  const newline = line.indexOf('\n');
  if (newline !== -1) {
    line = line.slice(0, newline);
    if (line.endsWith('\r')) line = line.slice(0, -1);
  }
  if (line === '') throw new CliError('--password-stdin: no password on standard input.');
  return line;
}

async function resolvePassword(values) {
  const given = values.password;
  if (values['password-stdin']) {
    if (given !== undefined) throw new CliError('Use either --password or --password-stdin, not both.');
    return { password: await readPasswordFromStdin(), generated: false };
  }
  if (given !== undefined) return { password: given, generated: false };
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const password = await promptHidden('Password: ');
    const again = await promptHidden('Repeat password: ');
    if (password !== again) throw new CliError('Passwords do not match.');
    return { password, generated: false };
  }
  return { password: randomBytes(18).toString('base64url'), generated: true };
}

function required(values, name) {
  const value = values[name];
  if (value === undefined || value === '') throw new CliError(`--${name} is required.\n\n${USAGE}`);
  return value;
}

function findUser(users, username) {
  const user = users.getByUsername(username);
  if (!user) throw new CliError(`No user named "${username}".`);
  return user;
}

function printTable(rows, columns) {
  const widths = columns.map(([key, title]) => Math.max(title.length, ...rows.map((row) => String(row[key]).length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  console.log(line(columns.map(([, title]) => title)));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(columns.map(([key]) => row[key])));
}

async function run(command, values, config) {
  if (command === 'apns-check') {
    const apns = new ApnsClient({
      teamId: config.apns.teamId,
      keyId: config.apns.keyId,
      keyPath: config.apns.keyPath,
      bundleId: config.apns.bundleId,
      environments: config.apns.environments,
      log: createLogger({ level: 'error' }),
    });
    try {
      if (!apns.configured) throw new CliError(`APNs is not configured: ${apns.error}`);
      console.log(`Checking APNs for ${config.apns.bundleId} (team ${config.apns.teamId}, key ${config.apns.keyId})…`);
      const results = await apns.check(config.apns.channelStoragePolicy);
      let failures = 0;
      for (const [environment, result] of Object.entries(results)) {
        if (result.ok) console.log(`  ${environment}: OK (created and deleted test channel ${result.channelId})`);
        else {
          failures += 1;
          console.log(`  ${environment}: FAILED — ${result.error}`);
        }
      }
      return failures === 0 ? 0 : 1;
    } finally {
      apns.close();
    }
  }

  const db = openDatabase(config.dbPath);
  const users = new UserService({ db });
  try {
    switch (command) {
      case 'create-user': {
        const username = required(values, 'username');
        const displayName = required(values, 'display-name');
        const role = required(values, 'role');
        if (!ROLES.includes(role)) throw new CliError(`--role must be one of: ${ROLES.join(', ')}.`);
        if (users.getByUsername(username)) throw new CliError(`A user named "${username}" already exists.`);
        const { password, generated } = await resolvePassword(values);
        const user = await users.create({ username, displayName, password, role });
        console.log(`Created ${user.role} "${user.username}" (id ${user.id}).`);
        if (generated) console.log(`Generated password (shown once): ${password}`);
        return 0;
      }
      case 'reset-password': {
        const user = findUser(users, required(values, 'username'));
        const { password, generated } = await resolvePassword(values);
        await users.setPassword(user.id, password);
        console.log(`Password reset for "${user.username}"; their sessions were signed out.`);
        if (generated) console.log(`Generated password (shown once): ${password}`);
        return 0;
      }
      case 'list-users': {
        const rows = users.list().map((user) => ({
          id: user.id,
          username: user.username,
          role: user.role,
          status: user.disabled ? 'disabled' : 'active',
          name: user.display_name,
          created: new Date(user.created_at).toISOString().slice(0, 10),
        }));
        if (rows.length === 0) console.log('No users yet. Create one with create-user.');
        else printTable(rows, [['id', 'ID'], ['username', 'USERNAME'], ['role', 'ROLE'], ['status', 'STATUS'], ['name', 'NAME'], ['created', 'CREATED']]);
        return 0;
      }
      case 'delete-user': {
        const user = findUser(users, required(values, 'username'));
        users.delete(user.id);
        console.log(`Deleted "${user.username}".`);
        return 0;
      }
      default:
        throw new CliError(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const [command] = parsed.positionals;
  if (!command || parsed.values.help) {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  try {
    return await run(command, parsed.values, config);
  } catch (err) {
    if (err instanceof CliError || err instanceof HttpError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  },
);
