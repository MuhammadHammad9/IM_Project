import { useState, useEffect, useCallback, useRef } from 'react';

// ─── Constants ───────────────────────────────────────────────────────────────
const WS_URL             = 'ws://localhost:8080';
const RECONNECT_BASE_MS  = 2000;  // increased from 1500 to give server more breathing room
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

// ─── E2EE Encryption Helpers ──────────────────────────────────────────────────
async function generateKeyPair() {
  return await window.crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"]
  );
}

async function exportKey(key) {
  const exported = await window.crypto.subtle.exportKey("jwk", key);
  return JSON.stringify(exported);
}

async function importPublicKey(jwkString) {
  const jwk = JSON.parse(jwkString);
  return await window.crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );
}

async function encryptBody(body, publicKeyJwk) {
  try {
    const key = await importPublicKey(publicKeyJwk);
    const enc = new TextEncoder();
    const encrypted = await window.crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      key,
      enc.encode(body)
    );
    return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
  } catch (e) {
    if (body && body.length > 20) {
        console.warn("Encryption failed", e);
    }
    return body;
  }
}

async function decryptBody(encryptedBase64, privateKey) {
  if (!privateKey) return "[Key Missing - Undecryptable]";
  try {
    const binary = atob(encryptedBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      bytes
    );
    const dec = new TextDecoder();
    return dec.decode(decrypted);
  } catch (e) {
    // console.warn("Decryption failed", e);
    return "[Encrypted Message]";
  }
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
  const [adminStats,   setAdminStats]   = useState(null);
  const [linkPreviews, setLinkPreviews] = useState({}); // url -> preview obj

  // ── Refs (never cause stale closures) ─────────────────────────────────────
  const wsRef          = useRef(null);  
  const userRef        = useRef(null);  
  const pendingUser    = useRef(null);  
  const reconnAttempt  = useRef(0);
  const reconnTimer    = useRef(null);
  const typingTimer    = useRef(null);
  const shouldReconn   = useRef(true);
  const myPrivKey      = useRef(null);

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
  dispatchRef.current = useCallback(async (data) => {
    switch (data.type) {

      case 'login_ok':
      case 'signup_ok': {
        const name = pendingUser.current;
        userRef.current = name;
        setCurrentUser(name);
        setAuthError('');
        reconnAttempt.current = 0;
        
        // E2EE Key Init — persist keys in localStorage so they survive reconnects.
        // Without this, a new key pair is generated on every page load and all
        // previous DMs become permanently undecryptable (BUG-4).
        try {
          const storedPrivStr = localStorage.getItem(`im_privkey_${name}`);
          const storedPubStr  = localStorage.getItem(`im_pubkey_${name}`);

          if (storedPrivStr && storedPubStr) {
            // Restore existing key pair
            const privJwk = JSON.parse(storedPrivStr);
            myPrivKey.current = await window.crypto.subtle.importKey(
              'jwk', privJwk,
              { name: 'RSA-OAEP', hash: 'SHA-256' },
              false, ['decrypt']
            );
            // Re-publish public key in case server lost it after a restart
            wsRef.current?.send(JSON.stringify({ type: 'profile_upd', public_key: storedPubStr }));
          } else {
            // First login for this user on this device — generate a fresh pair
            const keys = await generateKeyPair();
            myPrivKey.current = keys.privateKey;
            const pubJwkStr  = await exportKey(keys.publicKey);
            const privJwkStr = await exportKey(keys.privateKey);
            localStorage.setItem(`im_pubkey_${name}`, pubJwkStr);
            localStorage.setItem(`im_privkey_${name}`, privJwkStr);
            wsRef.current?.send(JSON.stringify({ type: 'profile_upd', public_key: pubJwkStr }));
          }
        } catch (e) {
          console.warn('E2EE key restore failed — generating fresh pair', e);
          const keys = await generateKeyPair();
          myPrivKey.current = keys.privateKey;
          const pubJwkStr = await exportKey(keys.publicKey);
          wsRef.current?.send(JSON.stringify({ type: 'profile_upd', public_key: pubJwkStr }));
        }

        wsRef.current?.send(JSON.stringify({ type: 'sync_history', contact: 'ALL' }));
        break;
      }

      case 'login_error':
        setAuthError(data.body || data.error || 'Authentication failed.');
        setCurrentUser(null);
        localStorage.removeItem('im_auth');
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
        break;

      case 'history': {
        const msgs = await Promise.all((data.messages || []).map(async m => {
          return { ...m, body: m.body, fromHistory: true };
        }));
        // Merge history with any live messages that already arrived (BUG-12).
        // History is older, so it goes first; live messages follow.
        // Dedup by ID so switching chats never shows duplicate messages.
        setMessages(prev => {
          const existing   = prev[data.contact] || [];
          const existingIds = new Set(existing.map(m => m.id));
          const freshMsgs  = msgs.filter(m => !existingIds.has(m.id));
          return { ...prev, [data.contact]: [...freshMsgs, ...existing] };
        });
        break;
      }

      case 'userlist':
        setUsers(data.users || []);
        break;

      case 'chat':
      case 'file':
      case 'voice': {
        const isMe      = data.sender === userRef.current;
        const room      = data.recipient === 'ALL' ? 'ALL'
                        : isMe ? data.recipient : data.sender;

        if (!isMe && document.visibilityState === 'hidden') {
          playBeep();
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`New message from ${data.sender}`, {
              body: data.type === 'chat' ? data.body : `📎 ${data.filename || 'Voice Message'}`,
            });
          }
        }

        let body = data.body;

        const msgObj = {
          id:          data.msg_id || `${Date.now()}`,
          sender:      data.sender,
          body:        body || null,
          type:        data.type,
          isFile:      data.type === 'file',
          fileName:    data.filename || null,
          fileData:    data.data     || null,
          voiceData:   data.type === 'voice' ? data.data : null,
          time:        data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status:      'sent',
          fromHistory: false,
          is_pinned:   data.is_pinned || false,
          reactions:   {},
          reply_to:    data.reply_to || null,
        };

        setMessages(prev => {
          const existing = prev[room] || [];
          if (existing.some(m => m.id === msgObj.id)) return prev;
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

      case 'edit_message':
        setMessages(prev => {
          const next = {};
          for (const [k, msgs] of Object.entries(prev)) {
            next[k] = msgs.map(m => m.id === data.msg_id ? { ...m, body: data.body, is_edited: true } : m);
          }
          return next;
        });
        break;

      case 'link_preview_result':
        setLinkPreviews(prev => ({ ...prev, [data.url]: data }));
        break;

      case 'reaction':
        setMessages(prev => {
            const next = {};
            for (const [k, msgs] of Object.entries(prev)) {
                next[k] = msgs.map(m => {
                    if (m.id !== data.msg_id) return m;
                    const reactions = { ...(m.reactions || {}) };
                    if (data.action === 'add') {
                        reactions[data.emoji] = (reactions[data.emoji] || 0) + 1;
                    } else {
                        if (reactions[data.emoji]) reactions[data.emoji]--;
                        if (reactions[data.emoji] === 0) delete reactions[data.emoji];
                    }
                    return { ...m, reactions };
                });
            }
            return next;
        });
        break;

      case 'pin_update':
        setMessages(prev => {
            const next = {};
            for (const [k, msgs] of Object.entries(prev)) {
                next[k] = msgs.map(m => m.id === data.msg_id ? { ...m, is_pinned: data.is_pinned } : m);
            }
            return next;
        });
        break;

      case 'admin_stats':
        setAdminStats(data.stats);
        break;

      case 'search_results':
        // Overwrite active chat with search results or handle in a separate state.
        // For now, let's inject it as a special chat room 'SEARCH_RESULTS'.
        setMessages(prev => ({
          ...prev,
          SEARCH_RESULTS: data.results.map(m => ({
            id: m.msg_id,
            sender: m.sender,
            recipient: m.recipient,
            body: m.snippet || m.body, // Use snippet if available!
            time: m.timestamp.substring(11, 16),
            status: m.status,
            fromHistory: true
          }))
        }));
        break;

      case 'webrtc_signal': {
        // This would be caught by a listener in App.jsx or handled here
        window.dispatchEvent(new CustomEvent('im-webrtc-signal', { detail: data }));
        break;
      }

      case 'typing':
        setTypings(prev => ({ ...prev, [data.sender]: true }));
        setTimeout(() => setTypings(prev => {
          const n = { ...prev }; delete n[data.sender]; return n;
        }), 2500);
        break;

      // Server join/leave notifications — show in the global chat (BUG-16)
      case 'system': {
        const sysMsg = {
          id:          `system_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          sender:      'System',
          body:        data.body,
          type:        'system',
          time:        data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status:      'seen',
          fromHistory: false,
          reactions:   {},
        };
        setMessages(prev => {
          const existing = prev['ALL'] || [];
          return { ...prev, ALL: [...existing, sysMsg] };
        });
        break;
      }

      default: break;
    }
  }, [playBeep]);

  // ── WebSocket connect / reconnect ─────────────────────────────────────────
  const connectRef = useRef(null);
  connectRef.current = () => {
    // Guard: don't open a new connection if one is already open OR connecting.
    // Without this, the reconnect timer can fire while a connection is still
    // in CONNECTING state (readyState 0), causing multiple simultaneous
    // TCP connections to pile up on the server's accept queue.
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => { setConnected(true); reconnAttempt.current = 0; };
    ws.onmessage = (ev) => { try { dispatchRef.current(JSON.parse(ev.data)); } catch (e) {} };
    ws.onclose = () => {
      wsRef.current = null; setConnected(false);
      if (!shouldReconn.current) return;
      const delay = Math.min(RECONNECT_BASE_MS * (2 ** reconnAttempt.current), RECONNECT_MAX_MS);
      reconnAttempt.current += 1;
      reconnTimer.current = setTimeout(() => connectRef.current?.(), delay);
    };
  };

  useEffect(() => {
    shouldReconn.current = true;
    connectRef.current();
    return () => { shouldReconn.current = false; clearTimeout(reconnTimer.current); wsRef.current?.close(); };
  }, []);

  // ── Send helpers ───────────────────────────────────────────────────────────
  const send = (obj) => wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify(obj));

  const login  = useCallback((u, p) => { pendingUser.current = u; send({ type: 'login', username: u, password: p }); }, []);
  const signup = useCallback((u, p) => { pendingUser.current = u; send({ type: 'signup', username: u, password: p }); }, []);

  const sendMessage = useCallback(async (body, recipient, reply_to = null) => {
    send({ type: 'chat', recipient, body, ...(reply_to ? { reply_to } : {}) });
  }, []);

  const sendFile = useCallback((filename, data, recipient) => send({ type: 'file', recipient, filename, data }), []);
  const sendVoice = useCallback((data_b64, recipient) => send({ type: 'voice', recipient, data: data_b64 }), []);
  const sendReaction = useCallback((msg_id, emoji, action = 'add') => send({ type: 'reaction', msg_id, emoji, action }), []);
  const sendScheduled = useCallback((body, recipient, scheduled_at, reply_to = null) =>
    send({ type: 'schedule', body, recipient, scheduled_at, ...(reply_to ? { reply_to } : {}) }), []);
  const sendEdit = useCallback((msg_id, body) => send({ type: 'edit', msg_id, body }), []);
  const sendLinkPreview = useCallback((url) => send({ type: 'link_preview', url }), []);
  const updateProfile = useCallback((profile) => send({ type: 'profile_upd', ...profile }), []);
  const togglePin = useCallback((msg_id) => send({ type: 'pin', msg_id }), []);
  const getAdminStats = useCallback(() => send({ type: 'admin_stats' }), []);
  const doSearch = useCallback((query) => send({ type: 'search', query }), []);
  const performAdminAction = useCallback((action, target, body = '') => send({ type: 'admin_action', action, target, body }), []);
  const sendTyping = useCallback((recipient) => {
    if (!recipient || recipient === 'ALL') return;
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => send({ type: 'typing', recipient }), TYPING_DEBOUNCE_MS);
  }, []);

  const sendStatus = useCallback((msg_id, status, contact) => {
    send({ type: 'status', msg_id, status });
    if (contact) {
      setMessages(prev => {
        if (!prev[contact]) return prev;
        return { ...prev, [contact]: prev[contact].map(m => m.id === msg_id ? { ...m, status } : m) };
      });
    }
  }, []);

  const syncHistory = useCallback((contact) => send({ type: 'sync_history', contact }), []);

  const logout = useCallback(() => {
    shouldReconn.current = false; clearTimeout(reconnTimer.current);
    wsRef.current?.close(); wsRef.current = null; userRef.current = null; pendingUser.current = null;
    myPrivKey.current = null;   // clear in-memory key on logout
    setCurrentUser(null); setMessages({}); setUsers([]); setConnected(false);
  }, []);

  return {
    connected, currentUser, users, messages, typings, authError, adminStats, linkPreviews,
    login, signup, logout,
    sendMessage, sendFile, sendVoice, sendTyping, sendStatus, syncHistory,
    sendReaction, updateProfile, togglePin, getAdminStats, performAdminAction,
    doSearch, sendScheduled, sendEdit, sendLinkPreview,
    sendWebRTCSignal: (recipient, signal) => send({ type: 'webrtc', recipient, signal }),
    sendKeyExchange:  (publicKey) => send({ type: 'key_exchange', public_key: publicKey }),
  };
}
