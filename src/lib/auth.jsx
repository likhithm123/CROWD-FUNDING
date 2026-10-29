import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, session, setUnauthorizedHandler } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const signOutLocal = useCallback(() => { session.clear(); setUser(null); }, []);

  useEffect(() => {
    setUnauthorizedHandler(signOutLocal);
    if (!session.get()) { setReady(true); return; }
    api.get('/api/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => session.clear())
      .finally(() => setReady(true));
  }, [signOutLocal]);

  const value = {
    user,
    ready,
    async signIn(email, password, portal) {
      const d = await api.post('/api/auth/login', { email, password, portal });
      session.set(d.token);
      setUser(d.user);
    },
    async signUp(form) {
      const d = await api.post('/api/auth/signup', form);
      session.set(d.token);
      setUser(d.user);
    },
    async signOut() {
      try { await api.post('/api/auth/logout'); } catch { /* already gone */ }
      signOutLocal();
      window.location.hash = '';
    },
    async refresh() {
      const d = await api.get('/api/auth/me');
      setUser(d.user);
    },
    setUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
