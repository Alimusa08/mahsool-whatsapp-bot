const pool = require('../db/pool');

async function getToken(phonenumber) {
  const result = await pool.query(
    'SELECT * FROM whatsapp_tokens WHERE phonenumber = $1',
    [phonenumber]
  );
  return result.rows[0] || null;
}

async function saveToken({ phonenumber, userId, accessToken, expiresAt }) {
  await pool.query(
    `INSERT INTO whatsapp_tokens (phonenumber, user_id, access_token, issued_at, expires_at)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (phonenumber)
     DO UPDATE SET user_id = $2, access_token = $3, issued_at = now(), expires_at = $4`,
    [phonenumber, userId, accessToken, expiresAt]
  );
}

function isExpired(tokenRow) {
  if (!tokenRow) return true;
  return new Date(tokenRow.expires_at).getTime() <= Date.now();
}

module.exports = { getToken, saveToken, isExpired };