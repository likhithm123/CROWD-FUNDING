import { useApi } from '../lib/hooks';
import { navigate } from '../lib/router';
import { ago } from '../lib/format';
import { ChatThread, CHAT_STATUS } from '../components/Chat';
import { ErrorState, Loading } from '../components/ui';

export default function Assistant({ id }) {
  const { data, error, loading, reload } = useApi('/api/conversations');
  const selected = id === 'new' ? null : id ? Number(id) : null;

  if (loading && !data) return <Loading />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;

  const list = data.conversations;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Assistant</h1>
          <p>Ask anything about your account, wallet or projects. After each answer you can say whether it solved your question. If not, the support team takes over and replies here.</p>
        </div>
        <a className="btn btn-primary" href="#/assistant/new">New question</a>
      </div>

      <div className="inbox">
        <aside className="panel inbox-list" aria-label="Your conversations">
          <div className="inbox-list-head"><strong>Your conversations</strong><span className="faint">{list.length}</span></div>
          {list.length === 0 && <p className="faint" style={{ padding: '4px 16px 16px' }}>Nothing yet. Your questions and their answers are kept here.</p>}
          {list.map((c) => (
            <a key={c.id} href={`#/assistant/${c.id}`} className={`inbox-item${selected === c.id ? ' active' : ''}`} aria-current={selected === c.id ? 'true' : undefined}>
              <div className="row-between" style={{ flexWrap: 'nowrap' }}>
                <span className="inbox-subject">{c.subject}</span>
                <span className="faint" style={{ whiteSpace: 'nowrap' }}>{ago(c.updatedAt)}</span>
              </div>
              <span className={`status ${CHAT_STATUS[c.status].cls}`}>{CHAT_STATUS[c.status].label}</span>
            </a>
          ))}
        </aside>
        <section className="panel inbox-thread">
          <ChatThread
            key={selected ?? 'new'}
            conversationId={selected}
            onChange={(c) => { reload(); if (c.id !== selected) navigate(`/assistant/${c.id}`); }}
          />
        </section>
      </div>
    </div>
  );
}
