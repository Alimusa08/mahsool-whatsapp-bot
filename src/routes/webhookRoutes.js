const express = require('express');
const verifySignature = require('../webhook/verifySignature');
const { verifyWebhook, receiveEvent } = require('../webhook/webhookController');

const router = express.Router();

router.get('/webhook', verifyWebhook);
router.post('/webhook', verifySignature, receiveEvent);

module.exports = router;