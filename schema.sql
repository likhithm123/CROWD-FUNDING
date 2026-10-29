-- =============================================================================
-- CrowdLedger database schema
-- Safe to run repeatedly: every statement is idempotent. The server applies it
-- on startup. To wipe everything and start fresh, run `npm run db:reset`.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
    id              VARCHAR(40) PRIMARY KEY,
    name            VARCHAR(60)  NOT NULL,
    email           VARCHAR(120) NOT NULL,
    password_hash   TEXT         NOT NULL,
    role            VARCHAR(16)  NOT NULL CHECK (role IN ('ADMIN', 'MANAGER', 'INVESTOR', 'SUPPORT')),
    balance         NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    failed_logins   INTEGER      NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  CHAR(64) PRIMARY KEY,
    user_id     VARCHAR(40) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent  VARCHAR(255),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS projects (
    id               VARCHAR(40) PRIMARY KEY,
    title            VARCHAR(120) NOT NULL,
    category         VARCHAR(60)  NOT NULL,
    summary          VARCHAR(200) NOT NULL,
    description      TEXT         NOT NULL,
    location         VARCHAR(120),
    manager_id       VARCHAR(40)  NOT NULL REFERENCES users(id),
    target_funding   NUMERIC(15, 2) NOT NULL CHECK (target_funding > 0),
    current_funding  NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (current_funding >= 0),
    tenure_months    INTEGER      NOT NULL CHECK (tenure_months BETWEEN 1 AND 60),
    status           VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'FUNDED', 'CLOSED')),
    review_note      TEXT,
    reviewed_by      VARCHAR(40) REFERENCES users(id),
    reviewed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS projects_manager ON projects (manager_id);

CREATE TABLE IF NOT EXISTS project_items (
    id          SERIAL PRIMARY KEY,
    project_id  VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    item_name   VARCHAR(120) NOT NULL,
    quantity    INTEGER      NOT NULL CHECK (quantity > 0),
    unit_price  NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
    supplier    VARCHAR(120)
);
CREATE INDEX IF NOT EXISTS project_items_project ON project_items (project_id);

CREATE TABLE IF NOT EXISTS project_documents (
    id             SERIAL PRIMARY KEY,
    project_id     VARCHAR(40)  NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    original_name  VARCHAR(255) NOT NULL,
    stored_name    VARCHAR(255) NOT NULL,
    mime_type      VARCHAR(120) NOT NULL,
    size_bytes     BIGINT       NOT NULL,
    sha256         CHAR(64)     NOT NULL,
    uploaded_by    VARCHAR(40)  NOT NULL REFERENCES users(id),
    uploaded_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_documents_project ON project_documents (project_id);

-- Hash-chained audit log. Each block's hash covers its index, timestamp,
-- previous hash and payload, so any edit after the fact breaks the chain.
CREATE TABLE IF NOT EXISTS ledger_blocks (
    block_index    INTEGER PRIMARY KEY,
    timestamp_iso  VARCHAR(40) NOT NULL,
    previous_hash  CHAR(64)    NOT NULL,
    block_hash     CHAR(64)    NOT NULL,
    payload        JSONB       NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id           VARCHAR(40) PRIMARY KEY,
    type         VARCHAR(16) NOT NULL CHECK (type IN ('DEPOSIT', 'INVESTMENT', 'REFUND', 'PAYOUT')),
    user_id      VARCHAR(40) NOT NULL REFERENCES users(id),
    project_id   VARCHAR(40) REFERENCES projects(id),
    amount       NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
    block_index  INTEGER     NOT NULL REFERENCES ledger_blocks(block_index),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transactions_user ON transactions (user_id);
CREATE INDEX IF NOT EXISTS transactions_project ON transactions (project_id);

-- Customer conversations with the assistant. When the customer says a reply
-- didn't solve their problem, the conversation is escalated to support, who see
-- the whole history and reply in the same thread.
CREATE TABLE IF NOT EXISTS conversations (
    id            SERIAL PRIMARY KEY,
    user_id       VARCHAR(40)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject       VARCHAR(120) NOT NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'BOT'
                  CHECK (status IN ('BOT', 'RESOLVED', 'ESCALATED', 'WITH_SUPPORT', 'CLOSED')),
    assigned_to   VARCHAR(40)  REFERENCES users(id) ON DELETE SET NULL,
    escalated_at  TIMESTAMPTZ,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conversations_user ON conversations (user_id);
CREATE INDEX IF NOT EXISTS conversations_status ON conversations (status);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id               SERIAL PRIMARY KEY,
    conversation_id  INTEGER     NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender           VARCHAR(8)  NOT NULL CHECK (sender IN ('USER', 'BOT', 'SUPPORT', 'SYSTEM')),
    author_id        VARCHAR(40) REFERENCES users(id) ON DELETE SET NULL,
    body             TEXT        NOT NULL,
    source           VARCHAR(8),
    asks_feedback    BOOLEAN     NOT NULL DEFAULT FALSE,
    feedback         VARCHAR(16) CHECK (feedback IN ('RESOLVED', 'NOT_RESOLVED')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conversation_messages_conv ON conversation_messages (conversation_id);

-- What a backer last told the Suggestions page.
CREATE TABLE IF NOT EXISTS investor_preferences (
    user_id         VARCHAR(40) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    budget          NUMERIC(15, 2) NOT NULL,
    risk            VARCHAR(10) NOT NULL CHECK (risk IN ('steady', 'balanced', 'growth')),
    horizon_months  INTEGER NOT NULL,
    categories      JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
