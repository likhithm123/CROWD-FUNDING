import { useEffect, useState } from 'react';
import { useApi } from '../lib/hooks';
import { CATEGORY_COLOR, money, percent } from '../lib/format';
import { CATEGORIES } from '../../shared/validation.js';
import { Bar, Empty, ErrorState, Loading, StatusPill } from '../components/ui';

export default function Explore({ user }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams();
  if (debounced) params.set('q', debounced);
  if (category) params.set('category', category);
  if (sort) params.set('sort', sort);
  const { data, error, loading, reload } = useApi(`/api/projects?${params}`, { keepPrevious: true });

  const filtering = debounced || category;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Every project here has been reviewed by an administrator. Pick one to see its budget, documents and who has backed it.</p>
        </div>
        {user.role === 'MANAGER' && <a className="btn btn-primary" href="#/new">Start a project</a>}
      </div>

      <div className="filters">
        <input className="input" type="search" placeholder="Search by name, summary or place" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort projects">
          <option value="">Raising first</option>
          <option value="closest">Closest to goal</option>
          <option value="newest">Newest</option>
          <option value="raised">Most raised</option>
          <option value="goal">Smallest goal</option>
        </select>
      </div>
      <div className="chips" role="group" aria-label="Filter by category">
        <button className="chip" aria-pressed={!category} onClick={() => setCategory('')}>All</button>
        {CATEGORIES.map((c) => (
          <button key={c} className="chip" aria-pressed={category === c} onClick={() => setCategory(category === c ? '' : c)}>{c}</button>
        ))}
      </div>

      {loading && !data ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : data.length === 0 ? (
        filtering ? (
          <Empty title="No projects match" action={<button className="btn" onClick={() => { setQ(''); setCategory(''); }}>Clear filters</button>}>
            Try a different search or category.
          </Empty>
        ) : (
          <Empty title="No projects are raising yet" action={user.role === 'MANAGER' ? <a className="btn btn-primary" href="#/new">Start a project</a> : null}>
            {user.role === 'MANAGER'
              ? 'Submit the first one. It appears here once an administrator approves it.'
              : 'Projects appear here once a project lead submits one and an administrator approves it.'}
          </Empty>
        )
      ) : (
        <div className="tiles">{data.map((p) => <ProjectTile key={p.id} project={p} />)}</div>
      )}
    </div>
  );
}

export function ProjectTile({ project: p, href }) {
  const done = p.status === 'FUNDED' || p.status === 'CLOSED';
  return (
    <a className="tile" href={href || `#/projects/${p.id}`}>
      <div className="tile-band" style={{ background: CATEGORY_COLOR[p.category] || '#9aa' }} />
      <div className="tile-body">
        <div className="tile-meta">
          <span>{p.category}{p.location ? `, ${p.location}` : ''}</span>
          {p.status !== 'VERIFIED' && <StatusPill status={p.status} />}
        </div>
        <h3>{p.title}</h3>
        <p>{p.summary}</p>
        <div className="tile-money">
          <Bar value={p.currentFunding} total={p.targetFunding} thin done={done} />
          <div className="amounts">
            <span><b>{money(p.currentFunding)}</b> <span className="faint">of {money(p.targetFunding)}</span></span>
            <span className="faint">{percent(p.currentFunding, p.targetFunding)}%, {p.backers} {p.backers === 1 ? 'backer' : 'backers'}</span>
          </div>
        </div>
      </div>
    </a>
  );
}
