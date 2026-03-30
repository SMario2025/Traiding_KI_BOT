import path from "path";
import dotenv from "dotenv";
dotenv.config();
function parsePairs() {
    const raw = process.env.PAIRS || "SOL/USDC";
    return raw.split(",").map(p => p.trim()).filter(Boolean);
}
const dataRoot = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || "data";
export const config = {
    paperMode: process.env.PAPER_MODE === "true",
    liveTrading: process.env.LIVE_TRADING_ENABLED === "true",
    port: Number(process.env.PORT || 3000),
    dbPath: process.env.DB_PATH || path.join(dataRoot, "bot.db"),
    // ?? MULTI PAIRS
    pairs: parsePairs(),
    // Trading
    maxTradeSol: Number(process.env.AUTO_TRADE_SIZE_SOL || process.env.MAX_TRADE_SOL || 0.02),
    minSolReserve: Number(process.env.MIN_SOL_RESERVE || 0.05),
    tradeSizePct: Number(process.env.TRADE_SIZE_PCT || 0.3),
    takeProfitPct: Number(process.env.TP_PCT || process.env.TAKE_PROFIT_PCT || 0.015),
    stopLossPct: Number(process.env.SL_PCT || process.env.STOP_LOSS_PCT || 0.008),
    // Timing
    pollSeconds: Number(process.env.POLL_SECONDS || 15),
    cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 120),
    // Entry Logic
    entryDipPct: Number(process.env.ENTRY_DIP_PCT || 0.004),
    reboundPct: Number(process.env.REBOUND_PCT || 0.001),
    // Safety
    maxDailyLossSol: Number(process.env.DAILY_DRAWDOWN_GUARD_SOL || process.env.MAX_DAILY_LOSS_SOL || 0.02),
};
