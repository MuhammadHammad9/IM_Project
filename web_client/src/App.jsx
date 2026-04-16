import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send, Search, LogOut, Check, CheckCheck, Mic, Square,
  UserCircle2, Paperclip, X, Users, Globe, Wifi, WifiOff,
  Smile, Pin, Phone, Video, Settings, Shield, Trash2, Plus,
  ChevronLeft, Menu, MessageCircle, Clock, Edit2, Forward
} from 'lucide-react';
import useIMSocket, { getMimeType, isImageFile } from './useIMSocket';
import { THEME_BASES, THEME_GRADIENTS, applyTheme } from './themes';

const EMOJIS = ['❤️','😂','😍','🔥','👍','😢','😮','🎉','🙏','💯','👏','✨','💀','😭','🥺','🤔','👀','💪','🤌','🚀'];

const SwipeableMessageRow = ({ isMe, children, onSwipeToReply, msg }) => {
  const containerRef = useRef(null);
  const touchStartX = useRef(0);
  const touchCurrentX = useRef(0);

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    touchCurrentX.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e) => {
    touchCurrentX.current = e.touches[0].clientX;
    const delta = touchCurrentX.current - touchStartX.current;
    
    // Only swipe right, max 80px
    if (delta > 0 && delta < 80) {
      if (containerRef.current) {
        containerRef.current.style.transform = `translateX(${delta}px)`;
        containerRef.current.style.transition = 'none';
      }
    }
  };

  const handleTouchEnd = () => {
    const delta = touchCurrentX.current - touchStartX.current;
    if (containerRef.current) {
      containerRef.current.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
      containerRef.current.style.transform = `translateX(0px)`;
    }
    if (delta > 50) {
      onSwipeToReply({ id: msg.id, sender: msg.sender, body: msg.body });
    }
  };

  return (
    <div 
      className={`msg-row ${isMe ? 'out' : 'in'}`}
      ref={containerRef}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{ willChange: 'transform' }}
    >
      {children}
    </div>
  );
};

function App() {
  const {
    connected, currentUser, users, messages, typings, authError, adminStats, linkPreviews,
    login, signup, logout,
    sendMessage, sendFile, sendVoice, sendTyping, sendStatus, syncHistory,
    sendReaction, updateProfile, togglePin, getAdminStats, performAdminAction,
    sendWebRTCSignal, sendKeyExchange, doSearch, sendScheduled, sendEdit, sendLinkPreview
  } = useIMSocket();

  // -- States for Modals & Overlays ------------------------------------------
  const [showProfile, setShowProfile] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [desktopSidebarExpanded, setDesktopSidebarExpanded] = useState(false);
  const [showAdmin, setShowAdmin]     = useState(false);
  const [showCall, setShowCall]       = useState(false);
  const [callType, setCallType]       = useState('audio'); // 'audio' or 'video'
  const [isCalling, setIsCalling]     = useState(false);
  const [remoteStream, setRemoteStream] = useState(null);
  const [localStream, setLocalStream]   = useState(null);

  // -- Auth state -------------------------------------------------------------
  const [authMode, setAuthMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // -- Chat state -------------------------------------------------------------
  const [activeChat, setActiveChat]     = useState('ALL');
  const [inputText, setInputText]       = useState('');
  // showSidebar controls the mobile overlay sidebar; defaults to false on mobile
  const [showSidebar, setShowSidebar]   = useState(false);
  // activeMobilePanel: 'contacts' or 'chat' — controls which full-screen panel is shown on mobile
  const [activeMobilePanel, setActiveMobilePanel] = useState('contacts');
  const [searchQuery, setSearchQuery]   = useState('');
  const [showMsgSearch, setShowMsgSearch] = useState(false);
  const [msgSearchQuery, setMsgSearchQuery] = useState('');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isRecording, setIsRecording]   = useState(false);
  const [voiceBlob, setVoiceBlob]       = useState(null);
  const [recordTime, setRecordTime]     = useState(0);
  const [showUserList, setShowUserList] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(null); // msg_id
  const [editingMsg, setEditingMsg] = useState(null); // { id, body }
  const [showForwardModal, setShowForwardModal] = useState(null); // msg object

  // -- Mute & Archive state (persisted) ---------------------------------------
  const [mutedContacts,    setMutedContacts]    = useState(() => {
    try { return JSON.parse(localStorage.getItem('im_muted') || '[]'); } catch { return []; }
  });
  const [archivedContacts, setArchivedContacts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('im_archived') || '[]'); } catch { return []; }
  });
  const [showArchived, setShowArchived] = useState(false);

  const toggleMute    = (contact) => setMutedContacts(prev => {
    const next = prev.includes(contact) ? prev.filter(c => c !== contact) : [...prev, contact];
    localStorage.setItem('im_muted', JSON.stringify(next)); return next;
  });
  const toggleArchive = (contact) => setArchivedContacts(prev => {
    const next = prev.includes(contact) ? prev.filter(c => c !== contact) : [...prev, contact];
    localStorage.setItem('im_archived', JSON.stringify(next)); return next;
  });

  // -- Themes state -----------------------------------------------------------
  const [myBaseTheme, setMyBaseTheme] = useState(localStorage.getItem('im_base_theme') || 'stitch');
  const [myGradient, setMyGradient]   = useState(localStorage.getItem('im_gradient') || 'stitch');

  const handleThemeChange = (val) => {
    if (val.startsWith('color|')) {
      setMyBaseTheme(val.split('|')[1]);
      setMyGradient('none');
    } else if (val.startsWith('grad|')) {
      setMyBaseTheme('void_purple'); // Safe dark base for gradients
      setMyGradient(val.split('|')[1]);
    }
  };

  useEffect(() => {
    applyTheme(myBaseTheme, myGradient);
    localStorage.setItem('im_base_theme', myBaseTheme);
    localStorage.setItem('im_gradient', myGradient);
  }, [myBaseTheme, myGradient]);

  const mediaRecorderRef = useRef(null);
  const chunksRef        = useRef([]);
  const timerRef         = useRef(null);

  const scrollRef     = useRef(null);
  const fileInputRef  = useRef(null);
  const imgInputRef   = useRef(null);
  const seenRef       = useRef(new Set());   // tracks msg IDs already sent as 'seen'

  // -- Detect mobile ----------------------------------------------------------
  const isMobile = () => window.innerWidth <= 768;

  // -- Auto-scroll ------------------------------------------------------------
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeChat, typings]);

  // -- Sync history when switching chats --------------------------------------
  useEffect(() => {
    if (currentUser && activeChat) {
      syncHistory(activeChat);
    }
  }, [currentUser, activeChat]);

  // -- Draft Auto-save: restore draft when switching chats -------------------
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('im_drafts') || '{}');
      draftsRef.current = saved;
    } catch (_) {}
  }, []); // load once on mount

  useEffect(() => {
    if (activeChat) {
      const draft = draftsRef.current[activeChat] || '';
      setInputText(draft);
    }
  }, [activeChat]);

  // -- Mark messages as seen --------------------------------------------------
  useEffect(() => {
    if (activeChat !== 'ALL') {
      (messages[activeChat] || []).forEach(msg => {
        if (
          msg.sender === activeChat &&
          msg.status !== 'seen' &&
          !seenRef.current.has(msg.id)
        ) {
          seenRef.current.add(msg.id);
          sendStatus(msg.id, 'seen', activeChat);
        }
      });
    }
  }, [activeChat, messages]);

  // -- Update document title for unread badges --------------------------------
  useEffect(() => {
    let unreadCount = 0;
    Object.keys(messages).forEach(contact => {
      if (contact !== 'ALL') {
        const msgs = messages[contact] || [];
        msgs.forEach(m => {
          if (m.status !== 'seen' && m.sender === contact && !m.fromHistory) {
            unreadCount += 1;
          }
        });
      }
    });
    
    if (unreadCount > 0) {
      document.title = `(${unreadCount}) Stitch IM`;
    } else {
      document.title = `Stitch IM`;
    }
  }, [messages]);

  // -- Push Notification: Request permission on login -------------------------
  useEffect(() => {
    if (!currentUser) return;
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [currentUser]);

  // -- Push Notification: Trigger on background incoming messages ---------------
  useEffect(() => {
    if (!currentUser) return;
    const allMsgs = Object.values(messages).flat();
    const latest = allMsgs[allMsgs.length - 1];
    if (!latest) return;
    if (latest.sender === currentUser || latest.sender === 'System') return;
    if (mutedContacts.includes(latest.sender)) return;
    if (!document.hidden) return;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(latest.sender, {
        body: latest.body || '📎 Attachment',
        icon: '/favicon.svg',
        tag: latest.id,
      });
    }
  }, [messages]);

  // -- Link preview: auto-request on new messages with URLs -------------------
  useEffect(() => {
    const URL_REGEX = /https?:\/\/[^\s]+/g;
    const allMsgs = (messages[activeChat] || []);
    allMsgs.forEach(msg => {
      if (!msg.body || msg.isFile || msg.type === 'voice') return;
      const matches = msg.body.match(URL_REGEX);
      if (!matches) return;
      matches.forEach(url => {
        if (!linkPreviews[url]) {
          sendLinkPreview(url);
        }
      });
    });
  }, [messages, activeChat]);

  // -- Close menus when clicking outside -------------------------------------
  useEffect(() => {
    const closeMenus = (e) => {
      if (!e.target.closest('.attach-wrapper')) setShowAttachMenu(false);
      if (!e.target.closest('.user-profile')) setShowUserMenu(false);
      if (!e.target.closest('.emoji-picker-container') && !e.target.closest('.react-btn')) setShowEmojiPicker(null);
    };
    document.addEventListener('mousedown', closeMenus);
    return () => document.removeEventListener('mousedown', closeMenus);
  }, []);

  // -- Auth handler -----------------------------------------------------------
  const handleAuth = (e) => {
    e.preventDefault();
    if (authMode === 'login') login(username, password);
    else signup(username, password);
  };

  // -- Send text message ------------------------------------------------------
  const [replyingTo, setReplyingTo] = useState(null); // { id, sender, body }
  const draftsRef = useRef({}); // { [contact]: draftText }

  const [scheduleAt, setScheduleAt] = useState('');
  const [showScheduler, setShowScheduler] = useState(false);

  const handleSend = (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    if (scheduleAt) {
      // Send as a scheduled message
      sendScheduled(inputText, activeChat, scheduleAt, replyingTo?.id || null);
      setScheduleAt('');
      setShowScheduler(false);
    } else {
      sendMessage(inputText, activeChat, replyingTo?.id || null);
    }
    setInputText('');
    setReplyingTo(null);
    // Clear the draft for this chat
    draftsRef.current[activeChat] = '';
    try { localStorage.setItem('im_drafts', JSON.stringify(draftsRef.current)); } catch (_) {}
  };

  const handleMsgSearch = (e) => {
    e.preventDefault();
    if (msgSearchQuery.trim().length >= 2) {
      doSearch(msgSearchQuery);
      setActiveChat('SEARCH_RESULTS');
      setShowMsgSearch(false);
      setMsgSearchQuery('');
    }
  };

  // -- File upload handler ----------------------------------------------------
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

  const [showMentions, setShowMentions]         = useState(false);
  const [mentionQuery, setMentionQuery]         = useState('');

  // -- Typing (debounced inside hook) -----------------------------------------
  const handleTyping = (e) => {
    const val = e.target.value;
    setInputText(val);
    sendTyping(activeChat);

    const cursorPosition = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPosition);
    const match = textBeforeCursor.match(/@(\w*)$/);

    if (match) {
      setShowMentions(true);
      setMentionQuery(match[1].toLowerCase());
    } else {
      setShowMentions(false);
    }

    // Auto-save draft for current chat
    draftsRef.current[activeChat] = val;
    try { localStorage.setItem('im_drafts', JSON.stringify(draftsRef.current)); } catch (_) {}
  };

  // -- Voice Recording --------------------------------------------------------
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          sendVoice(base64, activeChat);
        };
        reader.readAsDataURL(blob);
        stream.getTracks().forEach(t => t.stop());
      };

      recorder.start();
      setIsRecording(true);
      setRecordTime(0);
      timerRef.current = setInterval(() => setRecordTime(t => t + 1), 1000);
    } catch (err) {
      alert('Microphone access denied or not available.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      clearInterval(timerRef.current);
    }
  };

  // -- Profile Update ---------------------------------------------------------
  const handleUpdateProfile = (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const upd = { 
      bio: formData.get('bio'),
      presence: formData.get('presence'),
      status_text: formData.get('status_text')
    };
    const avatarInput = e.target.querySelector('input[type="file"]');
    
    if (avatarInput && avatarInput.files[0]) {
      const reader = new FileReader();
      reader.onloadend = () => {
        upd.avatar = reader.result;
        updateProfile(upd);
        setShowProfile(false);
      };
      reader.readAsDataURL(avatarInput.files[0]);
    } else {
      upd.avatar = formData.get('avatar_url');
      updateProfile(upd);
      setShowProfile(false);
    }
  };

  // -- Select a chat ----------------------------------------------------------
  const handleSelectChat = useCallback((contact) => {
    setActiveChat(contact);
    setSearchQuery('');
    if (isMobile()) {
      setActiveMobilePanel('chat');
      setShowSidebar(false);
    }
  }, []);

  // -- Go back to contacts on mobile ------------------------------------------
  const handleBackToContacts = () => {
    setActiveMobilePanel('contacts');
  };

  // -- Toggle sidebar on mobile -----------------------------------------------
  const handleToggleSidebar = () => {
    setShowSidebar(prev => !prev);
  };

  // -- WebRTC calls -----------------------------------------------------------
  const [incomingCall, setIncomingCall] = useState(null); // { from, type, offer }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);

  const createPeerConnection = (otherUser) => {
    if (pcRef.current) pcRef.current.close();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWebRTCSignal(otherUser, { type: 'ice-candidate', candidate: event.candidate });
      }
    };
    
    pc.ontrack = (event) => {
      setRemoteStream(event.streams[0]);
    };
    
    pcRef.current = pc;
    return pc;
  };

  const endCall = useCallback((fromRemote = false) => {
    if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
    }
    setLocalStream(null);
    localStreamRef.current = null;
    setRemoteStream(null);
    setShowCall(false);
    setIsCalling(false);
    
    if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
    }

    if (!fromRemote) {
        // Find other user to notify
        sendWebRTCSignal('ALL', { type: 'ended_broadcast' }); // Fallback cleanup
    }
    setIncomingCall(null);
  }, [sendWebRTCSignal]);

  useEffect(() => {
    const handleSignal = async (e) => {
      const { sender, signal } = e.detail;
      
      try {
        if (signal.type === 'calling') {
          setIncomingCall({ from: sender, type: signal.callType, offer: signal.offer });
        } else if (signal.type === 'accepted') {
          setIsCalling(false);
          if (pcRef.current && signal.answer) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal.answer));
          }
        } else if (signal.type === 'ice-candidate') {
          if (pcRef.current && signal.candidate) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
          }
        } else if (signal.type === 'ended') {
          endCall(true);
        }
      } catch (err) {
        console.error("WebRTC Signal error:", err);
      }
    };
    window.addEventListener('im-webrtc-signal', handleSignal);
    return () => window.removeEventListener('im-webrtc-signal', handleSignal);
  }, [endCall]);

  const initiateCall = async (type) => {
    if (activeChat === 'ALL') return;
    setCallType(type);
    setShowCall(true);
    setIsCalling(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: type === 'video',
        audio: true
      });
      setLocalStream(stream);
      localStreamRef.current = stream;

      const pc = createPeerConnection(activeChat);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendWebRTCSignal(activeChat, { type: 'calling', callType: type, offer });
    } catch (err) {
      console.error(err);
      alert('Media access denied or error generating WebRTC offer.');
      setShowCall(false);
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;
    setCallType(incomingCall.type);
    setShowCall(true);
    setIsCalling(false);
    const peer = incomingCall.from;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: incomingCall.type === 'video',
        audio: true
      });
      setLocalStream(stream);
      localStreamRef.current = stream;

      const pc = createPeerConnection(peer);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      sendWebRTCSignal(peer, { type: 'accepted', answer });
      setActiveChat(peer);
      setIncomingCall(null);
    } catch (err) {
      console.error(err);
      alert('Media access denied or error accepting WebRTC call.');
      sendWebRTCSignal(peer, { type: 'ended' });
      setIncomingCall(null);
      setShowCall(false);
    }
  };

  const declineCall = () => {
    if (incomingCall) {
      sendWebRTCSignal(incomingCall.from, { type: 'ended' });
      setIncomingCall(null);
    }
  };

  // -- Computed values --------------------------------------------------------
  const allContacts  = ['ALL', ...users.map(u => u.username).filter(u => u !== currentUser)];
  const activeContacts = allContacts.filter(c => c === 'ALL' || !archivedContacts.includes(c));
  const contacts     = searchQuery
    ? activeContacts.filter(c => c.toLowerCase().includes(searchQuery.toLowerCase()))
    : showArchived
      ? allContacts.filter(c => archivedContacts.includes(c))
      : activeContacts;

  const activeMessages    = messages[activeChat] || [];
  const activeChatUser    = users.find(u => u.username === activeChat);
  const isActiveChatOnline= activeChat !== 'ALL' && !!activeChatUser;
  const activeTyping      = activeChat !== 'ALL' && typings[activeChat];
  const myProfile         = users.find(u => u.username === currentUser) || { username: currentUser, avatar: '', bio: '', is_admin: 0 };

  // ───────────────────────────────────────────────────────────────────────
  // AUTH SCREEN
  // ───────────────────────────────────────────────────────────────────────
  if (!currentUser) {
    return (
      <div className="auth-container">
        <div className="auth-box">
          {/* Connection status indicator */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '8px', marginBottom: '20px', fontSize: '13px', fontWeight: 600,
            color: connected ? '#00c47a' : '#ff6b6b'
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
          <h1>{authMode === 'login' ? 'Welcome Back 👋' : 'Create Account'}</h1>
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
            <p style={{ color: 'var(--danger)', marginTop: '16px', fontSize: '14px', fontWeight: 600 }}>
              ⚠ {authError}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  // MAIN CHAT UI
  // ───────────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* ── MOBILE SIDEBAR OVERLAY BACKDROP ──────────────────────── */}
      <div
        className={`sidebar-overlay ${showSidebar ? 'visible' : ''}`}
        onClick={() => setShowSidebar(false)}
        aria-hidden="true"
      />

      {/* ── STITCH GLOBAL SIDEBAR ─────────────────────────────────── */}
      <div className={`app-sidebar ${showSidebar ? 'sidebar-open' : ''} ${desktopSidebarExpanded ? 'sidebar-expanded' : ''}`}>
        <div className="user-profile">
          <div className="avatar" title="Options" onClick={() => setShowUserMenu(!showUserMenu)}>
            {myProfile.avatar ? (
              <img src={myProfile.avatar} alt="Avatar" />
            ) : (
              currentUser.charAt(0).toUpperCase()
            )}
            <div className={`presence-dot presence-${myProfile.presence || 'online'}`} style={{ border: '2px solid var(--sidebar-bg)' }} />
          </div>
          <div className="profile-info profile-name" onClick={() => setShowUserMenu(!showUserMenu)}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div>{currentUser} {myProfile.is_admin ? <Check size={14} color="var(--success)"/> : null}</div>
              {myProfile.status_text && <div className="status-text-muted">{myProfile.status_text}</div>}
            </div>
          </div>

          {showUserMenu && (
            <div className="dropdown-menu" style={{ top: '64px', left: '16px' }}>
              <button className="dropdown-item" onClick={() => { setShowProfile(true); setShowUserMenu(false); }}>
                <UserCircle2 size={16}/> My Profile
              </button>
              {myProfile.is_admin ? (
                <button className="dropdown-item" onClick={() => { getAdminStats(); setShowAdmin(true); setShowUserMenu(false); }}>
                  <Shield size={16}/> Admin Dashboard
                </button>
              ) : null}
              <button className="dropdown-item danger" onClick={logout}>
                <LogOut size={16}/> Logout
              </button>
            </div>
          )}
        </div>

        <div className="nav-menu">
          <div className="nav-item active" title="Chat" onClick={() => setShowSidebar(false)}>
            <Globe size={22} /> <span className="nav-label">Chat</span>
          </div>
          <div className="nav-item" title="Settings" onClick={() => { setShowSettings(true); setShowSidebar(false); }}>
            <Settings size={22} /> <span className="nav-label">Settings</span>
          </div>
        </div>

        {/* Desktop Expand Toggle */}
        <div className="nav-menu hide-on-mobile" style={{ marginTop: 'auto', marginBottom: '16px' }}>
           <div className="nav-item" title={desktopSidebarExpanded ? "Collapse" : "Expand"} onClick={() => setDesktopSidebarExpanded(!desktopSidebarExpanded)}>
             {desktopSidebarExpanded ? <ChevronLeft size={22} /> : <Menu size={22} />}
             <span className="nav-label">Collapse</span>
           </div>
        </div>
      </div>

      {/* ── STITCH WORKSPACE CARD ─────────────────────────────────── */}
      <div className="app-workspace">

        {/* ── CONTACTS COLUMN ───────────────────────────────────── */}
        <div className={`contact-column ${activeMobilePanel === 'chat' ? 'panel-hidden' : ''}`}>
          <div className="column-header">
            <div className="column-header-row">
              {/* Hamburger on mobile */}
              <button
                className="mobile-hamburger"
                onClick={handleToggleSidebar}
                aria-label="Open navigation menu"
              >
                <Menu size={20} />
              </button>
              <h2>Chat</h2>
            </div>
            <div className="search-pill">
              <Search className="search-icon" size={16} />
              <input
                type="text"
                placeholder="Search"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                aria-label="Search contacts"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="icon-btn" style={{ position: 'absolute', right: '14px' }} aria-label="Clear search">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          <div className="contact-list">
            {contacts.map(contact => {
              const chatMsgs    = messages[contact] || [];
              const lastMsg     = chatMsgs.length > 0 ? chatMsgs[chatMsgs.length - 1] : null;
              const hasUnread   = chatMsgs.some(m => m.status !== 'seen' && m.sender === contact && !m.fromHistory);
              const isOnline    = contact === 'ALL' || users.some(u => u.username === contact);
              const unreadCount = chatMsgs.filter(m => m.status !== 'seen' && m.sender === contact && !m.fromHistory).length;

              return (
                <div
                  key={contact}
                  className={`contact-card ${activeChat === contact ? 'active' : ''}`}
                  onClick={() => handleSelectChat(contact)}
                  onKeyDown={e => e.key === 'Enter' && handleSelectChat(contact)}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open chat with ${contact === 'ALL' ? 'Global Chat' : contact}`}
                >
                  <div className="avatar">
                    {contact === 'ALL' ? (
                      <Globe size={20} color="var(--brand)" />
                    ) : (
                      users.find(u => u.username === contact)?.avatar ? (
                        <img src={users.find(u => u.username === contact).avatar} alt="" style={{ width: '100%', height: '100%', borderRadius: '50%' }} />
                      ) : (
                        contact.charAt(0).toUpperCase()
                      )
                    )}
                    {isOnline && contact !== 'ALL' && <div className={`presence-dot presence-${users.find(u => u.username === contact)?.presence || 'online'}`} />}
                  </div>

                  <div className="contact-info">
                    <div className="contact-header">
                      <div className="contact-name">{contact === 'ALL' ? 'Global Chat' : contact}</div>
                      {lastMsg && <div className="contact-time">{lastMsg.time}</div>}
                    </div>

                    {contact !== 'ALL' && typings[contact] ? (
                      <div className="contact-status" style={{ color: 'var(--brand)', fontWeight: 600 }}>typing…</div>
                    ) : draftsRef.current[contact] ? (
                      <div className="contact-status" style={{ color: '#ffb833', fontWeight: 600 }}>
                        ✏️ {draftsRef.current[contact].slice(0, 28)}{draftsRef.current[contact].length > 28 ? '…' : ''}
                      </div>
                    ) : (
                      <div className="contact-status">
                        {lastMsg ? (
                          (lastMsg.sender === currentUser ? 'You: ' : '') + (lastMsg.isFile ? `📎 ${lastMsg.fileName}` : lastMsg.body)
                        ) : 'No messages yet'}
                      </div>
                    )}
                  </div>

                  {hasUnread && !mutedContacts.includes(contact) && <div className="unread-badge">{unreadCount}</div>}
                  {mutedContacts.includes(contact) && <span title="Muted" style={{ fontSize: '14px', opacity: 0.5 }}>🔕</span>}
                  {contact !== 'ALL' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', opacity: 0, transition: 'opacity 0.2s' }} className="contact-actions">
                      <button
                        title={mutedContacts.includes(contact) ? 'Unmute' : 'Mute'}
                        onClick={e => { e.stopPropagation(); toggleMute(contact); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--text-muted)', fontSize: '11px', lineHeight: 1 }}
                        aria-label={mutedContacts.includes(contact) ? 'Unmute contact' : 'Mute contact'}
                      >{mutedContacts.includes(contact) ? '🔔' : '🔕'}</button>
                      <button
                        title={archivedContacts.includes(contact) ? 'Unarchive' : 'Archive'}
                        onClick={e => { e.stopPropagation(); toggleArchive(contact); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--text-muted)', fontSize: '11px', lineHeight: 1 }}
                        aria-label={archivedContacts.includes(contact) ? 'Unarchive contact' : 'Archive contact'}
                      >{archivedContacts.includes(contact) ? '📂' : '📁'}</button>
                    </div>
                  )}
                </div>
              );
            })}
            {contacts.length === 0 && !showArchived && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px', fontSize: '14px' }}>
                {searchQuery ? `No contacts match "${searchQuery}"` : 'No active chats'}
              </div>
            )}
            {archivedContacts.length > 0 && !searchQuery && (
              <div
                onClick={() => setShowArchived(a => !a)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
                  cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                  color: 'var(--text-muted)', borderTop: '1px solid var(--border)',
                  marginTop: '4px', userSelect: 'none'
                }}
                role="button"
                aria-expanded={showArchived}
                aria-label="Toggle archived chats"
              >
                📁 Archived ({archivedContacts.length}) {showArchived ? '▲' : '▼'}
              </div>
            )}
          </div>
        </div>

        {/* ── CHAT AREA ─────────────────────────────────────────── */}
        <div className={`chat-area ${activeMobilePanel === 'chat' ? 'panel-active' : ''}`}>
          <div className="chat-header">
            {/* Mobile back button */}
            <button
              className="mobile-back-btn"
              onClick={handleBackToContacts}
              aria-label="Back to contacts"
            >
              <ChevronLeft size={20} />
            </button>

            {/* Mobile hamburger (desktop shows it in contacts col, here for chat view on mobile) */}

            <div className="chat-header-pill" onClick={() => activeChat === 'ALL' && setShowUserList(true)} style={{ cursor: activeChat === 'ALL' ? 'pointer' : 'default' }}>
              <div className="avatar">
                {activeChat === 'ALL' ? <Globe size={18} color="var(--brand)"/> : (
                  activeChatUser?.avatar ? <img src={activeChatUser.avatar} alt=""/> : activeChat.charAt(0).toUpperCase()
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="chat-header-title">{activeChat === 'ALL' ? 'Global Chat' : activeChat}</div>
                <div className="chat-header-subtitle">
                  {activeChat === 'ALL'
                    ? `${users.length} member${users.length !== 1 ? 's' : ''} online • View List`
                    : isActiveChatOnline 
                       ? `${activeChatUser?.presence === 'busy' ? '🔴 Busy' : activeChatUser?.presence === 'away' ? '🟠 Away' : activeChatUser?.presence === 'invisible' ? '⚪ Invisible' : '🟢 Online'}${activeChatUser?.status_text ? ` - ${activeChatUser?.status_text}` : ''}`
                       : 'Offline'
                  }
                </div>
              </div>
            </div>

            {/* Call buttons and Search */}
            <div className="chat-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {showMsgSearch ? (
                <form onSubmit={handleMsgSearch} style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-hover)', borderRadius: '20px', padding: '2px 8px' }}>
                  <input autoFocus type="text" placeholder="Search chats..." value={msgSearchQuery} onChange={(e) => setMsgSearchQuery(e.target.value)} style={{ border: 'none', background: 'transparent', outline: 'none', color: 'var(--text-primary)', fontSize: '13px', width: '120px' }} />
                  <button type="button" onClick={() => setShowMsgSearch(false)} className="icon-btn" style={{ padding: '4px' }}><X size={14}/></button>
                </form>
              ) : (
                <button className="icon-btn" onClick={() => setShowMsgSearch(true)} aria-label="Search messages"><Search size={18}/></button>
              )}
              {activeChat !== 'ALL' && activeChat !== 'SEARCH_RESULTS' && (
                <>
                  <button className="icon-btn" onClick={() => initiateCall('audio')} aria-label="Start audio call"><Phone size={18}/></button>
                  <button className="icon-btn" onClick={() => initiateCall('video')} aria-label="Start video call"><Video size={18}/></button>
                </>
              )}
            </div>
          </div>

          {/* Messages list */}
          <div className="messages-list" ref={scrollRef}>
            {activeMessages.length === 0 ? (
              <div className="empty-chat">
                <div className="empty-chat-icon">
                  <MessageCircle size={32} color="var(--brand)" />
                </div>
                <h2>Say hello! 👋</h2>
                <p>Start the conversation with {activeChat === 'ALL' ? 'everyone in the group' : activeChat}. Be the first to send a message!</p>
              </div>
            ) : (
              activeMessages.map(msg => {
                const isMe = msg.sender === currentUser;
                const StatusIcon = msg.status === 'seen' ? CheckCheck : Check;

                return (
                  <SwipeableMessageRow key={msg.id} msg={msg} isMe={isMe} onSwipeToReply={setReplyingTo}>
                    <div className="message" style={{ filter: msg.is_pinned ? 'drop-shadow(0 0 8px rgba(255, 215, 0, 0.4))' : 'none' }}>
                      {msg.is_pinned && <div style={{ fontSize: '10px', opacity: 0.6, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}><Pin size={10} /> Pinned</div>}

                      {activeChat === 'ALL' && !isMe && msg.sender !== 'System' && (
                        <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--brand)', marginBottom: '4px' }}>
                          {msg.sender}
                        </div>
                      )}

                      {/* Quoted reply bubble */}
                      {msg.reply_to && (() => {
                        const quoted = activeMessages.find(m => m.id === msg.reply_to);
                        return quoted ? (
                          <div style={{
                            background: isMe ? 'rgba(255,255,255,0.15)' : 'rgba(94,25,230,0.06)',
                            borderLeft: '3px solid var(--brand)',
                            borderRadius: '6px',
                            padding: '6px 10px',
                            marginBottom: '6px',
                            fontSize: '12px',
                            cursor: 'pointer'
                          }}>
                            <div style={{ fontWeight: 700, color: 'var(--brand)', marginBottom: '2px' }}>{quoted.sender}</div>
                            <div style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '220px' }}>
                              {quoted.body}
                            </div>
                          </div>
                        ) : null;
                      })()}

                      <div style={{ fontStyle: msg.sender === 'System' ? 'italic' : 'normal' }}>
                        {msg.type === 'voice' ? (
                          <div className="audio-player">
                            <button className="play-btn" aria-label="Play voice message"><Square size={14} fill="#fff" stroke="none"/></button>
                            <img className="audio-waveform" src="https://upload.wikimedia.org/wikipedia/commons/e/ea/Sound_Wave_%281%29.png" style={{ filter: isMe ? 'invert(1) brightness(2)' : 'hue-rotate(240deg)' }} alt="waveform" />
                            <audio src={`data:audio/webm;base64,${msg.voiceData}`} controls />
                          </div>
                        ) : msg.isFile ? (
                          isImageFile(msg.fileName) ? (
                            <img
                              src={`data:${getMimeType(msg.fileName)};base64,${msg.fileData}`}
                              alt={msg.fileName}
                              loading="lazy"
                            />
                          ) : (
                            <a href={`data:${getMimeType(msg.fileName)};base64,${msg.fileData}`} download={msg.fileName} style={{ color: 'inherit', textDecoration: 'underline' }}>
                              📄 {msg.fileName}
                            </a>
                          )
                        ) : (
                          editingMsg?.id === msg.id ? (
                            <form onSubmit={(e) => {
                              e.preventDefault();
                              if (editingMsg.body !== msg.body && editingMsg.body.trim()) {
                                sendEdit(msg.id, editingMsg.body);
                              }
                              setEditingMsg(null);
                            }} style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '150px' }}>
                              <input
                                type="text"
                                value={editingMsg.body}
                                onChange={e => setEditingMsg({ ...editingMsg, body: e.target.value })}
                                style={{ width: '100%', padding: '6px', borderRadius: '4px', border: 'none', background: 'rgba(255,255,255,0.9)', color: '#000', outline: 'none' }}
                                autoFocus
                              />
                              <div style={{ display: 'flex', gap: '8px', fontSize: '11px' }}>
                                <button type="submit" style={{ cursor: 'pointer', background: 'none', border: '1px solid currentColor', borderRadius: '4px', padding: '2px 6px', color: 'inherit' }}>Save</button>
                                <button type="button" onClick={() => setEditingMsg(null)} style={{ cursor: 'pointer', background: 'none', border: '1px solid currentColor', borderRadius: '4px', padding: '2px 6px', color: 'inherit' }}>Cancel</button>
                              </div>
                            </form>
                          ) : (
                            <span style={{ wordBreak: 'break-word' }}>
                              {activeChat === 'SEARCH_RESULTS' && msg.body.includes('**') ? (
                                msg.body.split(new RegExp('\\*\\*(.*?)\\*\\*', 'g')).map((part, i) => i % 2 === 1 ? <b key={i} style={{color: 'var(--brand)', background: 'rgba(94,25,230,0.1)', padding: '0 2px', borderRadius: '2px'}}>{part}</b> : part)
                              ) : (
                                msg.body.split(/(@[a-zA-Z0-9_]+)/g).map((part, i) => 
                                  part.startsWith('@') ? <span key={i} style={{ color: 'var(--brand)', fontWeight: 700, cursor: 'pointer', borderBottom: '1px dotted var(--brand)' }}>{part}</span> : part
                                )
                              )}
                            </span>
                          )
                        )}
                       </div>

                      {/* Link Preview Cards */}
                      {msg.body && !msg.isFile && msg.type !== 'voice' && (() => {
                        const urlMatches = msg.body.match(/https?:\/\/[^\s]+/g) || [];
                        return urlMatches.map(url => {
                          const preview = linkPreviews[url];
                          if (!preview) return null;
                          return (
                            <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="link-preview-card" tabIndex={0} aria-label={`Link preview: ${preview.title || url}`}>
                              {preview.image && <img className="link-preview-card__img" src={preview.image} alt={preview.title || ''} loading="lazy" />}
                              <div className="link-preview-card__body">
                                {preview.title && <div className="link-preview-card__title">{preview.title}</div>}
                                {preview.description && <div className="link-preview-card__desc">{preview.description}</div>}
                                <div className="link-preview-card__url">{url}</div>
                              </div>
                            </a>
                          );
                        });
                      })()}

                      {/* Message time + read status */}
                      <div className="msg-meta">
                        <span>{msg.time} {msg.is_edited && <span style={{ opacity: 0.6, fontStyle: 'italic', marginLeft: '4px' }}>(edited)</span>}</span>
                        {isMe && msg.sender !== 'System' && <StatusIcon size={12} />}
                      </div>
                    </div>

                    {/* Reactions below text */}
                    {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                      <div className="reactions-list">
                        {Object.entries(msg.reactions).map(([char, count]) => (
                          <div 
                            key={char} 
                            className="reaction-badge"
                            onClick={() => sendReaction(msg.id, char, 'add')}
                          >
                            {char} <span>{count}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Hover actions (pin / react / reply) */}
                    {msg.sender !== 'System' && (
                      <div className="msg-hover-actions">
                        {isMe && msg.type === 'chat' && <button className="icon-btn" style={{ color: '#fff' }} onClick={() => setEditingMsg({ id: msg.id, body: msg.body })} aria-label="Edit message"><Edit2 size={12}/></button>}
                        <button className="icon-btn" style={{ color: '#fff' }} onClick={() => setReplyingTo({ id: msg.id, sender: msg.sender, body: msg.body })} aria-label="Reply">↩</button>
                        <button className="icon-btn" style={{ color: '#fff' }} onClick={() => setShowForwardModal({ id: msg.id, sender: msg.sender, body: msg.body, type: msg.type, fileData: msg.fileData, fileName: msg.fileName, voiceData: msg.voiceData, isFile: msg.isFile })} aria-label="Forward message"><Forward size={12}/></button>
                        <button className="icon-btn" style={{ color: '#fff' }} onClick={() => togglePin(msg.id)} aria-label="Pin message"><Pin size={12}/></button>
                        <div style={{ position: 'relative' }}>
                          <button className="icon-btn react-btn" style={{ color: '#fff' }} onClick={() => setShowEmojiPicker(showEmojiPicker === msg.id ? null : msg.id)} aria-label="React"><Smile size={12}/></button>
                          {showEmojiPicker === msg.id && (
                            <div className="emoji-picker-container">
                              {EMOJIS.map(emoji => (
                                <button key={emoji} className="emoji-btn" onClick={() => { sendReaction(msg.id, emoji); setShowEmojiPicker(null); }}>
                                  {emoji}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </SwipeableMessageRow>
                );
              })
            )}

            {/* Animated typing indicator */}
            {activeTyping && (
              <div className="msg-row in">
                <div className="message" style={{ padding: '12px 18px' }}>
                  <div className="typing-dots">
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Chat Input */}
          {activeChat !== 'SEARCH_RESULTS' && (
            <div className="chat-input-container">
              {/* Reply banner */}
              {replyingTo && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '8px 16px',
                  background: 'rgba(94,25,230,0.07)',
                  borderLeft: '3px solid var(--brand)',
                  borderRadius: '8px 8px 0 0',
                  fontSize: '13px'
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--brand)', fontSize: '12px' }}>↩ Replying to {replyingTo.sender}</div>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{replyingTo.body}</div>
                  </div>
                  <button className="icon-btn" onClick={() => setReplyingTo(null)} aria-label="Cancel reply" style={{ fontSize: '18px', lineHeight: 1, padding: '0 4px' }}>×</button>
                </div>
              )}
              {/* Mentions Autocomplete */}
              {showMentions && (
                <div style={{
                  marginBottom: '10px', background: 'var(--card-bg)', border: '1px solid var(--border)',
                  borderRadius: '12px', padding: '8px', minWidth: '200px',
                  boxShadow: 'var(--shadow-lg)', zIndex: 100, maxHeight: '200px', overflowY: 'auto'
                }}>
                  {users.filter(u => u.username.toLowerCase().startsWith(mentionQuery)).map(u => (
                    <div 
                      key={u.username}
                      onClick={() => {
                        const val = inputText;
                        const inputEl = document.querySelector('input[aria-label="Message input"]');
                        const cursorPosition = inputEl ? inputEl.selectionStart : val.length;
                        const textBefore = val.slice(0, cursorPosition);
                        const match = textBefore.match(/@(\w*)$/);
                        if (match) {
                          const replaced = val.slice(0, match.index) + `@${u.username} ` + val.slice(cursorPosition);
                          setInputText(replaced);
                        }
                        setShowMentions(false);
                        if (inputEl) inputEl.focus();
                      }}
                      style={{ padding: '8px 12px', cursor: 'pointer', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <div className="avatar" style={{ width: '24px', height: '24px', fontSize: '10px' }}>
                        {u.avatar ? <img src={u.avatar} alt=""/> : u.username.charAt(0).toUpperCase()}
                      </div>
                      <span style={{ fontSize: '13px', fontWeight: 600 }}>{u.username}</span>
                    </div>
                  ))}
                  {users.filter(u => u.username.toLowerCase().startsWith(mentionQuery)).length === 0 && (
                    <div style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>No users found</div>
                  )}
                </div>
              )}

              <form className="chat-input-pill" onSubmit={handleSend}>

              {isRecording ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--danger)' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: 'var(--danger)', flexShrink: 0, animation: 'typingBounce 1s ease-in-out infinite' }} />
                  <span style={{ fontWeight: 700, fontSize: '14px' }}>Recording {recordTime}s…</span>
                  <button type="button" onClick={stopRecording} className="icon-btn" aria-label="Stop recording" style={{ marginLeft: 'auto', backgroundColor: 'var(--danger)', borderRadius: '50%', color: '#fff', padding: '8px' }}>
                    <Square size={15} />
                  </button>
                </div>
              ) : (
                <>
                  <button type="button" className="icon-btn hide-xs" onClick={startRecording} aria-label="Record voice message">
                    <Mic size={18} />
                  </button>

                  <input
                    type="text"
                    placeholder="Type something…"
                    value={inputText}
                    onChange={handleTyping}
                    aria-label="Message input"
                  />

                  <button className="icon-btn hide-xs" type="button" onClick={() => sendReaction(messages[activeChat]?.[messages[activeChat].length - 1]?.id, '😂')} aria-label="Send emoji reaction">
                    <Smile size={18} />
                  </button>

                  <div className="attach-wrapper" style={{ position: 'relative' }}>
                    <button type="button" className="icon-btn" onClick={() => setShowAttachMenu(!showAttachMenu)} aria-label="Attach file">
                      <Paperclip size={18} />
                    </button>
                    {showAttachMenu && (
                      <div className="attach-menu">
                        <label className="attach-menu-item">
                          <Paperclip size={14}/> Upload Document
                          <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={(e) => { handleFileUpload(e); setShowAttachMenu(false); }} />
                        </label>
                        <label className="attach-menu-item">
                          <Globe size={14}/> Insert Image
                          <input ref={imgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { handleFileUpload(e); setShowAttachMenu(false); }} />
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Schedule message clock */}
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setShowScheduler(!showScheduler)}
                      aria-label="Schedule message"
                      title="Schedule message"
                      style={{ color: scheduleAt ? 'var(--brand)' : undefined }}
                    >
                      <Clock size={18} />
                    </button>
                    {showScheduler && (
                      <div style={{
                        position: 'absolute', bottom: '48px', right: 0, zIndex: 50,
                        background: 'var(--card-bg)', border: '1px solid var(--border)',
                        borderRadius: '12px', padding: '12px 14px', minWidth: '220px',
                        boxShadow: 'var(--shadow-lg)'
                      }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px', color: 'var(--brand)' }}>
                          ⏰ Schedule for
                        </div>
                        <input
                          type="datetime-local"
                          value={scheduleAt}
                          onChange={e => setScheduleAt(e.target.value)}
                          style={{
                            width: '100%', padding: '6px 8px', borderRadius: '8px',
                            border: '1px solid var(--border)', fontSize: '13px',
                            background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none'
                          }}
                        />
                        {scheduleAt && (
                          <button onClick={() => { setScheduleAt(''); setShowScheduler(false); }}
                            style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                            Clear schedule
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <button type="submit" className="send-btn" aria-label={scheduleAt ? 'Schedule message' : 'Send message'}
                    style={{ background: scheduleAt ? 'linear-gradient(135deg, #ffb833, #ff8c00)' : undefined }}>
                    {scheduleAt ? <Clock size={16} /> : <Send size={16} />}
                  </button>
                </>
              )}
            </form>
          </div>
          )}
        </div>
      </div>

      {/* ── PROFILE MODAL ────────────────────────────────────────────────── */}
      {showProfile && (
        <div className="modal-overlay" onClick={() => setShowProfile(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2>Edit Profile</h2>
              <button className="icon-btn" onClick={() => setShowProfile(false)} aria-label="Close profile modal"><X size={20}/></button>
            </div>
            <form onSubmit={handleUpdateProfile}>
              <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                <div className="avatar" style={{ width: '72px', height: '72px', fontSize: '28px', margin: '0 auto 12px' }}>
                  {myProfile.avatar
                    ? <img src={myProfile.avatar} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : currentUser.charAt(0).toUpperCase()
                  }
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <input type="file" accept="image/*" style={{ fontSize: '12px' }} />
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>OR use a URL</div>
                  <input type="text" name="avatar_url" placeholder="Avatar URL" defaultValue={myProfile.avatar} style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none' }} />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Status & Presence</div>
                <select name="presence" defaultValue={myProfile.presence || 'online'} style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none' }}>
                  <option value="online" style={{ background: 'var(--bg-workspace)', color: 'var(--text-primary)' }}>🟢 Online</option>
                  <option value="busy" style={{ background: 'var(--bg-workspace)', color: 'var(--text-primary)' }}>🔴 Busy</option>
                  <option value="away" style={{ background: 'var(--bg-workspace)', color: 'var(--text-primary)' }}>🟠 Away</option>
                  <option value="invisible" style={{ background: 'var(--bg-workspace)', color: 'var(--text-primary)' }}>⚪ Invisible</option>
                </select>
                <input type="text" name="status_text" placeholder="Status: Working hard..." defaultValue={myProfile.status_text} style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none' }} />
                
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginTop: '8px' }}>Bio</div>
                <textarea name="bio" placeholder="Tell us about yourself…" defaultValue={myProfile.bio} style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical' }} />
              </div>

              <button type="submit" style={{
                marginTop: '24px', padding: '14px',
                background: 'var(--brand)', color: '#fff',
                border: 'none', borderRadius: 'var(--radius-md)',
                fontSize: '15px', fontWeight: 700, fontFamily: 'inherit',
                cursor: 'pointer', width: '100%',
                boxShadow: '0 4px 15px var(--brand-glow)',
                transition: 'transform 0.2s, box-shadow 0.2s'
              }}>
                Save Profile
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── SETTINGS MODAL ────────────────────────────────────────────────── */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h2>Settings</h2>
              <button className="icon-btn" onClick={() => setShowSettings(false)} aria-label="Close settings modal"><X size={20}/></button>
            </div>
            
            <div style={{ position: 'relative', marginBottom: '24px' }}>
              <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '12px' }}/>
              <input type="text" placeholder="Search and add here..." style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', fontSize: '14px' }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
               <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>✨ Appearance Theme</h3>
               <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Selected Theme (Base & Gradient)</p>
               
               <select 
                  value={myGradient === 'none' ? `color|${myBaseTheme}` : `grad|${myGradient}`}
                  onChange={e => handleThemeChange(e.target.value)} 
                  style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer', fontSize: '14px' }}
               >
                 <optgroup label="Solid Colors" style={{ background: 'var(--bg-workspace)', color: 'var(--text-primary)' }}>
                   {THEME_BASES.map(t => <option key={`color|${t.id}`} value={`color|${t.id}`}>{t.name}</option>)}
                 </optgroup>
                 <optgroup label="Dynamic Gradients" style={{ background: 'var(--bg-workspace)', color: 'var(--text-primary)' }}>
                   {THEME_GRADIENTS.filter(g => g.id !== 'none').map(t => <option key={`grad|${t.id}`} value={`grad|${t.id}`}>{t.name}</option>)}
                 </optgroup>
               </select>

               <div style={{ marginTop: '16px', padding: '16px', background: 'var(--msg-out-bg)', borderRadius: 'var(--radius-md)', color: '#fff', textAlign: 'center', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.1)' }}>
                  <div style={{ fontWeight: 700, fontSize: '16px', textShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>Live Preview</div>
               </div>
            </div>
          </div>
        </div>
      )}

      {/* ── ADMIN DASHBOARD MODAL ───────────────────────────────────────── */}
      {showAdmin && (
        <div className="modal-overlay" onClick={() => setShowAdmin(false)}>
          <div className="modal-content admin-modal" style={{ width: 'min(900px, 95vw)', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', padding: '0 4px' }}>
              <div>
                <h2 style={{ fontSize: '24px', fontWeight: 800 }}>Admin Console</h2>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>Manage users and monitor server health</p>
              </div>
              <button className="icon-btn" onClick={() => setShowAdmin(false)} aria-label="Close admin dashboard"><X size={24}/></button>
            </div>

            {adminStats ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', overflowY: 'auto', padding: '4px' }}>
                {/* Stats Overview */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
                  <div className="stat-card" style={{ background: 'linear-gradient(135deg, #f0f7ff 0%, #e0efff 100%)', border: '1px solid rgba(0,100,255,0.1)' }}>
                    <Users size={20} color="#007bff" style={{ marginBottom: '8px' }}/>
                    <h3>Total Users</h3>
                    <p>{adminStats.total_users}</p>
                  </div>
                  <div className="stat-card" style={{ background: 'linear-gradient(135deg, #f5f0ff 0%, #ebe0ff 100%)', border: '1px solid rgba(94,25,230,0.1)' }}>
                    <MessageCircle size={20} color="var(--brand)" style={{ marginBottom: '8px' }}/>
                    <h3>Messages</h3>
                    <p>{adminStats.total_msgs}</p>
                  </div>
                  <div className="stat-card" style={{ background: 'linear-gradient(135deg, #f0fff4 0%, #e0ffea 100%)', border: '1px solid rgba(0,210,106,0.1)' }}>
                    <Paperclip size={20} color="#00ba5e" style={{ marginBottom: '8px' }}/>
                    <h3>Files</h3>
                    <p>{adminStats.total_files}</p>
                  </div>
                  <div className="stat-card" style={{ background: 'linear-gradient(135deg, #fffcf0 0%, #fff9e0 100%)', border: '1px solid rgba(255,193,7,0.1)' }}>
                    <Shield size={20} color="#ffc107" style={{ marginBottom: '8px' }}/>
                    <h3>DB Size</h3>
                    <p>{(adminStats.storage_size / 1024).toFixed(1)} KB</p>
                  </div>
                </div>

                {/* Global Announcement */}
                <div style={{ background: '#f8f9fc', padding: '20px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
                   <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                     <Globe size={16} color="var(--brand)"/> Broadcast System Announcement
                   </h3>
                   <form style={{ display: 'flex', gap: '10px' }} onSubmit={(e) => {
                     e.preventDefault();
                     const body = e.target.broadcast.value;
                     if (body) {
                        performAdminAction('broadcast', '', body);
                        e.target.broadcast.value = '';
                        alert('Announcement broadcasted!');
                     }
                   }}>
                     <input type="text" name="broadcast" placeholder="Enter message for all online users..." style={{ flex: 1, padding: '12px 16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px' }}/>
                     <button type="submit" className="send-btn" style={{ borderRadius: 'var(--radius-md)', width: 'auto', padding: '0 24px' }}>Send</button>
                   </form>
                </div>

                {/* User List Management */}
                <div>
                   <h3 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                     <Users size={18} color="var(--brand)"/> User Registry
                   </h3>
                   <div style={{ background: '#fff', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
                     <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
                        <thead>
                          <tr style={{ background: '#f8f9fc', borderBottom: '1px solid var(--border)' }}>
                            <th style={{ padding: '14px 20px', fontWeight: 700 }}>User</th>
                            <th style={{ padding: '14px 20px', fontWeight: 700 }}>Status</th>
                            <th style={{ padding: '14px 20px', fontWeight: 700, textAlign: 'right' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminStats.user_list?.map(u => (
                            <tr key={u.username} style={{ borderBottom: '1px solid rgba(0,0,0,0.03)' }}>
                              <td style={{ padding: '12px 20px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                  <div className="avatar" style={{ width: '32px', height: '32px', fontSize: '13px' }}>
                                    {u.avatar ? <img src={u.avatar} alt=""/> : u.username.charAt(0).toUpperCase()}
                                  </div>
                                  <div>
                                    <div style={{ fontWeight: 700 }}>{u.username} {u.is_admin ? <span style={{ fontSize: '10px', background: 'var(--brand)', color: '#fff', padding: '1px 6px', borderRadius: '4px', marginLeft: '4px' }}>ADMIN</span> : null}</div>
                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{u.bio || 'No bio'}</div>
                                  </div>
                                </div>
                              </td>
                              <td style={{ padding: '12px 20px' }}>
                                <div style={{ fontSize: '12px', fontWeight: 600, color: users.some(online => online.username === u.username) ? '#00d26a' : 'var(--text-muted)' }}>
                                  {users.some(online => online.username === u.username) ? '🟢 Online Now' : `Last seen: ${u.last_seen || 'Never'}`}
                                </div>
                              </td>
                              <td style={{ padding: '12px 20px', textAlign: 'right' }}>
                                {u.username !== currentUser ? (
                                  confirmDelete === u.username ? (
                                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                      <button 
                                        style={{ background: '#f0f0f0', color: '#333', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                                        onClick={() => setConfirmDelete(null)}
                                      >Cancel</button>
                                      <button 
                                        style={{ background: 'var(--danger)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
                                        onClick={() => {
                                          performAdminAction('delete_user', u.username);
                                          setConfirmDelete(null);
                                        }}
                                      >Confirm Delete</button>
                                    </div>
                                  ) : (
                                    <button 
                                      className="icon-btn danger" 
                                      style={{ color: 'var(--danger)', padding: '8px' }}
                                      onClick={() => setConfirmDelete(u.username)}
                                    >
                                      <Trash2 size={18}/>
                                    </button>
                                  )
                                ) : (
                                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>Fixed (Self)</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                     </table>
                   </div>
                </div>
              </div>
            ) : (
              <div style={{ margin: 'auto', textAlign: 'center', padding: '40px' }}>
                <div className="typing-dots"><div className="typing-dot"/><div className="typing-dot"/><div className="typing-dot"/></div>
                <p style={{ marginTop: '16px', color: 'var(--text-muted)', fontWeight: 600 }}>Fetching server statistics...</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── CALL OVERLAY ─────────────────────────────────────────────────── */}
      {incomingCall && !showCall && (
        <div className="modal-overlay" style={{ background: 'rgba(10, 5, 20, 0.95)' }}>
          <div style={{ background: '#fff', padding: '30px', borderRadius: '16px', textAlign: 'center', width: '90%', maxWidth: '300px' }}>
            <div className="avatar" style={{ width: '60px', height: '60px', margin: '0 auto 15px', fontSize: '24px' }}>
              {incomingCall.from.charAt(0).toUpperCase()}
            </div>
            <h3 style={{ margin: '0 0 5px 0', color: 'var(--text-primary)' }}>{incomingCall.from}</h3>
            <p style={{ margin: '0 0 20px 0', color: 'var(--text-muted)' }}>Incoming {incomingCall.type} call...</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button onClick={declineCall} style={{ background: 'var(--danger)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, flex: 1 }}>Decline</button>
              <button onClick={acceptCall} style={{ background: '#00d26a', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, flex: 1 }}>Accept</button>
            </div>
          </div>
        </div>
      )}

      {showCall && (
        <div className="modal-overlay" style={{ background: 'rgba(10, 5, 20, 0.95)' }}>
          <div style={{ width: '90%', maxWidth: '800px', textAlign: 'center', color: '#fff' }}>
            <div style={{ marginBottom: '30px' }}>
              <div className="avatar" style={{ width: '80px', height: '80px', margin: '0 auto 15px', fontSize: '30px' }}>
                {activeChat.charAt(0).toUpperCase()}
              </div>
              <h2 style={{ color: '#fff', fontSize: '22px' }}>{isCalling ? `Calling ${activeChat}…` : `In Call with ${activeChat}`}</h2>
              <p style={{ color: 'var(--brand-light)', marginTop: '8px', fontSize: '12px', letterSpacing: '1px', fontWeight: 700 }}>
                {callType.toUpperCase()} • ENCRYPTED
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '30px' }}>
              <div style={{ background: '#000', borderRadius: '20px', aspectRatio: '4/3', overflow: 'hidden', position: 'relative' }}>
                {localStream && callType === 'video' ? (
                  <video ref={v => v && (v.srcObject = localStream)} autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><UserCircle2 size={40} opacity={0.3}/></div>}
                <div style={{ position: 'absolute', bottom: '10px', left: '10px', fontSize: '12px', background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: '4px' }}>You</div>
              </div>
              <div style={{ background: '#000', borderRadius: '20px', aspectRatio: '4/3', overflow: 'hidden', position: 'relative' }}>
                {remoteStream && callType === 'video' ? (
                  <video ref={v => v && (v.srcObject = remoteStream)} autoPlay style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><UserCircle2 size={40} opacity={0.3}/></div>}
                <div style={{ position: 'absolute', bottom: '10px', left: '10px', fontSize: '12px', background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: '4px' }}>{activeChat}</div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '20px', justifyContent: 'center' }}>
              <button className="icon-btn" style={{ background: 'rgba(255,255,255,0.1)', padding: '16px', borderRadius: '50%', color: '#fff' }} aria-label="Mute microphone"><Mic size={24}/></button>
              <button className="icon-btn" onClick={endCall} style={{ background: '#ff4b4b', padding: '16px', borderRadius: '50%', color: '#fff' }} aria-label="End call"><X size={24}/></button>
            </div>
          </div>
        </div>
      )}
      {/* ── GLOBAL USER LIST MODAL ─────────────────────────────────────── */}
      {showUserList && (
        <div className="modal-overlay" onClick={() => setShowUserList(false)}>
          <div className="modal-content user-list-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2>Global Users</h2>
              <button className="icon-btn" onClick={() => setShowUserList(false)} aria-label="Close user list"><X size={20}/></button>
            </div>
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
              {users.map(u => (
                <div key={u.username} className="user-list-item">
                  <div className="avatar" style={{ width: '36px', height: '36px', fontSize: '14px' }}>
                    {u.avatar ? <img src={u.avatar} alt="" /> : u.username.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{u.username} {u.username === currentUser && '(You)'}</div>
                    <div style={{ fontSize: '11px', color: '#00d26a', fontWeight: 600 }}>Online</div>
                  </div>
                  <button className="icon-btn" onClick={() => { handleSelectChat(u.username); setShowUserList(false); }}>
                    <MessageCircle size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── FORWARD MODAL ──────────────────────────────────────────────── */}
      {showForwardModal && (
        <div className="modal-overlay" onClick={() => setShowForwardModal(null)}>
          <div className="modal-content user-list-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2>Forward Message</h2>
              <button className="icon-btn" onClick={() => setShowForwardModal(null)} aria-label="Close forward list"><X size={20}/></button>
            </div>
            
            <div style={{ padding: '12px', background: 'var(--bg-input)', borderRadius: '8px', marginBottom: '16px', fontSize: '13px', fontStyle: 'italic', color: 'var(--text-muted)' }}>
              {showForwardModal.isFile ? `Attachment: ${showForwardModal.fileName}` : showForwardModal.type === 'voice' ? 'Voice Message' : showForwardModal.body.substring(0, 50) + (showForwardModal.body.length > 50 ? '...' : '')}
            </div>

            <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
              {users.map(u => u.username !== currentUser && (
                <div key={u.username} className="user-list-item" onClick={() => {
                  if (showForwardModal.isFile) {
                    sendFile(showForwardModal.fileName, showForwardModal.fileData, u.username);
                  } else if (showForwardModal.type === 'voice') {
                    sendVoice(showForwardModal.voiceData, u.username);
                  } else {
                    sendMessage(`Forwarded from ${showForwardModal.sender}:\n\n${showForwardModal.body}`, u.username);
                  }
                  setShowForwardModal(null);
                  setActiveChat(u.username);
                }}>
                  <div className="avatar" style={{ width: '36px', height: '36px', fontSize: '14px' }}>
                    {u.avatar ? <img src={u.avatar} alt="" /> : u.username.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>{u.username}</div>
                  </div>
                  <button className="icon-btn" style={{ color: 'var(--brand)' }}>
                    <Forward size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
