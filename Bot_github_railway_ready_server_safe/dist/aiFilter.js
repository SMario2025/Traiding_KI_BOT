import { getWalletProfile } from "./db.js";
const AI_FILTER_ENABLED = String(process.env.AI_FILTER_ENABLED || "true") === "true";
const AI_MIN_SCORE = Number(process.env.AI_MIN_SCORE || 58);
const AI_HIGH_CONFIDENCE_SCORE = Number(process.env.AI_HIGH_CONFIDENCE_SCORE || 78);
const AI_REDUCE_SIZE_BELOW = Number(process.env.AI_REDUCE_SIZE_BELOW || 66);
const AI_DEAD_MARKET_LIQUIDITY = Number(process.env.AI_DEAD_MARKET_LIQUIDITY || 55);
const AI_DEAD_MARKET_VOLUME5M = Number(process.env.AI_DEAD_MARKET_VOLUME5M || 25);
const AI_DEAD_MARKET_SAMPLES = Number(process.env.AI_DEAD_MARKET_SAMPLES || 5);
function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
function getHourBerlin(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Berlin",
        hour: "2-digit",
        hourCycle: "h23",
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === "hour")?.value;
    return Number(hour || 0);
}
function getSessionBoost(hourBerlin) {
    if (hourBerlin >= 18 || hourBerlin < 2)
        return 9;
    if (hourBerlin >= 12 && hourBerlin < 18)
        return 4;
    if (hourBerlin >= 9 && hourBerlin < 12)
        return -3;
    return -7;
}
function detectMarketRegime(m, secondsSinceTrade) {
    if (m.liquidityUsd < AI_DEAD_MARKET_LIQUIDITY ||
        m.volume5mUsd < AI_DEAD_MARKET_VOLUME5M ||
        m.sampleCount < AI_DEAD_MARKET_SAMPLES ||
        secondsSinceTrade > 9) {
        return "DEAD";
    }
    if (m.change5mPct >= 0.08 && m.volume5mUsd >= AI_DEAD_MARKET_VOLUME5M * 2.4 && m.sampleCount >= 10) {
        return "HYPE";
    }
    return "NORMAL";
}
export function runAiFilter(params) {
    const { metrics: m, mode, baseScore, ageSeconds, secondsSinceTrade, volToLiquidity } = params;
    if (!AI_FILTER_ENABLED) {
        return {
            enabled: false,
            aiScore: baseScore,
            confidence: "MEDIUM",
            marketRegime: "NORMAL",
            decision: "ALLOW",
            sizeMultiplier: 1,
            summary: "AI deaktiviert",
            reasons: [],
            redFlags: [],
            features: { baseScore },
        };
    }
    const hourBerlin = getHourBerlin();
    const marketRegime = detectMarketRegime(m, secondsSinceTrade);
    const creatorWallet = String(m.creatorWallet || "").trim();
    const walletProfile = creatorWallet ? getWalletProfile(creatorWallet) : undefined;
    let aiScore = 50;
    aiScore += clamp((baseScore - 55) * 0.7, -15, 22);
    aiScore += clamp((m.liquidityUsd - 50) / 5, -10, 16);
    aiScore += clamp((m.volume5mUsd - 20) / 4, -10, 18);
    aiScore += clamp((m.avgVolume5mUsd - 10) / 4, -8, 10);
    aiScore += clamp((volToLiquidity - 0.35) * 22, -8, 10);
    aiScore += clamp((m.sampleCount - 4) * 1.5, -6, 12);
    aiScore += clamp((m.change5mPct - 0.02) * 120, -12, 10);
    aiScore += clamp((m.change15mPct - 0.04) * 55, -10, 8);
    aiScore += clamp((m.reboundFrom5mLowPct - 0.01) * 90, -8, 8);
    aiScore += clamp((m.dropFrom1hHighPct + 0.08) * 60, -10, 5);
    aiScore += getSessionBoost(hourBerlin);
    if (marketRegime === "DEAD")
        aiScore -= 10;
    if (walletProfile) {
        const closedLaunches = Number(walletProfile.closed_launches || 0);
        const wins = Number(walletProfile.wins || 0);
        const avgPnlPct = closedLaunches > 0 ? Number(walletProfile.total_pnl_pct || 0) / closedLaunches : 0;
        const winRate = closedLaunches > 0 ? wins / closedLaunches : 0;
        aiScore += Math.max(-10, Math.min(14, (Number(walletProfile.confidence_score || 0) - 50) * 0.22));
        aiScore += Math.max(-6, Math.min(8, (winRate - 0.5) * 28));
        aiScore += Math.max(-6, Math.min(8, avgPnlPct * 55));
        if (closedLaunches >= 3)
            aiScore += 4;
    }
    if (marketRegime === "HYPE")
        aiScore += 5;
    if (mode === "TREND_MODE")
        aiScore += 3;
    if (ageSeconds <= 45)
        aiScore -= 4;
    if (secondsSinceTrade <= 2)
        aiScore += 3;
    if (secondsSinceTrade > 6)
        aiScore -= 6;
    if (m.change5mPct > 0.28)
        aiScore -= 7;
    if (m.reboundFrom5mLowPct > 0.16)
        aiScore -= 5;
    if (m.dropFrom1hHighPct < -0.18)
        aiScore -= 8;
    aiScore = clamp(aiScore, 0, 100);
    const reasons = [];
    const redFlags = [];
    if (m.liquidityUsd >= 80)
        reasons.push(`AI mag Liq $${m.liquidityUsd.toFixed(1)}`);
    if (walletProfile && Number(walletProfile.confidence_score || 0) >= 65)
        reasons.push(`AI kennt Wallet (${Number(walletProfile.confidence_score || 0).toFixed(0)})`);
    if (m.volume5mUsd >= 35)
        reasons.push(`AI mag Flow $${m.volume5mUsd.toFixed(1)}`);
    if (volToLiquidity >= 0.5)
        reasons.push(`AI mag vol/liq ${volToLiquidity.toFixed(2)}`);
    if (secondsSinceTrade <= 3)
        reasons.push(`AI sieht frischen Tape ${secondsSinceTrade}s`);
    if (marketRegime === "HYPE")
        reasons.push("AI erkennt Hype-Markt");
    if (hourBerlin >= 18 || hourBerlin < 2)
        reasons.push("AI mag US Session");
    if (marketRegime === "DEAD")
        redFlags.push("AI erkennt dead market");
    if (m.sampleCount < 4)
        redFlags.push(`AI: Samples dünn (${m.sampleCount})`);
    if (secondsSinceTrade > 6)
        redFlags.push(`AI: Tape alt (${secondsSinceTrade}s)`);
    if (m.change5mPct > 0.28)
        redFlags.push(`AI: Spike überhitzt (${(m.change5mPct * 100).toFixed(1)}%)`);
    if (m.reboundFrom5mLowPct > 0.16)
        redFlags.push(`AI: Rebound zu steil (${(m.reboundFrom5mLowPct * 100).toFixed(1)}%)`);
    if (hourBerlin < 10)
        redFlags.push("AI: schwache Morgenphase Berlin");
    if (walletProfile && Number(walletProfile.confidence_score || 0) < 45 && Number(walletProfile.closed_launches || 0) >= 3)
        redFlags.push("AI: Wallet-Historie schwach");
    let decision = "ALLOW";
    let sizeMultiplier = 1;
    if (aiScore < AI_MIN_SCORE || marketRegime === "DEAD") {
        decision = "REJECT";
        sizeMultiplier = 0;
    }
    else if (aiScore < AI_REDUCE_SIZE_BELOW) {
        decision = "REDUCE_SIZE";
        sizeMultiplier = 0.72;
    }
    else if (aiScore >= AI_HIGH_CONFIDENCE_SCORE) {
        decision = "HIGH_CONFIDENCE";
        sizeMultiplier = 1.12;
    }
    if (walletProfile) {
        const confidence = Number(walletProfile.confidence_score || 0);
        if (confidence >= 75 && decision !== "REJECT")
            sizeMultiplier *= 1.18;
        else if (confidence <= 42 && decision !== "REJECT")
            sizeMultiplier *= 0.82;
    }
    sizeMultiplier = clamp(sizeMultiplier, 0, 1.35);
    const confidence = aiScore >= 78 ? "HIGH" : aiScore >= 62 ? "MEDIUM" : "LOW";
    const summary = decision === "REJECT"
        ? `AI blockt den Trade (${marketRegime.toLowerCase()}, score ${aiScore.toFixed(1)})`
        : decision === "REDUCE_SIZE"
            ? `AI erlaubt nur kleine Size (${marketRegime.toLowerCase()}, score ${aiScore.toFixed(1)})`
            : decision === "HIGH_CONFIDENCE"
                ? `AI sieht starken Kandidaten (${marketRegime.toLowerCase()}, score ${aiScore.toFixed(1)})`
                : `AI gibt grünes Licht (${marketRegime.toLowerCase()}, score ${aiScore.toFixed(1)})`;
    return {
        enabled: true,
        aiScore: Number(aiScore.toFixed(2)),
        confidence,
        marketRegime,
        decision,
        sizeMultiplier,
        summary,
        reasons,
        redFlags,
        features: {
            baseScore: Number(baseScore.toFixed(2)),
            hourBerlin,
            ageSeconds,
            secondsSinceTrade,
            volToLiquidity: Number(volToLiquidity.toFixed(3)),
            liquidityUsd: Number(m.liquidityUsd.toFixed(2)),
            volume5mUsd: Number(m.volume5mUsd.toFixed(2)),
            sampleCount: m.sampleCount,
            change5mPct: Number(m.change5mPct.toFixed(4)),
            change15mPct: Number(m.change15mPct.toFixed(4)),
            rebound5mPct: Number(m.reboundFrom5mLowPct.toFixed(4)),
            creatorWallet: creatorWallet || "",
            walletConfidenceScore: Number(walletProfile?.confidence_score || 0),
            walletClosedLaunches: Number(walletProfile?.closed_launches || 0),
            walletWins: Number(walletProfile?.wins || 0),
        },
    };
}
