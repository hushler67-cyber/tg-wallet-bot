/**
 * Admin Bot
 * ----------
 * Handles the "➕ Add Balance" button on new-wallet notifications
 * and writes dummy balances into the shared wallets.db.
 *
 * Run with:  node src/adminBot.js   (or  npm run admin)
 */

require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const db = require('./db');

if (!process.env.ADMIN_BOT_TOKEN) {
  console.error('ADMIN_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.ADMIN_BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

function isAdmin(ctx) {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId) return false;
  return (
    String(ctx.chat?.id) === String(adminChatId) ||
    String(ctx.from?.id) === String(adminChatId)
  );
}

function formatBalances(balances) {
  if (!balances) return 'No balances found.';
  return (
    `ETH: *$${(balances.eth ?? 0).toFixed(2)}*\n` +
    `BSC: *$${(balances.bsc ?? 0).toFixed(2)}*\n` +
    `SOL: *$${(balances.sol ?? 0).toFixed(2)}*`
  );
}

// Step 1: "Add Balance" button → show current balances + chain picker
bot.action(/^admin_add_balance:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');

  const targetId = ctx.match[1];
  const balances = db.getDummyBalances(Number(targetId));

  await ctx.reply(
    `💰 *Edit Balance*\n\n` +
      `User ID: \`${targetId}\`\n\n` +
      `*Current balances:*\n` +
      `${formatBalances(balances)}\n\n` +
      `Select chain to update:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('ETH', `admin_set_chain:${targetId}:eth`),
          Markup.button.callback('BSC (BNB)', `admin_set_chain:${targetId}:bsc`),
          Markup.button.callback('SOL', `admin_set_chain:${targetId}:sol`),
        ],
        [Markup.button.callback('❌ Cancel', 'admin_balance_cancel')],
      ]),
    }
  );
});

// Step 2: chain chosen → ask for new $ amount (shows current value)
bot.action(/^admin_set_chain:(\d+):(eth|bsc|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');

  const targetId = ctx.match[1];
  const chain = ctx.match[2];
  const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();

  const balances = db.getDummyBalances(Number(targetId));
  const current = balances ? (balances[chain] ?? 0) : 0;

  ctx.session.awaiting = 'admin_balance_amount';
  ctx.session.targetId = targetId;
  ctx.session.chain = chain;

  await ctx.reply(
    `💵 *Update ${label} balance*\n\n` +
      `User ID: \`${targetId}\`\n` +
      `Current: *$${Number(current).toFixed(2)}*\n\n` +
      `Enter the *new* amount in $ (this will replace the current value).\n` +
      `Example: \`25\` or \`100.50\``,
    { parse_mode: 'Markdown' }
  );
});

bot.action('admin_balance_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = null;
  ctx.session.targetId = null;
  ctx.session.chain = null;
  await ctx.reply('❌ Cancelled.');
});

// Step 3: admin types the new $ amount
bot.on('text', async (ctx) => {
  if (ctx.session?.awaiting !== 'admin_balance_amount') return;
  if (!isAdmin(ctx)) return;

  const amount = Number(String(ctx.message.text).trim().replace(/[$,]/g));
  const { targetId, chain } = ctx.session;

  ctx.session.awaiting = null;
  ctx.session.targetId = null;
  ctx.session.chain = null;

  if (Number.isNaN(amount) || amount < 0) {
    return ctx.reply('❌ Invalid amount. Send a positive number (e.g. 25 or 25.50).');
  }

  const user = db.getUser(Number(targetId));
  if (!user) {
    return ctx.reply(
      `❌ No user found with ID \`${targetId}\`. They must /start the main bot first.`,
      { parse_mode: 'Markdown' }
    );
  }

  try {
    const before = db.getDummyBalances(Number(targetId));
    const oldVal = before ? (before[chain] ?? 0) : 0;

    db.setDummyBalance(Number(targetId), chain, amount);
    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();

    await ctx.reply(
      `✅ Balance updated\n\n` +
        `User ID: \`${targetId}\`\n` +
        `Chain: *${label}*\n` +
        `Previous: *$${Number(oldVal).toFixed(2)}*\n` +
        `New: *$${amount}*`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});

// /setbalance also available anytime
bot.command('setbalance', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 4) {
    return ctx.reply(
      'Usage:\n' +
        '`/setbalance <telegram_id> <chain> <amount>`\n\n' +
        'Examples:\n' +
        '`/setbalance 123456789 eth 50`\n' +
        '`/setbalance 123456789 bsc 25.5`\n' +
        '`/setbalance 123456789 sol 100`',
      { parse_mode: 'Markdown' }
    );
  }

  const targetId = Number(parts[1]);
  const chain = parts[2].toLowerCase();
  const amount = Number(parts[3].replace(/[$,]/g));

  if (!targetId || Number.isNaN(targetId)) {
    return ctx.reply('❌ Invalid telegram_id.');
  }
  if (!['eth', 'bsc', 'sol'].includes(chain)) {
    return ctx.reply('❌ Chain must be one of: eth, bsc, sol');
  }
  if (Number.isNaN(amount) || amount < 0) {
    return ctx.reply('❌ Amount must be a non-negative number.');
  }

  const user = db.getUser(targetId);
  if (!user) {
    return ctx.reply(`❌ No user found with ID \`${targetId}\`.`, { parse_mode: 'Markdown' });
  }

  try {
    const before = db.getDummyBalances(targetId);
    const oldVal = before ? (before[chain] ?? 0) : 0;
    db.setDummyBalance(targetId, chain, amount);
    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
    await ctx.reply(
      `✅ Balance updated\n\n` +
        `User: \`${targetId}\`\n` +
        `Chain: *${label}*\n` +
        `Previous: *$${Number(oldVal).toFixed(2)}*\n` +
        `New: *$${amount}*`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});

bot.catch((err, ctx) => {
  console.error(`Admin bot error (${ctx.updateType}):`, err);
});

bot.launch();
console.log('Admin bot is running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
