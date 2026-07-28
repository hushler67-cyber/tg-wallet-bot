// Background scheduler for Auto Deposit reminders.
// Polls the DB periodically and DMs any user whose interval has elapsed since
// their last reminder. This only ever sends a message — it never moves funds
// or touches private keys.

const db = require('./db');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

function startAutoDepositScheduler(bot) {
  setInterval(async () => {
    let due;
    try {
      due = db.getDueAutoDepositReminders();
    } catch (err) {
      console.error('Auto deposit scheduler query failed:', err);
      return;
    }

    for (const row of due) {
      const text =
        '⏰ *Recurring deposit reminder*\n\n' +
        `It's been ${row.interval_hours}h — time to send from your external wallet:\n\n` +
        `*ETH:* \`${row.eth_address}\`\n` +
        `*BSC:* \`${row.bsc_address}\`\n` +
        `*SOL:* \`${row.sol_address}\``;

      try {
        await bot.telegram.sendMessage(row.telegram_id, text, { parse_mode: 'Markdown' });
        db.touchAutoDepositReminder(row.telegram_id);
      } catch (err) {
        console.error(`Failed to send auto-deposit reminder to ${row.telegram_id}:`, err.message);
        // If the user blocked the bot, stop retrying forever — turn the schedule off.
        if (err.response?.error_code === 403) {
          db.setAutoDepositScheduleActive(row.telegram_id, false);
        }
      }
    }
  }, POLL_INTERVAL_MS);

  console.log(`Auto deposit scheduler running (checking every ${POLL_INTERVAL_MS / 60000} min).`);
}

module.exports = { startAutoDepositScheduler };
