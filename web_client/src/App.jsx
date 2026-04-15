import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send, Search, LogOut, Check, CheckCheck,
  UserCircle2, Paperclip, X, Users, Globe, Wifi, WifiOff
} from 'lucide-react';
import useIMSocket, { getMimeType, isImageFile } from './useIMSocket';

function App() {
  const {
    connected, currentUser, users, messages, typings, authError,
    login, signup, logout,
    sendMessage, sendFile, sendTyping, sendStatus, syncHistory,
  } = useIMSocket();

  // ── Auth state ─────────────────────────────────────────────────────────────
  const [authMode, setAuthMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // ── Chat state ─────────────────────────────────────────────────────────────
  const [activeChat, setActiveChat]     = useState('ALL');
  const [inputText, setInputText]       = useState('');
  const [showSidebar, setShowSidebar]   = useState(true);
  const [searchQuery, setSearchQuery]   = useState('');
  const [showUserMenu, setShowUserMenu] = useState(false);

  const scrollRef     = useRef(null);
  const fileInputRef  = useRef(null);

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeChat, typings]);

  // ── Sync history when switching chats ─────────────────────────────────────
  useEffect(() => {
    if (currentUser && activeChat) {
      syncHistory(activeChat);
    }
  }, [currentUser, activeChat]);

  // ── Mark messages as seen (Fix #3: skip fromHistory messages) ─────────────
  useEffect(() => {
    if (activeChat !== 'ALL' && messages[activeChat]) {
      messages[activeChat].forEach(msg => {
        if (msg.sender === activeChat && msg.status !== 'seen' && !msg.fromHistory) {
          sendStatus(msg.id, 'seen', activeChat);
        }
      });
    }
  }, [activeChat, messages[activeChat]]);

  // ── Auth handler ───────────────────────────────────────────────────────────
  const handleAuth = (e) => {
    e.preventDefault();
    if (authMode === 'login') login(username, password);
    else signup(username, password);
  };

  // ── Send text message ──────────────────────────────────────────────────────
  const handleSend = (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    sendMessage(inputText, activeChat);
    setInputText('');
  };

  // ── File upload handler ────────────────────────────────────────────────────
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result.split(',')[1];
      sendFile(file.name, base64data, activeChat);
    };
    reader.readAsDataURL(file);
    e.target.value = null;
  };

  // ── Typing (debounced inside hook, just call it) ───────────────────────────
  const handleTyping = (e) => {
    setInputText(e.target.value);
    sendTyping(activeChat);
  };

  // ── Contact click ──────────────────────────────────────────────────────────
  const handleSelectChat = useCallback((contact) => {
    setActiveChat(contact);
    setSearchQuery('');
    if (window.innerWidth <= 768) setShowSidebar(false);
  }, []);

  // ── Computed values ────────────────────────────────────────────────────────
  const allContacts  = ['ALL', ...users.filter(u => u !== currentUser)];
  const contacts     = searchQuery
    ? allContacts.filter(c => c.toLowerCase().includes(searchQuery.toLowerCase()))
    : allContacts;

  const activeMessages = messages[activeChat] || [];
  // Fix #5: Only show "online" if the user is actually in the users list
  const isActiveChatOnline = activeChat !== 'ALL' && users.includes(activeChat);
  const activeTyping       = activeChat !== 'ALL' && typings[activeChat];

  // ─────────────────────────────────────────────────────────────────────────
  // AUTH SCREEN
  // ─────────────────────────────────────────────────────────────────────────
  if (!currentUser) {
    return (
      <div className="auth-container">
        <div className="auth-box">
          {/* Connection status indicator */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '8px', marginBottom: '20px', fontSize: '13px',
            color: connected ? '#5efc8d' : '#ff6b6b'
          }}>
            {connected
              ? <><Wifi size={14}/> Connected to server</>
              : <><WifiOff size={14}/> Connecting to server...</>
            }
          </div>

          <div className="auth-tabs">
            <button className={authMode === 'login'  ? 'active' : ''} onClick={() => setAuthMode('login')}>Login</button>
            <button className={authMode === 'signup' ? 'active' : ''} onClick={() => setAuthMode('signup')}>Sign Up</button>
          </div>
          <h1>{authMode === 'login' ? 'Welcome Back' : 'Create Account'}</h1>
          <form onSubmit={handleAuth}>
            <input
              type="text" placeholder="Username"
              value={username} onChange={e => setUsername(e.target.value)}
              required autoComplete="username"
            />
            <input
              type="password" placeholder="Password (min 4 chars)"
              value={password} onChange={e => setPassword(e.target.value)}
              required autoComplete="current-password"
            />
            <button type="submit" disabled={!connected}>
              {connected ? (authMode === 'login' ? 'Log in' : 'Sign up') : 'Waiting for server…'}
            </button>
          </form>
          {authError && (
            <p style={{ color: '#ff5f56', marginTop: '16px', fontSize: '14px', fontWeight: '500' }}>
              ⚠ {authError}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN CHAT UI
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── SIDEBAR ─────────────────────────────────────────────────────── */}
      <div className={`sidebar ${showSidebar ? 'show' : 'hide'}`}>

        {/* Profile header */}
        <div className="header">
          <div className="user-profile">
            <div className="avatar">{currentUser.charAt(0).toUpperCase()}</div>
            <div>
              <div className="contact-name">{currentUser}</div>
              <div style={{ fontSize: '12px', color: connected ? '#5efc8d' : '#ff6b6b', display: 'flex', alignItems: 'center', gap: '4px' }}>
                {connected ? <><Wifi size={11}/> Online</> : <><WifiOff size={11}/> Reconnecting…</>}
              </div>
            </div>
          </div>
          {/* User menu */}
          <div style={{ position: 'relative' }}>
            <button className="btn-icon" onClick={() => setShowUserMenu(v => !v)}>
              <Users size={20} />
            </button>
            {showUserMenu && (
              <div className="dropdown-menu">
                <button className="dropdown-item danger" onClick={logout}>
                  <LogOut size={14}/> Logout
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Search bar (Fix #10: functional filter) */}
        <div className="search-bar">
          <div style={{ position: 'relative' }}>
            <Search size={16} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search contacts…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ paddingLeft: '40px' }}
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}>
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Contact list */}
        <div className="contact-list">
          {contacts.map(contact => {
            const chatMsgs  = messages[contact] || [];
            const lastMsg   = chatMsgs.length > 0 ? chatMsgs[chatMsgs.length - 1] : null;
            const hasUnread = chatMsgs.some(m => m.status !== 'seen' && m.sender === contact && !m.fromHistory);
            const isOnline  = contact === 'ALL' || users.includes(contact);

            return (
              <div
                key={contact}
                className={`contact-item ${activeChat === contact ? 'active' : ''}`}
                onClick={() => handleSelectChat(contact)}
              >
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div className="avatar">
                    {contact === 'ALL' ? <Globe size={20} /> : contact.charAt(0).toUpperCase()}
                  </div>
                  {/* Fix #5: Online indicator dot only for real online users */}
                  {contact !== 'ALL' && (
                    <div style={{
                      position: 'absolute', bottom: '2px', right: '2px',
                      width: '10px', height: '10px', borderRadius: '50%',
                      background: isOnline ? '#5efc8d' : '#6b7280',
                      border: '2px solid var(--bg-deep)'
                    }} />
                  )}
                </div>

                <div className="contact-info">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="contact-name">{contact === 'ALL' ? 'Global Chat' : contact}</div>
                    {lastMsg && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{lastMsg.time}</div>}
                  </div>

                  {contact !== 'ALL' && typings[contact] ? (
                    <div className="contact-status" style={{ color: '#4facfe' }}>typing…</div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '3px' }}>
                      <div className="contact-status" style={{
                        color: hasUnread ? '#fff' : 'var(--text-muted)',
                        fontWeight: hasUnread ? 600 : 400,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px'
                      }}>
                        {lastMsg
                          ? (lastMsg.sender === currentUser ? `You: ` : '')
                            + (lastMsg.isFile ? `📎 ${lastMsg.fileName}` : lastMsg.body)
                          : 'No messages yet'}
                      </div>
                      {hasUnread && <div className="new-msg-badge">New</div>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {contacts.length === 0 && searchQuery && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px', fontSize: '14px' }}>
              No contacts match "{searchQuery}"
            </div>
          )}
        </div>
      </div>

      {/* ── CHAT AREA ────────────────────────────────────────────────────── */}
      <div className={`chat-area ${!showSidebar ? 'show' : 'hide'}`}>
        <div className="chat-bg" />

        {/* Chat header */}
        <div className="header">
          {window.innerWidth <= 768 && (
            <button className="btn-icon" onClick={() => setShowSidebar(true)} style={{ marginRight: '10px' }}>
              ←
            </button>
          )}
          <div className="user-profile">
            <div style={{ position: 'relative' }}>
              <div className="avatar">
                {activeChat === 'ALL' ? <Globe size={20} /> : activeChat.charAt(0).toUpperCase()}
              </div>
              {activeChat !== 'ALL' && (
                <div style={{
                  position: 'absolute', bottom: '2px', right: '2px',
                  width: '10px', height: '10px', borderRadius: '50%',
                  background: isActiveChatOnline ? '#5efc8d' : '#6b7280',
                  border: '2px solid var(--bg-deep)'
                }} />
              )}
            </div>
            <div>
              <div className="contact-name">{activeChat === 'ALL' ? 'Global Chat' : activeChat}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {activeTyping
                  ? <span style={{ color: '#4facfe' }}>typing…</span>
                  : activeChat === 'ALL'
                    ? `${users.length} online`
                    : isActiveChatOnline ? <span style={{ color: '#5efc8d' }}>Online</span> : 'Offline'
                }
              </div>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="messages-list" ref={scrollRef}>
          {activeMessages.length === 0 ? (
            <div className="empty-chat">
              <h2>Say hello! 👋</h2>
              <p>Start the conversation with {activeChat === 'ALL' ? 'everyone' : activeChat}.</p>
            </div>
          ) : (
            // Fix #9: use msg.id as key, not array index
            activeMessages.map(msg => {
              const isMe = msg.sender === currentUser;
              const StatusIcon = msg.status === 'seen' ? CheckCheck : Check;

              return (
                <div key={msg.id} className={`msg-wrapper ${isMe ? 'out' : 'in'}`}>
                  <div className="message">
                    {/* Sender label in group chat */}
                    {activeChat === 'ALL' && !isMe && msg.sender !== 'System' && (
                      <div style={{ fontSize: '12px', fontWeight: 600, color: '#4facfe', marginBottom: '4px' }}>
                        {msg.sender}
                      </div>
                    )}

                    {/* Message content */}
                    <div style={{ fontStyle: msg.sender === 'System' ? 'italic' : 'normal' }}>
                      {msg.isFile ? (
                        // Fix #2: Use correct MIME type from filename
                        isImageFile(msg.fileName) ? (
                          <img
                            src={`data:${getMimeType(msg.fileName)};base64,${msg.fileData}`}
                            alt={msg.fileName}
                            style={{ maxWidth: '240px', maxHeight: '300px', borderRadius: '10px', display: 'block' }}
                          />
                        ) : (
                          <a
                            href={`data:${getMimeType(msg.fileName)};base64,${msg.fileData}`}
                            download={msg.fileName}
                            style={{ color: '#4facfe', textDecoration: 'underline' }}
                          >
                            📄 {msg.fileName}
                          </a>
                        )
                      ) : (
                        <span style={{ wordBreak: 'break-word' }}>{msg.body}</span>
                      )}
                    </div>

                    {/* Meta: time + status */}
                    <div className="msg-meta">
                      <span className="msg-time">{msg.time}</span>
                      {isMe && msg.sender !== 'System' && (
                        <span className={`msg-status status-${msg.status}`}>
                          <StatusIcon size={14} />
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* Typing indicator */}
          {activeTyping && (
            <div className="msg-wrapper in">
              <div className="message" style={{ padding: '12px 16px', background: 'var(--msg-in)' }}>
                <div className="typing">
                  <span className="dot" /><span className="dot" /><span className="dot" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input bar */}
        <form className="chat-input-area" onSubmit={handleSend}>
          <label className="btn-icon" style={{ cursor: 'pointer', flexShrink: 0 }}>
            <Paperclip size={20} />
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
          </label>
          <input
            type="text"
            placeholder="Type a message…"
            value={inputText}
            onChange={handleTyping}
          />
          <button type="submit" className="send-btn">
            <Send size={18} />
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;
