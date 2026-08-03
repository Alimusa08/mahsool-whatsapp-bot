const pool = require('../db/pool');

async function getSession(phonenumber) {
  const result = await pool.query(
    'SELECT step, data FROM whatsapp_registrations WHERE phonenumber = $1',
    [phonenumber]
  );
  return result.rows[0] || null; // { step, data } or null if no session in progress
}

async function saveSession(phonenumber, step, data) {
  await pool.query(
    `INSERT INTO whatsapp_registrations (phonenumber, step, data, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (phonenumber)
     DO UPDATE SET step = $2, data = $3, updated_at = now()`,
    [phonenumber, step, data]
  );
}

async function clearSession(phonenumber) {
  await pool.query('DELETE FROM whatsapp_registrations WHERE phonenumber = $1', [phonenumber]);
}

module.exports = { getSession, saveSession, clearSession };