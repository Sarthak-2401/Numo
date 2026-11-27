import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

import api from '../services/api';

interface User {
  id: string;
  phone: string;
  email: string;
  displayName: string;
  profilePicture?: string;
  language?: string;
  aliases?: any[];
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  logout: () => void;
  signIn: (session: { token: string; user: User }) => void;
  setUser: (user: User) => void;
}

function expiryOf(token: string) {
  const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return Number(JSON.parse(atob(payload)).exp) * 1000;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Migrate sessions once for people returning after the rename.
    for (const field of ['token', 'user']) {
      const previousKey = `phonemail_${field}`;
      const currentKey = `numo_${field}`;
      const previousValue = localStorage.getItem(previousKey);
      if (previousValue !== null) {
        if (localStorage.getItem(currentKey) === null) localStorage.setItem(currentKey, previousValue);
        localStorage.removeItem(previousKey);
      }
    }
    const restore = () => {
      const savedToken = localStorage.getItem('numo_token');
      const savedUser = localStorage.getItem('numo_user');
      try {
        if (savedToken && savedUser && expiryOf(savedToken) > Date.now()) {
          setUser(JSON.parse(savedUser));
          setToken(savedToken);
          return;
        }
      } catch { /* A damaged session requires a fresh sign-in. */ }
      clearSession();
    };
    restore();
    setIsLoading(false);
    const sync = (event: StorageEvent) => {
      if (event.key === 'numo_token' || event.key === 'numo_user' || event.key === null) restore();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  useEffect(() => {
    if (!token) return;
    const expire = () => {
      if (localStorage.getItem('numo_token') === token && expiryOf(token) <= Date.now()) clearSession();
    };
    const timer = window.setTimeout(expire, Math.max(0, expiryOf(token) - Date.now()));
    window.addEventListener('focus', expire);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', expire); };
  }, [token]);

  const signIn = (session: { token: string; user: User }) => {
    localStorage.setItem('numo_user', JSON.stringify(session.user));
    localStorage.setItem('numo_token', session.token);
    setUser(session.user);
    setToken(session.token);
  };

  const handleSetUser = (newUser: User) => {
    setUser(newUser);
    setToken(localStorage.getItem('numo_token'));
  };

  const clearSession = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('numo_token');
    localStorage.removeItem('numo_user');
  };

  const logout = () => {
    const current = localStorage.getItem('numo_token');
    if (current) void api.post('/auth/logout', {}, { headers: { Authorization: 'Bearer ' + current } }).catch(() => {});
    clearSession();
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, logout, signIn, setUser: handleSetUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
