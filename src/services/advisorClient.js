const axios = require('axios');

const client = axios.create({
  baseURL: process.env.MAHSOOL_API_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.MAHSOOL_ADVISOR_TOKEN}`,
  },
});

async function askAdvisor(question) {
  const response = await client.post('/advisor/question', { question });
  return response.data.text;
}

module.exports = { askAdvisor };