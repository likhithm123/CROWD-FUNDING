import { useApi } from '../lib/hooks';
import { money, moneyShort, percent } from '../lib/format';
import { Bar, ErrorState, Loading } from '../components/ui';

export default function Insights() {
  const { data, error, loading, reload } = useApi('/api/insights');
  if (loading && !data) return <Loading />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;

  const s = data.projectsByStatus;
  const live = s.VERIFIED || 0;
  const done = (s.FUNDED || 0) + (s.CLOSED || 0);
  const hasMoney = data.contributions > 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Insights</h1>
          <p>Figures across the whole platform, calculated from the ledger each time you open this page.</p>
        </div>
      </div>

      <div className="stats">
        <div><b>{money(data.raised)}</b><span>Raised in total</span></div>
        <div><b>{data.backers}</b><span>{data.backers === 1 ? 'Backer' : 'Backers'}</span></div>
        <div><b>{hasMoney ? money(data.averageContribution) : '—'}</b><span>Average contribution</span></div>
        <div><b>{live}<span className="faint" style={{ fontSize: '1rem' }}> live, {done} funded</span></b><span>Projects</span></div>
      </div>

      <section className="panel panel-pad" style={{ marginBottom: 20 }}>
        <div className="section-title">
          <h2>Money raised, last 30 days</h2>
          <p>Contributions minus withdrawals, per day</p>
        </div>
        {hasMoney ? <DailyChart days={data.daily} /> : <p className="muted">No contributions yet. This chart fills in as backers contribute.</p>}
      </section>

      <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
        <section className="panel panel-pad">
          <div className="section-title"><h2>By category</h2><p>Raised against combined goals</p></div>
          {data.byCategory.length === 0 ? <p className="muted">No approved projects yet.</p> : data.byCategory.map((c) => (
            <div key={c.category} className="hbar">
              <span>{c.category} <span className="faint">({c.projects})</span></span>
              <div className="track"><span style={{ width: `${percent(c.raised, c.goal)}%` }} /></div>
              <span className="small" style={{ textAlign: 'right' }}>{moneyShort(c.raised)}</span>
            </div>
          ))}
        </section>

        <section className="panel panel-pad">
          <div className="section-title"><h2>Pace of live projects</h2><p>Based on the last 14 days</p></div>
          {data.pace.length === 0 ? <p className="muted">No projects are raising right now.</p> : (
            <ul className="list">
              {data.pace.slice(0, 8).map((p) => (
                <li key={p.projectId}>
                  <a href={`#/projects/${p.projectId}`}>{p.title}</a>
                  <Bar value={p.currentFunding} total={p.targetFunding} thin />
                  <div className="row-between faint">
                    <span>{percent(p.currentFunding, p.targetFunding)}% of {money(p.targetFunding)}</span>
                    <span>{p.daysToGoal ? `about ${p.daysToGoal} ${p.daysToGoal === 1 ? 'day' : 'days'} to goal at ${money(p.perDay)}/day` : 'no contributions in 14 days'}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {data.approvalRate !== null && (
        <p className="faint" style={{ marginTop: 20 }}>
          {Math.round(data.approvalRate * 100)}% of reviewed projects were approved. {s.PENDING || 0} waiting for review.
        </p>
      )}
    </div>
  );
}

function DailyChart({ days }) {
  const W = 760, H = 200, L = 52, B = 26, T = 10;
  const max = Math.max(1, ...days.map((d) => d.net));
  const min = Math.min(0, ...days.map((d) => d.net));
  const span = max - min;
  const step = (W - L) / days.length;
  const y = (v) => T + (H - T - B) * (1 - (v - min) / span);
  const ticks = [max, max / 2, 0].filter((v, i, a) => a.indexOf(v) === i);
  const label = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily net contributions over the last 30 days">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke="var(--line)" />
          <text x={L - 8} y={y(t) + 4} textAnchor="end">{moneyShort(t)}</text>
        </g>
      ))}
      {days.map((d, i) => {
        const top = y(Math.max(d.net, 0));
        const h = Math.abs(y(d.net) - y(0));
        return (
          <g key={d.day}>
            <rect x={L + i * step + 2} y={d.net >= 0 ? top : y(0)} width={Math.max(step - 4, 2)} height={Math.max(h, d.net ? 2 : 0)} rx="2" fill={d.net >= 0 ? 'var(--pine)' : 'var(--brick)'}>
              <title>{`${label(d.day)}: ${money(d.net)}`}</title>
            </rect>
            {i % 5 === 0 && <text x={L + i * step + step / 2} y={H - 6} textAnchor="middle">{label(d.day)}</text>}
          </g>
        );
      })}
    </svg>
  );
}
