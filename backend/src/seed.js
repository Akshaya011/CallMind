import pool from './db.js';

function generateEmbedding(text) {
  const tokens = (text.toLowerCase().match(/\b[\w']+\b/g) || []).slice(0, 24);
  const vector = Array.from({ length: 8 }, (_, index) => {
    const sum = tokens.reduce((total, token, tokenIndex) => {
      const charCode = token.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
      const contribution = ((charCode + tokenIndex + index * 17) % 97) / 97;
      return total + contribution;
    }, 0);
    return Number((sum / Math.max(tokens.length, 1) + index * 0.13).toFixed(4));
  });

  return `[${vector.join(',')}]`;
}

export async function seedDemoData() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(120) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      owner_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname VARCHAR(120),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      caller_id INT NOT NULL REFERENCES users(id),
      receiver_id INT NOT NULL REFERENCES users(id),
      contact_id INT REFERENCES contacts(id),
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      duration_seconds INT DEFAULT 0,
      status VARCHAR(40) DEFAULT 'completed',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id SERIAL PRIMARY KEY,
      contact_id INT NOT NULL REFERENCES contacts(id),
      user_id INT NOT NULL REFERENCES users(id),
      call_id INT REFERENCES calls(id),
      timestamp TIMESTAMPTZ NOT NULL,
      duration_seconds INT DEFAULT 0,
      full_transcript_text TEXT NOT NULL,
      speaker_segments JSONB DEFAULT '[]'::jsonb,
      scam_flag BOOLEAN DEFAULT FALSE,
      scam_reason TEXT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcript_vectors (
      id SERIAL PRIMARY KEY,
      transcript_id INT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
      embedding VECTOR(8),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transcripts_contact_ts
      ON transcripts(contact_id, timestamp);
  `);

  const userRows = await pool.query(`SELECT id, email FROM users`);
  const existingUsers = new Map(userRows.rows.map((row) => [row.email, row.id]));

  const alice = existingUsers.get('alice@callmind.demo') || (await pool.query(`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Alice Johnson', 'alice@callmind.demo', 'password123')
    ON CONFLICT (email) DO NOTHING
    RETURNING id
  `)).rows[0]?.id;

  const ramesh = existingUsers.get('ramesh@callmind.demo') || (await pool.query(`
    INSERT INTO users (name, email, password_hash)
    VALUES ('Ramesh Verma', 'ramesh@callmind.demo', 'password123')
    ON CONFLICT (email) DO NOTHING
    RETURNING id
  `)).rows[0]?.id;

  if (!alice || !ramesh) {
    const allUsers = await pool.query('SELECT id, email FROM users');
    const userMap = Object.fromEntries(allUsers.rows.map((row) => [row.email, row.id]));
    const resolvedAlice = userMap['alice@callmind.demo'];
    const resolvedRamesh = userMap['ramesh@callmind.demo'];
    if (resolvedAlice) {
      alice = resolvedAlice;
    }
    if (resolvedRamesh) {
      ramesh = resolvedRamesh;
    }
  }

  const existingContacts = await pool.query(`
    SELECT id FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2
  `, [alice, ramesh]);

  let contactId = existingContacts.rows[0]?.id;
  if (!contactId) {
    const contactInsert = await pool.query(`
      INSERT INTO contacts (owner_user_id, contact_user_id, nickname)
      VALUES ($1, $2, 'Ramesh')
      RETURNING id
    `, [alice, ramesh]);
    contactId = contactInsert.rows[0].id;
  }

  const transcriptCount = await pool.query('SELECT COUNT(*)::int AS total FROM transcripts WHERE contact_id = $1', [contactId]);
  if (transcriptCount.rows[0].total === 0) {
    const records = [
      {
        timestamp: '2026-08-12T10:00:00Z',
        duration: 390,
        text: 'You: Hey Ramesh, can we lock in the payment date for the project milestone?\n[Ramesh Verma]: Yes, I will send the payment on Sept 3. I promised the deadline would be before the end of the first week of September.\nYou: Perfect, I will plan around that.\n[Ramesh Verma]: Great, I will confirm once the transfer is processed.',
        segments: [
          { speaker: 'You', time: '00:00', text: 'Hey Ramesh, can we lock in the payment date for the project milestone?' },
          { speaker: 'Ramesh Verma', time: '00:15', text: 'Yes, I will send the payment on Sept 3. I promised the deadline would be before the end of the first week of September.' },
          { speaker: 'You', time: '00:42', text: 'Perfect, I will plan around that.' },
          { speaker: 'Ramesh Verma', time: '00:52', text: 'Great, I will confirm once the transfer is processed.' }
        ],
        scam: false,
        reason: null,
      },
      {
        timestamp: '2026-08-27T14:30:00Z',
        duration: 420,
        text: 'You: I need the updated money timeline because I have vendor commitments.\n[Ramesh Verma]: I am still trying to align it, but the payment date may shift to Sept 12 instead. The earlier Sept 3 date is no longer realistic.\nYou: That is a significant delay. We need clarity.\n[Ramesh Verma]: I understand, but I am telling you now so you can re-plan for Sept 12.',
        segments: [
          { speaker: 'You', time: '00:00', text: 'I need the updated money timeline because I have vendor commitments.' },
          { speaker: 'Ramesh Verma', time: '00:18', text: 'I am still trying to align it, but the payment date may shift to Sept 12 instead. The earlier Sept 3 date is no longer realistic.' },
          { speaker: 'You', time: '00:46', text: 'That is a significant delay. We need clarity.' },
          { speaker: 'Ramesh Verma', time: '01:02', text: 'I understand, but I am telling you now so you can re-plan for Sept 12.' }
        ],
        scam: false,
        reason: null,
      },
      {
        timestamp: '2026-09-03T18:15:00Z',
        duration: 360,
        text: 'You: I just want to confirm the final payment milestone.\n[Ramesh Verma]: We agreed on Sept 12 as the revised date, not Sept 3. I will send the transfer by the morning of Sept 12.\nYou: Understood. We are aligned on that now.\n[Ramesh Verma]: Yes, and I will keep you updated if anything changes before then.',
        segments: [
          { speaker: 'You', time: '00:00', text: 'I just want to confirm the final payment milestone.' },
          { speaker: 'Ramesh Verma', time: '00:16', text: 'We agreed on Sept 12 as the revised date, not Sept 3. I will send the transfer by the morning of Sept 12.' },
          { speaker: 'You', time: '00:45', text: 'Understood. We are aligned on that now.' },
          { speaker: 'Ramesh Verma', time: '00:57', text: 'Yes, and I will keep you updated if anything changes before then.' }
        ],
        scam: false,
        reason: null,
      },
      {
        timestamp: '2026-09-14T09:05:00Z',
        duration: 335,
        text: 'You: Before we continue, I want to keep this secure.\n[Ramesh Verma]: I am sending a secure payment link, but it is urgent. Please do not share the OTP with anyone.\nYou: I will be careful.\n[Ramesh Verma]: Good. This is a time-sensitive request and you should only trust the official link.',
        segments: [
          { speaker: 'You', time: '00:00', text: 'Before we continue, I want to keep this secure.' },
          { speaker: 'Ramesh Verma', time: '00:15', text: 'I am sending a secure payment link, but it is urgent. Please do not share the OTP with anyone.' },
          { speaker: 'You', time: '00:36', text: 'I will be careful.' },
          { speaker: 'Ramesh Verma', time: '00:42', text: 'Good. This is a time-sensitive request and you should only trust the official link.' }
        ],
        scam: true,
        reason: 'Urgency + OTP request + impersonation-like urgency language',
      }
    ];

    for (const record of records) {
      const transcriptInsert = await pool.query(`
        INSERT INTO transcripts (contact_id, user_id, timestamp, duration_seconds, full_transcript_text, speaker_segments, scam_flag, scam_reason)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        RETURNING id
      `, [contactId, alice, record.timestamp, record.duration, record.text, JSON.stringify(record.segments), record.scam, record.reason]);

      const transcriptId = transcriptInsert.rows[0].id;
      await pool.query(`
        INSERT INTO transcript_vectors (transcript_id, embedding)
        VALUES ($1, $2::vector)
      `, [transcriptId, generateEmbedding(record.text)]);
    }
  }
}

export async function getAllUsers() {
  const { rows } = await pool.query('SELECT id, name, email FROM users ORDER BY id');
  return rows;
}

export async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT id, name, email, password_hash FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

export async function getContactsForUser(userId) {
  const { rows } = await pool.query(`
    SELECT c.id, c.owner_user_id, c.contact_user_id, u.name AS contact_name, u.email AS contact_email
    FROM contacts c
    JOIN users u ON u.id = c.contact_user_id
    WHERE c.owner_user_id = $1
    ORDER BY c.id ASC
  `, [userId]);
  return rows;
}

export async function getContactById(contactId) {
  const { rows } = await pool.query(`
    SELECT c.*, u.name AS contact_name, u.email AS contact_email
    FROM contacts c
    JOIN users u ON u.id = c.contact_user_id
    WHERE c.id = $1
  `, [contactId]);
  return rows[0] || null;
}

export async function getLatestContactPreview(contactId) {
  const { rows } = await pool.query(`
    SELECT full_transcript_text, timestamp
    FROM transcripts
    WHERE contact_id = $1 AND deleted_at IS NULL
    ORDER BY timestamp DESC
    LIMIT 1
  `, [contactId]);
  return rows[0] || null;
}

export async function insertCall({ callerId, receiverId, contactId, startedAt, endedAt, durationSeconds, status }) {
  const { rows } = await pool.query(`
    INSERT INTO calls (caller_id, receiver_id, contact_id, started_at, ended_at, duration_seconds, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [callerId, receiverId, contactId, startedAt, endedAt, durationSeconds, status]);
  return rows[0];
}

export async function findContactByUserPair(userId, otherUserId) {
  const { rows } = await pool.query(`
    SELECT id FROM contacts
    WHERE owner_user_id = $1 AND contact_user_id = $2
    LIMIT 1
  `, [userId, otherUserId]);
  return rows[0]?.id || null;
}

export async function listTranscriptsForContact(contactId) {
  const { rows } = await pool.query(`
    SELECT t.*, c.nickname, u.name AS user_name
    FROM transcripts t
    JOIN contacts c ON c.id = t.contact_id
    JOIN users u ON u.id = t.user_id
    WHERE t.contact_id = $1 AND t.deleted_at IS NULL
    ORDER BY t.timestamp ASC
  `, [contactId]);
  return rows;
}

export async function createTranscript({ contactId, userId, callId, timestamp, duration, fullTranscriptText, speakerSegments, scamFlag, scamReason }) {
  const { rows } = await pool.query(`
    INSERT INTO transcripts (contact_id, user_id, call_id, timestamp, duration_seconds, full_transcript_text, speaker_segments, scam_flag, scam_reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    RETURNING *
  `, [contactId, userId, callId || null, timestamp, duration, fullTranscriptText, JSON.stringify(speakerSegments || []), scamFlag || false, scamReason || null]);

  const transcriptId = rows[0].id;
  const embedding = generateEmbedding(fullTranscriptText);
  await pool.query(`
    INSERT INTO transcript_vectors (transcript_id, embedding)
    VALUES ($1, $2::vector)
  `, [transcriptId, embedding]);

  return rows[0];
}

export async function searchSimilarTranscripts(contactId, question, limit = 4) {
  const questionEmbedding = generateEmbedding(question);
  const { rows } = await pool.query(`
    SELECT t.*, tv.embedding <=> $2::vector AS distance
    FROM transcripts t
    JOIN transcript_vectors tv ON tv.transcript_id = t.id
    WHERE t.contact_id = $1 AND t.deleted_at IS NULL
    ORDER BY tv.embedding <=> $2::vector
    LIMIT $3
  `, [contactId, questionEmbedding, limit]);
  return rows;
}

export async function deleteTranscriptById(transcriptId) {
  await pool.query(`
    UPDATE transcripts SET deleted_at = NOW() WHERE id = $1
  `, [transcriptId]);
}

export async function purgeExpiredTranscripts() {
  const days = Number(process.env.AUTO_DELETE_DAYS || 30);
  await pool.query(`
    UPDATE transcripts
    SET deleted_at = COALESCE(deleted_at, NOW())
    WHERE deleted_at IS NULL AND timestamp < NOW() - ($1 || ' days')::interval
  `, [days]);
}
