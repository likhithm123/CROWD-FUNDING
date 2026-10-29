// Creates the tables (safe to re-run). Pass --reset to delete ALL data first.
import { pool, applySchema } from './db.js';

const reset = process.argv.includes('--reset');

try {
  if (reset) {
    console.log('Dropping all CrowdLedger tables…');
    await pool.query(`
      DROP TABLE IF EXISTS investor_preferences, conversation_messages, conversations, ticket_messages, tickets, transactions, ledger_blocks, project_documents,
        project_items, projects, sessions, users,
        admin_uploaded_files, support_tickets, inventory_ledger_entries, inventory_items, blockchain_blocks CASCADE
    `);
  }
  await applySchema();
  console.log('Database is ready. Start the server with `npm start` — it creates the genesis block and admin account.');
} catch (err) {
  console.error('Database setup failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
