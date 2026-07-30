const pool = require('../db/pool');

async function getStatus(phonenumber) {
  const result = await pool.query(
    'SELECT status FROM whatsapp_conversations WHERE phonenumber = $1',
    [phonenumber]
  );
  return result.rows[0]?.status || 'bot'; // defaults to 'bot' if no row yet
}

async function setStatus(phonenumber, status) {
  if (status !== 'bot' && status !== 'human') {
    throw new Error(`Invalid conversation status: ${status}`);
  }
  await pool.query(
    `INSERT INTO whatsapp_conversations (phonenumber, status, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (phonenumber)
     DO UPDATE SET status = $2, updated_at = now()`,
    [phonenumber, status]
  );
}

module.exports = { getStatus, setStatus };