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

// sections: [{ title, rows: [{ id, title, description? }] }]
// WhatsApp hard limit: 10 rows total across all sections.
async function sendListMessage(to, { bodyText, buttonLabel, sections }) {
  const response = await client.post('/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonLabel,
        sections,
      },
    },
  });
  return response.data;
}

// buttons: [{ id, title }] — WhatsApp hard limit: max 3 reply buttons.
async function sendButtonMessage(to, { bodyText, buttons }) {
  const response = await client.post('/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
  return response.data;
}

module.exports = { sendTextMessage, sendListMessage, sendButtonMessage };