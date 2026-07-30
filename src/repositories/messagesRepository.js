const pool = require('../db/pool');

async function logMessage({ phonenumber, userId, direction, senderType, content }) {
  await pool.query(
    `INSERT INTO whatsapp_messages (phonenumber, user_id, direction, sender_type, content)
     VALUES ($1, $2, $3, $4, $5)`,
    [phonenumber, userId || null, direction, senderType, content]
  );
}

async function getHistory(phonenumber, limit = 50) {
  const result = await pool.query(
    `SELECT * FROM whatsapp_messages
     WHERE phonenumber = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [phonenumber, limit]
  );
  return result.rows;
}

module.exports = { logMessage, getHistory };