const mints = new Map();
function now() {
    return Date.now();
}
function isValidNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
}
function getWindow(points, ms) {
    const cutoff = now() - ms;
    return points.filter((p) => p && isValidNumber(p.price) && p.ts >= cutoff);
}
function getVolumeWindow(points, ms) {
    const cutoff = now() - ms;
    return points.filter((p) => p && isValidNumber(p.vol) && p.ts >= cutoff);
}
function pctChange(from, to) {
    if (!isValidNumber(from) || !isValidNumber(to) || from <= 0)
        return 0;
    return to / from - 1;
}
function getHigh(points) {
    if (!points.length)
        return 0;
    return Math.max(...points.map((p) => p.price));
}
function getLow(points) {
    if (!points.length)
        return 0;
    return Math.min(...points.map((p) => p.price));
}
function cleanupOldData(state) {
    const priceCutoff = now() - 60 * 60 * 1000;
    const volumeCutoff = now() - 60 * 60 * 1000;
    state.prices = state.prices
        .filter((p) => p && isValidNumber(p.price) && p.ts >= priceCutoff)
        .slice(-1000);
    state.volumeHistory = state.volumeHistory
        .filter((v) => v && isValidNumber(v.vol) && v.ts >= volumeCutoff)
        .slice(-1000);
}
export function upsertWatchedMint(mint, symbol) {
    if (!mint || typeof mint !== "string")
        return;
    const existing = mints.get(mint);
    if (existing) {
        if (symbol && typeof symbol === "string" && symbol.trim()) {
            existing.symbol = symbol;
        }
        return;
    }
    mints.set(mint, {
        mint,
        symbol: symbol || "PUMP",
        createdAt: now(),
        lastUpdatedAt: 0,
        lastTradeAt: 0,
        prices: [],
        liquidityUsd: 0,
        volume24hUsd: 0,
        volumeHistory: [],
        creatorWallet: undefined,
    });
    console.log(`🆕 Track Mint ${symbol || "PUMP"} ${mint}`);
    if (mints.size > 400) {
        const oldest = [...mints.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) {
            mints.delete(oldest.mint);
        }
    }
}
export function removeWatchedMint(mint) {
    mints.delete(mint);
}
export function ingestPriceUpdate(data) {
    if (!data?.mint || typeof data.mint !== "string")
        return;
    if (!isValidNumber(data.price) || data.price <= 0)
        return;
    const state = mints.get(data.mint);
    if (!state)
        return;
    const ts = now();
    state.prices.push({
        price: data.price,
        ts,
    });
    state.lastUpdatedAt = ts;
    state.lastTradeAt = ts;
    if (isValidNumber(data.liquidityUsd) && data.liquidityUsd >= 0) {
        state.liquidityUsd = data.liquidityUsd;
    }
    if (isValidNumber(data.volume24hUsd) && data.volume24hUsd >= 0) {
        state.volume24hUsd = data.volume24hUsd;
    }
    if (isValidNumber(data.volume5mUsd) && data.volume5mUsd >= 0) {
        state.volumeHistory.push({
            vol: data.volume5mUsd,
            ts,
        });
    }
    cleanupOldData(state);
}
export function ingestTradeEvent(data) {
    if (!data?.mint || typeof data.mint !== "string")
        return;
    upsertWatchedMint(data.mint, data.symbol || "PUMP");
    const state = mints.get(data.mint);
    if (state && data.creatorWallet) {
        state.creatorWallet = String(data.creatorWallet).trim();
    }
    const solAmount = isValidNumber(data.solAmount) ? data.solAmount : 0;
    const tokenAmount = isValidNumber(data.tokenAmount) ? data.tokenAmount : 0;
    let price = 0;
    if (solAmount > 0 && tokenAmount > 0) {
        price = solAmount / tokenAmount;
    }
    if (price > 0) {
        ingestPriceUpdate({
            mint: data.mint,
            price,
            liquidityUsd: data.liquidityUsd,
            volume24hUsd: data.volume24hUsd,
            volume5mUsd: data.volume5mUsd,
        });
    }
}
export async function refreshWatchedMints() {
    // Feed-basiert: aktuell kein aktiver HTTP Refresh
}
export function getMintMetrics(mint) {
    const s = mints.get(mint);
    if (!s)
        return null;
    if (!Array.isArray(s.prices) || s.prices.length < 1)
        return null;
    const validPrices = s.prices.filter((p) => p && isValidNumber(p.price) && p.price > 0);
    if (validPrices.length < 1)
        return null;
    const lastPoint = validPrices[validPrices.length - 1];
    if (!lastPoint || !isValidNumber(lastPoint.price) || lastPoint.price <= 0) {
        return null;
    }
    const currentPrice = lastPoint.price;
    const window5m = getWindow(validPrices, 5 * 60 * 1000);
    const window15m = getWindow(validPrices, 15 * 60 * 1000);
    const window1h = getWindow(validPrices, 60 * 60 * 1000);
    const base5m = window5m[0]?.price ?? currentPrice;
    const base15m = window15m[0]?.price ?? currentPrice;
    const base1h = window1h[0]?.price ?? currentPrice;
    const change5mPct = pctChange(base5m, currentPrice);
    const change15mPct = pctChange(base15m, currentPrice);
    const change1hPct = pctChange(base1h, currentPrice);
    const high1h = getHigh(window1h.length ? window1h : validPrices);
    const low5m = getLow(window5m.length ? window5m : validPrices);
    const dropFrom1hHighPct = high1h > 0 ? currentPrice / high1h - 1 : 0;
    const reboundFrom5mLowPct = low5m > 0 ? currentPrice / low5m - 1 : 0;
    const vol5mPoints = getVolumeWindow(s.volumeHistory || [], 5 * 60 * 1000);
    const volume5mUsd = vol5mPoints.length > 0
        ? vol5mPoints[vol5mPoints.length - 1]?.vol ?? 0
        : 0;
    const avgVolume5mUsd = vol5mPoints.length > 0
        ? vol5mPoints.reduce((sum, v) => sum + v.vol, 0) / vol5mPoints.length
        : volume5mUsd;
    return {
        mint: s.mint,
        symbol: s.symbol || "PUMP",
        currentPrice,
        liquidityUsd: isValidNumber(s.liquidityUsd) ? s.liquidityUsd : 0,
        volume5mUsd: isValidNumber(volume5mUsd) ? volume5mUsd : 0,
        volume24hUsd: isValidNumber(s.volume24hUsd) ? s.volume24hUsd : 0,
        change5mPct,
        change15mPct,
        change1hPct,
        dropFrom1hHighPct,
        reboundFrom5mLowPct,
        avgVolume5mUsd: isValidNumber(avgVolume5mUsd) ? avgVolume5mUsd : 0,
        sampleCount: validPrices.length,
        ageMs: now() - s.createdAt,
        lastTradeAt: s.lastTradeAt || 0,
        creatorWallet: s.creatorWallet,
    };
}
export function getAllMetrics() {
    const result = [];
    for (const mint of mints.keys()) {
        try {
            const metrics = getMintMetrics(mint);
            if (metrics) {
                result.push(metrics);
            }
        }
        catch (err) {
            console.log(`⚠️ getMintMetrics Fehler ${mint}:`, err);
        }
    }
    return result;
}
export function getMintPriceSeries(mint, limit = 32) {
    const s = mints.get(mint);
    if (!s || !Array.isArray(s.prices) || s.prices.length < 1)
        return [];
    const points = s.prices
        .filter((p) => p && isValidNumber(p.price) && p.price > 0)
        .slice(-Math.max(5, limit));
    const basePrice = points[0]?.price || 0;
    return points.map((p) => ({
        ts: p.ts,
        price: p.price,
        pctFromFirst: basePrice > 0 ? p.price / basePrice - 1 : 0,
    }));
}
