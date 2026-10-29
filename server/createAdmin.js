// Interactive helper: `npm run create-admin` creates an administrator account.
import readline from 'readline/promises';
import crypto from 'crypto';
import { stdin as input, stdout as output } from 'process';
import { pool, applySchema } from './db.js';
import { hashPassword } from './auth.js';
import { validateSignup } from '../shared/validation.js';

const rl = readline.createInterface({ input, output });

try {
  await applySchema();
  const name = await rl.question('Full name: ');
  const email = await rl.question('Email: ');
  const password = await rl.question('Password (min 8 chars, upper, lower, number, symbol): ');
  const { errors, value } = validateSignup({ name, email, password, role: 'ADMIN' }, { allowedRoles: ['ADMIN'] });
  if (Object.keys(errors).length) {
    console.error(Object.values(errors).join('\n'));
    process.exitCode = 1;
  } else {
    await pool.query('INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [`usr_${crypto.randomBytes(8).toString('hex')}`, value.name, value.email, await hashPassword(value.password), 'ADMIN']);
    console.log(`Admin account created for ${value.email}.`);
  }
} catch (err) {
  console.error(err.code === '23505' ? 'An account with that email already exists.' : err.message);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
