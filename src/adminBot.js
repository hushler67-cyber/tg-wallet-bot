/**
 * Admin Bot
 * - Add/Edit balances (from notification buttons + /setbalance)
 * - /edit → pick user → balances, add live-tracked dummy positions, view/close positions
 */

require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const db = require('./db');
const { fetchTokenPrice, enrichPositions } = require('./prices');
const fetch = require('node-fetch');

if (!process.env.ADMIN_BOT_TOKEN) {
  console.error('ADMIN_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.ADMIN_BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

const USERS_PER_PAGE = 8;

async function notifyUserCopytradeFill({ telegramId, symbol, chain, amountUsd, entryPrice, tokenAddress, posId }) {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.warn('BOT_TOKEN not set — cannot notify user of copytrade fill');
    return { ok: false, error: 'BOT_TOKEN not set on admin bot' };
  }
  const label = chain === 'bsc' ? 'BNB' : String(chain).toUpperCase();
  const text =
    '📈 Copytrade fill\n\n' +
    'A position was opened from copytrade:\n\n' +
    'Token: ' + (symbol || 'TOKEN') + ' (' + label + ')\n' +
    String(tokenAddress) + '\n' +
    'Size: $' + Number(amountUsd).toFixed(2) + '\n' +
    'Entry: $' + Number(entryPrice) + '\n' +
    'Position #' + posId + '\n\n' +
    'Open Wallet to track live PnL or Sell to close.';
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error('notifyUserCopytradeFill failed:', res.status, body);
      return { ok: false, error: body };
    }
    return { ok: true };
  } catch (err) {
    console.error('notifyUserCopytradeFill error:', err.message);
    return { ok: false, error: err.message };
  }
}

function isAdmin(ctx) {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId) return false;
  const allowed = String(adminChatId).split(',').map((s) => s.trim()).filter(Boolean);
  const chatId = String(ctx.chat?.id ?? '');
  const fromId = String(ctx.from?.id ?? '');
  return allowed.includes(chatId) || allowed.includes(fromId);
}

function formatBalances(balances) {
  if (!balances) return 'No balances found.';
  return (
    `ETH: *$${(balances.eth ?? 0).toFixed(2)}*\n` +
    `BSC: *$${(balances.bsc ?? 0).toFixed(2)}*\n` +
    `SOL: *$${(balances.sol ?? 0).toFixed(2)}*`
  );
}

function userLabel(u) {
  const name = u.telegram_username ? `@${u.telegram_username}` : `id:${u.telegram_id}`;
  return name.slice(0, 60);
}

function usersKeyboard(page = 0) {
  const users = db.getAllUsers();
  const total = users.length;
  const start = page * USERS_PER_PAGE;
  const slice = users.slice(start, start + USERS_PER_PAGE);
  const rows = slice.map((u) => [
    Markup.button.callback(userLabel(u), `edit_user:${u.telegram_id}`),
  ]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('⬅️ Prev', `edit_page:${page - 1}`));
  if (start + USERS_PER_PAGE < total) nav.push(Markup.button.callback('Next ➡️', `edit_page:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('❌ Close', 'admin_balance_cancel')]);
  return { users, total, keyboard: Markup.inlineKeyboard(rows) };
}

function userMenuKeyboard(telegramId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰 Edit Balance', `admin_add_balance:${telegramId}`)],
    [Markup.button.callback('📈 Add Position', `pos_add:${telegramId}`)],
    [Markup.button.callback('📋 View Positions', `pos_list:${telegramId}`)],
    [Markup.button.callback('🔙 Back to users', 'edit_page:0')],
  ]);
}

// ---------- /edit — list all wallet users ----------
bot.command('edit', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');
  const { total, keyboard } = usersKeyboard(0);
  if (total === 0) return ctx.reply('No users with wallets yet.');
  await ctx.reply(
    `👥 *Users with wallets* (${total})\n\nSelect a user to manage:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
});

bot.action(/^edit_page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');
  const page = Number(ctx.match[1]);
  const { total, keyboard } = usersKeyboard(page);
  await ctx.editMessageText(
    `👥 *Users with wallets* (${total})\n\nSelect a user to manage:`,
    { parse_mode: 'Markdown', ...keyboard }
  ).catch(async () => {
    await ctx.reply(`👥 *Users with wallets* (${total})\n\nSelect a user to manage:`, {
      parse_mode: 'Markdown',
      ...keyboard,
    });
  });
});

bot.action(/^edit_user:(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (_) {}
  if (!isAdmin(ctx)) {
    return ctx.reply('Admin only.');
  }
  try {
    const targetId = Number(ctx.match[1]);
    const user = db.getUser(targetId);
    if (!user) return ctx.reply('User not found for id ' + targetId);

    const balances = db.getDummyBalances(targetId) || { eth: 0, bsc: 0, sol: 0 };
    const openCount = db.countOpenPositions(targetId);
    const uname = user.telegram_username ? ('@' + user.telegram_username) : '(no username)';

    const text =
      'User: ' + uname + '\n' +
      'ID: ' + targetId + '\n\n' +
      'Balances:\n' +
      'ETH: $' + Number(balances.eth ?? 0).toFixed(2) + '\n' +
      'BSC: $' + Number(balances.bsc ?? 0).toFixed(2) + '\n' +
      'SOL: $' + Number(balances.sol ?? 0).toFixed(2) + '\n\n' +
      'Open positions: ' + openCount;

    await ctx.reply(text, userMenuKeyboard(targetId));
  } catch (err) {
    console.error('edit_user error:', err);
    await ctx.reply('Error opening user: ' + (err.message || String(err)));
  }
});


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
      `Enter the *new* amount in $:`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('admin_balance_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = null;
  ctx.session.targetId = null;
  ctx.session.chain = null;
  ctx.session.pos = null;
  await ctx.reply('❌ Cancelled.');
});

// ---------- Add position (real token, live price) ----------
bot.action(/^pos_add:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');
  const targetId = ctx.match[1];
  ctx.session.pos = { targetId: Number(targetId) };
  await ctx.reply(
    `📈 *Add Position*\n\nUser: \`${targetId}\`\n\nSelect chain for the token:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('ETH', `pos_chain:${targetId}:eth`),
          Markup.button.callback('BSC', `pos_chain:${targetId}:bsc`),
          Markup.button.callback('SOL', `pos_chain:${targetId}:sol`),
        ],
        [Markup.button.callback('❌ Cancel', 'admin_balance_cancel')],
      ]),
    }
  );
});

bot.action(/^pos_chain:(\d+):(eth|bsc|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');
  const targetId = Number(ctx.match[1]);
  const chain = ctx.match[2];
  ctx.session.pos = { targetId, chain };
  ctx.session.awaiting = 'pos_contract';
  const hint =
    chain === 'sol'
      ? 'Send the *Solana mint address* of the token.'
      : 'Send the *token contract address* (0x...).';
  await ctx.reply(
    `📈 *Add Position* (${chain.toUpperCase()})\n\n${hint}\n\n` +
      'We will pull live price from DexScreener.',
    { parse_mode: 'Markdown' }
  );
});

bot.action(/^pos_list:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');
  const targetId = Number(ctx.match[1]);
  const positions = db.getPositions(targetId, true);
  if (!positions.length) {
    return ctx.reply(
      `No open positions for \`${targetId}\`.`,
      { parse_mode: 'Markdown', ...userMenuKeyboard(targetId) }
    );
  }

  await ctx.reply('⏳ Fetching live prices...');
  const enriched = await enrichPositions(positions);
  let text = `📋 *Open positions* — \`${targetId}\`\n\n`;
  const buttons = [];
  for (const p of enriched) {
    const sign = p.pnl >= 0 ? '+' : '';
    text +=
      `*${p.symbol}* (${p.chain.toUpperCase()})\n` +
      `\`${p.token_address}\`\n` +
      `Entry: $${Number(p.entry_price_usd).toFixed(8)}\n` +
      `Now: $${p.currentPrice.toFixed(8)} ${p.live ? '🟢' : '⚪'}\n` +
      `Invested: $${Number(p.amount_usd).toFixed(2)}\n` +
      `Value: $${p.currentValue.toFixed(2)} | PnL: ${sign}$${p.pnl.toFixed(2)} (${sign}${p.pnlPct.toFixed(1)}%)\n\n`;
    buttons.push([
      Markup.button.callback(`❌ Close ${p.symbol} #${p.id}`, `pos_close:${p.id}:${targetId}`),
    ]);
  }
  buttons.push([Markup.button.callback('🔙 Back', `edit_user:${targetId}`)]);
  await ctx.reply(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^pos_close:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');
  const posId = Number(ctx.match[1]);
  const targetId = Number(ctx.match[2]);
  db.closePosition(posId);
  await ctx.reply(`✅ Position #${posId} closed.`, userMenuKeyboard(targetId));
});

// ---------- Text input (balance amount, contract, position $ amount) ----------
bot.on('text', async (ctx) => {
  if (!isAdmin(ctx)) return;

  // Balance amount
  if (ctx.session?.awaiting === 'admin_balance_amount') {
    const amount = Number(String(ctx.message.text).trim().replace(/[$,]/g));
    const { targetId, chain } = ctx.session;
    ctx.session.awaiting = null;
    ctx.session.targetId = null;
    ctx.session.chain = null;

    if (Number.isNaN(amount) || amount < 0) {
      return ctx.reply('❌ Invalid amount. Send a positive number (e.g. 25 or 25.50).');
    }
    try {
      const before = db.getDummyBalances(Number(targetId));
      const oldVal = before ? (before[chain] ?? 0) : 0;
      db.setDummyBalance(Number(targetId), chain, amount);
      const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
      await ctx.reply(
        `✅ Balance updated\n\nUser: \`${targetId}\`\nChain: *${label}*\nPrevious: *$${Number(oldVal).toFixed(2)}*\nNew: *$${amount}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err.message}`);
    }
    return;
  }

  // Position: contract / mint
  if (ctx.session?.awaiting === 'pos_contract') {
    const address = ctx.message.text.trim();
    const pos = ctx.session.pos || {};
    if (!pos.targetId || !pos.chain) {
      ctx.session.awaiting = null;
      return ctx.reply('❌ Session expired. Use /edit again.');
    }

    await ctx.reply('⏳ Looking up token on DexScreener...');
    const info = await fetchTokenPrice(address);
    if (!info) {
      ctx.session.awaiting = 'pos_contract';
      return ctx.reply(
        '❌ Could not find that token on DexScreener. Check the address and try again.'
      );
    }

    ctx.session.pos = {
      ...pos,
      tokenAddress: address,
      tokenSymbol: info.symbol,
      tokenName: info.name,
      entryPriceUsd: info.priceUsd,
    };
    ctx.session.awaiting = 'pos_amount';

    await ctx.reply(
      `✅ *${info.symbol}* — ${info.name}\n` +
        `Price: *$${info.priceUsd}*\n` +
        (info.priceChange24h != null ? `24h: *${info.priceChange24h.toFixed(2)}%*\n` : '') +
        `\n💵 Enter position size in *$* (how much this user “bought”):`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Position: $ amount
  if (ctx.session?.awaiting === 'pos_amount') {
    const amountUsd = Number(String(ctx.message.text).trim().replace(/[$,]/g));
    const pos = ctx.session.pos || {};
    ctx.session.awaiting = null;

    if (!pos.targetId || !pos.chain || !pos.tokenAddress || !pos.entryPriceUsd) {
      ctx.session.pos = null;
      return ctx.reply('❌ Session expired. Use /edit again.');
    }
    if (Number.isNaN(amountUsd) || amountUsd <= 0) {
      ctx.session.awaiting = 'pos_amount';
      return ctx.reply('❌ Enter a valid $ amount greater than 0.');
    }

        const balances = db.getDummyBalances(pos.targetId) || { eth: 0, bsc: 0, sol: 0 };
    const chain = String(pos.chain).toLowerCase();
    const available = Number(balances[chain] ?? 0);
    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();

    if (amountUsd > available) {
      ctx.session.pos = pos;
      ctx.session.awaiting = 'pos_amount';
      await ctx.reply(
        'User has insufficient ' + label + ' balance.\n\n' +
          'Needed: $' + amountUsd.toFixed(2) + '\n' +
          'Available: $' + available.toFixed(2) + '\n\n' +
          'Use Edit Balance to top up, then enter the amount again.'
      );
      return;
    }

    const tokenAmount = amountUsd / pos.entryPriceUsd;

    // Deduct from user balance (only Edit Balance should increase balance)
    db.setDummyBalance(pos.targetId, chain, available - amountUsd);

    const id = db.addPosition({
      telegramId: pos.targetId,
      chain: pos.chain,
      tokenAddress: pos.tokenAddress,
      tokenSymbol: pos.tokenSymbol,
      tokenName: pos.tokenName,
      entryPriceUsd: pos.entryPriceUsd,
      amountUsd,
      tokenAmount,
      source: 'copytrade',
    });
    ctx.session.pos = null;

    const notify = await notifyUserCopytradeFill({
      telegramId: pos.targetId,
      symbol: pos.tokenSymbol,
      chain: pos.chain,
      amountUsd,
      entryPrice: pos.entryPriceUsd,
      tokenAddress: pos.tokenAddress,
      posId: id,
    });

    await ctx.reply(
      'Position created #' + id + '\n\n' +
        'User: ' + pos.targetId + '\n' +
        'Token: ' + (pos.tokenSymbol || '') + ' (' + label + ')\n' +
        pos.tokenAddress + '\n' +
        'Entry: $' + Number(pos.entryPriceUsd) + '\n' +
        'Size: $' + amountUsd.toFixed(2) + '\n' +
        label + ' balance: $' + available.toFixed(2) + ' -> $' + (available - amountUsd).toFixed(2) + '\n' +
        'User notify: ' + (notify && notify.ok ? 'sent' : ('FAILED - ' + (notify && notify.error ? notify.error : 'unknown'))) + '\n\n' +
        'User will see this under Wallet positions.',
      userMenuKeyboard(pos.targetId)
    );
    return;
  }
});

// ---------- /setbalance ----------
bot.command('setbalance', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 4) {
    return ctx.reply(
      'Usage:\n`/setbalance <telegram_id> <chain> <amount>`\n\n' +
        'Examples:\n`/setbalance 123456789 eth 50`\n`/setbalance 123456789 bsc 25.5`',
      { parse_mode: 'Markdown' }
    );
  }

  const targetId = Number(parts[1]);
  const chain = parts[2].toLowerCase();
  const amount = Number(parts[3].replace(/[$,]/g));

  if (!targetId || Number.isNaN(targetId)) return ctx.reply('❌ Invalid telegram_id.');
  if (!['eth', 'bsc', 'sol'].includes(chain)) return ctx.reply('❌ Chain: eth, bsc, or sol');
  if (Number.isNaN(amount) || amount < 0) return ctx.reply('❌ Invalid amount.');

  if (!db.getUser(targetId)) {
    return ctx.reply(`❌ No user \`${targetId}\`.`, { parse_mode: 'Markdown' });
  }

  try {
    const before = db.getDummyBalances(targetId);
    const oldVal = before ? (before[chain] ?? 0) : 0;
    db.setDummyBalance(targetId, chain, amount);
    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
    await ctx.reply(
      `✅ Balance updated\nUser: \`${targetId}\`\nChain: *${label}*\nPrevious: *$${Number(oldVal).toFixed(2)}*\nNew: *$${amount}*`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});

bot.catch((err, ctx) => {
  console.error(`Admin bot error (${ctx.updateType}):`, err);
});

bot.telegram.setMyCommands([
  { command: 'edit', description: 'Manage users, balances & positions' },
  { command: 'setbalance', description: 'Set user balance quickly' },
]).catch(() => {});

bot.launch();
console.log('Admin bot is running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
