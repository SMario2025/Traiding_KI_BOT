import fs from "fs";
import path from "path";
import { config } from "./config.js";
const dbPath = path.resolve(config.dbPath);
const dbDir = path.dirname(dbPath);
const jsonPath = dbPath.endsWith('.json') ? dbPath : dbPath.replace(/\.db$/i, '.json');
const backupPath = `${jsonPath}.bak`;
if (!fs.existsSync(dbDir))
    fs.mkdirSync(dbDir, { recursive: true });
function nowIso() {
    return new Date().toISOString();
}
function defaultStore() {
    return {
        counters: {},
        trades: [],
        positions: [],
        price_history: [],
        bot_trade_log: [],
        runtime_positions: [],
        runtime_watchlist: [],
        equity_snapshots: [],
        bot_events: [],
        bot_decisions: [],
        ai_snapshots: [],
        mint_creators: [],
        wallet_profiles: [],
        seen_mints: [],
        learning_history: [],
        users: [],
        bot_health: {
            status: 'idle',
            lastLoopAt: 0,
            lastFeedAt: 0,
            lastBuyAt: 0,
            lastSellAt: 0,
            updatedAt: 0,
            details: {},
        },
        dashboard_controls: {
            killSwitch: false,
            sizeMultiplier: 1,
            maxPositionsOverride: null,
            abortAll: false,
            abortMints: [],
            updatedAt: 0,
        },
    };
}
function normalizeStore(parsed) {
    const defaults = defaultStore();
    return {
        ...defaults,
        ...parsed,
        bot_health: { ...defaults.bot_health, ...(parsed.bot_health || {}) },
        dashboard_controls: { ...defaults.dashboard_controls, ...(parsed.dashboard_controls || {}) },
        counters: parsed.counters || {},
        trades: parsed.trades || [],
        positions: parsed.positions || [],
        price_history: parsed.price_history || [],
        bot_trade_log: parsed.bot_trade_log || [],
        runtime_positions: parsed.runtime_positions || [],
        runtime_watchlist: parsed.runtime_watchlist || [],
        equity_snapshots: parsed.equity_snapshots || [],
        bot_events: parsed.bot_events || [],
        bot_decisions: parsed.bot_decisions || [],
        ai_snapshots: parsed.ai_snapshots || [],
        mint_creators: parsed.mint_creators || [],
        wallet_profiles: parsed.wallet_profiles || [],
        seen_mints: parsed.seen_mints || [],
        learning_history: parsed.learning_history || [],
        users: parsed.users || [],
    };
}
function tryReadStore(filePath) {
    if (!fs.existsSync(filePath))
        return null;
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim())
            return null;
        return normalizeStore(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
let store = defaultStore();
let storeDirty = false;
let saveTimer = null;
let lastSaveAt = 0;
const SAVE_DEBOUNCE_MS = Number(process.env.DB_SAVE_DEBOUNCE_MS || 350);
function loadStore(fallback = store) {
    const current = tryReadStore(jsonPath);
    if (current)
        return current;
    const backup = tryReadStore(backupPath);
    if (backup)
        return backup;
    return fallback || defaultStore();
}
store = loadStore(defaultStore());
function refreshStore() {
    if (storeDirty)
        return;
    store = loadStore(store);
}
function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function replaceFileRobust(tempPath, targetPath) {
    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            if (fs.existsSync(targetPath)) {
                try {
                    fs.chmodSync(targetPath, 0o666);
                }
                catch { }
            }
            try {
                fs.rmSync(targetPath, { force: true });
            }
            catch { }
            fs.renameSync(tempPath, targetPath);
            return;
        }
        catch (error) {
            lastError = error;
            if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') {
                throw error;
            }
            try {
                fs.copyFileSync(tempPath, targetPath);
                try {
                    fs.rmSync(tempPath, { force: true });
                }
                catch { }
                return;
            }
            catch (copyError) {
                lastError = copyError;
                if (copyError?.code !== 'EPERM' && copyError?.code !== 'EBUSY' && copyError?.code !== 'EACCES') {
                    throw copyError;
                }
            }
            sleepMs(40 * (attempt + 1));
        }
    }
    throw lastError instanceof Error ? lastError : new Error('Failed to replace JSON store file');
}
function writeStoreToDisk() {
    const payload = JSON.stringify(store, null, 2);
    const tempPath = `${jsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, payload, 'utf8');
    replaceFileRobust(tempPath, jsonPath);
    try {
        fs.writeFileSync(backupPath, payload, 'utf8');
    }
    catch { }
    storeDirty = false;
    lastSaveAt = Date.now();
}
function saveStore(force = false) {
    storeDirty = true;
    const now = Date.now();
    const age = now - lastSaveAt;
    if (force || age >= SAVE_DEBOUNCE_MS) {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        writeStoreToDisk();
        return;
    }
    if (saveTimer)
        return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (!storeDirty)
            return;
        writeStoreToDisk();
    }, Math.max(25, SAVE_DEBOUNCE_MS - age));
}
process.on('beforeExit', () => {
    if (!storeDirty)
        return;
    try {
        writeStoreToDisk();
    }
    catch { }
});
process.on('SIGINT', () => {
    if (storeDirty) {
        try {
            writeStoreToDisk();
        }
        catch { }
    }
    process.exit(0);
});
process.on('SIGTERM', () => {
    if (storeDirty) {
        try {
            writeStoreToDisk();
        }
        catch { }
    }
    process.exit(0);
});
function nextId(key) {
    store.counters[key] = Number(store.counters[key] || 0) + 1;
    return store.counters[key];
}
function limitLatest(arr, max) {
    if (arr.length > max)
        arr.splice(0, arr.length - max);
}
export const db = { kind: 'json-store', path: jsonPath };
export function insertTrade(params) {
    store.trades.push({ id: nextId('trades'), pair: params.pair, side: params.side, price: params.price, amount_sol: params.amountSol, amount_out: params.amountOut, pnl: params.pnl ?? 0, status: params.status ?? 'FILLED', notes: params.notes ?? '', tx: params.tx ?? '', created_at: nowIso() });
    limitLatest(store.trades, 5000);
    saveStore();
}
export function getTrades(limit = 100) {
    refreshStore();
    return [...store.trades].sort((a, b) => b.id - a.id).slice(0, limit);
}
export function getTradesByPair(pair, limit = 100) {
    refreshStore();
    return getTrades(10000).filter(x => x.pair === pair).slice(0, limit);
}
export function setOpenPosition(params) {
    const existing = store.positions.find(x => x.pair === params.pair);
    if (existing) {
        existing.entry_price = params.entryPrice;
        existing.amount_sol = params.amountSol;
        existing.amount_token = params.amountToken;
        existing.opened_at = nowIso();
    }
    else {
        store.positions.push({ id: nextId('positions'), pair: params.pair, entry_price: params.entryPrice, amount_sol: params.amountSol, amount_token: params.amountToken, opened_at: nowIso() });
    }
    saveStore();
}
export function getOpenPosition(pair) {
    refreshStore();
    return store.positions.find(x => x.pair === pair);
}
export function getAllOpenPositions() {
    refreshStore();
    return [...store.positions].sort((a, b) => b.id - a.id);
}
export function closePosition(pair) {
    refreshStore();
    store.positions = store.positions.filter(x => x.pair !== pair);
    saveStore();
}
export function insertPrice(pair, price) {
    refreshStore();
    store.price_history.push({ id: nextId('price_history'), pair, price, created_at: nowIso() });
    limitLatest(store.price_history, 10000);
    saveStore();
}
export function getRecentPrices(pair, limit = 100) {
    refreshStore();
    return store.price_history.filter(x => x.pair === pair).sort((a, b) => b.id - a.id).slice(0, limit).map(x => Number(x.price)).reverse();
}
export function trimPriceHistory(keepPerPair = 500) {
    refreshStore();
    const grouped = new Map();
    for (const row of store.price_history) {
        const arr = grouped.get(row.pair) || [];
        arr.push(row);
        grouped.set(row.pair, arr);
    }
    store.price_history = Array.from(grouped.values()).flatMap(rows => rows.sort((a, b) => b.id - a.id).slice(0, keepPerPair));
    saveStore();
}
export function getLastBuyTime(pair) {
    refreshStore();
    const row = getTradesByPair(pair, 1000).find(x => x.side === 'BUY');
    return row ? new Date(row.created_at).getTime() : null;
}
export function getTotalRealizedPnl() {
    refreshStore();
    return Number(store.trades.filter(x => x.side === 'SELL').reduce((s, x) => s + Number(x.pnl || 0), 0));
}
export function getDailyRealizedPnl() {
    refreshStore();
    const day = new Date().toISOString().slice(0, 10);
    return Number(store.trades.filter(x => x.side === 'SELL' && String(x.created_at).slice(0, 10) === day).reduce((s, x) => s + Number(x.pnl || 0), 0));
}
export function logBotTrade(params) {
    refreshStore();
    store.bot_trade_log.push({ id: nextId('bot_trade_log'), mint: params.mint, symbol: params.symbol, side: params.side, entry_price: params.entryPrice ?? 0, exit_price: params.exitPrice ?? 0, size_sol: params.sizeSol, pnl_pct: params.pnlPct ?? 0, pnl_sol: params.pnlSol ?? 0, reason: params.reason ?? '', route: params.route ?? '', txid: params.txid ?? '', status: params.status ?? 'FILLED', created_at: nowIso() });
    limitLatest(store.bot_trade_log, 10000);
    saveStore();
}
export function getBotTrades(limit = 100) {
    refreshStore();
    return [...store.bot_trade_log].sort((a, b) => b.id - a.id).slice(0, limit);
}
export function getBotTradeStats() {
    refreshStore();
    const sells = store.bot_trade_log.filter(x => x.side === 'SELL');
    const realizedPnlSol = sells.reduce((s, x) => s + Number(x.pnl_sol || 0), 0);
    const wins = sells.filter(x => Number(x.pnl_sol || 0) > 0).length;
    const losses = sells.filter(x => Number(x.pnl_sol || 0) <= 0).length;
    return { totalTrades: store.bot_trade_log.length, realizedPnlSol, wins, losses };
}
export function upsertRuntimePosition(params) {
    refreshStore();
    const existing = store.runtime_positions.find(x => x.mint === params.mint);
    const row = { mint: params.mint, symbol: params.symbol, entry_time: params.entryTime, entry_price: params.entryPrice, highest_price_seen: params.highestPriceSeen, size_sol: params.sizeSol, buy_txid: params.buyTxid, route: params.route, updated_at: Date.now() };
    if (existing)
        Object.assign(existing, row);
    else
        store.runtime_positions.push(row);
    saveStore();
}
export function removeRuntimePosition(mint) {
    refreshStore();
    store.runtime_positions = store.runtime_positions.filter(x => x.mint !== mint);
    saveStore();
}
export function getRuntimePositions() {
    refreshStore();
    return [...store.runtime_positions].sort((a, b) => b.entry_time - a.entry_time);
}
export function insertEquitySnapshot(params) {
    refreshStore();
    store.equity_snapshots.push({ id: nextId('equity_snapshots'), ts: params.ts ?? Date.now(), wallet_sol: params.walletSol, open_positions_value_sol: params.openPositionsValueSol, realized_pnl_sol: params.realizedPnlSol, total_equity_sol: params.totalEquitySol, open_positions: params.openPositions, watched_mints: params.watchedMints });
    limitLatest(store.equity_snapshots, 3000);
    saveStore();
}
export function getRecentEquitySnapshots(limit = 200) {
    refreshStore();
    return [...store.equity_snapshots].sort((a, b) => b.id - a.id).slice(0, limit).reverse();
}
export function insertBotEvent(level, type, message, meta) {
    refreshStore();
    store.bot_events.push({ id: nextId('bot_events'), level, type, message, meta: meta || {}, created_at: nowIso() });
    limitLatest(store.bot_events, 5000);
    saveStore();
}
export function logBotDecision(params) {
    refreshStore();
    store.bot_decisions.push({ id: nextId('bot_decisions'), mint: params.mint, symbol: params.symbol, action: params.action, score: params.score ?? 0, summary: params.summary ?? '', details: params.details || {}, created_at: nowIso() });
    limitLatest(store.bot_decisions, 8000);
    saveStore();
}
export function getRecentBotDecisions(limit = 100) {
    refreshStore();
    return [...store.bot_decisions].sort((a, b) => b.id - a.id).slice(0, limit);
}
export function getActiveWatchlist(limit = 12) {
    refreshStore();
    return getRuntimeWatchlist(limit).filter(x => x.status !== 'COOLDOWN');
}
export function getDecisionSummary(limit = 500) {
    refreshStore();
    const counts = new Map();
    for (const row of getRecentBotDecisions(limit))
        counts.set(row.action, (counts.get(row.action) || 0) + 1);
    return [...counts.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count);
}
export function getRecentBotEvents(limit = 100) {
    refreshStore();
    return [...store.bot_events].sort((a, b) => b.id - a.id).slice(0, limit);
}
export function setBotHealth(params) {
    refreshStore();
    if (params.status !== undefined)
        store.bot_health.status = params.status;
    if (params.lastLoopAt !== undefined)
        store.bot_health.lastLoopAt = params.lastLoopAt;
    if (params.lastFeedAt !== undefined)
        store.bot_health.lastFeedAt = params.lastFeedAt;
    if (params.lastBuyAt !== undefined)
        store.bot_health.lastBuyAt = params.lastBuyAt;
    if (params.lastSellAt !== undefined)
        store.bot_health.lastSellAt = params.lastSellAt;
    if (params.details !== undefined) {
        const prev = (store.bot_health.details && typeof store.bot_health.details === 'object') ? store.bot_health.details : {};
        const next = (params.details && typeof params.details === 'object') ? params.details : {};
        store.bot_health.details = { ...prev, ...next };
    }
    store.bot_health.updatedAt = Date.now();
    saveStore();
}
export function getBotHealth() {
    refreshStore();
    return { ...store.bot_health };
}
export function upsertMintCreator(params) {
    refreshStore();
    if (!params.creatorWallet)
        return;
    const wallet = String(params.creatorWallet).trim();
    const existing = store.mint_creators.find(x => x.mint === params.mint);
    const now = Date.now();
    if (existing) {
        existing.symbol = params.symbol || existing.symbol;
        existing.creator_wallet = wallet;
        existing.last_seen_at = now;
    }
    else {
        store.mint_creators.push({ mint: params.mint, symbol: params.symbol || 'PUMP', creator_wallet: wallet, first_seen_at: now, last_seen_at: now, outcome_recorded: false, last_pnl_pct: 0, last_pnl_sol: 0 });
    }
    const profile = getWalletProfile(wallet);
    if (profile) {
        profile.total_launches += existing ? 0 : 1;
        profile.last_launch_at = now;
    }
    else {
        store.wallet_profiles.push({ wallet, total_launches: 1, closed_launches: 0, wins: 0, losses: 0, total_pnl_pct: 0, total_pnl_sol: 0, best_pnl_pct: 0, confidence_score: 50, last_launch_at: now, last_result_at: 0, notes_json: {} });
    }
    recomputeWalletScores();
    saveStore();
}
export function getMintCreator(mint) {
    refreshStore();
    return store.mint_creators.find(x => x.mint === mint);
}
export function getWalletProfile(wallet) {
    refreshStore();
    return store.wallet_profiles.find(x => x.wallet === wallet);
}
function recomputeWalletScores() {
    for (const row of store.wallet_profiles) {
        const closed = Math.max(1, row.closed_launches || 0);
        const winRate = (row.wins || 0) / closed;
        const avgPnl = Number(row.total_pnl_pct || 0) / closed;
        let score = 50;
        score += Math.max(-18, Math.min(18, (winRate - 0.5) * 40));
        score += Math.max(-15, Math.min(15, avgPnl * 60));
        score += Math.max(-6, Math.min(10, (row.total_launches || 0) * 1.2));
        score += Math.max(-8, Math.min(8, (row.best_pnl_pct || 0) * 25));
        row.confidence_score = Math.max(1, Math.min(99, Number(score.toFixed(2))));
    }
}
export function recordMintOutcome(params) {
    refreshStore();
    const creator = getMintCreator(params.mint);
    if (!creator || creator.outcome_recorded)
        return;
    creator.outcome_recorded = true;
    creator.last_pnl_pct = params.pnlPct;
    creator.last_pnl_sol = params.pnlSol;
    const profile = getWalletProfile(creator.creator_wallet);
    if (profile) {
        profile.closed_launches += 1;
        if (params.pnlSol > 0)
            profile.wins += 1;
        else
            profile.losses += 1;
        profile.total_pnl_pct += params.pnlPct;
        profile.total_pnl_sol += params.pnlSol;
        profile.best_pnl_pct = Math.max(profile.best_pnl_pct || 0, params.pnlPct);
        profile.last_result_at = Date.now();
    }
    recomputeWalletScores();
    saveStore();
}
export function getTopWalletProfiles(limit = 10) {
    refreshStore();
    return [...store.wallet_profiles].sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0)).slice(0, limit);
}
export function insertAiSnapshot(params) {
    refreshStore();
    store.ai_snapshots.push({ id: nextId('ai_snapshots'), ts: Date.now(), ai_enabled: params.aiEnabled, market_regime: params.marketRegime, ai_score_avg: params.aiScoreAvg, ai_score_best: params.aiScoreBest, allows: params.allows, rejects: params.rejects, reduce_size: params.reduceSize, high_confidence: params.highConfidence });
    limitLatest(store.ai_snapshots, 3000);
    saveStore();
}
export function getLatestAiSnapshot() {
    refreshStore();
    return [...store.ai_snapshots].sort((a, b) => b.id - a.id)[0] || null;
}
export function upsertRuntimeWatchlist(params) {
    refreshStore();
    const existing = store.runtime_watchlist.find(x => x.mint === params.mint);
    const row = { mint: params.mint, symbol: params.symbol, status: params.status, score: params.score, aiScore: params.aiScore, bestScore: params.bestScore, seenCount: params.seenCount, stableSeconds: params.stableSeconds, pullbackFromLocalHighPct: params.pullbackFromLocalHighPct, currentPrice: params.currentPrice, change5mPct: params.change5mPct, change15mPct: params.change15mPct, change1hPct: params.change1hPct, summary: params.summary, reasons: params.reasons, readyToBuy: params.readyToBuy, entryLabel: params.entryLabel, updatedAt: Date.now(), created_at: existing?.created_at || nowIso() };
    if (existing)
        Object.assign(existing, row);
    else
        store.runtime_watchlist.push(row);
    limitLatest(store.runtime_watchlist, 1000);
    saveStore();
}
export function deleteRuntimeWatchlist(mint) {
    refreshStore();
    store.runtime_watchlist = store.runtime_watchlist.filter(x => x.mint !== mint);
    saveStore();
}
export function getRuntimeWatchlistByMint(mint) {
    refreshStore();
    return store.runtime_watchlist.find(x => x.mint === mint);
}
export function getRuntimeWatchlist(limit = 24) { return [...store.runtime_watchlist].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit); }
export function upsertSeenMintObservation(params) {
    if (!params?.mint)
        return;
    refreshStore();
    const ts = Date.now();
    const price = Number(params.price || 0);
    const existing = store.seen_mints.find(x => x.mint === params.mint);
    const row = existing || {
        mint: params.mint,
        symbol: params.symbol || 'PUMP',
        first_seen_at: ts,
        last_seen_at: ts,
        observations: 0,
        last_price: price,
        first_price: price,
        highest_price: price > 0 ? price : 0,
        lowest_price: price > 0 ? price : 0,
        last_liquidity_usd: 0,
        last_volume5m_usd: 0,
        last_volume24h_usd: 0,
        best_score: 0,
        last_score: 0,
        best_ai_score: 0,
        last_ai_score: 0,
        ready_hits: 0,
        watch_hits: 0,
        positive_ticks: 0,
        source: params.source || 'unknown',
        entry_label: params.entryLabel || '',
        updated_at: ts,
    };
    row.symbol = params.symbol || row.symbol || 'PUMP';
    row.last_seen_at = ts;
    row.updated_at = ts;
    row.observations += 1;
    row.source = params.source || row.source || 'unknown';
    row.entry_label = params.entryLabel || row.entry_label || '';
    if (price > 0) {
        if (row.first_price <= 0)
            row.first_price = price;
        if (row.last_price > 0 && price > row.last_price)
            row.positive_ticks += 1;
        row.last_price = price;
        row.highest_price = row.highest_price > 0 ? Math.max(row.highest_price, price) : price;
        row.lowest_price = row.lowest_price > 0 ? Math.min(row.lowest_price, price) : price;
    }
    row.last_liquidity_usd = Number(params.liquidityUsd ?? row.last_liquidity_usd ?? 0);
    row.last_volume5m_usd = Number(params.volume5mUsd ?? row.last_volume5m_usd ?? 0);
    row.last_volume24h_usd = Number(params.volume24hUsd ?? row.last_volume24h_usd ?? 0);
    row.last_score = Math.max(0, Number(params.score || 0));
    row.best_score = Math.max(Number(row.best_score || 0), row.last_score);
    row.last_ai_score = Math.max(0, Number(params.aiScore || 0));
    row.best_ai_score = Math.max(Number(row.best_ai_score || 0), row.last_ai_score);
    if (params.status === 'READY')
        row.ready_hits += 1;
    if (params.status === 'WATCH' || params.status === 'READY')
        row.watch_hits += 1;
    if (!existing)
        store.seen_mints.push(row);
    limitLatest(store.seen_mints, 10000);
    saveStore();
}
export function getSeenMints(limit = 300) {
    refreshStore();
    return [...store.seen_mints].sort((a, b) => b.updated_at - a.updated_at).slice(0, limit);
}
export function getSeenMintStats(limit = 4000) {
    refreshStore();
    const rows = getSeenMints(limit);
    const observed = rows.length;
    const readyHits = rows.filter(x => Number(x.ready_hits || 0) > 0).length;
    const avgMovePct = rows.length ? rows.reduce((s, x) => s + (Number(x.first_price || 0) > 0 && Number(x.last_price || 0) > 0 ? (Number(x.last_price) / Number(x.first_price) - 1) : 0), 0) / rows.length : 0;
    const avgDrawdownPct = rows.length ? rows.reduce((s, x) => s + (Number(x.highest_price || 0) > 0 && Number(x.last_price || 0) > 0 ? Math.abs(Number(x.last_price) / Number(x.highest_price) - 1) : 0), 0) / rows.length : 0;
    const avgScore = rows.length ? rows.reduce((s, x) => s + Number(x.best_score || 0), 0) / rows.length : 0;
    const avgAiScore = rows.length ? rows.reduce((s, x) => s + Number(x.best_ai_score || 0), 0) / rows.length : 0;
    const positiveCloseRate = rows.length ? rows.filter(x => Number(x.first_price || 0) > 0 && Number(x.last_price || 0) > Number(x.first_price || 0)).length / rows.length : 0;
    const followThroughRate = rows.length ? rows.filter(x => Number(x.first_price || 0) > 0 && Number(x.highest_price || 0) / Number(x.first_price || 1) - 1 >= 0.05).length / rows.length : 0;
    const freshnessSec = rows.length ? rows.reduce((s, x) => s + Math.max(0, (Date.now() - Number(x.last_seen_at || 0)) / 1000), 0) / rows.length : 999999;
    return {
        observed,
        readyRate: observed ? readyHits / observed : 0,
        avgMovePct: Number(avgMovePct.toFixed(4)),
        avgDrawdownPct: Number(avgDrawdownPct.toFixed(4)),
        avgScore: Number(avgScore.toFixed(2)),
        avgAiScore: Number(avgAiScore.toFixed(2)),
        positiveCloseRate: Number(positiveCloseRate.toFixed(3)),
        followThroughRate: Number(followThroughRate.toFixed(3)),
        avgFreshnessSec: Number(freshnessSec.toFixed(1)),
    };
}
export function insertLearningSnapshot(params) {
    refreshStore();
    store.learning_history.push({
        id: nextId('learning_history'),
        ts: params.ts ?? Date.now(),
        phase: params.phase,
        confidence_score: params.confidenceScore,
        size_multiplier: params.sizeMultiplier,
        min_ai_score_boost: params.minAiScoreBoost,
        recent_win_rate: params.recentWinRate,
        recent_avg_pnl_pct: params.recentAvgPnlPct,
        total_closed_trades: params.totalClosedTrades,
        watchlist_quality_score: params.watchlistQualityScore,
        watchlist_observed: params.watchlistObserved,
        summary: params.summary,
    });
    limitLatest(store.learning_history, 5000);
    saveStore();
}
export function getLearningHistory(limit = 300) {
    refreshStore();
    return [...store.learning_history].sort((a, b) => b.id - a.id).slice(0, limit).reverse();
}
export function getDashboardControlState() {
    refreshStore();
    return { ...store.dashboard_controls, abortMints: [...store.dashboard_controls.abortMints] };
}
export function updateDashboardControlState(patch) {
    refreshStore();
    if (patch.killSwitch !== undefined)
        store.dashboard_controls.killSwitch = Boolean(patch.killSwitch);
    if (patch.sizeMultiplier !== undefined)
        store.dashboard_controls.sizeMultiplier = Math.max(0.25, Math.min(2, Number(patch.sizeMultiplier)));
    if (patch.maxPositionsOverride !== undefined)
        store.dashboard_controls.maxPositionsOverride = patch.maxPositionsOverride == null ? null : Math.max(1, Math.min(10, Number(patch.maxPositionsOverride)));
    if (patch.abortAll !== undefined)
        store.dashboard_controls.abortAll = Boolean(patch.abortAll);
    if (patch.abortMints !== undefined)
        store.dashboard_controls.abortMints = Array.from(new Set((patch.abortMints || []).map(String)));
    store.dashboard_controls.updatedAt = Date.now();
    saveStore();
    return getDashboardControlState();
}
export function requestAbortMint(mint) {
    refreshStore();
    if (!store.dashboard_controls.abortMints.includes(mint))
        store.dashboard_controls.abortMints.push(mint);
    store.dashboard_controls.updatedAt = Date.now();
    saveStore();
}
export function clearAbortMint(mint) {
    refreshStore();
    store.dashboard_controls.abortMints = store.dashboard_controls.abortMints.filter(x => x !== mint);
    saveStore();
}
export function consumeAbortAllFlag() {
    refreshStore();
    const flag = store.dashboard_controls.abortAll;
    if (flag) {
        store.dashboard_controls.abortAll = false;
        store.dashboard_controls.updatedAt = Date.now();
        saveStore();
    }
    return flag;
}
function safeId() {
    return Math.random().toString(36).slice(2, 10);
}
function defaultUserStats() {
    return { trades: 0, wins: 0, losses: 0, realized_pnl_sol: 0 };
}
export function createUserProfile(params) {
    refreshStore();
    const now = nowIso();
    const username = String(params.username || params.displayName || 'user').trim().toLowerCase().replace(/[^a-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || `user_${safeId()}`;
    const row = {
        id: `usr_${safeId()}`,
        username,
        display_name: String(params.displayName || username).trim(),
        email: String(params.email || '').trim(),
        bio: String(params.bio || '').trim(),
        avatar_url: String(params.avatarUrl || '').trim(),
        ai_enabled: params.aiEnabled !== false,
        wallet_public_key: String(params.walletPublicKey || '').trim(),
        wallet_secret_key: String(params.walletSecretKey || '').trim(),
        preferences: (params.preferences && typeof params.preferences === 'object') ? params.preferences : {},
        stats: defaultUserStats(),
        created_at: now,
        updated_at: now,
    };
    store.users = store.users.filter(x => x.username !== row.username && (!row.email || x.email !== row.email));
    store.users.push(row);
    saveStore(true);
    return row;
}
export function getUserProfiles(limit = 100) {
    refreshStore();
    return [...store.users].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, limit);
}
export function getUserProfileById(id) {
    refreshStore();
    return store.users.find(x => x.id === id);
}
export function updateUserProfile(id, patch) {
    refreshStore();
    const user = store.users.find(x => x.id === id);
    if (!user)
        return null;
    if (patch.username !== undefined)
        user.username = String(patch.username || user.username).trim().toLowerCase().replace(/[^a-z0-9_\-]+/g, '_') || user.username;
    if (patch.displayName !== undefined)
        user.display_name = String(patch.displayName || '').trim();
    if (patch.email !== undefined)
        user.email = String(patch.email || '').trim();
    if (patch.bio !== undefined)
        user.bio = String(patch.bio || '').trim();
    if (patch.avatarUrl !== undefined)
        user.avatar_url = String(patch.avatarUrl || '').trim();
    if (patch.aiEnabled !== undefined)
        user.ai_enabled = Boolean(patch.aiEnabled);
    if (patch.preferences !== undefined && patch.preferences && typeof patch.preferences === 'object')
        user.preferences = patch.preferences;
    if (patch.stats !== undefined && patch.stats)
        user.stats = { ...defaultUserStats(), ...patch.stats };
    user.updated_at = nowIso();
    saveStore(true);
    return user;
}
export function replaceUserWallet(id, walletPublicKey, walletSecretKey) {
    refreshStore();
    const user = store.users.find(x => x.id === id);
    if (!user)
        return null;
    user.wallet_public_key = String(walletPublicKey || '').trim();
    user.wallet_secret_key = String(walletSecretKey || '').trim();
    user.updated_at = nowIso();
    saveStore(true);
    return user;
}
export function deleteUserProfile(id) {
    refreshStore();
    const before = store.users.length;
    store.users = store.users.filter(x => x.id !== id);
    if (store.users.length !== before)
        saveStore(true);
    return store.users.length !== before;
}
