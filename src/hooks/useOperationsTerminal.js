import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getAccessToken } from 'api/tokenStore';

function buildWsUrl(envId, token) {
  const base = (import.meta.env.VITE_APP_API_BASE || '/api').replace(/\/api\/?$/, '');
  let origin;
  if (base.startsWith('http')) {
    origin = base.replace(/^http/, 'ws');
  } else {
    origin = window.location.origin.replace(/^http/, 'ws') + base;
  }
  return `${origin}/ws/ssh?envId=${encodeURIComponent(envId)}&token=${encodeURIComponent(token)}`;
}

export default function useOperationsTerminal({ envId, containerRef, enabled }) {
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | open | closed | error
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled || !envId || !containerRef.current) return undefined;

    const token = getAccessToken();
    if (!token) {
      setStatus('error');
      setError('Not authenticated');
      return undefined;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      theme: { background: '#1e1e1e' },
      convertEol: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    termRef.current = term;
    fitRef.current = fit;

    setStatus('connecting');
    setError(null);
    const ws = new WebSocket(buildWsUrl(envId, token));
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('open');
      ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }));
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'error') {
        setError(msg.message || 'Terminal error');
        term.write(`\r\n[error] ${msg.message || 'unknown'}\r\n`);
      } else if (msg.type === 'exit') {
        term.write(`\r\n[exit ${msg.code ?? '?'}]\r\n`);
      } else if (msg.type === 'ready') {
        term.write('\x1b[2;37m[connected]\x1b[0m\r\n');
      }
    };
    ws.onerror = () => {
      setStatus('error');
      setError('WebSocket error');
    };
    ws.onclose = () => {
      setStatus('closed');
    };

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const onResize = () => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }));
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      onData.dispose();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [envId, enabled, containerRef]);

  return { status, error };
}
