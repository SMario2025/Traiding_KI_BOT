import type { MintMetrics } from "./live/pumpStream.js";
import { runAiFilter, type AiDecision } from "./aiFilter.js";

export type OpenPosition = {
    mint: string;
    symbol: string;
    entryTime: number;
    entryPrice: number;
    highestPriceSeen: number;
    buyTxid: string;
    route: string;
};

export type BuyDecision = {
    buy: boolean;
    mode: "SNIPER_MODE" | "TREND_MODE";
    score: number;
    sizeMultiplier: number;
    reasons: string[];
    redFlags: string[];
    reason: Record<string, boolean | number | string>;
    ai: AiDecision;
};

const ONLY_NEW_COINS = String(process.env.ONLY_NEW_COINS || "true") === "true";
const NEW_COIN_MAX_AGE_SECONDS = Number(process.env.NEW_COIN_MAX_AGE_SECONDS || 420);
const FRESH_MIN_LIQUIDITY_USD = Number(process.env.FRESH_MIN_LIQUIDITY_USD || 90);
const FRESH_MIN_VOLUME5M_USD = Number(process.env.FRESH_MIN_VOLUME5M_USD || 45);
const MIN_VOLUME_TO_LIQUIDITY = Number(process.env.MIN_VOLUME_TO_LIQUIDITY || 0.52);
const MIN_SAMPLE_COUNT = Number(process.env.MIN_SAMPLE_COUNT || 10);
const MAX_SECONDS_SINCE_TRADE = Number(process.env.MAX_SECONDS_SINCE_TRADE || 6);
const MOMENTUM_MIN_5M_PCT = Number(process.env.MOMENTUM_MIN_5M_PCT || 0.04);
const MOMENTUM_MAX_5M_PCT = Number(process.env.MOMENTUM_MAX_5M_PCT || 0.14);
const MOMENTUM_MIN_REBOUND_5M = Number(process.env.MOMENTUM_MIN_REBOUND_5M || 0.025);
const MOMENTUM_MAX_REBOUND_5M = Number(process.env.MOMENTUM_MAX_REBOUND_5M || 0.10);
const MAX_DROP_FROM_1H_HIGH_PCT = Number(process.env.MAX_DROP_FROM_1H_HIGH_PCT || -0.16);
const MIN_AVG_VOLUME5M_USD = Number(process.env.MIN_AVG_VOLUME5M_USD || 22);
const SNIPER_MIN_SCORE = Number(process.env.SNIPER_MIN_SCORE || 67);

const ENABLE_TREND_MODE = String(process.env.ENABLE_TREND_MODE || "true") === "true";
const TREND_MAX_AGE_SECONDS = Number(process.env.TREND_MAX_AGE_SECONDS || 1800);
const TREND_MIN_SCORE = Number(process.env.TREND_MIN_SCORE || 74);
const TREND_MIN_LIQUIDITY_USD = Number(process.env.TREND_MIN_LIQUIDITY_USD || 140);
const TREND_MIN_VOLUME5M_USD = Number(process.env.TREND_MIN_VOLUME5M_USD || 75);
const TREND_MIN_AVG_VOLUME5M_USD = Number(process.env.TREND_MIN_AVG_VOLUME5M_USD || 42);
const TREND_MIN_VOLUME_TO_LIQUIDITY = Number(process.env.TREND_MIN_VOLUME_TO_LIQUIDITY || 0.55);
const TREND_MIN_SAMPLE_COUNT = Number(process.env.TREND_MIN_SAMPLE_COUNT || 14);
const TREND_MAX_SECONDS_SINCE_TRADE = Number(process.env.TREND_MAX_SECONDS_SINCE_TRADE || 8);
const TREND_MIN_5M_PCT = Number(process.env.TREND_MIN_5M_PCT || 0.03);
const TREND_MAX_5M_PCT = Number(process.env.TREND_MAX_5M_PCT || 0.18);
const TREND_MIN_15M_PCT = Number(process.env.TREND_MIN_15M_PCT || 0.08);
const TREND_MAX_15M_PCT = Number(process.env.TREND_MAX_15M_PCT || 0.40);
const TREND_MIN_REBOUND_5M = Number(process.env.TREND_MIN_REBOUND_5M || 0.015);
const TREND_MAX_REBOUND_5M = Number(process.env.TREND_MAX_REBOUND_5M || 0.09);
const TREND_MAX_DROP_FROM_1H_HIGH_PCT = Number(process.env.TREND_MAX_DROP_FROM_1H_HIGH_PCT || -0.10);

const SL_PCT = Number(process.env.SL_PCT || 0.065);
const TAKE_PROFIT_PCT = Number(process.env.TP_PCT || process.env.TAKE_PROFIT_PCT || 0.16);
const FAST_TP_PCT = Number(process.env.FAST_TP_PCT || 0.10);
const FAST_TP_WINDOW_SECONDS = Number(process.env.FAST_TP_WINDOW_SECONDS || 18);
const TRAILING_STOP_PCT = Number(process.env.TRAILING_STOP_PCT || 0.045);
const BREAK_EVEN_ARM_PCT = Number(process.env.BREAK_EVEN_ARM_PCT || 0.05);
const BREAK_EVEN_BUFFER_PCT = Number(process.env.BREAK_EVEN_BUFFER_PCT || 0.008);
const MOMENTUM_FAIL_5M_PCT = Number(process.env.MOMENTUM_FAIL_5M_PCT || -0.035);
const MOMENTUM_FAIL_AFTER_SECONDS = Number(process.env.MOMENTUM_FAIL_AFTER_SECONDS || 16);
const MAX_HOLD_SECONDS = Number(process.env.MAX_HOLD_SECONDS || 150);
const STALE_POSITION_SECONDS = Number(process.env.STALE_POSITION_SECONDS || 14);

function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function buildDecision(params: {
    mode: "SNIPER_MODE" | "TREND_MODE";
    score: number;
    minScore: number;
    buy: boolean;
    reasons: string[];
    redFlags: string[];
    reason: Record<string, boolean | number | string>;
    ai: AiDecision;
}): BuyDecision {
    const sizeMultiplier =
        params.score >= 92 ? 1.0 :
        params.score >= 86 ? 0.9 :
        params.score >= 80 ? 0.78 :
        params.score >= params.minScore ? 0.68 : 0;

    const finalBuy = params.buy && params.ai.decision !== "REJECT";
    const finalSizeMultiplier = Number((sizeMultiplier * params.ai.sizeMultiplier).toFixed(3));

    return {
        buy: finalBuy,
        mode: params.mode,
        score: Number(params.score.toFixed(2)),
        sizeMultiplier: finalSizeMultiplier,
        reasons: [...params.reasons, ...params.ai.reasons],
        redFlags: [...params.redFlags, ...params.ai.redFlags],
        reason: params.reason,
        ai: params.ai,
    };
}

function evaluateSniper(m: MintMetrics, ageSeconds: number, secondsSinceTrade: number, volToLiquidity: number, notDead: boolean) {
    const isNewEnough = ONLY_NEW_COINS ? ageSeconds <= NEW_COIN_MAX_AGE_SECONDS : true;
    const liquidityEnough = m.liquidityUsd >= FRESH_MIN_LIQUIDITY_USD;
    const volumeEnough = m.volume5mUsd >= FRESH_MIN_VOLUME5M_USD;
    const avgVolumeEnough = m.avgVolume5mUsd >= MIN_AVG_VOLUME5M_USD;
    const volumeToLiquidityHealthy = volToLiquidity >= MIN_VOLUME_TO_LIQUIDITY;
    const sampleCountEnough = m.sampleCount >= MIN_SAMPLE_COUNT;
    const freshTrade = secondsSinceTrade <= MAX_SECONDS_SINCE_TRADE;
    const momentumGood = m.change5mPct >= MOMENTUM_MIN_5M_PCT && m.change5mPct <= MOMENTUM_MAX_5M_PCT;
    const reboundHealthy = m.reboundFrom5mLowPct >= MOMENTUM_MIN_REBOUND_5M && m.reboundFrom5mLowPct <= MOMENTUM_MAX_REBOUND_5M;
    const notDumped = m.dropFrom1hHighPct >= MAX_DROP_FROM_1H_HIGH_PCT;

    let score = 0;
    score += clamp((m.liquidityUsd - FRESH_MIN_LIQUIDITY_USD) / Math.max(FRESH_MIN_LIQUIDITY_USD, 1) * 18, 0, 18);
    score += clamp((m.volume5mUsd - FRESH_MIN_VOLUME5M_USD) / Math.max(FRESH_MIN_VOLUME5M_USD, 1) * 18, 0, 18);
    score += clamp((volToLiquidity - MIN_VOLUME_TO_LIQUIDITY) * 35, 0, 16);
    score += clamp((m.change5mPct - MOMENTUM_MIN_5M_PCT) * 145, 0, 15);
    score += clamp((m.reboundFrom5mLowPct - MOMENTUM_MIN_REBOUND_5M) * 150, 0, 12);
    score += clamp((m.sampleCount - MIN_SAMPLE_COUNT) * 1.2, 0, 7);
    score += freshTrade ? 6 : 0;
    score += notDumped ? 4 : 0;

    const redFlags: string[] = [];
    if (!isNewEnough) redFlags.push(`zu alt (${ageSeconds}s)`);
    if (!liquidityEnough) redFlags.push(`zu wenig Liquidität ($${m.liquidityUsd.toFixed(1)})`);
    if (!volumeEnough) redFlags.push(`zu wenig 5m-Volumen ($${m.volume5mUsd.toFixed(1)})`);
    if (!avgVolumeEnough) redFlags.push(`zu wenig avg5m ($${m.avgVolume5mUsd.toFixed(1)})`);
    if (!volumeToLiquidityHealthy) redFlags.push(`vol/liq zu schwach (${volToLiquidity.toFixed(2)})`);
    if (!sampleCountEnough) redFlags.push(`zu wenige Samples (${m.sampleCount})`);
    if (!freshTrade) redFlags.push(`letzter Trade zu alt (${secondsSinceTrade}s)`);
    if (!momentumGood) redFlags.push(`5m-Momentum ungeeignet (${(m.change5mPct * 100).toFixed(2)}%)`);
    if (!reboundHealthy) redFlags.push(`Rebound ungeeignet (${(m.reboundFrom5mLowPct * 100).toFixed(2)}%)`);
    if (!notDumped) redFlags.push(`zu weit unter 1h-High (${(m.dropFrom1hHighPct * 100).toFixed(2)}%)`);
    if (!notDead) redFlags.push("Coin wirkt tot");

    const reasons: string[] = [];
    if (liquidityEnough) reasons.push(`Liquidität ok $${m.liquidityUsd.toFixed(1)}`);
    if (volumeEnough) reasons.push(`5m-Vol ok $${m.volume5mUsd.toFixed(1)}`);
    if (volumeToLiquidityHealthy) reasons.push(`vol/liq ${volToLiquidity.toFixed(2)}`);
    if (momentumGood) reasons.push(`5m ${(m.change5mPct * 100).toFixed(2)}%`);
    if (reboundHealthy) reasons.push(`Rebound ${(m.reboundFrom5mLowPct * 100).toFixed(2)}%`);
    if (freshTrade) reasons.push(`frischer Flow ${secondsSinceTrade}s`);

    const buy =
        isNewEnough &&
        liquidityEnough &&
        volumeEnough &&
        avgVolumeEnough &&
        volumeToLiquidityHealthy &&
        sampleCountEnough &&
        freshTrade &&
        momentumGood &&
        reboundHealthy &&
        notDumped &&
        notDead &&
        score >= SNIPER_MIN_SCORE;

    const ai = runAiFilter({
        metrics: m,
        mode: "SNIPER_MODE",
        baseScore: score,
        ageSeconds,
        secondsSinceTrade,
        volToLiquidity,
    });

    return buildDecision({
        mode: "SNIPER_MODE",
        score,
        minScore: SNIPER_MIN_SCORE,
        buy,
        reasons,
        redFlags,
        ai,
        reason: {
            isNewEnough,
            liquidityEnough,
            volumeEnough,
            avgVolumeEnough,
            volumeToLiquidityHealthy,
            sampleCountEnough,
            freshTrade,
            momentumGood,
            reboundHealthy,
            notDumped,
            notDead,
            sniperScore: Number(score.toFixed(2)),
            sniperMinScore: SNIPER_MIN_SCORE,
        },
    });
}

function evaluateTrend(m: MintMetrics, ageSeconds: number, secondsSinceTrade: number, volToLiquidity: number, notDead: boolean) {
    const oldEnough = ageSeconds > NEW_COIN_MAX_AGE_SECONDS;
    const ageAllowed = ageSeconds <= TREND_MAX_AGE_SECONDS;
    const liquidityEnough = m.liquidityUsd >= TREND_MIN_LIQUIDITY_USD;
    const volumeEnough = m.volume5mUsd >= TREND_MIN_VOLUME5M_USD;
    const avgVolumeEnough = m.avgVolume5mUsd >= TREND_MIN_AVG_VOLUME5M_USD;
    const volumeToLiquidityHealthy = volToLiquidity >= TREND_MIN_VOLUME_TO_LIQUIDITY;
    const sampleCountEnough = m.sampleCount >= TREND_MIN_SAMPLE_COUNT;
    const freshTrade = secondsSinceTrade <= TREND_MAX_SECONDS_SINCE_TRADE;
    const momentum5mGood = m.change5mPct >= TREND_MIN_5M_PCT && m.change5mPct <= TREND_MAX_5M_PCT;
    const momentum15mGood = m.change15mPct >= TREND_MIN_15M_PCT && m.change15mPct <= TREND_MAX_15M_PCT;
    const reboundHealthy = m.reboundFrom5mLowPct >= TREND_MIN_REBOUND_5M && m.reboundFrom5mLowPct <= TREND_MAX_REBOUND_5M;
    const notDumped = m.dropFrom1hHighPct >= TREND_MAX_DROP_FROM_1H_HIGH_PCT;
    const notOverextended = m.reboundFrom5mLowPct < Math.max(0.14, TREND_MAX_REBOUND_5M + 0.03);

    let score = 0;
    score += clamp((m.liquidityUsd - TREND_MIN_LIQUIDITY_USD) / Math.max(TREND_MIN_LIQUIDITY_USD, 1) * 20, 0, 20);
    score += clamp((m.volume5mUsd - TREND_MIN_VOLUME5M_USD) / Math.max(TREND_MIN_VOLUME5M_USD, 1) * 18, 0, 18);
    score += clamp((m.avgVolume5mUsd - TREND_MIN_AVG_VOLUME5M_USD) / Math.max(TREND_MIN_AVG_VOLUME5M_USD, 1) * 10, 0, 10);
    score += clamp((volToLiquidity - TREND_MIN_VOLUME_TO_LIQUIDITY) * 32, 0, 12);
    score += clamp((m.change15mPct - TREND_MIN_15M_PCT) * 65, 0, 14);
    score += clamp((m.change5mPct - TREND_MIN_5M_PCT) * 115, 0, 10);
    score += clamp((m.sampleCount - TREND_MIN_SAMPLE_COUNT) * 0.8, 0, 6);
    score += freshTrade ? 5 : 0;
    score += notDumped ? 3 : 0;

    const redFlags: string[] = [];
    if (!oldEnough) redFlags.push(`noch zu frisch für Trend (${ageSeconds}s)`);
    if (!ageAllowed) redFlags.push(`Trend zu alt (${ageSeconds}s)`);
    if (!liquidityEnough) redFlags.push(`Trend-Liq zu klein ($${m.liquidityUsd.toFixed(1)})`);
    if (!volumeEnough) redFlags.push(`Trend-Vol 5m zu klein ($${m.volume5mUsd.toFixed(1)})`);
    if (!avgVolumeEnough) redFlags.push(`Trend avg5m zu klein ($${m.avgVolume5mUsd.toFixed(1)})`);
    if (!volumeToLiquidityHealthy) redFlags.push(`Trend vol/liq schwach (${volToLiquidity.toFixed(2)})`);
    if (!sampleCountEnough) redFlags.push(`Trend Samples zu wenig (${m.sampleCount})`);
    if (!freshTrade) redFlags.push(`Trend-Flow alt (${secondsSinceTrade}s)`);
    if (!momentum5mGood) redFlags.push(`Trend 5m ungeeignet (${(m.change5mPct * 100).toFixed(2)}%)`);
    if (!momentum15mGood) redFlags.push(`Trend 15m ungeeignet (${(m.change15mPct * 100).toFixed(2)}%)`);
    if (!reboundHealthy) redFlags.push(`Trend Rebound ungeeignet (${(m.reboundFrom5mLowPct * 100).toFixed(2)}%)`);
    if (!notDumped) redFlags.push(`Trend zu weit unter 1h-High (${(m.dropFrom1hHighPct * 100).toFixed(2)}%)`);
    if (!notOverextended) redFlags.push("Trend bereits überdehnt");
    if (!notDead) redFlags.push("Trend Coin wirkt tot");

    const reasons: string[] = [];
    if (liquidityEnough) reasons.push(`Trend-Liq $${m.liquidityUsd.toFixed(1)}`);
    if (volumeEnough) reasons.push(`Trend-Vol $${m.volume5mUsd.toFixed(1)}`);
    if (avgVolumeEnough) reasons.push(`Trend-avg5m $${m.avgVolume5mUsd.toFixed(1)}`);
    if (momentum15mGood) reasons.push(`15m ${(m.change15mPct * 100).toFixed(2)}%`);
    if (momentum5mGood) reasons.push(`5m ${(m.change5mPct * 100).toFixed(2)}%`);
    if (freshTrade) reasons.push(`Trend-Flow ${secondsSinceTrade}s`);

    const buy =
        ENABLE_TREND_MODE &&
        oldEnough &&
        ageAllowed &&
        liquidityEnough &&
        volumeEnough &&
        avgVolumeEnough &&
        volumeToLiquidityHealthy &&
        sampleCountEnough &&
        freshTrade &&
        momentum5mGood &&
        momentum15mGood &&
        reboundHealthy &&
        notDumped &&
        notOverextended &&
        notDead &&
        score >= TREND_MIN_SCORE;

    const ai = runAiFilter({
        metrics: m,
        mode: "TREND_MODE",
        baseScore: score,
        ageSeconds,
        secondsSinceTrade,
        volToLiquidity,
    });

    return buildDecision({
        mode: "TREND_MODE",
        score,
        minScore: TREND_MIN_SCORE,
        buy,
        reasons,
        redFlags,
        ai,
        reason: {
            oldEnough,
            ageAllowed,
            liquidityEnough,
            volumeEnough,
            avgVolumeEnough,
            volumeToLiquidityHealthy,
            sampleCountEnough,
            freshTrade,
            momentum5mGood,
            momentum15mGood,
            reboundHealthy,
            notDumped,
            notOverextended,
            notDead,
            trendScore: Number(score.toFixed(2)),
            trendMinScore: TREND_MIN_SCORE,
        },
    });
}

export function shouldBuySignal(m: MintMetrics): BuyDecision {
    const now = Date.now();
    const ageSeconds = Math.floor(m.ageMs / 1000);
    const secondsSinceTrade = m.lastTradeAt > 0 ? Math.floor((now - m.lastTradeAt) / 1000) : 999999;
    const volToLiquidity = m.liquidityUsd > 0 ? m.volume5mUsd / m.liquidityUsd : 0;
    const notDead = m.change1hPct > -0.95;

    const sniper = evaluateSniper(m, ageSeconds, secondsSinceTrade, volToLiquidity, notDead);
    const trend = evaluateTrend(m, ageSeconds, secondsSinceTrade, volToLiquidity, notDead);

    if (sniper.buy && trend.buy) {
        return sniper.score >= trend.score ? sniper : trend;
    }
    if (sniper.buy) return sniper;
    if (trend.buy) return trend;
    return sniper.score >= trend.score ? sniper : trend;
}

export function shouldSellSignal(pos: OpenPosition, m: MintMetrics) {
    const pnlPct = pos.entryPrice > 0 ? m.currentPrice / pos.entryPrice - 1 : 0;
    const now = Date.now();
    const holdSeconds = Math.floor((now - pos.entryTime) / 1000);
    const secondsSinceLastTrade = m.lastTradeAt > 0 ? Math.floor((now - m.lastTradeAt) / 1000) : Number.MAX_SAFE_INTEGER;

    const stopLossHit = pnlPct <= -SL_PCT;
    const takeProfitHit = pnlPct >= TAKE_PROFIT_PCT;
    const fastTakeProfitHit = holdSeconds <= FAST_TP_WINDOW_SECONDS && pnlPct >= FAST_TP_PCT;
    const breakEvenActive = pos.highestPriceSeen >= pos.entryPrice * (1 + BREAK_EVEN_ARM_PCT);
    const breakEvenHit = breakEvenActive && m.currentPrice <= pos.entryPrice * (1 + BREAK_EVEN_BUFFER_PCT);

    const trailingDrawdown = pos.highestPriceSeen > 0 ? 1 - m.currentPrice / pos.highestPriceSeen : 0;
    const trailingStopHit = pos.highestPriceSeen > pos.entryPrice && trailingDrawdown >= TRAILING_STOP_PCT;
    const momentumFailHit = holdSeconds >= MOMENTUM_FAIL_AFTER_SECONDS && m.change5mPct <= MOMENTUM_FAIL_5M_PCT && pnlPct > -SL_PCT;
    const stalePriceHit = secondsSinceLastTrade >= STALE_POSITION_SECONDS;
    const maxHoldHit = holdSeconds >= MAX_HOLD_SECONDS;

    const sell = stopLossHit || takeProfitHit || fastTakeProfitHit || breakEvenHit || trailingStopHit || momentumFailHit || stalePriceHit || maxHoldHit;

    let reason = "hold";
    if (stopLossHit) reason = "stop_loss";
    else if (fastTakeProfitHit) reason = "fast_take_profit";
    else if (takeProfitHit) reason = "take_profit";
    else if (breakEvenHit) reason = "break_even";
    else if (trailingStopHit) reason = "trailing_stop";
    else if (momentumFailHit) reason = "momentum_fail";
    else if (stalePriceHit) reason = "stale_price";
    else if (maxHoldHit) reason = "max_hold";

    return {
        sell,
        pnlPct,
        trailingDrawdown,
        reason,
    };
}
