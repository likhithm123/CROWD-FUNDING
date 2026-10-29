import { useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import { useRoute } from './lib/router';
import { useApi } from './lib/hooks';
import { ROLE_LABEL, initials, money } from './lib/format';
import { Loading, Mark, ToastProvider } from './components/ui';
import AuthPage from './pages/AuthPage';
import Explore from './pages/Explore';
import ProjectPage from './pages/ProjectPage';
import Wallet from './pages/Wallet';
import MyProjects from './pages/MyProjects';
import ProjectForm from './pages/ProjectForm';
import Review from './pages/Review';
import Ledger from './pages/Ledger';
import Insights from './pages/Insights';
import Assistant from './pages/Assistant';
import SupportDesk from './pages/SupportDesk';
import Suggestions from './pages/Suggestions';
import Inventory from './pages/Inventory';
import { ChatLauncher } from './components/Chat';
import People from './pages/People';
import Account from './pages/Account';

const NAV = {
  INVESTOR: [['explore', 'Projects'], ['suggestions', 'AI Suggestions'], ['wallet', 'Wallet'], ['assistant', 'Assistant'], ['insights', 'Insights'], ['ledger', 'Ledger']],
  MANAGER: [['mine', 'My projects'], ['explore', 'Projects'], ['suggestions', 'AI Suggestions'], ['wallet', 'Payouts'], ['assistant', 'Assistant'], ['insights', 'Insights'], ['ledger', 'Ledger']],
  ADMIN: [['review', 'Review'], ['explore', 'Projects'], ['suggestions', 'AI Suggestions'], ['people', 'People'], ['support', 'Conversations'], ['insights', 'Insights'], ['ledger', 'Ledger']],
  SUPPORT: [['support', 'Support queue'], ['review', 'Review queue'], ['explore', 'Projects'], ['suggestions', 'AI Suggestions'], ['ledger', 'Ledger']],
};

const ALLOWED = {
  INVESTOR: ['explore', 'projects', 'suggestions', 'inventory', 'wallet', 'assistant', 'insights', 'ledger', 'account'],
  MANAGER: ['mine', 'new', 'edit', 'explore', 'projects', 'suggestions', 'inventory', 'wallet', 'assistant', 'insights', 'ledger', 'account'],
  ADMIN: ['review', 'explore', 'projects', 'suggestions', 'inventory', 'people', 'support', 'insights', 'ledger', 'account'],
  SUPPORT: ['support', 'review', 'explore', 'projects', 'suggestions', 'inventory', 'ledger', 'account'],
};

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ToastProvider>
  );
}

function Shell() {
  const { user, ready } = useAuth();
  const route = useRoute();
  const [authMode, setAuthMode] = useState(route.path[0] === 'signup' ? 'signup' : 'signin');

  if (!ready) return <Loading label="Opening CrowdFund…" />;
  if (!user) return <AuthPage mode={authMode} onSwitch={setAuthMode} />;

  const section = ALLOWED[user.role].includes(route.path[0]) ? route.path[0] : NAV[user.role][0][0];
  return (
    <>
      <TopBar user={user} section={section} />
      <Page section={section} route={route} user={user} />
      {(user.role === 'INVESTOR' || user.role === 'MANAGER') && section !== 'assistant' && <ChatLauncher />}
    </>
  );
}

function Page({ section, route, user }) {
  const id = route.path[1];
  switch (section) {
    case 'explore': return <Explore user={user} />;
    case 'projects': return <ProjectPage key={id} id={id} presetAmount={route.query.amount} />;
    case 'wallet': return <Wallet />;
    case 'mine': return <MyProjects />;
    case 'new': return <ProjectForm />;
    case 'edit': return <ProjectForm key={id} id={id} />;
    case 'review': return <Review />;
    case 'ledger': return <Ledger />;
    case 'insights': return <Insights />;
    case 'assistant': return <Assistant id={id} />;
    case 'support': return <SupportDesk id={id} />;
    case 'suggestions': return <Suggestions />;
    case 'inventory': return <Suggestions />;
    case 'people': return <People />;
    case 'account': return <Account />;
    default: return null;
  }
}

function TopBar({ user, section }) {
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const pending = useApi(user.role === 'ADMIN' ? '/api/projects?scope=review' : null);
  const pendingCount = pending.data?.length || 0;
  const queue = useApi(user.role === 'ADMIN' || user.role === 'SUPPORT' ? '/api/conversations?scope=waiting' : null);
  const waitingCount = queue.data?.conversations?.length || 0;
  const reloadQueue = queue.reload;
  useEffect(() => {
    if (user.role !== 'ADMIN' && user.role !== 'SUPPORT') return;
    const t = setInterval(reloadQueue, 15000);
    return () => clearInterval(t);
  }, [user.role, reloadQueue]);

  useEffect(() => {
    if (!open) return;
    const close = (e) => !menuRef.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const active = section === 'projects' ? 'explore' : section === 'new' || section === 'edit' ? 'mine' : section;

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="wordmark" href="#/"><Mark /> CrowdFund</a>
        <nav className="nav" aria-label="Main">
          {NAV[user.role].map(([key, label]) => (
            <a key={key} href={`#/${key}`} aria-current={active === key ? 'page' : undefined}>
              {label}
              {key === 'review' && pendingCount > 0 && <span className="count">{pendingCount}</span>}
              {key === 'support' && waitingCount > 0 && <span className="count">{waitingCount}</span>}
            </a>
          ))}
        </nav>
        <div className="user-menu" ref={menuRef}>
          <button className="user-button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
            <span className="avatar">{initials(user.name)}</span>
            <span className="who">
              {user.name}
              <small>{user.role === 'INVESTOR' || user.role === 'MANAGER' ? money(user.balance) : ROLE_LABEL[user.role]}</small>
            </span>
          </button>
          {open && (
            <div className="menu" role="menu" onClick={() => setOpen(false)}>
              <div style={{ padding: '6px 10px 8px' }}>
                <div style={{ fontWeight: 600 }}>{user.name}</div>
                <div className="faint">{user.email}</div>
                <div className="faint">{ROLE_LABEL[user.role]}</div>
              </div>
              <hr />
              <a href="#/account" role="menuitem">Account settings</a>
              {(user.role === 'INVESTOR' || user.role === 'MANAGER') && <a href="#/wallet" role="menuitem">Wallet</a>}
              <hr />
              <button role="menuitem" onClick={signOut}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
