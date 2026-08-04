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

// Turns a raw incoming WhatsApp message into:
//   input      — what registrationFlow/advisor actually consume
//   logContent — a plain-text summary for whatsapp_messages.content
function normalizeIncoming(message) {
  if (message.type === 'text') {
    const text = message.text?.body || '';
    return { input: { type: 'text', text }, logContent: text };
  }

  if (message.type === 'interactive') {
    const interactive = message.interactive || {};

    if (interactive.type === 'list_reply') {
      const { id, title } = interactive.list_reply;
      return { input: { type: 'interactive', id }, logContent: title || id };
    }

    if (interactive.type === 'button_reply') {
      const { id, title } = interactive.button_reply;
      return { input: { type: 'interactive', id }, logContent: title || id };
    }
  }

  return { input: { type: 'unsupported' }, logContent: '[unsupported message type]' };
}

// Sends an outgoing message (text / list / buttons) and logs a plain-text
// summary of it, since whatsapp_messages.content is a single text column.
async function deliverMessage(phonenumber, userId, message) {
  let logContent;

  switch (message.kind) {
    case 'text':
      await whatsappClient.sendTextMessage(phonenumber, message.text);
      logContent = message.text;
      break;

    case 'buttons':
      await whatsappClient.sendButtonMessage(phonenumber, {
        bodyText: message.bodyText,
        buttons: message.buttons,
      });
      logContent = `${message.bodyText} [${message.buttons.map((b) => b.title).join(' | ')}]`;
      break;

    case 'list':
      await whatsappClient.sendListMessage(phonenumber, {
        bodyText: message.bodyText,
        buttonLabel: message.buttonLabel,
        sections: message.sections,
      });
      logContent = `${message.bodyText} [${message.sections
        .flatMap((s) => s.rows.map((r) => r.title))
        .join(' | ')}]`;
      break;

    default:
      throw new Error(`Unknown message kind: ${message.kind}`);
  }

  await messagesRepo.logMessage({
    phonenumber,
    userId: userId || null,
    direction: 'outbound',
    senderType: 'bot',
    content: logContent,
  });
}

// Drives one turn of the registration conversation for an unregistered
// phone number. Persists session state in whatsapp_registrations between
// webhook calls since each call is a stateless HTTP request.
async function handleRegistrationMessage(phonenumber, input) {
  const session = await registrationsRepo.getSession(phonenumber);
  const result = session
    ? await registrationFlow.advanceFlow(session, input)
    : await registrationFlow.startFlow();

  if (result.retry) {
    await deliverMessage(phonenumber, null, result.message);
    return;
  }

  if (result.complete) {
    await registrationsRepo.clearSession(phonenumber);
    await completeRegistration(phonenumber, result.data);
    return;
  }

  await registrationsRepo.saveSession(phonenumber, result.step, result.data);
  await deliverMessage(phonenumber, null, result.message);
}

// data.dob is collected as plain YYYY-MM-DD (easier to type over WhatsApp);
// the API expects full ISO-8601 with milliseconds, e.g.
// "2004-04-20T00:00:00.000Z" — confirmed against the real payload the
// website itself sends. Midnight UTC is an arbitrary but harmless choice
// since only the calendar date itself is meaningful.
function toRegisterDob(yyyyMmDd) {
  return new Date(`${yyyyMmDd}T00:00:00Z`).toISOString();
}

// Calls /auth/register with the collected answers, then reuses the existing
// token flow to fetch and cache an access token for the new account.
async function completeRegistration(phonenumber, data) {
  const password = generatePassword();

  const payload = {
    name: data.name,
    phonenumber: `+${phonenumber}`, // ASSUMPTION: matches the `+${phonenumber}` convention already used for /auth/whatsapp/token. Confirm this yields the 13-char format the register schema expects.
    password,
    repassword: password, // NOTE: confirmed the real RegisterDto schema has no repassword field/refine — nestjs-zod drops unrecognized keys silently, so this does nothing server-side. Harmless to keep since the website's own request includes it too, but it isn't what fixed the earlier 500.
    location: data.location,
    city: data.city,
    type: data.type,
    gender: data.gender, // undefined (and dropped by JSON.stringify) for types that don't collect it, e.g. supplier
    dob: data.dob ? toRegisterDob(data.dob) : undefined,
    subCategory_id: data.subCategory_id, // always present; [] when type is supplier
    service_id: data.service_id, // always present; [] when type isn't supplier
  };

  try {
    await mahsoolApiClient.register(payload);
  } catch (err) {
    console.error('Registration failed:', err.response?.status, err.response?.data || err.message);
    await deliverMessage(phonenumber, null, {
      kind: 'text',
      text: 'عذراً، لم نتمكن من إنشاء حسابك. الرجاء المحاولة مرة أخرى بإرسال أي رسالة.',
    });
    return;
  }

  const auth = await mahsoolApiClient.getAccessToken(`+${phonenumber}`);

  const successText =
    'تم إنشاء حسابك بنجاح!\n' +
    `كلمة المرور المؤقتة الخاصة بك: ${password}\n` +
    'الرجاء الاحتفاظ بها وتغييرها لاحقاً من داخل التطبيق. يمكنك الآن إرسال طلبك.';

  await deliverMessage(phonenumber, auth.userId, { kind: 'text', text: successText });
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
      const { input, logContent } = normalizeIncoming(message);

      console.log(`Incoming from ${phonenumber}: ${logContent}`);

      await messagesRepo.logMessage({
        phonenumber,
        userId: null,
        direction: 'inbound',
        senderType: 'user',
        content: logContent,
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
          await deliverMessage(phonenumber, null, { kind: 'text', text: GENERIC_ERROR_MESSAGE });
          continue;
        }

        try {
          await handleRegistrationMessage(phonenumber, input);
        } catch (regErr) {
          console.error('Registration flow failed:', regErr.response?.data || regErr.message);
          await deliverMessage(phonenumber, null, { kind: 'text', text: GENERIC_ERROR_MESSAGE });
        }
        continue; // don't call the advisor for this message
      }

      // Advisor only understands free text; interactive taps shouldn't reach
      // it in practice once registered, but fall back to the button/row
      // title if one somehow does.
      const textForAdvisor = input.type === 'text' ? input.text : logContent;

      let replyText;
      try {
        replyText = await advisorClient.askAdvisor(textForAdvisor, accessToken);
      } catch (err) {
        console.error('Advisor request failed:', err.message);
        replyText = GENERIC_ERROR_MESSAGE;
      }

      await deliverMessage(phonenumber, userId, { kind: 'text', text: replyText });
    }
  } catch (err) {
    console.error('Error handling webhook event:', err);
  }
}

module.exports = { verifyWebhook, receiveEvent };