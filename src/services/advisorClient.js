const axios = require('axios');

const client = axios.create({
  baseURL: process.env.MAHSOOL_API_BASE_URL,
});

async function askAdvisor(question, accessToken) {
  const response = await client.post(
    '/advisor/question',
    { question },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return response.data.text;
}

module.exports = { askAdvisor };