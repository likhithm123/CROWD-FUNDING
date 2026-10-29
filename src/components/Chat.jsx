import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { Notice } from './ui';

export const CHAT_STATUS = {
  BOT: { label: 'With the assistant', cls: 'status-live' },
  RESOLVED: { label: 'Resolved', cls: 'status-closed' },
  ESCALATED: { label: 'Waiting for support', cls: 'status-pending' },
  WITH_SUPPORT: { label: 'Support replied', cls: 'status-funded' },
  CLOSED: { label: 'Resolved by support', cls: 'status-closed' },
};

const STARTERS = {
  INVESTOR: ['What’s my wallet balance?', 'How do I add money?', 'Which project should I back?', 'How do withdrawals work?'],
  MANAGER: ['What’s the status of my projects?', 'How do I submit a project?', 'How do I release funds?', 'How do I upload documents?'],
};

const WITH_PEOPLE = new Set(['ESCALATED', 'WITH_SUPPORT']);

/**
 * One conversation thread. Customers talk to the assistant and answer the
 * "did this solve it?" prompt; staff see the whole history and reply.
 * Pass conversationId={null} to start a new conversation.
 */
export function ChatThread({ conversationId, onChange, compact = false }) {
  const { user } = useAuth();
  const staff = user.role === 'SUPPORT' || user.role === 'ADMIN';
  const [conv, setConv] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null); // optimistic user message while waiting
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);
  const input = useRef(null);

  const load = useCallback(async () => {
    if (!conversationId) { setConv(null); return; }
    try {
      setConv(await api.get(`/api/conversations/${conversationId}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [conversationId]);

  useEffect(() => { setConv(null); setPending(null); setText(''); load(); }, [load]);

  // While people are involved, check for new replies every few seconds.
  useEffect(() => {
    if (!conv || (!WITH_PEOPLE.has(conv.status) && !staff)) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [conv?.status, staff, load]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv?.messages?.length, pending, busy]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setConv(next);
      onChange?.(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function send(e, preset) {
    e?.preventDefault();
    const body = (preset ?? text).trim();
    if (!body || busy) return;
    if (body.length > 2000) return setError('Messages must be 2,000 characters or fewer.');
    setText('');
    setPending(body);
    await run(() => (conv
      ? api.post(`/api/conversations/${conv.id}/messages`, { body })
      : api.post('/api/conversations', { message: body })));
    input.current?.focus();
  }

  const answer = (resolved) => run(() => api.post(`/api/conversations/${conv.id}/feedback`, { resolved }));
  const escalate = () => run(() => api.post(`/api/conversations/${conv.id}/escalate`));
  const close = () => run(() => api.post(`/api/conversations/${conv.id}/close`));

  const messages = conv?.messages || [];
  const canReply = !staff || (conv && WITH_PEOPLE.has(conv.status));
  const waitingOn = conv?.awaitingFeedbackOn;
  const expectsBot = !conv || !WITH_PEOPLE.has(conv.status);

  let placeholder = 'Type your question';
  if (staff) placeholder = canReply ? `Reply to ${conv?.userName?.split(' ')[0] || 'the customer'}` : 'You can reply once the customer escalates';
  else if (conv && WITH_PEOPLE.has(conv.status)) placeholder = 'Add details for the support team';

  return (
    <div className={`chat${compact ? ' chat-compact' : ''}`}>
      {conv && (
        <div className="chat-head">
          <div style={{ minWidth: 0 }}>
            <div className="chat-title">{conv.subject}</div>
            <div className="faint">
              {staff ? `${conv.userName} (${conv.userEmail})` : CHAT_STATUS[conv.status].label}
              {staff && <> &nbsp;<span className={`status ${CHAT_STATUS[conv.status].cls}`}>{CHAT_STATUS[conv.status].label}</span></>}
            </div>
          </div>
          {!staff && conv.status === 'BOT' && <button className="btn btn-sm" onClick={escalate} disabled={busy}>Talk to a person</button>}
          {staff && !['CLOSED', 'RESOLVED'].includes(conv.status) && <button className="btn btn-sm" onClick={close} disabled={busy}>Mark resolved</button>}
        </div>
      )}

      <div className="chat-scroll" ref={scroller} aria-live="polite">
        {!conv && !pending && !conversationId && (
          <div className="chat-empty">
            <p style={{ fontWeight: 600, marginBottom: 4 }}>Hi {user.name.split(' ')[0]}, what can I help with?</p>
            <p className="faint" style={{ marginBottom: 14 }}>I answer from your account and the platform rules. If I can’t solve it, a person from the support team takes over with this whole conversation.</p>
            <div className="starters">
              {(STARTERS[user.role] || []).map((s) => <button key={s} className="chip" onClick={() => send(null, s)}>{s}</button>)}
            </div>
          </div>
        )}
        {conversationId && !conv && !error && <p className="faint" style={{ padding: 16 }}>Loading conversation…</p>}

        {messages.map((m) => <Bubble key={m.id} m={m} staff={staff} />)}

        {waitingOn && conv.isOwner && !busy && (
          <div className="feedback" role="group" aria-label="Was your question resolved?">
            <span>Did this solve your question?</span>
            <div className="row">
              <button className="btn btn-sm btn-primary" onClick={() => answer(true)}>Yes, resolved</button>
              <button className="btn btn-sm" onClick={() => answer(false)}>No, I still need help</button>
            </div>
          </div>
        )}
        {waitingOn && staff && <p className="faint chat-note">Waiting for the customer to say whether this solved it.</p>}

        {pending && <Bubble m={{ sender: 'USER', body: pending, createdAt: new Date().toISOString() }} />}
        {busy && pending && expectsBot && <div className="bubble bot typing"><span /><span /><span /></div>}
      </div>

      {error && <div style={{ padding: '0 14px 10px' }}><Notice kind="error">{error}</Notice></div>}

      <form className="chat-input" onSubmit={send}>
        <textarea
          ref={input} className="textarea" rows={1} value={text} disabled={!canReply || busy}
          placeholder={placeholder} maxLength={2000} aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e); }}
        />
        <button className="btn btn-primary" type="submit" disabled={!canReply || busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}

function Bubble({ m, staff }) {
  if (m.sender === 'SYSTEM') return <p className="chat-note">{m.body}</p>;
  const who = m.sender === 'USER' ? (staff ? 'Customer' : 'You') : m.sender === 'BOT' ? 'Assistant' : `${m.authorName || 'Support'}, support team`;
  const cls = m.sender === 'USER' ? 'user' : m.sender === 'BOT' ? 'bot' : 'support';
  return (
    <div className={`bubble ${cls}`}>
      <header>{who}<span>{dateTime(m.createdAt)}</span></header>
      <p>{m.body}</p>
      {m.feedback && <div className={`fb ${m.feedback === 'RESOLVED' ? 'ok' : 'no'}`}>{m.feedback === 'RESOLVED' ? 'Marked resolved' : 'Marked not resolved'}</div>}
    </div>
  );
}

/** Floating button + panel so customers can ask from any page. */
export function ChatLauncher() {
  const [open, setOpen] = useState(false);
  const [convId, setConvId] = useState(undefined);

  useEffect(() => {
    if (!open || convId !== undefined) return;
    // Resume the most recent open conversation, otherwise start fresh.
    api.get('/api/conversations').then((d) => {
      const active = d.conversations.find((c) => c.status !== 'RESOLVED' && c.status !== 'CLOSED');
      setConvId(active ? active.id : null);
    }).catch(() => setConvId(null));
  }, [open, convId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {open && (
        <div className="launcher-panel" role="dialog" aria-label="Assistant">
          <div className="launcher-bar">
            <strong>Assistant</strong>
            <span className="row" style={{ gap: 4 }}>
              {convId && <button className="btn btn-sm btn-ghost" onClick={() => setConvId(null)}>New question</button>}
              <a className="btn btn-sm btn-ghost" href="#/assistant" onClick={() => setOpen(false)}>History</a>
              <button className="close-x" aria-label="Close assistant" onClick={() => setOpen(false)}>×</button>
            </span>
          </div>
          {convId === undefined ? <p className="faint" style={{ padding: 16 }}>Loading…</p> : (
            <ChatThread key={convId ?? 'new'} conversationId={convId} compact onChange={(c) => setConvId(c.id)} />
          )}
        </div>
      )}
      <button className="launcher" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor" /></svg>
        {open ? 'Close' : 'Ask a question'}
      </button>
    </>
  );
}
