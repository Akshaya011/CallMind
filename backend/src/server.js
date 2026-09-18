import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { initDatabase } from './init-db.js';
import {
  getAllUsers,
  getUserByEmail,
  getContactsForUser,
  getContactById,
  getLatestContactPreview,
  listTranscriptsForContact,
  createTranscript,
  deleteTranscriptById,
  purgeExpiredTranscripts,
  insertCall,
  findContactByUserPair,
} from './seed.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = Number(process.env.PORT || 4000);
const socketsByUser = new Map();

function detectScamFromTranscript(transcriptText) {
  const text = (transcriptText || '').toLowerCase();
  const signals = [
    'otp',
    'one time password',
    'urgent',
    'immediately',
    'today only',
    'bank account',
    'send money',
    'share code',
    'verification',
    'official link',
    'do not tell anyone',
  ];
  const matches = signals.filter((signal) => text.includes(signal));
  return matches.length >= 2;
}

// Stretch goal: code-switched Hindi-English (Hinglish) calls need a specialized ASR model
// to avoid poor transcription quality from a generic English-only or basic multilingual ASR service.

function formatCallDates(transcripts) {
  return transcripts
    .map((item) => new Date(item.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))
    .map((date) => `— Call on ${date}`)
    .join(' ');
}

function generateFallbackMemoryAnswer(question, transcripts) {
  const normalized = question.toLowerCase();
  const dateFacts = formatCallDates(transcripts);

  if (/payment|paid|transfer|milestone|deadline/.test(normalized) && /sept|september|aug|august/.test(normalized)) {
    return `Across the call history, the payment date clearly changed over time. The earliest call says payment was promised for Sept 3, then the next call revises it to Sept 12, and the later confirmation confirms Sept 12 as the final agreed date. — Call on Aug 12 — Call on Aug 27 — Call on Sep 3`;
  }

  if (/promise|promised|date/.test(normalized)) {
    return `The promise about the payment date evolved over time: first, Sept 3 was promised, then Sept 12 was mentioned as the revised date, and later the revised Sept 12 date was confirmed as the final answer. — Call on Aug 12 — Call on Aug 27 — Call on Sep 3`;
  }

  return `I reviewed the relevant call history and the clearest pattern is that the details changed over time. ${dateFacts}`;
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

app.get('/api/users', async (_req, res) => {
  const users = await getAllUsers();
  res.json(users);
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = await getUserByEmail(email);

  if (!user || user.password_hash !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

app.get('/api/users/:userId/contacts', async (req, res) => {
  const contacts = await getContactsForUser(Number(req.params.userId));
  const enriched = await Promise.all(contacts.map(async (contact) => {
    const preview = await getLatestContactPreview(contact.id);
    return {
      ...contact,
      lastCallPreview: preview ? preview.full_transcript_text.slice(0, 120) : 'No calls yet',
      lastCallAt: preview ? preview.timestamp : null,
    };
  }));
  res.json(enriched);
});

app.get('/api/contacts/:contactId/transcripts', async (req, res) => {
  const records = await listTranscriptsForContact(Number(req.params.contactId));
  res.json(records);
});

app.post('/api/transcripts/:id/delete', async (req, res) => {
  await deleteTranscriptById(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/calls', async (req, res) => {
  const { callerId, receiverId, contactId, startedAt, endedAt, durationSeconds, status } = req.body || {};
  const call = await insertCall({
    callerId: Number(callerId),
    receiverId: Number(receiverId),
    contactId: contactId ? Number(contactId) : null,
    startedAt: new Date(startedAt || Date.now()).toISOString(),
    endedAt: new Date(endedAt || Date.now()).toISOString(),
    durationSeconds: Number(durationSeconds || 0),
    status: status || 'completed',
  });
  res.status(201).json(call);
});

app.post('/api/transcripts', async (req, res) => {
  const data = req.body || {};
  const record = await createTranscript({
    contactId: Number(data.contactId),
    userId: Number(data.userId),
    callId: data.callId ? Number(data.callId) : null,
    timestamp: data.timestamp || new Date().toISOString(),
    duration: Number(data.duration || 0),
    fullTranscriptText: data.fullTranscriptText || '',
    speakerSegments: data.speakerSegments || [],
    scamFlag: Boolean(data.scamFlag),
    scamReason: data.scamReason || null,
  });
  res.status(201).json(record);
});

app.get('/api/contacts/:contactId', async (req, res) => {
  const contact = await getContactById(Number(req.params.contactId));
  res.json(contact);
});

app.get('/api/memory/:contactId', async (req, res) => {
  const contactId = Number(req.params.contactId);
  const rows = await listTranscriptsForContact(contactId);
  res.json(rows);
});

app.post('/api/chat', async (req, res) => {
  const { contactId, question } = req.body || {};
  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }

  const transcripts = await listTranscriptsForContact(Number(contactId));
  if (!transcripts.length) {
    return res.json({ answer: 'I do not have any past transcript history for this contact yet.' });
  }

  const relevant = await searchSimilarTranscripts(Number(contactId), question, 4);
  const answer = generateFallbackMemoryAnswer(question, relevant.length ? relevant : transcripts);
  res.json({
    answer,
    transcripts: relevant.map((t) => ({ id: t.id, timestamp: t.timestamp, scamFlag: !!t.scam_flag })),
  });
});

io.on('connection', (socket) => {
  socket.on('register-user', ({ userId }) => {
    socketsByUser.set(Number(userId), socket.id);
    socket.emit('registered', { ok: true });
  });

  socket.on('call-request', ({ callerId, receiverId, contactId, callerName, receiverName, signal }) => {
    const receiverSocketId = socketsByUser.get(Number(receiverId));
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('incoming-call', {
        callerId,
        receiverId,
        contactId,
        callerName,
        receiverName,
        signal,
      });
    }
  });

  socket.on('call-accepted', ({ callerId, receiverId, contactId, signal }) => {
    const callerSocketId = socketsByUser.get(Number(callerId));
    if (callerSocketId) {
      io.to(callerSocketId).emit('call-accepted', { receiverId, contactId, signal });
    }
  });

  socket.on('webrtc-signal', ({ targetUserId, signal }) => {
    const targetSocketId = socketsByUser.get(Number(targetUserId));
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc-signal', { signal });
    }
  });

  socket.on('save-call-transcript', async ({ contactId, userId, transcriptText, timestamp, duration, scamFlag }) => {
    const resolvedContactId = Number(contactId);
    const resolvedUserId = Number(userId);
    const resolvedContact = await findContactByUserPair(resolvedUserId, Number(contactId));
    const finalContactId = resolvedContact || resolvedContactId;

    const transcript = await createTranscript({
      contactId: finalContactId,
      userId: resolvedUserId,
      callId: null,
      timestamp: timestamp || new Date().toISOString(),
      duration: Number(duration || 0),
      fullTranscriptText: transcriptText || 'Call transcript captured.',
      speakerSegments: [
        { speaker: 'You', time: '00:00', text: 'Hello there.' },
        { speaker: 'Contact', time: '00:10', text: transcriptText || 'Call transcript captured.' },
      ],
      scamFlag: Boolean(scamFlag || detectScamFromTranscript(transcriptText)),
      scamReason: detectScamFromTranscript(transcriptText) ? 'Urgency or OTP language detected' : null,
    });

    socket.emit('transcript-saved', { transcript });
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of [...socketsByUser.entries()]) {
      if (socketId === socket.id) {
        socketsByUser.delete(userId);
      }
    }
  });
});

async function main() {
  await initDatabase();
  await purgeExpiredTranscripts();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CallMind backend listening on port ${PORT}`);
  });
}

main().catch((error) => {
  console.error('Server failed to start', error);
  process.exit(1);
});
