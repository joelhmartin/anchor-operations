import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, severity = 'info') => {
    // Accept either positional (message, severity) or object form
    // ({ message, type, severity }) — older callers used the object shape.
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const obj = message;
      severity = obj.severity || obj.type || severity;
      message = obj.message ?? '';
    }
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message: String(message ?? ''), severity }]);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useMemo(() => ({
    success: (msg) => addToast(msg, 'success'),
    error: (msg) => addToast(msg, 'error'),
    warning: (msg) => addToast(msg, 'warning'),
    info: (msg) => addToast(msg, 'info'),
    showToast: (msg, severity = 'info') => addToast(msg, severity)
  }), [addToast]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {toasts.map((t) => (
        <Snackbar
          key={t.id}
          open
          autoHideDuration={5000}
          onClose={() => removeToast(t.id)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        >
          <Alert severity={t.severity} onClose={() => removeToast(t.id)} sx={{ width: '100%' }}>
            {t.message}
          </Alert>
        </Snackbar>
      ))}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback if not wrapped in provider
    return {
      success: (msg) => console.log('[toast:success]', msg),
      error: (msg) => console.error('[toast:error]', msg),
      warning: (msg) => console.warn('[toast:warning]', msg),
      info: (msg) => console.info('[toast:info]', msg),
      showToast: (msg, severity = 'info') => console.log(`[toast:${severity}]`, msg)
    };
  }
  return ctx;
}

