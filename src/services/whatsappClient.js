const axios = require('axios');

const client = axios.create({
  baseURL: `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
  },
});

async function sendTextMessage(to, text) {
  const response = await client.post('/messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
  return response.data;
}

module.exports = { sendTextMessage };