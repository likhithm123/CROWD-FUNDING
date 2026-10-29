import { useEffect, useState } from 'react';
import { useApi } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL, ago } from '../lib/format';
import { ChatThread, CHAT_STATUS } from '../components/Chat';
import { ErrorState, Loading } from '../components/ui';

const FILTERS = [
  ['waiting', 'Needs a reply', ['ESCALATED']],
  ['queue', 'Escalated', ['ESCALATED', 'WITH_SUPPORT']],
  ['bot', 'With the assistant', ['BOT']],
  ['closed', 'Resolved', ['RESOLVED', 'CLOSED']],
  ['all', 'All', null],
];

export default function SupportDesk({ id }) {
  const { user } = useAuth();
  const [filter, setFilter] = useState(user.role === 'ADMIN' ? 'all' : 'queue');
  const { data, error, loading, reload } = useApi(`/api/conversations?scope=${filter}`, { keepPrevious: true });
  const selected = id ? Number(id) : null;

  useEffect(() => {
    const t = setInterval(reload, 10000);
    return () => clearInterval(t);
  }, [reload]);

  if (loading && !data) return <Loading />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;

  const counts = data.counts || {};
  const countFor = (statuses) => (statuses ? statuses.reduce((s, k) => s + (counts[k] || 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{user.role === 'ADMIN' ? 'Conversations' : 'Support queue'}</h1>
          <p>Conversations customers escalated because the assistant’s answer didn’t solve their question. You see the whole history; after each reply the customer is asked whether it’s resolved.</p>
        </div>
      </div>

      <div className="chips" role="group" aria-label="Filter conversations">
        {FILTERS.map(([key, label, statuses]) => (
          <button key={key} className="chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label} <span className="chip-count">{countFor(statuses)}</span>
          </button>
        ))}
      </div>

      <div className="inbox">
        <aside className="panel inbox-list" aria-label="Conversations">
          {data.conversations.length === 0 && (
            <p className="faint" style={{ padding: 16 }}>{filter === 'waiting' || filter === 'queue' ? 'No one is waiting. Escalated conversations appear here.' : 'Nothing here.'}</p>
          )}
          {data.conversations.map((c) => (
            <a key={c.id} href={`#/support/${c.id}`} className={`inbox-item${selected === c.id ? ' active' : ''}`} aria-current={selected === c.id ? 'true' : undefined}>
              <div className="row-between" style={{ flexWrap: 'nowrap' }}>
                <strong className="inbox-subject">{c.userName}</strong>
                <span className="faint" style={{ whiteSpace: 'nowrap' }}>{ago(c.updatedAt)}</span>
              </div>
              <div className="inbox-subject muted small">{c.subject}</div>
              <div className="row" style={{ gap: 6 }}>
                <span className={`status ${CHAT_STATUS[c.status].cls}`}>{CHAT_STATUS[c.status].label}</span>
                <span className="faint">{ROLE_LABEL[c.userRole]}, {c.messageCount} messages</span>
              </div>
            </a>
          ))}
        </aside>
        <section className="panel inbox-thread">
          {selected ? (
            <ChatThread key={selected} conversationId={selected} onChange={reload} />
          ) : (
            <div className="chat-empty" style={{ margin: 'auto' }}>
              <p style={{ fontWeight: 600 }}>Choose a conversation</p>
              <p className="faint">Its full history opens here, including what the assistant already told the customer.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
