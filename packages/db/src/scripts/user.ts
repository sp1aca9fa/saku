// `pnpm user <command>`: account management from the server (there is no sign-up page).
//
//   pnpm user list
//   pnpm user create <username> [--admin]   password + authenticator + backup codes
//
// AUTH_SECRET in .env must equal the app's: it encrypts the authenticator secrets.
import {
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashPassword,
  normalizeUsername,
  otpauthUri,
  verifyTotp,
} from '@saku/auth';
import { createInterface } from 'node:readline/promises';
import { createDb } from '../client';
import { dbConfigFromEnv, loadRootEnv } from '../env';
import { exitIfUnmigrated } from '../migrate';
import { createUser, getUserByUsername, listUsers } from '../users';

const MIN_PASSWORD = 12;

loadRootEnv();
const authSecret = process.env.AUTH_SECRET?.trim() ?? '';
const db = createDb(dbConfigFromEnv());
await exitIfUnmigrated(db);
const [command, ...args] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function askPassword(): Promise<string> {
  const password = await promptHidden(`New password (min ${MIN_PASSWORD} characters): `);
  if (password.length < MIN_PASSWORD) fail('Too short.');
  if ((await promptHidden('Repeat: ')) !== password) fail('Passwords do not match.');
  return hashPassword(password);
}

/** Requires one valid code before saving, so a mistyped key cannot lock the account out. */
async function enrollAuthenticator(username: string) {
  const secret = generateTotpSecret();
  console.log('\nAdd this key to your authenticator app (Google Authenticator, 1Password, ...):');
  console.log(`  ${secret.match(/.{1,4}/g)!.join(' ')}`);
  console.log(`Or open this link on the phone: ${otpauthUri(secret, username)}\n`);
  for (let attempt = 1; ; attempt++) {
    const code = await prompt('Enter the 6-digit code the app shows: ');
    const step = verifyTotp(secret, code);
    if (step !== null) return { totpSecretEnc: encryptSecret(secret, authSecret), step };
    if (attempt >= 3) fail('Code did not match. Nothing was saved; run the command again.');
    console.log('That code did not match, try again (check the phone clock is automatic).');
  }
}

switch (command) {
  case 'list': {
    for (const u of await listUsers(db)) {
      const flags = [u.isAdmin && 'admin', u.disabledAt && 'disabled', !u.setUp && 'not set up'];
      console.log([u.username, ...flags.filter(Boolean)].join('  '));
    }
    break;
  }
  case 'create': {
    const username = normalizeUsername(args[0] ?? '');
    if (!username) fail('Usage: pnpm user create <username> [--admin] (3-32 of a-z 0-9 . _ -)');
    if (authSecret.length < 32)
      fail('AUTH_SECRET (32+ characters, same as the app) must be set in .env.');
    if (await getUserByUsername(db, username)) fail(`User ${username} already exists.`);
    const isAdmin = args.includes('--admin') || (await listUsers(db)).length === 0;
    const passwordHash = await askPassword();
    const { totpSecretEnc, step } = await enrollAuthenticator(username);
    const backup = generateBackupCodes();
    await createUser(db, {
      username,
      passwordHash,
      totpSecretEnc,
      totpLastStep: step,
      backupCodeHashes: backup.hashes,
      isAdmin,
    });
    console.log(
      '\nBackup codes (each works once if you lose the authenticator). Store them offline:',
    );
    for (const c of backup.codes) console.log(`  ${c}`);
    console.log(`\nCreated ${username}${isAdmin ? ' (admin)' : ''}.`);
    break;
  }
  default:
    fail('Usage: pnpm user list | pnpm user create <username> [--admin]');
}
