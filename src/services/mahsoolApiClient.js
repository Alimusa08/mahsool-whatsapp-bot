const axios = require('axios');
const tokensRepo = require('../repositories/tokensRepository');

const client = axios.create({
  baseURL: process.env.MAHSOOL_API_BASE_URL,
});

// How long to trust the cached /state and /categories/subCategories lists
// before refetching. These are reference data that changes rarely, if ever,
// so a long TTL avoids hammering the API on every registration step.
const REFERENCE_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

let statesCache = null;
let statesCacheExpiresAt = 0;

let subCategoriesCache = null;
let subCategoriesCacheExpiresAt = 0;

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

// ASSUMPTION: response shape is an array of { id, name }. Verify against the
// real /state response and adjust the mapping below if the field names differ.
async function getStates() {
  if (statesCache && Date.now() < statesCacheExpiresAt) {
    return statesCache;
  }

  const response = await client.get('/state');
  statesCache = response.data;
  statesCacheExpiresAt = Date.now() + REFERENCE_CACHE_TTL_MS;
  return statesCache;
}

// ASSUMPTION: response shape is an array of { id, name }. Verify against the
// real /categories/subCategories response.
async function getSubCategories() {
  if (subCategoriesCache && Date.now() < subCategoriesCacheExpiresAt) {
    return subCategoriesCache;
  }

  const response = await client.get('/categories/subCategories');
  subCategoriesCache = response.data;
  subCategoriesCacheExpiresAt = Date.now() + REFERENCE_CACHE_TTL_MS;
  return subCategoriesCache;
}

// ASSUMPTION: /auth/register is authenticated the same way as
// /auth/whatsapp/token (x-service-secret header). Confirm against the real
// route — if it's public or uses a different scheme, drop/adjust the header.
async function register(payload) {
  const response = await client.post('/auth/register', payload, {
  });
  return response.data;
}

module.exports = { getAccessToken, getStates, getSubCategories, register };