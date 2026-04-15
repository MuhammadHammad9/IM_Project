import { useState, useCallback, useRef } from 'react';

export default function useIMSocket() {
  const [socket, setSocket] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState({});
  const [typings, setTypings] = useState({});
  const [authError, setAuthError] = useState('');
  
  // Keep track of the current user inside the closure without deps
  const userRef = useRef(null);
  const pendingUserRef = useRef(null);

  const connect = useCallback(() => {
    if (socket) return;
    const ws = new WebSocket('ws://localhost:8080');
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handlePacket(data);
      } catch (e) {
        console.error("Invalid packet:", event.data);
      }
    };
    
    ws.onclose = () => {
      setSocket(null);
      setCurrentUser(null);
      userRef.current = null;
    };
    
    setSocket(ws);
    return ws;
  }, [socket]);

  const handlePacket = (data) => {
    switch (data.type) {
      case 'login_ok':
      case 'signup_ok':
        setCurrentUser(pendingUserRef.current);
        userRef.current = pendingUserRef.current;
        setAuthError('');
        break;
      case 'login_error':
        setAuthError(data.body || data.error);
        break;
      case 'userlist':
        setUsers(data.users);
        break;
      case 'chat':
      case 'file':
        setMessages(prev => {
          const isMe = data.sender === userRef.current;
          let otherPerson = isMe ? data.recipient : data.sender;
          
          if (data.recipient === "ALL") {
            otherPerson = "ALL";
          }

          const msgObj = {
            id: data.msg_id,
            sender: data.sender,
            body: data.type === 'chat' ? data.body : `📄 Base64 Extracted File: ${data.filename}`,
            time: data.time || new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
            status: 'sent'
          };
          
          const newChat = [...(prev[otherPerson] || []), msgObj];
          return { ...prev, [otherPerson]: newChat };
        });
        break;
      case 'status':
        setMessages(prev => {
           const next = { ...prev };
           for (const user of Object.keys(next)) {
             next[user] = next[user].map(m => m.id === data.msg_id ? { ...m, status: data.status } : m);
           }
           return next;
        });
        break;
      case 'typing':
        setTypings(prev => ({ ...prev, [data.sender]: true }));
        setTimeout(() => {
          setTypings(prev => {
            const next = { ...prev };
            delete next[data.sender];
            return next;
          });
        }, 1500);
        break;
      case 'system':
        // Just insert it into ALL chat for simplicity
        setMessages(prev => {
          const newChat = [...(prev["ALL"] || []), {
            id: Date.now().toString(),
            sender: "System",
            body: data.body,
            time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
            status: 'seen'
          }];
          return { ...prev, ["ALL"]: newChat };
        });
        break;
      default:
        break;
    }
  };

  const executeAuth = (type, username, password) => {
    pendingUserRef.current = username;
    let ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws = connect();
    }
    
    // Wait for open if it's connecting
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.addEventListener('open', () => {
         ws.send(JSON.stringify({ type, username, password }));
      }, { once: true });
    } else if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, username, password }));
    }
  };

  const login = (username, password) => executeAuth('login', username, password);
  const signup = (username, password) => executeAuth('signup', username, password);

  const sendMessage = (recipient, body) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'chat', recipient, body }));
    }
  };

  const sendTyping = (recipient) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'typing', recipient }));
    }
  };

  const sendStatus = (msg_id, status) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'status', msg_id, status }));
    }
  };

  return {
    socket, currentUser, users, messages, typings, authError,
    login, signup, sendMessage, sendTyping, sendStatus, connect
  };
}
