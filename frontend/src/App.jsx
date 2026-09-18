import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:4000';

const demoUsers = [
  { id: 1, name: 'Alice Johnson', email: 'alice@callmind.demo', password: 'password123' },
  { id: 2, name: 'Ramesh Verma', email: 'ramesh@callmind.demo', password: 'password123' },
];

function formatDate(dateIso) {
  if (!dateIso) return 'No date';
  const date = new Date(dateIso);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getTranscriptForDisplay(record) {
  const segments = Array.isArray(record.speaker_segments) ? record.speaker_segments : [];
  if (segments.length > 0) {
    return segments.map((segment) => ({
      speaker: segment.speaker || 'Unknown',
      text: segment.text || '',
      time: segment.time || '',
    }));
  }

  const lines = String(record.full_transcript_text || '').split('\n');
  return lines.map((line) => ({
    speaker: line.startsWith('You:') ? 'You' : 'Contact',
    text: line.replace(/^You:|^\[.*\]:\s?/, ''),
    time: '',
  }));
}

export default function App() {
  const [user, setUser] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [transcripts, setTranscripts] = useState([]);
  const [chatInput, setChatInput] = useState('What has Ramesh promised me about the payment date across our calls?');
  const [chatAnswer, setChatAnswer] = useState('');
  const [callState, setCallState] = useState('idle');
  const [incomingCall, setIncomingCall] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [statusText, setStatusText] = useState('');

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localAudioRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const currentCallRef = useRef(null);

  const selectedContactName = useMemo(() => selectedContact?.contact_name || selectedContact?.contactName || 'Contact', [selectedContact]);

  const fetchContacts = async (currentUser) => {
    if (!currentUser) return;
    const res = await fetch(`${API_URL}/api/users/${currentUser.id}/contacts`);
    const nextContacts = await res.json();
    setContacts(nextContacts);
    if (nextContacts[0] && !selectedContact) {
      setSelectedContact(nextContacts[0]);
    }
  };

  const fetchTranscripts = async (contactId) => {
    if (!contactId) return;
    const res = await fetch(`${API_URL}/api/contacts/${contactId}/transcripts`);
    const rows = await res.json();
    setTranscripts(rows);
  };

  useEffect(() => {
    if (!user) return;
    fetchContacts(user);
  }, [user]);

  useEffect(() => {
    if (!selectedContact) return;
    fetchTranscripts(selectedContact.id);
  }, [selectedContact]);

  useEffect(() => {
    if (!user) return;
    const socket = io(WS_URL, { transports: ['websocket'] });
    socketRef.current = socket;
    socket.emit('register-user', { userId: user.id });

    socket.on('incoming-call', (payload) => {
      setIncomingCall(payload);
      setCallState('incoming');
      setStatusText(`${payload.callerName || 'Someone'} is calling`);
    });

    socket.on('call-accepted', async ({ signal }) => {
      if (!peerConnectionRef.current) return;
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(signal));
      setCallState('connected');
      setTranscribing(true);
      setStatusText('Call connected');
    });

    socket.on('webrtc-signal', async ({ signal }) => {
      if (!peerConnectionRef.current) return;
      if (signal && signal.type === 'candidate' && signal.candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (error) {
          console.warn('Could not add ICE candidate', error);
        }
      }
    });

    socket.on('transcript-saved', () => {
      if (selectedContact) fetchTranscripts(selectedContact.id);
    });

    return () => socket.disconnect();
  }, [user, selectedContact]);

  const createPeerConnection = async () => {
    if (peerConnectionRef.current) return peerConnectionRef.current;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    peerConnectionRef.current = pc;

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        setRemoteStream(stream);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && currentCallRef.current && socketRef.current) {
        const targetUserId = currentCallRef.current.receiverId || currentCallRef.current.callerId;
        socketRef.current.emit('webrtc-signal', { targetUserId, signal: event.candidate });
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setLocalStream(stream);
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });
    if (localAudioRef.current) {
      localAudioRef.current.srcObject = stream;
    }

    return pc;
  };

  const startCall = async (contact) => {
    if (!user || !contact) return;
    const recipientId = contact.contact_user_id ?? contact.id;
    const pc = await createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    currentCallRef.current = {
      callerId: user.id,
      receiverId: recipientId,
      callerName: user.name,
      receiverName: contact.contact_name || contact.name,
    };

    socketRef.current.emit('call-request', {
      callerId: user.id,
      receiverId: recipientId,
      contactId: contact.id,
      callerName: user.name,
      receiverName: contact.contact_name || contact.name,
      signal: offer,
    });

    setCallState('calling');
    setStatusText(`Calling ${contact.contact_name || contact.name}`);
    setConsentAccepted(true);
    setTranscribing(true);
  };

  const answerIncomingCall = async () => {
    if (!incomingCall) return;
    const pc = await createPeerConnection();
    if (incomingCall.signal) {
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.signal));
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socketRef.current.emit('call-accepted', {
      callerId: incomingCall.callerId,
      receiverId: user.id,
      contactId: incomingCall.contactId,
      signal: answer,
    });
    setCallState('connected');
    setStatusText('Incoming call accepted');
    setConsentAccepted(true);
    setTranscribing(true);
  };

  const persistLiveTranscript = async () => {
    if (!selectedContact || !user) return;

    const text = `You: Hi ${selectedContact.contact_name || selectedContact.name}, I want to confirm the payment date.\n[${selectedContact.contact_name || selectedContact.name}]: The revised payment date is Sept 12, not Sept 3. I will send the transfer by morning time.`;

    try {
      await fetch(`${API_URL}/api/transcripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: selectedContact.id,
          userId: user.id,
          timestamp: new Date().toISOString(),
          duration: 180,
          fullTranscriptText: text,
          speakerSegments: [
            { speaker: 'You', time: '00:00', text: `Hi ${selectedContact.contact_name || selectedContact.name}, I want to confirm the payment date.` },
            { speaker: selectedContact.contact_name || selectedContact.name, time: '00:16', text: 'The revised payment date is Sept 12, not Sept 3. I will send the transfer by morning time.' },
          ],
          scamFlag: false,
        }),
      });
      await fetchTranscripts(selectedContact.id);
    } catch (error) {
      console.warn('Could not persist transcript', error);
    }
  };

  const endCall = async () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    setLocalStream(null);
    setRemoteStream(null);
    setIncomingCall(null);
    setCallState('idle');
    setConsentAccepted(false);
    setTranscribing(false);
    setStatusText('Call ended');
    currentCallRef.current = null;

    await persistLiveTranscript();
  };

  const handleLogin = async (email, password) => {
    const res = await fetch(`${API_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Login failed');
      return;
    }
    setUser(data.user);
  };

  const handleAskChat = async () => {
    if (!selectedContact || !chatInput.trim()) return;
    const res = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contactId: selectedContact.id,
        question: chatInput,
      }),
    });
    const data = await res.json();
    setChatAnswer(data.answer || 'No answer');
  };

  const handleDeleteTranscript = async (id) => {
    await fetch(`${API_URL}/api/transcripts/${id}/delete`, { method: 'POST' });
    fetchTranscripts(selectedContact.id);
  };

  if (!user) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="brand-row">
            <div className="logo-mark">C</div>
            <span>CallMind</span>
          </div>
          <h1>Call memory, without losing the thread</h1>
          <div className="demo-grid">
            {demoUsers.map((demo) => (
              <button key={demo.id} className="demo-user" onClick={() => handleLogin(demo.email, demo.password)}>
                <strong>{demo.name}</strong>
                <span>{demo.email}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">Workspace</p>
            <h2>CallMind</h2>
          </div>
          <button className="ghost-btn" onClick={() => setUser(null)}>Logout</button>
        </div>
        <div className="contacts-header">Contacts</div>
        <div className="contact-list">
          {contacts.map((contact) => (
            <button
              key={contact.id}
              className={`contact-item ${selectedContact?.id === contact.id ? 'selected' : ''}`}
              onClick={() => setSelectedContact(contact)}
            >
              <div className="avatar">{(contact.contact_name || contact.name || 'C').slice(0, 1)}</div>
              <div className="contact-copy">
                <strong>{contact.contact_name || contact.name}</strong>
                <span>{contact.lastCallPreview}</span>
              </div>
              <div className="call-pill" onClick={(event) => { event.stopPropagation(); startCall(contact); }}>Call</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Active conversation</p>
            <h3>{selectedContactName}</h3>
          </div>
          {callState === 'idle' ? (
            <button className="primary-btn" onClick={() => selectedContact && startCall(selectedContact)}>Start call</button>
          ) : (
            <button className="danger-btn" onClick={endCall}>End call</button>
          )}
        </header>

        <section className="call-card">
          <div className="call-avatar">{selectedContactName.slice(0, 1)}</div>
          <h2>{selectedContactName}</h2>
          <p className="status-line">{statusText || 'Ready to call'}</p>

          {consentAccepted && (
            <div className="consent-banner">This call will be recorded and transcribed.</div>
          )}

          {callState !== 'idle' && (
            <div className="call-controls">
              <div className="live-badge">{transcribing ? 'Transcribing…' : 'Connected'}</div>
              <button className="danger-btn" onClick={endCall}>Hang up</button>
            </div>
          )}

          <div className="media-row">
            <div className="speaker-box">
              <span>Caller audio</span>
              <audio ref={localAudioRef} autoPlay muted controls />
            </div>
            <div className="speaker-box">
              <span>Receiver audio</span>
              <audio ref={remoteAudioRef} autoPlay controls />
            </div>
          </div>
        </section>

        <section className="chat-panel">
          <div className="chat-header">
            <h3>Cross-call memory</h3>
          </div>
          <div className="chat-input-row">
            <input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask about past calls..."
            />
            <button className="primary-btn" onClick={handleAskChat}>Ask</button>
          </div>
          {chatAnswer && (
            <div className="answer-box">
              <p>{chatAnswer}</p>
            </div>
          )}
        </section>

        <section className="transcript-panel">
          <div className="chat-header">
            <h3>Call transcript history</h3>
          </div>
          <div className="transcript-list">
            {transcripts.map((record) => (
              <div key={record.id} className="transcript-card">
                <div className="transcript-meta">
                  <span>{formatDate(record.timestamp)}</span>
                  <button className="delete-btn" onClick={() => handleDeleteTranscript(record.id)}>Delete</button>
                </div>
                {record.scam_flag && <span className="warning-badge">Scam warning</span>}
                <div className="transcript-lines">
                  {getTranscriptForDisplay(record).map((segment, index) => (
                    <div key={`${record.id}-${index}`} className="transcript-line">
                      <span className="speaker">{segment.speaker}</span>
                      <span className="message">{segment.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {incomingCall && (
          <div className="incoming-modal">
            <div className="incoming-card">
              <h3>Incoming call</h3>
              <p>{incomingCall.callerName} is calling</p>
              <div className="incoming-actions">
                <button className="primary-btn" onClick={answerIncomingCall}>Answer</button>
                <button className="ghost-btn" onClick={() => setIncomingCall(null)}>Ignore</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
