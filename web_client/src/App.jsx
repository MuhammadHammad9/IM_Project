import React, { useState, useEffect, useRef } from 'react';
import { Send, Search, MoreVertical, Check, CheckCheck, UserCircle2 } from 'lucide-react';
import useIMSocket from './useIMSocket';

function App() {
  const { 
    currentUser, users, messages, typings, authError, 
    login, signup, sendMessage, sendTyping, sendStatus 
  } = useIMSocket();

  const [authMode, setAuthMode] = useState('login'); // 'login' or 'signup'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  
  const [activeChat, setActiveChat] = useState("ALL");
  const [inputText, setInputText] = useState('');
  
  const scrollRef = useRef(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeChat, typings]);

  // Mark all messages as seen when changing chat
  useEffect(() => {
    if (activeChat !== "ALL" && messages[activeChat]) {
      messages[activeChat].forEach(msg => {
        if (msg.sender === activeChat && msg.status !== 'seen') {
          sendStatus(msg.id, 'seen');
        }
      });
    }
  }, [activeChat, messages[activeChat], sendStatus]);

  const handleAuth = (e) => {
    e.preventDefault();
    if (authMode === 'login') login(username, password);
    else signup(username, password);
  };

  const handleSend = (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    sendMessage(activeChat, inputText);
    setInputText('');
  };

  const handleTyping = (e) => {
    setInputText(e.target.value);
    // Debounce or limit sendTyping to not overwhelm if activeChat != ALL
    if (activeChat !== "ALL") {
       sendTyping(activeChat);
    }
  };

  // Auth Screen
  if (!currentUser) {
    return (
      <div className="auth-container">
        <div className="auth-box">
          <div className="auth-tabs">
             <button className={authMode==='login'?'active':''} onClick={()=>setAuthMode('login')}>Login</button>
             <button className={authMode==='signup'?'active':''} onClick={()=>setAuthMode('signup')}>Sign Up</button>
          </div>
          <h1>{authMode === 'login' ? 'Welcome Back' : 'Create Account'}</h1>
          <form onSubmit={handleAuth}>
            <input type="text" placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} required />
            <input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} required />
            <button type="submit">{authMode === 'login' ? 'Log in' : 'Sign up'}</button>
          </form>
          {authError && <p style={{color: '#ff5f56', marginTop: '16px', fontSize: '14px', fontWeight: '500'}}>{authError}</p>}
        </div>
      </div>
    );
  }

  // Active chat details
  const activeMessages = messages[activeChat] || [];
  const activeTyping = activeChat !== "ALL" && typings[activeChat];
  
  // Contacts list
  const contacts = ["ALL", ...users.filter(u => u !== currentUser)];

  return (
    <div className="app">
      <div className="sidebar">
        <div className="header">
          <div className="user-profile">
            <div className="avatar"><UserCircle2 size={24} /></div>
            {currentUser}
          </div>
          <button className="btn-icon"><MoreVertical size={20} /></button>
        </div>
        
        <div className="search-bar">
          <input type="text" placeholder="Search or start new chat" />
        </div>
        
        <div className="contact-list">
          {contacts.map(contact => (
            <div 
              key={contact} 
              className={`contact-item ${activeChat === contact ? 'active' : ''}`}
              onClick={() => setActiveChat(contact)}
            >
              <div className="avatar">
                {contact === "ALL" ? "🌐" : contact.charAt(0).toUpperCase()}
              </div>
              <div className="contact-info">
                <div className="contact-name">{contact === "ALL" ? "Global Chat" : contact}</div>
                {contact !== "ALL" && typings[contact] ? (
                  <div className="contact-status" style={{color: '#00a884'}}>typing...</div>
                ) : (
                  messages[contact] && messages[contact].some(m => m.status !== 'seen' && m.sender === contact) ? (
                    <div className="contact-status" style={{color: '#00a884', fontWeight: 'bold'}}>New message!</div>
                  ) : null
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="chat-area">
        <div className="chat-bg"></div>
        <div className="header">
          <div className="user-profile">
             <div className="avatar">{activeChat === "ALL" ? "🌐" : activeChat.charAt(0).toUpperCase()}</div>
             <div>
                <div className="contact-name">{activeChat === "ALL" ? "Global Chat" : activeChat}</div>
                <div className="contact-status" style={{fontSize: '13px', color: 'var(--text-muted)'}}>
                   {activeTyping ? <span style={{color: '#00a884'}}>typing...</span> : (activeChat !== "ALL" && 'online')}
                </div>
             </div>
          </div>
          <button className="btn-icon"><Search size={20} /></button>
        </div>

        <div className="messages-list" ref={scrollRef}>
          {activeMessages.length === 0 ? (
            <div className="empty-chat">
              <h2>Say hello to {activeChat}!</h2>
              <p>Send a message to start the conversation.</p>
            </div>
          ) : (
            activeMessages.map((msg, idx) => {
              const isMe = msg.sender === currentUser;
              const StatusIcon = msg.status === 'seen' ? CheckCheck : Check;
              
              return (
                <div key={idx} className={`msg-wrapper ${isMe ? 'out' : 'in'}`}>
                  <div className="message">
                    {activeChat === "ALL" && !isMe && msg.sender !== "System" && (
                      <div style={{color: '#4facfe', fontSize: '13px', fontWeight: '500', marginBottom: '4px'}}>{msg.sender}</div>
                    )}
                    <div className="msg-text" style={{ fontStyle: msg.sender === "System" ? 'italic' : 'normal' }}>
                      {msg.body}
                    </div>
                    <div className="msg-meta">
                      <div className="msg-time">{msg.time}</div>
                      {isMe && <div className={`msg-status ${msg.status === 'seen' ? 'status-seen' : 'status-sent'}`}><StatusIcon size={14} /></div>}
                    </div>
                  </div>
                </div>
              );
            })
          )}
          {activeTyping && (
            <div className="msg-wrapper in">
                <div className="message" style={{padding: '12px 16px', background: 'var(--msg-in)'}}>
                  <div className="typing">
                    <span className="dot"></span><span className="dot"></span><span className="dot"></span>
                  </div>
                </div>
            </div>
          )}
        </div>

        <form className="chat-input-area" onSubmit={handleSend}>
           <input 
              type="text" 
              placeholder="Type a message" 
              value={inputText}
              onChange={handleTyping}
           />
           <button type="submit" className="btn-icon" style={{background: 'var(--accent)', color: '#111b21', borderRadius: '50%', padding: '10px'}}>
              <Send size={18} style={{marginLeft: '-2px', marginTop: '2px'}}/>
           </button>
        </form>
      </div>
    </div>
  );
}

export default App;
