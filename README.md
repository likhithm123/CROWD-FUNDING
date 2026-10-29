# CrowdLedger

A crowdfunding platform for community projects. Project leads submit a plan with a budget and documents, an administrator reviews it, backers contribute from a wallet, and every movement of money is written to a hash-chained ledger that anyone signed in can verify.

There is no demo or seed data. Every project, contribution and account is created by people using the app.

## How it works

| Role | Signs up | Can |
|---|---|---|
| Backer | Themselves | Add funds, contribute, withdraw while a project is still raising, get suggestions, chat with the assistant |
| Project lead | Themselves | Submit and edit projects, upload documents, release funds once the goal is met |
| Administrator | Created by an admin (first one from `.env`) | Approve or reject projects, manage people and passwords, read every conversation |
| Support | Created by an admin, or the first one from `.env` | Answer escalated conversations, read the review queue |

Project life cycle: **Waiting for review → Raising funds → Goal reached → Funds released**, or **Changes requested** (the lead edits and resubmits).

## Assistant and support

Customers (backers and project leads) ask questions through the assistant: the **Assistant** page or the **Ask a question** button on every page.

1. The assistant answers from the customer's live account (balance, contributions, project status, recent transactions) and the platform rules.
2. After **every** reply, from the assistant or from a person, the customer is asked *“Did this solve your question?”*
3. **Yes, resolved** closes the conversation. **No, I still need help** (or **Talk to a person**) escalates it to the support team.
4. Support sees the escalated conversation with its whole history in the **Support queue** and replies in the same thread. The customer gets the same resolved/not resolved prompt; saying no puts it back at the top of the queue.
5. Customers keep their full history on the Assistant page. Administrators can read every conversation under **Conversations**.

With `ANTHROPIC_API_KEY` set, replies are written by Claude using that live data as context. Without a key, or if the API is unreachable, a built-in assistant answers the same kinds of questions from the same data, and anything it can't handle goes to support.

## Suggestions

Backers enter a budget, an approach (steady, balanced or growth), how long they're happy to wait and optional interests. Every project that's raising funds is scored on:

- **Likely to finish**: how close it is to its goal, and how fast money is arriving.
- **Funding momentum**: net contributions over the last 14 days, and the projected days to goal at that pace.
- **Budget clarity**: how much of the goal is itemised, and how many documents are attached.
- **Unit cost fit**: whether the budget can pay for whole units of the items the project lists.

The budget is split across the strongest matches, and each pick shows what that share could buy at the project's unit costs. Preferences are saved for next time. These rank funding progress, not financial returns: contributions don't pay interest.

## Accounts and sign-in rules

Enforced on the server and shown live in the form (rules live in `shared/validation.js`):

- **Name**: 2–60 characters, letters, spaces, apostrophes, hyphens and dots.
- **Email**: valid format, max 120 characters, unique regardless of letter case.
- **Password**: 8–64 characters with an uppercase letter, lowercase letter, number and symbol; no spaces; must not contain your name or email; common passwords are refused.
- **Public sign-up** can only create backer or project-lead accounts. Admin and support accounts are created by an administrator.
- **Sign-in portals**: the sign-in page has Customer, Support team and Administrator tabs, and the account's role must match the tab chosen.
- **Forgotten passwords**: there's no email reset. An administrator can set a temporary password from People, which signs the person out everywhere.
- **Lockout**: 5 wrong passwords lock the account for 15 minutes (an admin can unlock it). Sign-in is also rate-limited per network.
- **Sessions** last 7 days, are stored hashed, and end on sign-out. Changing your password signs out your other devices. Deactivated accounts are signed out immediately.
- Passwords are hashed with salted scrypt.

## Money rules

- Deposits: ₹100 to ₹10,00,000 each. Contributions start at ₹100 and can’t exceed what’s left to reach the goal.
- Backers can withdraw up to what they contributed while the project is still raising.
- Reaching the goal closes the project to new contributions; the lead then releases the funds to their wallet.
- **Deposits are recorded, not charged.** There is no payment gateway yet. `POST /api/wallet/deposit` in `server/server.js` is where you would confirm a Razorpay/Stripe payment before crediting the wallet.

## The ledger

Every action (submission, approval, document upload with its SHA-256, deposit, contribution, withdrawal, release) appends a block whose hash covers its contents and the previous block’s hash. The integrity check on the Ledger page verifies that:

1. every block links to the one before and its hash matches its contents,
2. every transaction row matches the block it was recorded in,
3. every wallet balance and project total equals what the ledger adds up to.

If any check fails, all payments are paused until the data is fixed.

## Running it

Requires Node 20+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env          # set DATABASE_URL and the ADMIN_* values
npm run db:init               # creates tables (safe to re-run)
npm start                     # API on :5001, creates the first admin
npm run dev                   # in another terminal: the app on http://localhost:3000
```

Production: `npm run build && npm start` serves the built app and API from port 5001. Or with Docker: set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your shell, then `docker compose up --build`.

Other scripts:

- `npm run create-admin` creates an administrator interactively.
- `npm run db:reset` **deletes all data** and recreates the tables. Use it once when upgrading from the old version of this project, whose tables are incompatible.
- `npm run test:ui` runs 51 browser test cases (Puppeteer) across sign-up, login, wallet and contributions, and the AI assistant, saving a screenshot and expected/actual result per case in `tests/e2e/output/`. Start the server with `DISABLE_RATE_LIMIT=true` on a throwaway database and set `APP_URL`, `ADMIN_*` and `SUPPORT_*` credentials.
- `npm run test:api` runs the end-to-end API checks. It creates accounts and edits ledger rows to test tamper detection, so only point it at a throwaway database: `API_URL=http://localhost:5001 ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run test:api`.

Uploaded documents are stored in `uploads/documents/` and are only served to signed-in users who can see the project.

## Project layout

```
server/      Express API: auth.js (passwords, sessions, roles), ledger.js (hash chain + verification),
             chat.js (conversations, escalation, suggestions routes), assistant.js (AI + built-in answers),
             recommend.js (suggestion scoring), server.js (everything else)
shared/      Validation rules used by both the browser and the server
src/         React app (pages/, components/ui.jsx, lib/)
schema.sql   Idempotent PostgreSQL schema, applied on startup
contracts/   Solidity contract from the earlier version (not used by the app)
```
