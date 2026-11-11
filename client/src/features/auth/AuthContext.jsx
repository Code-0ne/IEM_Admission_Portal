import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { http } from '../../api/http.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const stored = window.localStorage.getItem('iem_cached_user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);
  const authRequestId = useRef(0);

  const refreshCurrentUser = useCallback(async () => {
    const requestId = ++authRequestId.current;
    try {
      const data = await http.get('/auth/me');
      if (requestId === authRequestId.current && data?.user) {
        setUser(data.user);
        window.localStorage.setItem('iem_cached_user', JSON.stringify(data.user));
      }
    } catch (error) {
      if (
        requestId === authRequestId.current
        && (error?.statusCode === 401 || error?.code === 'UNAUTHORIZED')
      ) {
        setUser(null);
        window.localStorage.removeItem('iem_cached_user');
      }
    } finally {
      if (requestId === authRequestId.current) setLoading(false);
    }
  }, []);

  // Keep the cached identity aligned with the shared cookie across browser tabs.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshCurrentUser();
    };
    const refreshAfterStorageChange = (event) => {
      if (event.key === 'iem_cached_user') refreshCurrentUser();
    };

    refreshCurrentUser();
    window.addEventListener('focus', refreshCurrentUser);
    window.addEventListener('storage', refreshAfterStorageChange);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshCurrentUser);
      window.removeEventListener('storage', refreshAfterStorageChange);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshCurrentUser]);

  const register = async (payload) => {
    const res = await http.post('/auth/register', payload);
    if (res?.user) {
      authRequestId.current += 1;
      setUser(res.user);
      window.localStorage.setItem('iem_cached_user', JSON.stringify(res.user));
    }
    return res;
  };

  const login = async ({ identifier, password }) => {
    const res = await http.post('/auth/login', { identifier, password });
    if (res?.user) {
      authRequestId.current += 1;
      setUser(res.user);
      window.localStorage.setItem('iem_cached_user', JSON.stringify(res.user));
    }
    return res;
  };

  const logout = async () => {
    try {
      await http.post('/auth/logout');
    } catch {
      // Ignore network errors on logout
    } finally {
      authRequestId.current += 1;
      setUser(null);
      window.localStorage.removeItem('iem_cached_user');
    }
  };

  const forgotPassword = async ({ email }) => {
    return http.post('/auth/forgot-password', { email });
  };

  const resetPassword = async ({ accessToken, newPassword }) => {
    const res = await http.post('/auth/reset-password', { accessToken, newPassword });
    authRequestId.current += 1;
    setUser(null);
    window.localStorage.removeItem('iem_cached_user');
    return res;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: Boolean(user),
        loading,
        register,
        login,
        logout,
        forgotPassword,
        resetPassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
