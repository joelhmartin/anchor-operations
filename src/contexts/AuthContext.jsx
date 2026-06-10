import PropTypes from 'prop-types';
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as authApi from 'api/auth';
import { clearAccessToken, setAccessToken } from 'api/tokenStore';

export const AuthContext = createContext(undefined);

const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const ACTING_CLIENT_STORAGE_KEY = 'actingClientId';
const ACTING_CLIENT_NAME_STORAGE_KEY = 'actingClientName';
const SELECTED_CLIENT_ACCOUNT_STORAGE_KEY = 'selectedClientAccountId';

function readSessionValue(key) {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(key);
}

function writeSessionValue(key, value) {
  if (typeof window === 'undefined') return;
  if (value) {
    window.sessionStorage.setItem(key, value);
  } else {
    window.sessionStorage.removeItem(key);
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [impersonator, setImpersonator] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [actingClientId, setActingClientId] = useState(() => readSessionValue(ACTING_CLIENT_STORAGE_KEY));
  const [actingClientName, setActingClientName] = useState(() => readSessionValue(ACTING_CLIENT_NAME_STORAGE_KEY));
  const [selectedClientAccountId, setSelectedClientAccountId] = useState(() => readSessionValue(SELECTED_CLIENT_ACCOUNT_STORAGE_KEY));

  const refreshIntervalRef = useRef(null);
  const refreshInFlight = useRef(null);
  const lastRefreshAt = useRef(0);

  const updateSelectedClientAccount = useCallback((nextId) => {
    writeSessionValue(SELECTED_CLIENT_ACCOUNT_STORAGE_KEY, nextId || null);
    setSelectedClientAccountId(nextId || null);
  }, []);

  const updateActingClient = useCallback((nextId, nextName = null) => {
    writeSessionValue(ACTING_CLIENT_STORAGE_KEY, nextId || null);
    writeSessionValue(ACTING_CLIENT_NAME_STORAGE_KEY, nextId ? nextName || null : null);
    setActingClientId(nextId || null);
    setActingClientName(nextId ? nextName || null : null);
  }, []);

  const mergeAuthUser = useCallback((response) => {
    if (!response?.user) return null;
    return {
      ...response.user,
      effectiveRole: response.effectiveRole ?? response.user.effectiveRole,
      clientAccountRole: response.clientAccountRole ?? response.user.clientAccountRole ?? null
    };
  }, []);

  const syncClientAccountSelection = useCallback(
    (nextUser) => {
      const role = nextUser?.effectiveRole || nextUser?.role;
      const accounts = nextUser?.availableClientAccounts || [];

      if (role !== 'client' || !accounts.length) {
        updateSelectedClientAccount(null);
        return null;
      }

      const currentSelected = readSessionValue(SELECTED_CLIENT_ACCOUNT_STORAGE_KEY);
      if (currentSelected && accounts.some((account) => account.clientOwnerId === currentSelected)) {
        setSelectedClientAccountId(currentSelected);
        return currentSelected;
      }

      // Auto-select only when there's exactly one account. Users with multiple accounts
      // land on the account picker so they choose instead of defaulting to whichever sorts first.
      let fallbackId = nextUser.activeClientAccountId || null;
      if (!fallbackId && accounts.length === 1) {
        fallbackId = accounts[0].clientOwnerId;
      }
      updateSelectedClientAccount(fallbackId);
      return fallbackId;
    },
    [updateSelectedClientAccount]
  );

  const applyAuthResponse = useCallback(
    (response, options = {}) => {
      const { clearActing = false, clearSelected = false } = options;
      const mergedUser = mergeAuthUser(response);

      setUser(mergedUser);
      setImpersonator(response?.impersonator || null);

      if (clearActing) {
        updateActingClient(null);
      }

      if (clearSelected) {
        updateSelectedClientAccount(null);
      }

      syncClientAccountSelection(mergedUser);
      return mergedUser;
    },
    [mergeAuthUser, syncClientAccountSelection, updateActingClient, updateSelectedClientAccount]
  );

  const silentRefresh = useCallback(async () => {
    const now = Date.now();
    if (now - lastRefreshAt.current < 30000) return true;
    if (refreshInFlight.current) return refreshInFlight.current;

    refreshInFlight.current = (async () => {
      try {
        const res = await authApi.refreshSession();
        if (res?.accessToken) {
          setAccessToken(res.accessToken);
          applyAuthResponse(res);
          lastRefreshAt.current = Date.now();
          return true;
        }
        return false;
      } catch (err) {
        console.warn('[auth] Silent token refresh failed:', err.message);
        return false;
      } finally {
        refreshInFlight.current = null;
      }
    })();

    return refreshInFlight.current;
  }, [applyAuthResponse]);

  const startRefreshInterval = useCallback(() => {
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
    }

    refreshIntervalRef.current = setInterval(async () => {
      const success = await silentRefresh();
      if (!success) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    }, TOKEN_REFRESH_INTERVAL_MS);
  }, [silentRefresh]);

  const stopRefreshInterval = useCallback(() => {
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    authApi
      .refreshSession()
      .then((res) => {
        if (res?.accessToken) {
          setAccessToken(res.accessToken);
          applyAuthResponse(res);
          startRefreshInterval();
        } else {
          setUser(null);
        }
      })
      .catch(() => {
        clearAccessToken();
        setUser(null);
      })
      .finally(() => setInitializing(false));

    return () => stopRefreshInterval();
  }, [applyAuthResponse, startRefreshInterval, stopRefreshInterval]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && user) {
        silentRefresh();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [user, silentRefresh]);

  const refreshUser = useCallback(async () => {
    const res = await authApi.fetchCurrentUser();
    return applyAuthResponse(res);
  }, [applyAuthResponse]);

  const setClientAccount = useCallback(
    (nextId) => {
      updateSelectedClientAccount(nextId || null);
      setUser((prev) => {
        if (!prev) return prev;
        const accounts = prev.availableClientAccounts || [];
        const activeAccount = accounts.find((account) => account.clientOwnerId === nextId) || null;
        return {
          ...prev,
          activeClientAccountId: activeAccount?.clientOwnerId || prev.activeClientAccountId || null,
          clientAccountRole: activeAccount?.membershipRole || prev.clientAccountRole || null
        };
      });
    },
    [updateSelectedClientAccount]
  );

  const activePortalClientId = actingClientId || selectedClientAccountId || user?.activeClientAccountId || null;

  const activeClientAccount = useMemo(() => {
    const accounts = user?.availableClientAccounts || [];
    const activeAccountId = selectedClientAccountId || user?.activeClientAccountId || null;
    return accounts.find((account) => account.clientOwnerId === activeAccountId) || null;
  }, [selectedClientAccountId, user]);

  const value = useMemo(
    () => ({
      user,
      impersonator,
      initializing,
      actingClientId,
      actingClientName,
      selectedClientAccountId,
      activePortalClientId,
      activeClientAccount,
      setActingClient: (nextId, nextName) => {
        updateSelectedClientAccount(null);
        updateActingClient(nextId, nextName);
      },
      clearActingClient: () => updateActingClient(null),
      setClientAccount,
      clearClientAccount: () => setClientAccount(null),
      refreshUser,
      login: async (payload) => {
        const res = await authApi.login(payload);
        if (res?.requiresMfa) {
          return res;
        }
        if (res?.accessToken) {
          setAccessToken(res.accessToken);
        }
        const mergedUser = applyAuthResponse(res, { clearActing: true });
        startRefreshInterval();
        return mergedUser;
      },
      setAuthState: ({ user: newUser, accessToken }) => {
        if (accessToken) {
          setAccessToken(accessToken);
        }
        applyAuthResponse({ user: newUser }, { clearActing: true });
        startRefreshInterval();
      },
      impersonate: async (userId) => {
        const res = await authApi.impersonate(userId);
        if (res?.accessToken) {
          setAccessToken(res.accessToken);
        }
        const mergedUser = applyAuthResponse(res, { clearActing: true, clearSelected: true });
        return mergedUser;
      },
      verifyMfa: async (payload) => {
        const res = await authApi.verifyMfa(payload);
        if (res?.accessToken) {
          setAccessToken(res.accessToken);
        }
        const mergedUser = applyAuthResponse(res, { clearActing: true });
        startRefreshInterval();
        return mergedUser;
      },
      logout: async () => {
        stopRefreshInterval();
        await authApi.logout();
        clearAccessToken();
        setUser(null);
        setImpersonator(null);
        updateActingClient(null);
        updateSelectedClientAccount(null);
      }
    }),
    [
      user,
      impersonator,
      initializing,
      actingClientId,
      actingClientName,
      selectedClientAccountId,
      activePortalClientId,
      activeClientAccount,
      updateActingClient,
      updateSelectedClientAccount,
      setClientAccount,
      refreshUser,
      applyAuthResponse,
      startRefreshInterval,
      stopRefreshInterval
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

AuthProvider.propTypes = {
  children: PropTypes.node
};
