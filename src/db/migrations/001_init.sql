-- Cached WhatsApp-bot access tokens, one per phone number
CREATE TABLE whatsapp_tokens (
  phonenumber   text PRIMARY KEY,
  user_id       uuid NOT NULL,
  access_token  text NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

-- One row per phone number tracking whether the bot or a human is currently handling it
CREATE TABLE whatsapp_conversations (
  phonenumber   text PRIMARY KEY,
  status        text NOT NULL DEFAULT 'bot' CHECK (status IN ('bot', 'human')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Full chat log, for the admin dashboard to render later
CREATE TABLE whatsapp_messages (
  id            serial PRIMARY KEY,
  phonenumber   text NOT NULL,
  user_id       uuid,
  direction     text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender_type   text NOT NULL CHECK (sender_type IN ('user', 'bot', 'admin')),
  content       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_whatsapp_messages_phonenumber ON whatsapp_messages (phonenumber);