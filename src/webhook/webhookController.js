const conversationsRepo = require('../repositories/conversationsRepository');
const messagesRepo = require('../repositories/messagesRepository');
const whatsappClient = require('../services/whatsappClient');
const advisorClient = require('../services/advisorClient');

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
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const messages = change?.value?.messages;

    if (!messages || messages.length === 0) {
      return;
    }

    for (const message of messages) {
      const phonenumber = message.from;
      const content = message.text?.body || '[unsupported message type]';

      console.log(`Incoming from ${phonenumber}: ${content}`);

      await messagesRepo.logMessage({
        phonenumber,
        userId: null,
        direction: 'inbound',
        senderType: 'user',
        content,
      });

      const status = await conversationsRepo.getStatus(phonenumber);

      if (status === 'bot') {
        let replyText;
        try {
          replyText = await advisorClient.askAdvisor(content);
        } catch (err) {
          console.error('Advisor request failed:', err.message);
          replyText = 'عذراً، حدث خطأ، الرجاء المحاولة مرة أخرى.';
        }

        await whatsappClient.sendTextMessage(phonenumber, replyText);

        await messagesRepo.logMessage({
          phonenumber,
          userId: null,
          direction: 'outbound',
          senderType: 'bot',
          content: replyText,
        });
      }
    }
  } catch (err) {
    console.error('Error handling webhook event:', err);
  }
}

module.exports = { verifyWebhook, receiveEvent };