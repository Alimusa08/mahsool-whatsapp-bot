const crypto = require('crypto');

// Avoids visually-confusable characters (0/O, 1/l/I) since this password
// gets read off a WhatsApp message and typed into the mobile app.
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length = 10) {
  const bytes = crypto.randomBytes(length);
  let password = '';
  for (let i = 0; i < length; i++) {
    password += CHARSET[bytes[i] % CHARSET.length];
  }
  return password;
}

module.exports = { generatePassword };