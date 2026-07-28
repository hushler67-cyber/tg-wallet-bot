# TG Wallet Bot

Telegram bot that provisions ETH, BTC, and Solana wallets for each new user on `/start`,
encrypts private keys at rest, and reports **addresses only** (never private keys) to a
second admin/backend bot for record-keeping.

## Setup

```bash
npm install
cp .env.example .env
```

Generate a master encryption key and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Fill in `.env`:
- `BOT_TOKEN` — from @BotFather, for the main user-facing bot
- `MASTER_KEY` — the key you just generated
- `ADMIN_BOT_TOKEN` / `ADMIN_CHAT_ID` — a second bot + the chat/channel ID it should post to

Run it:

```bash
npm start
```

## Hosting

This runs fine on any Node host that supports persistent disk (for the SQLite file) and
long-running processes — **Railway**, **Render** (background worker, not a web service),
or a small VPS (Fly.io, DigitalOcean). Avoid pure serverless platforms unless you swap
`better-sqlite3` for a hosted Postgres/MySQL, since serverless functions don't keep local
disk between invocations.

Whatever you pick: set the same env vars there, and treat `MASTER_KEY` as the single most
sensitive value in the whole system — store it in the platform's secret manager, not in a
committed file.

## Security model — read this before going to production

- **Private keys are encrypted with AES-256-GCM** (`src/crypto.js`) using `MASTER_KEY`
  before they ever reach the database. The DB only ever stores ciphertext.
- **The admin bot only ever receives addresses** (`src/adminNotify.js`). If you extend this
  bot, keep that contract — never pass a private key or the decrypted keys object into
  `notifyAdmin()` or any other outbound call.
- **This is a custodial model.** You are holding users' keys. Before launching for real
  users:
  - Add an explicit disclosure/consent step in `/start` (the current copy is a placeholder).
  - Build the "export keys" flow referenced in Settings so users can actually leave with
    their funds.
  - Decide on a key-rotation plan for `MASTER_KEY` — rotating it means decrypting
    everything with the old key and re-encrypting with the new one.
  - Consider a proper KMS/HSM (AWS KMS, GCP KMS, HashiCorp Vault) instead of an env-var
    master key once you have real funds in play — this scaffold is a reasonable starting
    point, not a final answer for holding significant value.
  - Rate-limit `/start` and validate `ctx.from.id` — don't trust client-supplied data
    beyond what Telegram itself signs.
- **Never log private keys or `MASTER_KEY`**, including in error messages or crash reports.

## What's stubbed

Copytrade, Autotrade, Live Charts, Bot Guide, Import Wallet, and Auto Deposit currently
just reply with a placeholder message — the wallet generation/storage/admin-reporting core
is fully wired, but the actual trading engine, chart data source, and import flow are up to
you to build out.
