import { useApi } from '../lib/hooks';
import { Empty, ErrorState, Loading } from '../components/ui';
import { ProjectTile } from './Explore';

const ORDER = ['REJECTED', 'FUNDED', 'PENDING', 'VERIFIED', 'CLOSED'];

export default function MyProjects() {
  const { data, error, loading, reload } = useApi('/api/projects?scope=mine&sort=newest');

  if (loading && !data) return <Loading />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;

  const sorted = [...data].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const needsYou = data.filter((p) => p.status === 'REJECTED' || p.status === 'FUNDED');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>My projects</h1>
          <p>Projects you’ve submitted, from waiting for review through to funds released.</p>
        </div>
        <a className="btn btn-primary" href="#/new">Start a project</a>
      </div>

      {needsYou.length > 0 && (
        <div className="notice notice-warn" style={{ marginBottom: 20 }}>
          <strong>{needsYou.length === 1 ? 'One project needs you' : `${needsYou.length} projects need you`}</strong>
          {needsYou.map((p) => (
            <div key={p.id}>
              <a href={`#/projects/${p.id}`}>{p.title}</a>: {p.status === 'REJECTED' ? 'the reviewer asked for changes.' : 'goal reached, ready to release funds.'}
            </div>
          ))}
        </div>
      )}

      {data.length === 0 ? (
        <Empty title="You haven’t started a project" action={<a className="btn btn-primary" href="#/new">Start a project</a>}>
          Describe what you want to do, list what it costs, and attach any quotes or permits. An administrator reviews it before it can raise money.
        </Empty>
      ) : (
        <div className="tiles">{sorted.map((p) => <ProjectTile key={p.id} project={p} />)}</div>
      )}
    </div>
  );
}
