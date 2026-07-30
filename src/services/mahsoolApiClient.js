const axios = require('axios');
const tokensRepo = require('../repositories/tokensRepository');

const client = axios.create({
  baseURL: process.env.MAHSOOL_API_BASE_URL,
});

async function fetchFreshToken(phonenumber) {
  const response = await client.post(
    '/auth/whatsapp/token',
    { phonenumber },
    { headers: { 'x-service-secret': process.env.WHATSAPP_BOT_SERVICE_SECRET } }
  );
  return response.data; // { user_id, access_token }
}

async function getAccessToken(phonenumber) {
  const cached = await tokensRepo.getToken(phonenumber);

  if (!tokensRepo.isExpired(cached)) {
    return { userId: cached.user_id, accessToken: cached.access_token };
  }

  const { user_id, access_token } = await fetchFreshToken(phonenumber);

  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days, matches server-side expiry
  await tokensRepo.saveToken({
    phonenumber,
    userId: user_id,
    accessToken: access_token,
    expiresAt,
  });

  return { userId: user_id, accessToken: access_token };
}

module.exports = { getAccessToken };