import crypto from 'crypto';

export const GENESIS_PREVIOUS = '0'.repeat(64);

// Deterministic JSON: object keys sorted at every level so the same payload
// always hashes the same way, no matter how Postgres JSONB reorders keys.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashBlock({ index, timestamp, previousHash, payload }) {
  return crypto
    .createHash('sha256')
    .update(canonical({ index, timestamp, previousHash, payload }))
    .digest('hex');
}

/**
 * Append one block inside the caller's transaction. An advisory lock makes
 * concurrent writers queue up, so two blocks can never claim the same index.
 */
export async function appendBlock(client, payload) {
  await client.query('SELECT pg_advisory_xact_lock(727274)');
  const { rows } = await client.query(
    'SELECT block_index, block_hash FROM ledger_blocks ORDER BY block_index DESC LIMIT 1'
  );
  const last = rows[0];
  const block = {
    index: last ? last.block_index + 1 : 0,
    timestamp: new Date().toISOString(),
    previousHash: last ? last.block_hash : GENESIS_PREVIOUS,
    payload,
  };
  block.hash = hashBlock(block);
  await client.query(
    `INSERT INTO ledger_blocks (block_index, timestamp_iso, previous_hash, block_hash, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [block.index, block.timestamp, block.previousHash, block.hash, JSON.stringify(payload)]
  );
  return block;
}

export async function ensureGenesis(client) {
  const { rows } = await client.query('SELECT 1 FROM ledger_blocks WHERE block_index = 0');
  if (rows.length === 0) await appendBlock(client, { event: 'GENESIS', note: 'Ledger opened' });
}

const money = (n) => Math.round(Number(n) * 100);

/**
 * Full integrity check:
 *  1. every block's hash matches its contents and links to the previous block;
 *  2. every money transaction row matches the block it was recorded in;
 *  3. every wallet balance and project total equals what the ledger implies.
 * Returns { valid, blocks, problems: [{ kind, blockIndex?, message }] }.
 */
export async function verifyLedger(db) {
  const problems = [];
  const { rows: blocks } = await db.query('SELECT * FROM ledger_blocks ORDER BY block_index ASC');

  const byIndex = new Map();
  let prevHash = GENESIS_PREVIOUS;
  blocks.forEach((b, i) => {
    if (b.block_index !== i) {
      problems.push({ kind: 'gap', blockIndex: b.block_index, message: `Block #${i} is missing from the chain.` });
    }
    if (b.previous_hash !== prevHash) {
      problems.push({ kind: 'link', blockIndex: b.block_index, message: `Block #${b.block_index} doesn’t point to the block before it.` });
    }
    const expected = hashBlock({ index: b.block_index, timestamp: b.timestamp_iso, previousHash: b.previous_hash, payload: b.payload });
    if (expected !== b.block_hash) {
      problems.push({ kind: 'hash', blockIndex: b.block_index, message: `Block #${b.block_index} was changed after it was written.` });
    }
    prevHash = b.block_hash;
    byIndex.set(b.block_index, b);
  });

  const { rows: txs } = await db.query('SELECT * FROM transactions ORDER BY block_index');
  const balances = new Map();
  const funding = new Map();
  const bump = (map, key, delta) => map.set(key, (map.get(key) || 0) + delta);

  for (const tx of txs) {
    const p = byIndex.get(tx.block_index)?.payload;
    if (!p || p.txId !== tx.id || p.type !== tx.type || p.userId !== tx.user_id ||
        (p.projectId || null) !== (tx.project_id || null) || money(p.amount) !== money(tx.amount)) {
      problems.push({ kind: 'transaction', blockIndex: tx.block_index, message: `Transaction ${tx.id} doesn’t match what block #${tx.block_index} recorded.` });
    }
  }

  // Rebuild balances from the ledger payloads themselves (the source of truth).
  for (const b of blocks) {
    const p = b.payload;
    if (!p || !p.txId) continue;
    const amt = money(p.amount);
    if (p.type === 'DEPOSIT') bump(balances, p.userId, amt);
    if (p.type === 'INVESTMENT') { bump(balances, p.userId, -amt); bump(funding, p.projectId, amt); }
    if (p.type === 'REFUND') { bump(balances, p.userId, amt); bump(funding, p.projectId, -amt); }
    if (p.type === 'PAYOUT') { bump(balances, p.userId, amt); }
  }

  const { rows: users } = await db.query('SELECT id, name, balance FROM users');
  for (const u of users) {
    if (money(u.balance) !== (balances.get(u.id) || 0)) {
      problems.push({ kind: 'balance', message: `${u.name}’s wallet balance doesn’t match the ledger.` });
    }
  }
  const { rows: projects } = await db.query('SELECT id, title, current_funding FROM projects');
  for (const pr of projects) {
    if (money(pr.current_funding) !== (funding.get(pr.id) || 0)) {
      problems.push({ kind: 'funding', message: `The amount raised for “${pr.title}” doesn’t match the ledger.` });
    }
  }

  return { valid: problems.length === 0, blocks: blocks.length, problems, checkedAt: new Date().toISOString() };
}
