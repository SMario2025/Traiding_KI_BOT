import WebSocket from "ws";
import { ingestTradeEvent, upsertWatchedMint, } from "./pumpStream.js";
import { insertBotEvent, setBotHealth, upsertMintCreator, upsertSeenMintObservation } from "../db.js";
let ws = null;
let debugLogged = 0;
const subscribedTradeMints = new Set();
const pendingTradeMints = new Set();
const subscribedTradeMintQueue = [];
let reconnectTimer = null;
let staleCheckTimer = null;
let heartbeatTimer = null;
let subscribeFlushTimer = null;
let lastMessageAt = 0;
let reconnectAttempt = 0;
let intentionalClose = false;
const MAX_ACTIVE_TRADE_SUBSCRIPTIONS = Number(process.env.PUMP_MAX_TRADE_SUBS || 80);
const TRADE_SUBSCRIBE_BATCH_SIZE = Number(process.env.PUMP_TRADE_SUB_BATCH || 12);
const HEARTBEAT_INTERVAL_MS = Number(process.env.PUMP_HEARTBEAT_MS || 20000);
const STALE_TIMEOUT_MS = Number(process.env.PUMP_STALE_TIMEOUT_MS || 90000);
function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
function extractMint(data) {
    return String(data?.mint ??
        data?.tokenAddress ??
        data?.baseMint ??
        data?.address ??
        "").trim();
}
function extractCreatorWallet(data) {
    return String(data?.creatorWallet ??
        data?.traderPublicKey ??
        data?.creator ??
        data?.user ??
        data?.owner ??
        "").trim();
}
function extractSymbol(data) {
    return String(data?.symbol ??
        data?.ticker ??
        data?.name ??
        "PUMP").trim();
}
function flushTradeSubscriptions() {
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;
    if (pendingTradeMints.size < 1)
        return;
    const nextBatch = [];
    for (const mint of [...pendingTradeMints]) {
        pendingTradeMints.delete(mint);
        if (!mint || subscribedTradeMints.has(mint))
            continue;
        if (subscribedTradeMints.size >= MAX_ACTIVE_TRADE_SUBSCRIPTIONS)
            break;
        nextBatch.push(mint);
        if (nextBatch.length >= TRADE_SUBSCRIBE_BATCH_SIZE)
            break;
    }
    if (nextBatch.length < 1)
        return;
    try {
        ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: nextBatch }));
        for (const mint of nextBatch) {
            subscribedTradeMints.add(mint);
            subscribedTradeMintQueue.push(mint);
        }
        console.log(`👀 Subscribed token trades: +${nextBatch.length} (${subscribedTradeMints.size}/${MAX_ACTIVE_TRADE_SUBSCRIPTIONS})`);
    }
    catch (err) {
        for (const mint of nextBatch)
            pendingTradeMints.add(mint);
        console.log("⚠️ Trade subscribe failed:", err?.message || err);
    }
}
function scheduleTradeSubscriptionFlush() {
    if (subscribeFlushTimer)
        return;
    subscribeFlushTimer = setTimeout(() => {
        subscribeFlushTimer = null;
        flushTradeSubscriptions();
        if (pendingTradeMints.size > 0)
            scheduleTradeSubscriptionFlush();
    }, 900);
}
function subscribeTokenTrades(mint) {
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;
    if (!mint || subscribedTradeMints.has(mint) || pendingTradeMints.has(mint))
        return;
    if (subscribedTradeMints.size >= MAX_ACTIVE_TRADE_SUBSCRIPTIONS)
        return;
    pendingTradeMints.add(mint);
    scheduleTradeSubscriptionFlush();
}
function handleEvent(rawMsg) {
    const data = rawMsg?.data ?? rawMsg;
    if (!data || typeof data !== "object")
        return;
    const mint = extractMint(data);
    if (!mint)
        return;
    const symbol = extractSymbol(data);
    const creatorWallet = extractCreatorWallet(data);
    upsertWatchedMint(mint, symbol);
    if (creatorWallet) {
        upsertMintCreator({ mint, symbol, creatorWallet });
    }
    subscribeTokenTrades(mint);
    setBotHealth({ lastFeedAt: Date.now() });
    const solAmount = toNum(data?.solAmount) ||
        toNum(data?.sol_amount) ||
        toNum(data?.baseAmount) ||
        toNum(data?.amountSol);
    const tokenAmount = toNum(data?.tokenAmount) ||
        toNum(data?.token_amount) ||
        toNum(data?.amountToken) ||
        toNum(data?.initialBuy) ||
        toNum(data?.tokensBought);
    let liquidityUsd = toNum(data?.liquidityUsd) ||
        toNum(data?.liquidity) ||
        toNum(data?.market?.liquidityUsd);
    if (liquidityUsd <= 0 && solAmount > 0) {
        liquidityUsd = solAmount * 100;
    }
    let volume24hUsd = toNum(data?.volume24hUsd) ||
        toNum(data?.volume24h) ||
        toNum(data?.market?.volume24hUsd);
    let volume5mUsd = toNum(data?.volume5mUsd) ||
        toNum(data?.volume5m) ||
        toNum(data?.market?.volume5mUsd);
    if (volume5mUsd <= 0 && solAmount > 0) {
        volume5mUsd = solAmount * 50;
    }
    ingestTradeEvent({
        mint,
        symbol,
        solAmount,
        tokenAmount,
        liquidityUsd,
        volume24hUsd,
        volume5mUsd,
        creatorWallet,
    });
    const price = solAmount > 0 && tokenAmount > 0
        ? solAmount / tokenAmount
        : 0;
    upsertSeenMintObservation({ mint, symbol, price, liquidityUsd, volume5mUsd, volume24hUsd, source: "feed" });
    if (price > 0) {
        console.log(`📈 PRICE ${symbol} | ${price} | liq=${liquidityUsd} | vol5m=${volume5mUsd}`);
    }
}
function clearFeedTimers() {
    if (staleCheckTimer)
        clearInterval(staleCheckTimer);
    if (heartbeatTimer)
        clearInterval(heartbeatTimer);
    if (subscribeFlushTimer)
        clearTimeout(subscribeFlushTimer);
    staleCheckTimer = null;
    heartbeatTimer = null;
    subscribeFlushTimer = null;
}
function nextReconnectDelayMs() {
    reconnectAttempt += 1;
    const base = Math.min(30000, 2500 * Math.max(1, reconnectAttempt));
    const jitter = Math.floor(Math.random() * 1200);
    return base + jitter;
}
function scheduleReconnect(delayMs) {
    if (reconnectTimer)
        return;
    const waitMs = delayMs ?? nextReconnectDelayMs();
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startPumpFeed();
    }, waitMs);
}
function restartFeed(reason) {
    if (!ws)
        return;
    intentionalClose = true;
    try {
        ws.terminate();
    }
    catch { }
    insertBotEvent("warn", "feed_reconnect", `Pump feed reconnect: ${reason}`);
    setBotHealth({ status: "reconnecting", details: { feedReason: reason, feedState: "reconnecting" } });
}
export function startPumpFeed() {
    if (ws)
        return;
    console.log("🌐 Starte Pump Feed...");
    const apiKey = process.env.PUMP_API_KEY?.trim();
    const url = apiKey
        ? `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(apiKey)}`
        : "wss://pumpportal.fun/api/data";
    ws = new WebSocket(url);
    ws.on("open", () => {
        console.log("✅ Pump Feed verbunden");
        intentionalClose = false;
        reconnectAttempt = 0;
        lastMessageAt = Date.now();
        pendingTradeMints.clear();
        insertBotEvent("success", "feed_connected", "Pump feed connected");
        setBotHealth({ status: "feed_connected", lastFeedAt: Date.now(), details: { feedState: "connected" } });
        ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
        ws?.send(JSON.stringify({ method: "subscribeMigration" }));
        clearFeedTimers();
        heartbeatTimer = setInterval(() => {
            try {
                if (ws?.readyState === WebSocket.OPEN)
                    ws.ping();
            }
            catch { }
        }, HEARTBEAT_INTERVAL_MS);
        staleCheckTimer = setInterval(() => {
            const ageMs = Date.now() - lastMessageAt;
            const staleSec = Math.floor(ageMs / 1000);
            setBotHealth({ details: { feedState: ageMs > 15000 ? "stale" : "streaming", feedStaleMs: ageMs } });
            if (lastMessageAt > 0 && ageMs > STALE_TIMEOUT_MS) {
                console.log(`⚠️ Feed stale ${staleSec}s -> reconnect`);
                restartFeed(`stale_${staleSec}s`);
            }
        }, 5000);
    });
    ws.on("message", (raw) => {
        lastMessageAt = Date.now();
        setBotHealth({ lastFeedAt: lastMessageAt, details: { feedState: "streaming" } });
        try {
            const text = raw.toString();
            if (debugLogged < 5) {
                console.log("📦 FEED RAW:", text.slice(0, 400));
                debugLogged++;
            }
            const msg = JSON.parse(text);
            if (Array.isArray(msg)) {
                for (const item of msg) {
                    handleEvent(item);
                }
                return;
            }
            if (Array.isArray(msg?.data)) {
                for (const item of msg.data) {
                    handleEvent(item);
                }
                return;
            }
            handleEvent(msg);
        }
        catch (err) {
            console.log("⚠️ Feed Parse Error:", err?.message || err);
        }
    });
    ws.on("close", () => {
        console.log("❌ Feed disconnected → reconnect...");
        clearFeedTimers();
        insertBotEvent("warn", "feed_disconnected", "Pump feed disconnected; reconnecting");
        setBotHealth({ status: "reconnecting", details: { feedState: "reconnecting", lastFeedAt: lastMessageAt } });
        ws = null;
        subscribedTradeMints.clear();
        pendingTradeMints.clear();
        subscribedTradeMintQueue.length = 0;
        const quickReconnect = intentionalClose;
        intentionalClose = false;
        scheduleReconnect(quickReconnect ? 1500 : undefined);
    });
    ws.on("error", (err) => {
        console.log("❌ WS Error:", err?.message || err);
        insertBotEvent("error", "feed_error", "Pump feed websocket error", { error: err?.message || String(err) });
        setBotHealth({ status: "feed_error", details: { feedState: "error", error: err?.message || String(err) } });
        if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            intentionalClose = true;
            try {
                ws.terminate();
            }
            catch { }
        }
    });
    ws.on("pong", () => {
        lastMessageAt = Date.now();
    });
}
