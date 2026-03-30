import { getPumpSolBalance, liveBuyPumpMint, liveSellPumpMint, } from "./live/pumpExecution.js";
import { getAllMetrics, getMintMetrics, refreshWatchedMints, removeWatchedMint, } from "./live/pumpStream.js";
import { shouldBuySignal, shouldSellSignal } from "./signals.js";
import { getBotTradeStats, getBotTrades, getRecentBotDecisions, insertBotEvent, insertEquitySnapshot, insertAiSnapshot, logBotDecision, logBotTrade, removeRuntimePosition, setBotHealth, upsertRuntimePosition, recordMintOutcome, getDashboardControlState, clearAbortMint, consumeAbortAllFlag, getRuntimeWatchlist, upsertSeenMintObservation, getSeenMintStats, getLearningHistory, insertLearningSnapshot, } from "./db.js";
import { getWatchCandidate, persistWatchCandidate, removeWatchCandidate, refreshRuntimeWatchlistMetrics, getWatchlistLearningSnapshots } from "./watchlistEngine.js";
let activePositions = [];
const MAX_POSITIONS = Number(process.env.AUTO_TRADE_MAX_POSITIONS || 1);
const BASE_SIZE_SOL = Number(process.env.AUTO_TRADE_SIZE_SOL || 0.003);
const MIN_POSITION_SIZE_SOL = Number(process.env.MIN_POSITION_SIZE_SOL || 0.003);
const MAX_POSITION_SIZE_SOL = Number(process.env.MAX_POSITION_SIZE_SOL || 0.006);
const MAX_ACTIVE_RISK_SOL = Number(process.env.MAX_ACTIVE_RISK_SOL || 0.006);
const MIN_SOL_BUFFER = Number(process.env.MIN_SOL_RESERVE || 0.01);
const WATCHLIST_MAX_AGE_SECONDS = Number(process.env.WATCHLIST_MAX_AGE_SECONDS || 1800);
const STALE_TRADE_SECONDS = Number(process.env.STALE_TRADE_SECONDS || 30);
const DAILY_DRAWDOWN_GUARD_SOL = Number(process.env.DAILY_DRAWDOWN_GUARD_SOL || 0.01);
const MAX_CONSECUTIVE_LOSSES = Number(process.env.MAX_CONSECUTIVE_LOSSES || 2);
const LOSS_STREAK_PAUSE_SECONDS = Number(process.env.LOSS_STREAK_PAUSE_SECONDS || 900);
const LOSS_COOLDOWN_SECONDS = Number(process.env.LOSS_COOLDOWN_SECONDS || 180);
const ENTRY_CONFIRM_CYCLES = Number(process.env.ENTRY_CONFIRM_CYCLES || 2);
const ENTRY_CONFIRM_SECONDS = Number(process.env.ENTRY_CONFIRM_SECONDS || 6);
const ENTRY_CHASE_LIMIT_PCT = Number(process.env.ENTRY_CHASE_LIMIT_PCT || 0.025);
const ENTRY_PREFERRED_PULLBACK_PCT = Number(process.env.ENTRY_PREFERRED_PULLBACK_PCT || 0.008);
const ENTRY_MAX_PULLBACK_FROM_LOCAL_HIGH_PCT = Number(process.env.ENTRY_MAX_PULLBACK_FROM_LOCAL_HIGH_PCT || 0.09);
const ENTRY_EARLY_BYPASS_SCORE = Number(process.env.ENTRY_EARLY_BYPASS_SCORE || 90);
const ENTRY_AI_MIN_SCORE = Number(process.env.ENTRY_AI_MIN_SCORE || 64);
const WATCHLIST_MAX_SIZE = Number(process.env.WATCHLIST_MAX_SIZE || 60);
const WATCHLIST_MIN_SCORE = Number(process.env.WATCHLIST_MIN_SCORE || 55);
const WATCHLIST_TTL_SECONDS = Number(process.env.WATCHLIST_TTL_SECONDS || 900);
const WATCHLIST_READY_MIN_SCORE = Number(process.env.WATCHLIST_READY_MIN_SCORE || Math.max(ENTRY_AI_MIN_SCORE, 62));
const WATCHLIST_REJECT_DROP_SCORE = Number(process.env.WATCHLIST_REJECT_DROP_SCORE || 42);
const LEARNING_ENABLED = String(process.env.LEARNING_ENABLED || "true") === "true";
const LEARNING_WINDOW_TRADES = Number(process.env.LEARNING_WINDOW_TRADES || 30);
const LEARNING_MIN_CLOSED_TRADES = Number(process.env.LEARNING_MIN_CLOSED_TRADES || 5);
const LEARNING_STRONG_WINRATE = Number(process.env.LEARNING_STRONG_WINRATE || 0.62);
const LEARNING_WEAK_WINRATE = Number(process.env.LEARNING_WEAK_WINRATE || 0.42);
const WATCHLIST_LEARNING_WINDOW = Number(process.env.WATCHLIST_LEARNING_WINDOW || 400);
const candidateMemory = new Map();
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function fmtPct(v) {
    return `${(v * 100).toFixed(2)}%`;
}
function fmtNum(v) {
    return Number.isFinite(v) ? v.toFixed(8) : "0.00000000";
}
function pruneCandidateMemory() {
    const cutoff = Date.now() - WATCHLIST_TTL_SECONDS * 1000;
    for (const [mint, memory] of candidateMemory.entries()) {
        if (memory.lastSeenAt < cutoff || activePositions.some((pos) => pos.mint === mint)) {
            candidateMemory.delete(mint);
            removeWatchCandidate(mint);
        }
    }
}
function trackCandidate(mint, price, score, aiScore, mode) {
    const now = Date.now();
    const existing = candidateMemory.get(mint);
    if (!existing) {
        const created = {
            firstSeenAt: now,
            lastSeenAt: now,
            seenCount: 1,
            lastScore: score,
            bestScore: score,
            lastAiScore: aiScore,
            lastPrice: price,
            localHighPrice: price,
            lastMode: mode,
        };
        candidateMemory.set(mint, created);
        return created;
    }
    const gapMs = now - existing.lastSeenAt;
    existing.seenCount = gapMs <= 15000 ? existing.seenCount + 1 : 1;
    existing.firstSeenAt = gapMs <= 15000 ? existing.firstSeenAt : now;
    existing.lastSeenAt = now;
    existing.lastScore = score;
    existing.bestScore = Math.max(existing.bestScore, score);
    existing.lastAiScore = aiScore;
    existing.lastPrice = price;
    existing.localHighPrice = Math.max(existing.localHighPrice, price);
    existing.lastMode = mode;
    return existing;
}
function assessEntryQuality(memory, currentPrice, score, aiScore) {
    const stableSeconds = Math.max(0, Math.floor((memory.lastSeenAt - memory.firstSeenAt) / 1000));
    const pullbackFromLocalHighPct = memory.localHighPrice > 0 ? 1 - currentPrice / memory.localHighPrice : 0;
    const scoreVsBestPct = memory.bestScore > 0 ? score / memory.bestScore - 1 : 0;
    const matureSignal = stableSeconds >= ENTRY_CONFIRM_SECONDS && memory.seenCount >= ENTRY_CONFIRM_CYCLES;
    const earlyBypass = score >= ENTRY_EARLY_BYPASS_SCORE && aiScore >= Math.max(ENTRY_AI_MIN_SCORE, 70);
    const notChasing = pullbackFromLocalHighPct >= 0 || Math.abs(pullbackFromLocalHighPct) <= ENTRY_CHASE_LIMIT_PCT;
    const pullbackHealthy = pullbackFromLocalHighPct >= ENTRY_PREFERRED_PULLBACK_PCT / 2 &&
        pullbackFromLocalHighPct <= ENTRY_MAX_PULLBACK_FROM_LOCAL_HIGH_PCT;
    const notFallingKnife = pullbackFromLocalHighPct <= ENTRY_MAX_PULLBACK_FROM_LOCAL_HIGH_PCT;
    const scoreStillStrong = scoreVsBestPct >= -0.12;
    const aiStrongEnough = aiScore >= ENTRY_AI_MIN_SCORE;
    let allowed = false;
    let label = "EARLY";
    const reasons = [];
    if (earlyBypass && notFallingKnife && scoreStillStrong) {
        allowed = true;
        label = "EARLY";
        reasons.push("Elite-Signal darf früh rein");
    }
    else if (matureSignal && notChasing && pullbackHealthy && scoreStillStrong && aiStrongEnough) {
        allowed = true;
        label = "PREFERRED";
        reasons.push("Signal bestätigt + kleiner Pullback");
    }
    else if (matureSignal && notChasing && notFallingKnife && scoreStillStrong && aiStrongEnough) {
        allowed = true;
        label = "LATE";
        reasons.push("Signal bestätigt, Entry noch ok");
    }
    if (!matureSignal)
        reasons.push(`warte Bestätigung (${memory.seenCount}/${ENTRY_CONFIRM_CYCLES}, ${stableSeconds}s)`);
    if (!notChasing)
        reasons.push(`zu nah am Ausbruch (${fmtPct(Math.abs(pullbackFromLocalHighPct))})`);
    if (!pullbackHealthy)
        reasons.push(`kein sauberer Pullback (${fmtPct(pullbackFromLocalHighPct)})`);
    if (!notFallingKnife)
        reasons.push(`Pullback zu tief (${fmtPct(pullbackFromLocalHighPct)})`);
    if (!scoreStillStrong)
        reasons.push(`Score fällt ggü. Peak (${fmtPct(scoreVsBestPct)})`);
    if (!aiStrongEnough)
        reasons.push(`AI zu schwach (${aiScore.toFixed(1)})`);
    const summary = allowed
        ? `${label} entry • ${reasons[0] || "Entry ok"}`
        : reasons[0] || "Entry noch nicht sauber";
    return {
        allowed,
        label,
        summary,
        reasons,
        data: {
            stableSeconds,
            seenCount: memory.seenCount,
            bestScore: Number(memory.bestScore.toFixed(2)),
            currentScore: Number(score.toFixed(2)),
            aiScore: Number(aiScore.toFixed(2)),
            pullbackFromLocalHighPct: Number(pullbackFromLocalHighPct.toFixed(4)),
            scoreVsBestPct: Number(scoreVsBestPct.toFixed(4)),
            earlyBypass,
            matureSignal,
            notChasing,
            pullbackHealthy,
            notFallingKnife,
            scoreStillStrong,
            aiStrongEnough,
            entryLabel: label,
        },
    };
}
function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
function average(values) {
    if (!values.length)
        return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function buildWatchlistLearningStats() {
    const activeRows = typeof getWatchlistLearningSnapshots === "function"
        ? getWatchlistLearningSnapshots(WATCHLIST_MAX_SIZE)
        : getRuntimeWatchlist(WATCHLIST_MAX_SIZE);
    const recentDecisions = getRecentBotDecisions(WATCHLIST_LEARNING_WINDOW)
        .filter((row) => row.action === 'watch_entry' || row.action === 'watch_ready');
    const latestByMint = new Map();
    for (const row of recentDecisions.reverse()) {
        const details = (row.details || {});
        const entry = (details.entry || {});
        const data = (entry.data || {});
        latestByMint.set(String(row.mint), {
            score: Number(row.score || 0),
            aiScore: Number(details?.ai?.aiScore || data.aiScore || 0),
            ready: row.action === 'watch_ready',
            stableSeconds: Number(data.stableSeconds || 0),
            seenCount: Number(data.seenCount || 0),
            entryLabel: String(entry.label || data.entryLabel || 'EARLY'),
            moveFromFirstPct: 0,
            maxUpPct: 0,
            drawdownFromHighPct: 0,
            freshnessSec: 999999,
            positiveClose: false,
            strongFollowThrough: false,
        });
    }
    for (const row of activeRows) {
        const existing = latestByMint.get(String(row.mint));
        const next = {
            score: Math.max(Number(row.score || 0), Number(existing?.score || 0)),
            aiScore: Math.max(Number(row.aiScore || 0), Number(existing?.aiScore || 0)),
            ready: row.status === 'READY' || Boolean(existing?.ready),
            stableSeconds: Math.max(Number(row.stableSeconds || 0), Number(existing?.stableSeconds || 0)),
            seenCount: Math.max(Number(row.seenCount || 0), Number(existing?.seenCount || 0)),
            entryLabel: String(row.entryLabel || existing?.entryLabel || 'EARLY'),
            moveFromFirstPct: Number(row.movement?.moveFromFirstPct || existing?.moveFromFirstPct || 0),
            maxUpPct: Number(row.movement?.maxUpPct || existing?.maxUpPct || 0),
            drawdownFromHighPct: Number(row.movement?.drawdownFromHighPct || existing?.drawdownFromHighPct || 0),
            freshnessSec: Number(row.movement?.freshnessSec || existing?.freshnessSec || 999999),
            positiveClose: Boolean(row.movement?.positiveClose || existing?.positiveClose),
            strongFollowThrough: Boolean(row.movement?.strongFollowThrough || existing?.strongFollowThrough),
        };
        latestByMint.set(String(row.mint), next);
    }
    const observed = Array.from(latestByMint.values());
    if (!observed.length) {
        return {
            observed: 0,
            readyRate: 0,
            avgScore: 0,
            avgAiScore: 0,
            qualityScore: 0,
            bias: 0,
            avgMovePct: 0,
            avgDrawdownPct: 0,
            positiveCloseRate: 0,
            followThroughRate: 0,
            freshSamples: 0,
            summary: 'watchlist warmup • noch keine verwertbaren Beobachtungen',
        };
    }
    const readyCount = observed.filter((row) => row.ready).length;
    const readyRate = readyCount / observed.length;
    const avgScore = average(observed.map((row) => row.score));
    const avgAiScore = average(observed.map((row) => row.aiScore));
    const avgStableSeconds = average(observed.map((row) => row.stableSeconds));
    const avgSeenCount = average(observed.map((row) => row.seenCount));
    const preferredRate = observed.filter((row) => row.entryLabel === 'PREFERRED').length / observed.length;
    const avgMovePct = average(observed.map((row) => row.moveFromFirstPct));
    const avgDrawdownPct = average(observed.map((row) => Math.abs(row.drawdownFromHighPct)));
    const positiveCloseRate = observed.filter((row) => row.positiveClose).length / observed.length;
    const followThroughRate = observed.filter((row) => row.strongFollowThrough).length / observed.length;
    const freshSamples = observed.filter((row) => row.freshnessSec <= Math.max(15, STALE_TRADE_SECONDS * 2)).length;
    const freshnessRate = freshSamples / observed.length;
    const qualityScore = clamp(Number((readyRate * 30 +
        (avgScore / 100) * 16 +
        (avgAiScore / 100) * 14 +
        Math.min(8, avgStableSeconds / Math.max(1, ENTRY_CONFIRM_SECONDS) * 4) +
        Math.min(6, avgSeenCount * 1.2) +
        preferredRate * 8 +
        positiveCloseRate * 10 +
        followThroughRate * 9 +
        freshnessRate * 6).toFixed(1)), 0, 99);
    const bias = clamp(Number(((readyRate - 0.3) * 0.95 +
        (positiveCloseRate - 0.5) * 0.55 +
        (followThroughRate - 0.35) * 0.5 +
        (freshnessRate - 0.55) * 0.25 +
        ((avgMovePct * 100) / 18) * 0.18 -
        ((avgDrawdownPct * 100) / 24) * 0.16 +
        (preferredRate - 0.28) * 0.25).toFixed(3)), -0.45, 0.45);
    return {
        observed: observed.length,
        readyRate: Number(readyRate.toFixed(3)),
        avgScore: Number(avgScore.toFixed(2)),
        avgAiScore: Number(avgAiScore.toFixed(2)),
        qualityScore,
        bias,
        avgMovePct: Number(avgMovePct.toFixed(4)),
        avgDrawdownPct: Number(avgDrawdownPct.toFixed(4)),
        positiveCloseRate: Number(positiveCloseRate.toFixed(3)),
        followThroughRate: Number(followThroughRate.toFixed(3)),
        freshSamples,
        summary: `watchlist ${observed.length} obs | ready ${(readyRate * 100).toFixed(0)}% | +close ${(positiveCloseRate * 100).toFixed(0)}% | follow ${(followThroughRate * 100).toFixed(0)}% | move ${(avgMovePct * 100).toFixed(1)}% | dd ${(avgDrawdownPct * 100).toFixed(1)}% | q ${qualityScore.toFixed(0)}/99`,
    };
}
function buildLearningProfile() {
    if (!LEARNING_ENABLED) {
        return {
            universeObserved: 0,
            universeReadyRate: 0,
            universeAvgMovePct: 0,
            universeAvgDrawdownPct: 0,
            universePositiveCloseRate: 0,
            universeFollowThroughRate: 0,
            enabled: false,
            phase: 'DISABLED',
            sampleSize: 0,
            totalClosedTrades: 0,
            recentWinRate: 0,
            recentAvgPnlPct: 0,
            recentAvgWinPct: 0,
            recentAvgLossPct: 0,
            lifetimeWinRate: 0,
            lifetimeAvgPnlPct: 0,
            confidenceScore: 0,
            consecutiveLosses: 0,
            sizeMultiplier: 1,
            minAiScoreBoost: 0,
            avoidLateEntries: false,
            preferOnlyPreferredEntries: false,
            watchlistObserved: 0,
            watchlistReadyRate: 0,
            watchlistAvgScore: 0,
            watchlistAvgAiScore: 0,
            watchlistQualityScore: 0,
            watchlistBias: 0,
            watchlistAvgMovePct: 0,
            watchlistAvgDrawdownPct: 0,
            watchlistPositiveCloseRate: 0,
            watchlistFollowThroughRate: 0,
            watchlistFreshSamples: 0,
            watchlistSummary: 'watchlist learning disabled',
            summary: 'learning disabled',
        };
    }
    const watchlistIntel = buildWatchlistLearningStats();
    const universeIntel = getSeenMintStats(Math.max(WATCHLIST_LEARNING_WINDOW * 10, 1000));
    const allClosedTrades = getBotTrades(Math.max(LEARNING_WINDOW_TRADES * 8, 500))
        .filter((row) => row.side === 'SELL');
    const closedTrades = allClosedTrades.slice(0, LEARNING_WINDOW_TRADES);
    let consecutiveLosses = 0;
    for (const trade of closedTrades) {
        if (Number(trade.pnl_sol || 0) > 0)
            break;
        consecutiveLosses += 1;
    }
    const totalClosedTrades = allClosedTrades.length;
    const lifetimeWins = allClosedTrades.filter((row) => Number(row.pnl_sol || 0) > 0);
    const lifetimeWinRate = lifetimeWins.length / Math.max(1, totalClosedTrades);
    const lifetimeAvgPnlPct = average(allClosedTrades.map((row) => Number(row.pnl_pct || 0)));
    if (closedTrades.length < LEARNING_MIN_CLOSED_TRADES) {
        const confidenceScore = clamp(Number(((closedTrades.length / Math.max(1, LEARNING_MIN_CLOSED_TRADES)) * 45).toFixed(1)), 5, 45);
        const warmupSizeMultiplier = clamp(Number((1 +
            watchlistIntel.bias * 0.08 +
            (watchlistIntel.qualityScore >= 60 && watchlistIntel.observed >= 6 ? 0.03 : 0) -
            (watchlistIntel.qualityScore <= 28 && watchlistIntel.observed >= 6 ? 0.05 : 0)).toFixed(2)), 0.8, 1.08);
        const warmupAiBoost = clamp((watchlistIntel.qualityScore <= 28 && watchlistIntel.observed >= 6 ? 2 : 0) +
            (watchlistIntel.bias < -0.08 ? 1 : 0) +
            (watchlistIntel.bias > 0.12 ? -1 : 0), -1, 3);
        const warmupAvoidLateEntries = watchlistIntel.qualityScore < 32 && watchlistIntel.observed >= 6;
        const warmupPreferredOnly = watchlistIntel.readyRate < 0.18 && watchlistIntel.observed >= 12;
        const warmupProfile = {
            universeObserved: universeIntel.observed,
            universeReadyRate: universeIntel.readyRate,
            universeAvgMovePct: universeIntel.avgMovePct,
            universeAvgDrawdownPct: universeIntel.avgDrawdownPct,
            universePositiveCloseRate: universeIntel.positiveCloseRate,
            universeFollowThroughRate: universeIntel.followThroughRate,
            enabled: true,
            phase: 'WARMUP',
            sampleSize: closedTrades.length,
            totalClosedTrades,
            recentWinRate: 0,
            recentAvgPnlPct: 0,
            recentAvgWinPct: 0,
            recentAvgLossPct: 0,
            lifetimeWinRate: Number(lifetimeWinRate.toFixed(3)),
            lifetimeAvgPnlPct: Number(lifetimeAvgPnlPct.toFixed(4)),
            confidenceScore,
            consecutiveLosses,
            sizeMultiplier: warmupSizeMultiplier,
            minAiScoreBoost: warmupAiBoost,
            avoidLateEntries: warmupAvoidLateEntries,
            preferOnlyPreferredEntries: warmupPreferredOnly,
            watchlistObserved: watchlistIntel.observed,
            watchlistReadyRate: watchlistIntel.readyRate,
            watchlistAvgScore: watchlistIntel.avgScore,
            watchlistAvgAiScore: watchlistIntel.avgAiScore,
            watchlistQualityScore: watchlistIntel.qualityScore,
            watchlistBias: watchlistIntel.bias,
            watchlistAvgMovePct: watchlistIntel.avgMovePct,
            watchlistAvgDrawdownPct: watchlistIntel.avgDrawdownPct,
            watchlistPositiveCloseRate: watchlistIntel.positiveCloseRate,
            watchlistFollowThroughRate: watchlistIntel.followThroughRate,
            watchlistFreshSamples: watchlistIntel.freshSamples,
            watchlistSummary: watchlistIntel.summary,
            summary: `learning warmup (${closedTrades.length}/${LEARNING_MIN_CLOSED_TRADES}) • historical ${totalClosedTrades} closed • size x${warmupSizeMultiplier.toFixed(2)} • ai+${warmupAiBoost} • ${watchlistIntel.summary}`,
        };
        const lastWarmupLearning = getLearningHistory(1)[0];
        if (!lastWarmupLearning || Date.now() - Number(lastWarmupLearning.ts || 0) > 5 * 60 * 1000 || lastWarmupLearning.summary !== warmupProfile.summary) {
            insertLearningSnapshot({
                phase: warmupProfile.phase,
                confidenceScore: warmupProfile.confidenceScore,
                sizeMultiplier: warmupProfile.sizeMultiplier,
                minAiScoreBoost: warmupProfile.minAiScoreBoost,
                recentWinRate: warmupProfile.recentWinRate,
                recentAvgPnlPct: warmupProfile.recentAvgPnlPct,
                totalClosedTrades: warmupProfile.totalClosedTrades,
                watchlistQualityScore: warmupProfile.watchlistQualityScore,
                watchlistObserved: warmupProfile.watchlistObserved,
                summary: warmupProfile.summary,
            });
        }
        return warmupProfile;
    }
    const pnlPcts = closedTrades.map((row) => Number(row.pnl_pct || 0));
    const wins = closedTrades.filter((row) => Number(row.pnl_sol || 0) > 0);
    const losses = closedTrades.filter((row) => Number(row.pnl_sol || 0) <= 0);
    const recentWinRate = wins.length / Math.max(1, closedTrades.length);
    const recentAvgPnlPct = average(pnlPcts);
    const recentAvgWinPct = average(wins.map((row) => Number(row.pnl_pct || 0)));
    const recentAvgLossPct = average(losses.map((row) => Math.abs(Number(row.pnl_pct || 0))));
    let sizeMultiplier = 1;
    let minAiScoreBoost = 0;
    if (recentWinRate >= LEARNING_STRONG_WINRATE && recentAvgPnlPct > 0.018) {
        sizeMultiplier += 0.12;
        minAiScoreBoost -= 2;
    }
    if (recentWinRate <= LEARNING_WEAK_WINRATE) {
        sizeMultiplier -= 0.16;
        minAiScoreBoost += 4;
    }
    if (recentAvgPnlPct <= -0.015) {
        sizeMultiplier -= 0.1;
        minAiScoreBoost += 3;
    }
    if (consecutiveLosses >= 2) {
        sizeMultiplier -= 0.08;
        minAiScoreBoost += 2;
    }
    sizeMultiplier += watchlistIntel.bias * 0.12;
    if (universeIntel.observed >= 50) {
        if (universeIntel.positiveCloseRate >= 0.55 && universeIntel.followThroughRate >= 0.4) {
            sizeMultiplier += 0.04;
            minAiScoreBoost -= 1;
        }
        if (universeIntel.avgDrawdownPct >= 0.14) {
            sizeMultiplier -= 0.05;
            minAiScoreBoost += 1;
        }
        if (universeIntel.readyRate <= 0.08) {
            minAiScoreBoost += 1;
        }
    }
    if (watchlistIntel.followThroughRate >= 0.45 && watchlistIntel.positiveCloseRate >= 0.55 && watchlistIntel.freshSamples >= 6) {
        sizeMultiplier += 0.05;
    }
    if (watchlistIntel.avgDrawdownPct >= 0.18 && watchlistIntel.observed >= 8) {
        sizeMultiplier -= 0.08;
        minAiScoreBoost += 2;
    }
    minAiScoreBoost += watchlistIntel.bias > 0.12 ? -1 : 0;
    if (watchlistIntel.qualityScore <= 34 && watchlistIntel.observed >= 6) {
        sizeMultiplier -= 0.06;
        minAiScoreBoost += 2;
    }
    if (watchlistIntel.readyRate >= 0.5 && watchlistIntel.avgAiScore >= ENTRY_AI_MIN_SCORE && watchlistIntel.observed >= 8) {
        sizeMultiplier += 0.04;
        minAiScoreBoost -= 1;
    }
    const avoidLateEntries = recentWinRate < 0.5 || recentAvgLossPct > Math.max(0.018, recentAvgWinPct * 0.85) || (watchlistIntel.qualityScore < 32 && watchlistIntel.observed >= 6);
    const preferOnlyPreferredEntries = recentWinRate < 0.38 || consecutiveLosses >= 3 || (watchlistIntel.readyRate < 0.2 && watchlistIntel.observed >= 10);
    sizeMultiplier = clamp(Number(sizeMultiplier.toFixed(2)), 0.55, 1.2);
    minAiScoreBoost = clamp(minAiScoreBoost, -2, 8);
    let phase = 'TRAINING';
    if (totalClosedTrades >= 100 && recentWinRate >= LEARNING_STRONG_WINRATE && recentAvgPnlPct > 0)
        phase = 'OPTIMIZED';
    else if (totalClosedTrades >= 30 || closedTrades.length >= Math.max(10, LEARNING_MIN_CLOSED_TRADES * 2))
        phase = 'ADAPTIVE';
    const consistencyBoost = recentAvgPnlPct >= 0 ? 8 : -8;
    const confidenceScore = clamp(Number((30 +
        Math.min(30, totalClosedTrades * 0.45) +
        Math.min(20, closedTrades.length * 0.9) +
        (recentWinRate - 0.5) * 30 +
        consistencyBoost -
        consecutiveLosses * 6).toFixed(1)), 10, 99);
    const profile = {
        universeObserved: universeIntel.observed,
        universeReadyRate: universeIntel.readyRate,
        universeAvgMovePct: universeIntel.avgMovePct,
        universeAvgDrawdownPct: universeIntel.avgDrawdownPct,
        universePositiveCloseRate: universeIntel.positiveCloseRate,
        universeFollowThroughRate: universeIntel.followThroughRate,
        enabled: true,
        phase,
        sampleSize: closedTrades.length,
        totalClosedTrades,
        recentWinRate: Number(recentWinRate.toFixed(3)),
        recentAvgPnlPct: Number(recentAvgPnlPct.toFixed(4)),
        recentAvgWinPct: Number(recentAvgWinPct.toFixed(4)),
        recentAvgLossPct: Number(recentAvgLossPct.toFixed(4)),
        lifetimeWinRate: Number(lifetimeWinRate.toFixed(3)),
        lifetimeAvgPnlPct: Number(lifetimeAvgPnlPct.toFixed(4)),
        confidenceScore,
        consecutiveLosses,
        sizeMultiplier,
        minAiScoreBoost,
        avoidLateEntries,
        preferOnlyPreferredEntries,
        watchlistObserved: watchlistIntel.observed,
        watchlistReadyRate: watchlistIntel.readyRate,
        watchlistAvgScore: watchlistIntel.avgScore,
        watchlistAvgAiScore: watchlistIntel.avgAiScore,
        watchlistQualityScore: watchlistIntel.qualityScore,
        watchlistBias: watchlistIntel.bias,
        watchlistAvgMovePct: watchlistIntel.avgMovePct,
        watchlistAvgDrawdownPct: watchlistIntel.avgDrawdownPct,
        watchlistPositiveCloseRate: watchlistIntel.positiveCloseRate,
        watchlistFollowThroughRate: watchlistIntel.followThroughRate,
        watchlistFreshSamples: watchlistIntel.freshSamples,
        watchlistSummary: watchlistIntel.summary,
        summary: `phase=${phase} | recent ${closedTrades.length} | total ${totalClosedTrades} | winRate=${(recentWinRate * 100).toFixed(0)}% | avg=${(recentAvgPnlPct * 100).toFixed(2)}% | size x${sizeMultiplier.toFixed(2)} | ai+${minAiScoreBoost} | universe ${universeIntel.observed} | ${watchlistIntel.summary}`,
    };
    const lastLearning = getLearningHistory(1)[0];
    if (!lastLearning || Date.now() - Number(lastLearning.ts || 0) > 5 * 60 * 1000 || lastLearning.summary !== profile.summary) {
        insertLearningSnapshot({
            phase: profile.phase,
            confidenceScore: profile.confidenceScore,
            sizeMultiplier: profile.sizeMultiplier,
            minAiScoreBoost: profile.minAiScoreBoost,
            recentWinRate: profile.recentWinRate,
            recentAvgPnlPct: profile.recentAvgPnlPct,
            totalClosedTrades: profile.totalClosedTrades,
            watchlistQualityScore: profile.watchlistQualityScore,
            watchlistObserved: profile.watchlistObserved,
            summary: profile.summary,
        });
    }
    return profile;
}
function isEntryAllowedByLearning(entry, learning) {
    if (!learning.enabled || learning.sampleSize < LEARNING_MIN_CLOSED_TRADES)
        return true;
    if (learning.preferOnlyPreferredEntries && entry.label !== 'PREFERRED')
        return false;
    if (learning.avoidLateEntries && entry.label === 'LATE')
        return false;
    return true;
}
function classifyWatchStatus(signal, entry, memory) {
    const stableSeconds = Number(entry.data.stableSeconds || 0);
    const scoreFloor = Math.max(WATCHLIST_MIN_SCORE, ENTRY_AI_MIN_SCORE - 6);
    const keepWatching = signal.score >= scoreFloor ||
        signal.ai.aiScore >= Math.max(55, ENTRY_AI_MIN_SCORE - 8) ||
        memory.seenCount >= 2;
    if (entry.allowed && signal.score >= WATCHLIST_READY_MIN_SCORE && signal.ai.aiScore >= ENTRY_AI_MIN_SCORE) {
        return { keep: true, status: "READY", summary: `${entry.label} • Watchlist-Kauf freigegeben` };
    }
    if (keepWatching) {
        return {
            keep: true,
            status: "WATCH",
            summary: entry.allowed
                ? `${entry.label} • noch beobachten vor Kauf`
                : `${entry.summary} • Watchlist sammelt weitere Bestätigung`,
        };
    }
    if (signal.score <= WATCHLIST_REJECT_DROP_SCORE && stableSeconds < ENTRY_CONFIRM_SECONDS) {
        return { keep: false, status: "COOLDOWN", summary: "zu schwach für Watchlist" };
    }
    return { keep: false, status: "COOLDOWN", summary: "Signal verloren" };
}
function persistCandidateState(item) {
    const { metrics, signal, memory, entry } = item;
    const watch = classifyWatchStatus(signal, entry, memory);
    upsertSeenMintObservation({
        mint: metrics.mint,
        symbol: metrics.symbol || "PUMP",
        price: Number(metrics.currentPrice || 0),
        liquidityUsd: Number(metrics.liquidityUsd || 0),
        volume5mUsd: Number(metrics.volume5mUsd || 0),
        volume24hUsd: Number(metrics.volume24hUsd || 0),
        score: signal.score,
        aiScore: signal.ai.aiScore,
        status: watch.status,
        entryLabel: entry.label,
        source: "analysis",
    });
    if (!watch.keep) {
        removeWatchCandidate(metrics.mint);
        return null;
    }
    persistWatchCandidate({
        mint: metrics.mint,
        symbol: metrics.symbol || "PUMP",
        status: watch.status,
        score: signal.score,
        aiScore: signal.ai.aiScore,
        bestScore: memory.bestScore,
        seenCount: memory.seenCount,
        stableSeconds: Number(entry.data.stableSeconds || 0),
        pullbackFromLocalHighPct: Number(entry.data.pullbackFromLocalHighPct || 0),
        summary: watch.summary,
        reasons: entry.reasons,
        entryLabel: entry.label,
    });
    logBotDecision({
        mint: metrics.mint,
        symbol: metrics.symbol || "PUMP",
        action: watch.status === "READY" ? "watch_ready" : "watch_entry",
        score: signal.score,
        summary: watch.summary,
        details: {
            mode: signal.mode,
            entry,
            memory,
            reasons: signal.reasons,
            ai: signal.ai,
        },
    });
    return watch;
}
function syncPosition(position) {
    upsertRuntimePosition({
        mint: position.mint,
        symbol: position.symbol,
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        highestPriceSeen: position.highestPriceSeen,
        sizeSol: position.sizeSol,
        buyTxid: position.buyTxid,
        route: position.route,
    });
}
function getRiskUsedSol() {
    return activePositions.reduce((sum, pos) => sum + pos.sizeSol, 0);
}
function candidatePriority(item) {
    const seenBoost = Math.min(12, item.memory.seenCount * 1.5);
    const stableBoost = Math.min(8, Math.max(0, item.entry.data.stableSeconds || 0) / 6);
    const readyBoost = item.entry.allowed ? 18 : 0;
    const preferredBoost = item.entry.label === "PREFERRED" ? 8 : item.entry.label === "LATE" ? 4 : 0;
    const modeBoost = item.signal.mode === "TREND_MODE" ? 3 : 0;
    return item.signal.score + seenBoost + stableBoost + readyBoost + preferredBoost + modeBoost;
}
function getLossStreakState() {
    const decisions = getRecentBotDecisions(100);
    let consecutiveLosses = 0;
    let lastLossAt = 0;
    for (const row of decisions) {
        if (row.action === "sell_win")
            break;
        if (row.action === "sell_loss") {
            consecutiveLosses += 1;
            if (!lastLossAt)
                lastLossAt = new Date(row.created_at).getTime();
        }
    }
    const cooldownActive = consecutiveLosses >= MAX_CONSECUTIVE_LOSSES &&
        lastLossAt > 0 &&
        Date.now() - lastLossAt < LOSS_STREAK_PAUSE_SECONDS * 1000;
    return {
        consecutiveLosses,
        lastLossAt,
        cooldownActive,
        cooldownRemainingSec: cooldownActive
            ? Math.max(0, Math.ceil((LOSS_STREAK_PAUSE_SECONDS * 1000 - (Date.now() - lastLossAt)) / 1000))
            : 0,
    };
}
async function snapshotEquity() {
    const walletSol = await getPumpSolBalance();
    const tradeStats = getBotTradeStats();
    let openPositionsValueSol = 0;
    for (const pos of activePositions) {
        const metrics = getMintMetrics(pos.mint);
        const markPrice = metrics?.currentPrice || pos.entryPrice;
        const multiple = pos.entryPrice > 0 ? markPrice / pos.entryPrice : 1;
        openPositionsValueSol += pos.sizeSol * multiple;
    }
    insertEquitySnapshot({
        walletSol,
        openPositionsValueSol,
        realizedPnlSol: tradeStats.realizedPnlSol,
        totalEquitySol: walletSol + openPositionsValueSol,
        openPositions: activePositions.length,
        watchedMints: getAllMetrics().length,
    });
}
async function trySell() {
    const controls = getDashboardControlState();
    const abortAll = consumeAbortAllFlag();
    if (activePositions.length === 0) {
        console.log("📭 Keine offenen Positionen zum Verkaufen");
        return;
    }
    console.log(`🧾 Sell-Check startet | offene Positionen=${activePositions.length}`);
    for (let i = activePositions.length - 1; i >= 0; i--) {
        const pos = activePositions[i];
        const metrics = getMintMetrics(pos.mint);
        if (!metrics) {
            console.log(`⚠️ Keine Metriken für offene Position ${pos.symbol}`);
            continue;
        }
        if (metrics.currentPrice > pos.highestPriceSeen) {
            pos.highestPriceSeen = metrics.currentPrice;
            syncPosition(pos);
        }
        const forcedAbort = abortAll || controls.abortMints.includes(pos.mint);
        const decision = forcedAbort
            ? { sell: true, reason: abortAll ? "dashboard_abort_all" : "dashboard_abort", pnlPct: (metrics.currentPrice / Math.max(pos.entryPrice, 1e-9)) - 1, trailingDrawdown: 0 }
            : shouldSellSignal(pos, metrics);
        console.log(`📦 HOLD ${pos.symbol} | pnl=${fmtPct(decision.pnlPct)} | high=$${fmtNum(pos.highestPriceSeen)} | drawdown=${fmtPct(decision.trailingDrawdown)} | 5m=${fmtPct(metrics.change5mPct)} | 15m=${fmtPct(metrics.change15mPct)} | 1h=${fmtPct(metrics.change1hPct)}`);
        if (!decision.sell)
            continue;
        try {
            console.log(`💰 SELL ${pos.symbol} | reason=${decision.reason}`);
            const sell = await liveSellPumpMint(pos.mint, 0, { entryRoute: pos.route });
            const pnlSol = pos.sizeSol * decision.pnlPct;
            recordMintOutcome({ mint: pos.mint, pnlPct: decision.pnlPct, pnlSol });
            logBotTrade({
                mint: pos.mint,
                symbol: pos.symbol,
                side: "SELL",
                entryPrice: pos.entryPrice,
                exitPrice: metrics.currentPrice,
                sizeSol: pos.sizeSol,
                pnlPct: decision.pnlPct,
                pnlSol,
                reason: decision.reason,
                route: sell.route,
                txid: sell.txid,
            });
            logBotDecision({
                mint: pos.mint,
                symbol: pos.symbol,
                action: pnlSol > 0 ? "sell_win" : "sell_loss",
                score: Math.abs(decision.pnlPct) * 100,
                summary: `${decision.reason} • ${fmtPct(decision.pnlPct)}`,
                details: {
                    reason: decision.reason,
                    pnlPct: decision.pnlPct,
                    pnlSol,
                },
            });
            insertBotEvent("success", "sell", `SELL ${pos.symbol} • ${decision.reason}`, {
                mint: pos.mint,
                txid: sell.txid,
                pnlPct: decision.pnlPct,
                pnlSol,
            });
            setBotHealth({ lastSellAt: Date.now() });
            clearAbortMint(pos.mint);
            removeRuntimePosition(pos.mint);
            removeWatchCandidate(pos.mint);
            activePositions.splice(i, 1);
            await sleep(1000);
        }
        catch (err) {
            console.log(`❌ SELL FAIL ${pos.symbol}: ${err?.message || err}`);
            insertBotEvent("error", "sell_fail", `SELL FAIL ${pos.symbol}`, {
                mint: pos.mint,
                reason: decision.reason,
                error: err?.message || String(err),
            });
        }
    }
}
function computePositionSize(score, sizeMultiplier, learning) {
    const controls = getDashboardControlState();
    const learningMult = learning.enabled ? learning.sizeMultiplier : 1;
    const raw = BASE_SIZE_SOL * sizeMultiplier * learningMult * Number(controls.sizeMultiplier || 1);
    const boosted = score >= 85 ? raw * 1.05 : raw;
    return Math.max(MIN_POSITION_SIZE_SOL, Math.min(MAX_POSITION_SIZE_SOL, boosted));
}
async function tryBuy() {
    const controls = getDashboardControlState();
    const effectiveMaxPositions = controls.maxPositionsOverride ?? MAX_POSITIONS;
    if (controls.killSwitch) {
        console.log("🛑 Kill switch aktiv, keine neuen Käufe");
        return;
    }
    if (activePositions.length >= effectiveMaxPositions) {
        console.log(`⛔ Max Positionen erreicht: ${activePositions.length}/${effectiveMaxPositions}`);
        return;
    }
    const tradeStats = getBotTradeStats();
    const learning = buildLearningProfile();
    if (tradeStats.realizedPnlSol <= -Math.abs(DAILY_DRAWDOWN_GUARD_SOL)) {
        console.log(`🛑 Daily Drawdown Guard aktiv | realized=${tradeStats.realizedPnlSol.toFixed(4)} SOL`);
        setBotHealth({
            status: "guarded",
            details: {
                mode: "SNIPER_TREND_MODE",
                guard: "daily_drawdown",
                realizedPnlSol: tradeStats.realizedPnlSol,
                thresholdSol: DAILY_DRAWDOWN_GUARD_SOL,
                activePositions: activePositions.length,
            },
        });
        logBotDecision({
            mint: "-",
            symbol: "SYSTEM",
            action: "guard_daily_drawdown",
            score: 0,
            summary: `realized=${tradeStats.realizedPnlSol.toFixed(4)} SOL`,
            details: { realizedPnlSol: tradeStats.realizedPnlSol },
        });
        return;
    }
    const lossStreak = getLossStreakState();
    if (lossStreak.cooldownActive) {
        console.log(`🧊 Loss-Streak Pause aktiv | remaining=${lossStreak.cooldownRemainingSec}s`);
        logBotDecision({
            mint: "-",
            symbol: "SYSTEM",
            action: "guard_loss_streak",
            score: 0,
            summary: `pause ${lossStreak.cooldownRemainingSec}s`,
            details: lossStreak,
        });
        return;
    }
    const balance = await getPumpSolBalance();
    console.log(`💰 SOL Balance: ${balance.toFixed(4)}`);
    if (balance < MIN_POSITION_SIZE_SOL + MIN_SOL_BUFFER) {
        console.log("⛔ Zu wenig SOL für neuen Trade");
        return;
    }
    if (getRiskUsedSol() >= MAX_ACTIVE_RISK_SOL) {
        console.log(`⛔ Max Active Risk erreicht | risk=${getRiskUsedSol().toFixed(4)} SOL`);
        return;
    }
    await refreshWatchedMints();
    pruneCandidateMemory();
    const now = Date.now();
    const candidates = getAllMetrics()
        .filter((m) => {
        const ageSec = Math.floor(m.ageMs / 1000);
        const secondsSinceTrade = m.lastTradeAt > 0 ? Math.floor((now - m.lastTradeAt) / 1000) : 999999;
        const existingWatch = getWatchCandidate(m.mint);
        if (ageSec > WATCHLIST_MAX_AGE_SECONDS || ageSec > WATCHLIST_TTL_SECONDS) {
            removeWatchedMint(m.mint);
            removeWatchCandidate(m.mint);
            return false;
        }
        if (activePositions.find((p) => p.mint === m.mint)) {
            removeWatchCandidate(m.mint);
            return false;
        }
        if (secondsSinceTrade > STALE_TRADE_SECONDS && !existingWatch)
            return false;
        return true;
    })
        .map((metrics) => {
        const signal = shouldBuySignal(metrics);
        const memory = trackCandidate(metrics.mint, metrics.currentPrice, signal.score, signal.ai.aiScore, signal.mode);
        const entry = assessEntryQuality(memory, metrics.currentPrice, signal.score, signal.ai.aiScore);
        const watch = persistCandidateState({ metrics, signal, memory, entry });
        return { metrics, signal, memory, entry, watch };
    })
        .filter((item) => item.watch?.keep || item.signal.buy || item.signal.score >= WATCHLIST_MIN_SCORE)
        .sort((a, b) => candidatePriority(b) - candidatePriority(a))
        .slice(0, WATCHLIST_MAX_SIZE);
    const dynamicAiFloor = ENTRY_AI_MIN_SCORE + learning.minAiScoreBoost;
    const readyCandidates = candidates
        .filter((item) => item.watch?.status === "READY" && item.entry.allowed)
        .filter((item) => item.signal.ai.aiScore >= dynamicAiFloor)
        .filter((item) => isEntryAllowedByLearning(item.entry, learning))
        .sort((a, b) => candidatePriority(b) - candidatePriority(a));
    const aiTop = candidates.slice(0, 12).map((x) => x.signal.ai);
    const aiScoreAvg = aiTop.length ? aiTop.reduce((sum, item) => sum + item.aiScore, 0) / aiTop.length : 0;
    const aiScoreBest = aiTop.length ? Math.max(...aiTop.map((item) => item.aiScore)) : 0;
    const aiRegime = aiTop.length ? aiTop.reduce((acc, item) => {
        acc[item.marketRegime] = (acc[item.marketRegime] || 0) + 1;
        return acc;
    }, {}) : {};
    const marketRegime = Object.entries(aiRegime).sort((a, b) => b[1] - a[1])[0]?.[0] || "NORMAL";
    insertAiSnapshot({
        aiEnabled: aiTop.some((x) => x.enabled),
        marketRegime,
        aiScoreAvg,
        aiScoreBest,
        allows: aiTop.filter((x) => x.decision === "ALLOW").length,
        rejects: aiTop.filter((x) => x.decision === "REJECT").length,
        reduceSize: aiTop.filter((x) => x.decision === "REDUCE_SIZE").length,
        highConfidence: aiTop.filter((x) => x.decision === "HIGH_CONFIDENCE").length,
    });
    console.log(`🧠 ${learning.summary}`);
    for (const { metrics: c, signal, entry, watch } of candidates.slice(0, 8)) {
        console.log(`🎯 ${c.symbol} | mode=${signal.mode.replace("_MODE", "")} | score=${signal.score.toFixed(1)} | ai=${signal.ai.aiScore.toFixed(1)} ${signal.ai.decision} | price=${fmtNum(c.currentPrice)} | liq=$${c.liquidityUsd.toFixed(2)} | vol5m=$${c.volume5mUsd.toFixed(2)} | 5m=${fmtPct(c.change5mPct)} | 15m=${fmtPct(c.change15mPct)} | watch=${watch?.status || "DROP"} | entry=${entry.label} ${entry.allowed ? "OK" : "WAIT"}`);
    }
    for (const { metrics: m, signal, entry, watch } of readyCandidates) {
        const persisted = getWatchCandidate(m.mint);
        if (!persisted?.readyToBuy)
            continue;
        const sizeSol = computePositionSize(signal.score, signal.sizeMultiplier, learning);
        const riskHeadroom = MAX_ACTIVE_RISK_SOL - getRiskUsedSol();
        const finalSizeSol = Math.min(sizeSol, riskHeadroom, Math.max(0, balance - MIN_SOL_BUFFER));
        if (finalSizeSol < MIN_POSITION_SIZE_SOL) {
            console.log(`⛔ Size zu klein nach Risk-Limits | ${finalSizeSol.toFixed(4)} SOL`);
            continue;
        }
        const lastLoss = getLossStreakState();
        if (lastLoss.lastLossAt > 0 && Date.now() - lastLoss.lastLossAt < LOSS_COOLDOWN_SECONDS * 1000) {
            console.log(`🧊 Cooldown nach letztem Verlust aktiv | ${(LOSS_COOLDOWN_SECONDS - Math.floor((Date.now() - lastLoss.lastLossAt) / 1000))}s`);
            return;
        }
        try {
            console.log(`🔥 WATCHLIST BUY ${m.symbol} | mode=${signal.mode.replace("_MODE", "")} | score=${signal.score.toFixed(1)} | ai=${signal.ai.aiScore.toFixed(1)} ${signal.ai.decision} | entry=${entry.label} | size=${finalSizeSol.toFixed(4)} SOL | entryPrice=${fmtNum(m.currentPrice)}`);
            const buy = await liveBuyPumpMint(m.mint, finalSizeSol, {
                preferredDex: "pump",
            });
            const position = {
                mint: m.mint,
                symbol: m.symbol || "PUMP",
                entryTime: Date.now(),
                entryPrice: m.currentPrice,
                highestPriceSeen: m.currentPrice,
                buyTxid: buy.txid,
                route: buy.route,
                sizeSol: finalSizeSol,
            };
            activePositions.push(position);
            syncPosition(position);
            removeWatchCandidate(m.mint);
            logBotTrade({
                mint: m.mint,
                symbol: position.symbol,
                side: "BUY",
                entryPrice: m.currentPrice,
                sizeSol: finalSizeSol,
                route: buy.route,
                txid: buy.txid,
                reason: `watchlist_${signal.score.toFixed(1)}_${entry.label.toLowerCase()}`,
            });
            logBotDecision({
                mint: m.mint,
                symbol: position.symbol,
                action: "buy",
                score: signal.score,
                summary: `WATCHLIST ${signal.mode.replace("_MODE", "")} • ${entry.label} • ` + signal.reasons.slice(0, 3).join(" • "),
                details: {
                    mode: signal.mode,
                    reasons: signal.reasons,
                    sizeSol: finalSizeSol,
                    reason: signal.reason,
                    ai: signal.ai,
                    entry,
                    learning,
                },
            });
            insertBotEvent("success", "buy", `WATCHLIST BUY ${position.symbol}`, {
                mint: m.mint,
                txid: buy.txid,
                entryPrice: m.currentPrice,
                sizeSol: finalSizeSol,
                score: signal.score,
                mode: signal.mode,
                aiScore: signal.ai.aiScore,
                aiDecision: signal.ai.decision,
                entryLabel: entry.label,
                learningSummary: learning.summary,
            });
            setBotHealth({ lastBuyAt: Date.now() });
            console.log(`✅ BOUGHT ${m.symbol} FROM WATCHLIST | score=${signal.score.toFixed(1)} | entry=${entry.label} | route=${buy.route} | tx=${buy.txid}`);
            return;
        }
        catch (err) {
            console.log(`❌ BUY FAIL ${m.symbol}: ${err?.message || err}`);
            insertBotEvent("error", "buy_fail", `BUY FAIL ${m.symbol}`, {
                mint: m.mint,
                error: err?.message || String(err),
                score: signal.score,
                mode: signal.mode,
                aiScore: signal.ai.aiScore,
                aiDecision: signal.ai.decision,
                entryLabel: entry.label,
            });
        }
    }
    console.log("🚫 Kein Watchlist-Kauf ausgelöst");
}
export async function runAutoTrader() {
    console.log("🔄 Sniper + Trend AutoTrader Runde startet");
    const tradeStats = getBotTradeStats();
    const lossStreak = getLossStreakState();
    setBotHealth({
        status: "running",
        lastLoopAt: Date.now(),
        details: {
            mode: "SNIPER_TREND_MODE",
            activePositions: activePositions.length,
            maxPositions: getDashboardControlState().maxPositionsOverride ?? MAX_POSITIONS,
            baseSizeSol: BASE_SIZE_SOL * Number(getDashboardControlState().sizeMultiplier || 1),
            riskUsedSol: getRiskUsedSol(),
            maxActiveRiskSol: MAX_ACTIVE_RISK_SOL,
            realizedPnlSol: tradeStats.realizedPnlSol,
            consecutiveLosses: lossStreak.consecutiveLosses,
            learning: buildLearningProfile(),
        },
    });
    refreshRuntimeWatchlistMetrics(WATCHLIST_MAX_SIZE);
    await trySell();
    await tryBuy();
    refreshRuntimeWatchlistMetrics(WATCHLIST_MAX_SIZE);
    await snapshotEquity();
    setBotHealth({
        status: "running",
        lastLoopAt: Date.now(),
        details: {
            mode: "SNIPER_TREND_MODE",
            activePositions: activePositions.length,
            maxPositions: getDashboardControlState().maxPositionsOverride ?? MAX_POSITIONS,
            baseSizeSol: BASE_SIZE_SOL * Number(getDashboardControlState().sizeMultiplier || 1),
            riskUsedSol: getRiskUsedSol(),
            maxActiveRiskSol: MAX_ACTIVE_RISK_SOL,
            realizedPnlSol: getBotTradeStats().realizedPnlSol,
            consecutiveLosses: getLossStreakState().consecutiveLosses,
            learning: buildLearningProfile(),
        },
    });
    console.log("⏳ Sniper + Trend AutoTrader Runde fertig");
}
