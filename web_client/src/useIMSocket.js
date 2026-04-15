import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Constants ───────────────────────────────────────────────────────────────
const WS_URL             = 'ws://localhost:8080';
const RECONNECT_BASE_MS  = 1500;
const RECONNECT_MAX_MS   = 30000;
const TYPING_DEBOUNCE_MS = 350;

// ─── Pure helper functions (no hooks) ────────────────────────────────────────
export function getMimeType(filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png',  jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', txt: 'text/plain',
    mp4: 'video/mp4',  mp3: 'audio/mpeg',
  };
  return map[ext] || 'application/octet-stream';
}

export function isImageFile(filename = '') {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filename || '');
}

// ─── Main hook ────────────────────────────────────────────────────────────────
export default function useIMSocket() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [connected,    setConnected]    = useState(false);
  const [currentUser,  setCurrentUser]  = useState(null);
  const [users,        setUsers]        = useState([]);
  const [messages,     setMessages]     = useState({});
  const [typings,      setTypings]      = useState({});
  const [authError,    setAuthError]    = useState('');

  // ── Refs (never cause stale closures) ─────────────────────────────────────
  const wsRef          = useRef(null);  // The active WebSocket instance
  const userRef        = useRef(null);  // Currently logged-in username
  const pendingUser    = useRef(null);  // Username waiting for auth response
  const reconnAttempt  = useRef(0);
  const reconnTimer    = useRef(null);
  const typingTimer    = useRef(null);
  const shouldReconn   = useRef(true);  // Set false on manual logout

  // ── Audio notification ─────────────────────────────────────────────────────
  const playBeep = useCallback(() => {
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
      gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      gain.gain.linearRampToValueAtTime(0,    ctx.currentTime + 0.3);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch (_) {}
  }, []);

  // ── Packet dispatcher — lives in a ref so ws.onmessage never goes stale ───
  const dispatchRef = useRef(null);
  dispatchRef.current = useCallback((data) => {
    switch (data.type) {

      case 'login_ok':
      case 'signup_ok': {
        const name = pendingUser.current;
        userRef.current = name;
        setCurrentUser(name);
        setAuthError('');
        reconnAttempt.current = 0;
        // Immediately load global chat history after login
        wsRef.current?.send(JSON.stringify({ type: 'sync_history', contact: 'ALL' }));
        break;
      }

      case 'login_error':
        setAuthError(data.body || data.error || 'Authentication failed.');
        break;

      case 'history':
        setMessages(prev => ({
          ...prev,
          [data.contact]: (data.messages || []).map(m => ({ ...m, fromHistory: true })),
        }));
        break;

      case 'userlist':
        setUsers(data.users || []);
        break;

      case 'chat':
      case 'file': {
        const isMe      = data.sender === userRef.current;
        const room      = data.recipient === 'ALL' ? 'ALL'
                        : isMe ? data.recipient : data.sender;

        if (!isMe && document.visibilityState === 'hidden') {
          playBeep();
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`New message from ${data.sender}`, {
              body: data.type === 'chat' ? data.body : `📎 ${data.filename}`,
            });
          }
        }

        const msgObj = {
          id:          data.msg_id || `${Date.now()}`,
          sender:      data.sender,
          body:        data.body   || null,
          isFile:      data.type === 'file',
          fileName:    data.filename || null,
          fileData:    data.data     || null,
          time:        data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status:      'sent',
          fromHistory: false,
        };

        setMessages(prev => {
          const existing = prev[room] || [];
          if (existing.some(m => m.id === msgObj.id)) return prev; // deduplicate
          return { ...prev, [room]: [...existing, msgObj] };
        });
        break;
      }

      case 'status':
        setMessages(prev => {
          const next = {};
          for (const [k, msgs] of Object.entries(prev)) {
            next[k] = msgs.map(m => m.id === data.msg_id ? { ...m, status: data.status } : m);
          }
          return next;
        });
        break;

      case 'typing':
        setTypings(prev => ({ ...prev, [data.sender]: true }));
        setTimeout(() => setTypings(prev => {
          const n = { ...prev }; delete n[data.sender]; return n;
        }), 2000);
        break;

      case 'system':
        setMessages(prev => ({
          ...prev,
          ALL: [...(prev.ALL || []), {
            id:          `sys-${Date.now()}`,
            sender:      'System',
            body:        data.body,
            time:        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            status:      'seen',
            fromHistory: false,
          }],
        }));
        break;

      default: break;
    }
  }, [playBeep]);

  // ── WebSocket connect / reconnect ─────────────────────────────────────────
  // Use a ref for connect so the onclose handler always calls the latest version
  const connectRef = useRef(null);
  connectRef.current = () => {
    if (wsRef.current && wsRef.current.readyState < WebSocket.CLOSING) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnAttempt.current = 0;
    };

    ws.onmessage = (ev) => {
      try { dispatchRef.current(JSON.parse(ev.data)); }
      catch (e) { console.warn('[WS] Bad packet', e); }
    };

    ws.onerror = () => {};  // handled by onclose

    ws.onclose = () => {
      wsRef.current = null;
      setConnected(false);
      if (!shouldReconn.current) return;
      const delay = Math.min(
        RECONNECT_BASE_MS * (2 ** reconnAttempt.current),
        RECONNECT_MAX_MS
      );
      reconnAttempt.current += 1;
      reconnTimer.current = setTimeout(() => connectRef.current?.(), delay);
    };
  };

  // Mount: connect once, cleanup on unmount
  useEffect(() => {
    shouldReconn.current = true;
    connectRef.current();
    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    return () => {
      shouldReconn.current = false;
      clearTimeout(reconnTimer.current);
      wsRef.current?.close();
    };
  }, []);

  // ── Send helpers ───────────────────────────────────────────────────────────
  const send = (obj) => wsRef.current?.readyState === WebSocket.OPEN
    && wsRef.current.send(JSON.stringify(obj));

  const login  = useCallback((u, p) => {
    pendingUser.current = u;
    const doSend = () => send({ type: 'login', username: u, password: p });
    if (wsRef.current?.readyState === WebSocket.OPEN) doSend();
    else wsRef.current?.addEventListener('open', doSend, { once: true });
  }, []);

  const signup = useCallback((u, p) => {
    pendingUser.current = u;
    const doSend = () => send({ type: 'signup', username: u, password: p });
    if (wsRef.current?.readyState === WebSocket.OPEN) doSend();
    else wsRef.current?.addEventListener('open', doSend, { once: true });
  }, []);

  const sendMessage = useCallback((body, recipient) =>
    send({ type: 'chat', recipient, body }), []);

  const sendFile = useCallback((filename, data, recipient) =>
    send({ type: 'file', recipient, filename, data }), []);

  // Debounced typing indicator
  const sendTyping = useCallback((recipient) => {
    if (!recipient || recipient === 'ALL') return;
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() =>
      send({ type: 'typing', recipient }), TYPING_DEBOUNCE_MS);
  }, []);

  // Mark message seen — skip fromHistory messages (Fix #3)
  const sendStatus = useCallback((msg_id, status, contact) => {
    send({ type: 'status', msg_id, status });
    if (contact) {
      setMessages(prev => {
        if (!prev[contact]) return prev;
        return {
          ...prev,
          [contact]: prev[contact].map(m =>
            m.id === msg_id ? { ...m, status } : m
          ),
        };
      });
    }
  }, []);

  const syncHistory = useCallback((contact) =>
    send({ type: 'sync_history', contact }), []);

  const logout = useCallback(() => {
    shouldReconn.current = false;
    clearTimeout(reconnTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    userRef.current = null;
    pendingUser.current = null;
    reconnAttempt.current = 0;
    setCurrentUser(null);
    setMessages({});
    setUsers([]);
    setAuthError('');
    setConnected(false);
    // Re-enable reconnect for next login
    setTimeout(() => {
      shouldReconn.current = true;
      connectRef.current?.();
    }, 500);
  }, []);

  return {
    connected, currentUser, users, messages, typings, authError,
    login, signup, logout,
    sendMessage, sendFile, sendTyping, sendStatus, syncHistory,
  };
}
