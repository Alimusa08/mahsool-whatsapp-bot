const conversationsRepo = require('../repositories/conversationsRepository');
const messagesRepo = require('../repositories/messagesRepository');
const registrationsRepo = require('../repositories/registrationsRepository');
const whatsappClient = require('../services/whatsappClient');
const advisorClient = require('../services/advisorClient');
const mahsoolApiClient = require('../services/mahsoolApiClient');
const registrationFlow = require('../services/registrationFlow');
const { generatePassword } = require('../utils/generatePassword');

const GENERIC_ERROR_MESSAGE = 'عذراً، حدث خطأ، الرجاء المحاولة مرة أخرى.';

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

async function sendAndLog(phonenumber, userId, text) {
  await whatsappClient.sendTextMessage(phonenumber, text);
  await messagesRepo.logMessage({
    phonenumber,
    userId: userId || null,
    direction: 'outbound',
    senderType: 'bot',
    content: text,
  });
}

// Drives one turn of the registration conversation for an unregistered
// phone number. Persists session state in whatsapp_registrations between
// webhook calls since each call is a stateless HTTP request.
async function handleRegistrationMessage(phonenumber, content) {
  const session = await registrationsRepo.getSession(phonenumber);
  const result = session
    ? await registrationFlow.advanceFlow(session, content)
    : await registrationFlow.startFlow();

  if (result.retry) {
    await sendAndLog(phonenumber, null, result.replyText);
    return;
  }

  if (result.complete) {
    await registrationsRepo.clearSession(phonenumber);
    await completeRegistration(phonenumber, result.data);
    return;
  }

  await registrationsRepo.saveSession(phonenumber, result.step, result.data);
  await sendAndLog(phonenumber, null, result.replyText);
}

// Calls /auth/register with the collected answers, then reuses the existing
// token flow to fetch and cache an access token for the new account.
async function completeRegistration(phonenumber, data) {
  const password = generatePassword();

  const payload = {
    name: data.name,
    phonenumber: `+${phonenumber}`, 
    password,
    location: data.location,
    type: data.type,
    dob: data.dob,
    gender: data.gender,
  };

  if (data.type === 'supplier') {
    payload.service_id = data.service_id;
  } else {
    payload.subCategory_id = data.subCategory_id;
  }

  try {
    await mahsoolApiClient.register(payload);
  } catch (err) {
    console.error('Registration failed:', err.response?.status, err.response?.data || err.message);
    await sendAndLog(
      phonenumber,
      null,
      'عذراً، لم نتمكن من إنشاء حسابك. الرجاء المحاولة مرة أخرى بإرسال أي رسالة.'
    );
    return;
  }

  const auth = await mahsoolApiClient.getAccessToken(`+${phonenumber}`);

  const successText =
    'تم إنشاء حسابك بنجاح!\n' +
    `كلمة المرور المؤقتة الخاصة بك: ${password}\n` +
    'الرجاء الاحتفاظ بها وتغييرها لاحقاً من داخل التطبيق. يمكنك الآن إرسال طلبك.';

  await sendAndLog(phonenumber, auth.userId, successText);
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
      if (status !== 'bot') {
        continue; // human is handling this conversation
      }

      let userId;
      let accessToken;
      try {
        const auth = await mahsoolApiClient.getAccessToken(`+${phonenumber}`);
        userId = auth.userId;
        accessToken = auth.accessToken;
      } catch (err) {
        const isUnregistered = err.response?.status === 401;

        if (!isUnregistered) {
          console.error('Auth check failed:', err.response?.status, err.response?.data || err.message);
          await sendAndLog(phonenumber, null, GENERIC_ERROR_MESSAGE);
          continue;
        }

        try {
          await handleRegistrationMessage(phonenumber, content);
        } catch (regErr) {
          console.error('Registration flow failed:', regErr.response?.data || regErr.message);
          await sendAndLog(phonenumber, null, GENERIC_ERROR_MESSAGE);
        }
        continue; // don't call the advisor for this message
      }

      let replyText;
      try {
        replyText = await advisorClient.askAdvisor(content, accessToken);
      } catch (err) {
        console.error('Advisor request failed:', err.message);
        replyText = GENERIC_ERROR_MESSAGE;
      }

      await sendAndLog(phonenumber, userId, replyText);
    }
  } catch (err) {
    console.error('Error handling webhook event:', err);
  }
}

module.exports = { verifyWebhook, receiveEvent };