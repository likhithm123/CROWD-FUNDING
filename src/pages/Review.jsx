import { useApi } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { ago, money } from '../lib/format';
import { Empty, ErrorState, Loading } from '../components/ui';

export default function Review() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi('/api/projects?scope=review');

  if (loading && !data) return <Loading />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{user.role === 'ADMIN' ? 'Review' : 'Review queue'}</h1>
          <p>{user.role === 'ADMIN'
            ? 'Projects waiting for a decision, oldest first. Open one to read the plan and documents, then approve it or ask for changes.'
            : 'Projects waiting for an administrator. You can read them to help backers with questions.'}</p>
        </div>
      </div>
      {data.length === 0 ? (
        <Empty title="Nothing to review">New submissions from project leads will show up here.</Empty>
      ) : (
        <div className="panel">
          {data.map((p) => (
            <a key={p.id} className="list-link" href={`#/projects/${p.id}`}>
              <div className="row-between">
                <strong style={{ fontSize: '1.05rem' }}>{p.title}</strong>
                <span className="faint">submitted {ago(p.updatedAt)}</span>
              </div>
              <p className="muted small" style={{ margin: '4px 0 8px' }}>{p.summary}</p>
              <div className="row faint">
                <span>{p.managerName}</span>
                <span className="tag">{p.category}</span>
                <span>Goal {money(p.targetFunding)}</span>
                <span>{p.documentCount} {p.documentCount === 1 ? 'document' : 'documents'}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
