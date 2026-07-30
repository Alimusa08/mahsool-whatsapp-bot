const conversationsRepo = require('../repositories/conversationsRepository');
const messagesRepo = require('../repositories/messagesRepository');

// GET — Meta's one-time verification handshake when you register the webhook URL
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

// POST — actual incoming message/status events
async function receiveEvent(req, res) {
  console.log(`Webhook hit at ${new Date().toISOString()}`);
  // Respond immediately — Meta expects a fast 200, retries aggressively otherwise
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const messages = change?.value?.messages;

    if (!messages || messages.length === 0) {
      return; // status updates (delivered/read) also land here — nothing to do yet
    }

    for (const message of messages) {
      const phonenumber = message.from;
      const content = message.text?.body || '[unsupported message type]';

      console.log(`Incoming from ${phonenumber}: ${content}`);

      await messagesRepo.logMessage({
        phonenumber,
        userId: null, // resolved later once we wire in mahsoolApiClient
        direction: 'inbound',
        senderType: 'user',
        content,
      });
      

      const status = await conversationsRepo.getStatus(phonenumber);
      console.log(`Conversation status for ${phonenumber}: ${status}`);

      if (status === 'bot') {
        const replytext = `You said: "${content}"`;
        await whatsappClient.sendTextMessage(phonenumber, replytext);

        await messagesRepo.logMessage({
          phonenumber,
          userId: null, // resolved later once we wire in mahsoolApiClient
          direction: 'outbound',
            senderType: 'bot',
            content: replytext,
        });
    }

      // Bot reply logic + actual WhatsApp send-back come in the next step
    }
  } catch (err) {
    console.error('Error handling webhook event:', err);
  }
}

module.exports = { verifyWebhook, receiveEvent };