// Live token price helpers via DexScreener (no API key required).

const fetch = require('node-fetch');

/**
 * Fetch token info + USD price from DexScreener.
 * address = contract (EVM) or mint (Solana)
 * Returns { symbol, name, priceUsd, chainId, url } or null
 */
async function fetchTokenPrice(address) {
  const cleaned = String(address).trim();
  if (!cleaned || cleaned.length < 8) return null;

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(cleaned)}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs || [];
    if (!pairs.length) return null;

    // Prefer highest liquidity pair
    pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    const p = pairs[0];
    const priceUsd = Number(p.priceUsd);
    if (!priceUsd || Number.isNaN(priceUsd)) return null;

    return {
      symbol: p.baseToken?.symbol || 'TOKEN',
      name: p.baseToken?.name || p.baseToken?.symbol || 'Unknown',
      priceUsd,
      chainId: p.chainId || '',
      pairAddress: p.pairAddress || '',
      url: p.url || `https://dexscreener.com/search?q=${cleaned}`,
      priceChange24h: p.priceChange?.h24 != null ? Number(p.priceChange.h24) : null,
    };
  } catch (err) {
    console.error('fetchTokenPrice error:', err.message);
    return null;
  }
}

/**
 * Enrich a list of positions with live prices + PnL.
 */
async function enrichPositions(positions) {
  const out = [];
  for (const pos of positions) {
    const live = await fetchTokenPrice(pos.token_address);
    const entry = Number(pos.entry_price_usd) || 0;
    const tokens = Number(pos.token_amount) || 0;
    const invested = Number(pos.amount_usd) || 0;
    let currentPrice = live ? live.priceUsd : entry;
    let currentValue = tokens * currentPrice;
    let pnl = currentValue - invested;
    let pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

    out.push({
      ...pos,
      symbol: live?.symbol || pos.token_symbol || 'TOKEN',
      name: live?.name || pos.token_name || '',
      currentPrice,
      currentValue,
      pnl,
      pnlPct,
      priceChange24h: live?.priceChange24h ?? null,
      dexUrl: live?.url || null,
      live: !!live,
    });
  }
  return out;
}

module.exports = { fetchTokenPrice, enrichPositions };
