import "dotenv/config";
import { startPumpFeed } from "./live/pumpFeed.js";
import { runAutoTrader } from "./autoTrader.js";
import { insertBotEvent, setBotHealth } from "./db.js";

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

async function main() {
    console.log("🚀 BOT STARTET...");
    insertBotEvent("info", "bot_start", "Bot process starting");
    setBotHealth({ status: "starting", lastLoopAt: Date.now() });

    startPumpFeed();

    while (true) {
        try {
            console.log("🔄 Neue Runde...");
            await runAutoTrader();
        } catch (err: any) {
            console.log("❌ Bot Fehler:", err);
            insertBotEvent("error", "bot_loop_error", "Bot loop error", {
                error: err?.message || String(err),
            });
            setBotHealth({ status: "error" });
        }

        console.log("⏳ Warten auf nächste Runde...");
        await sleep(Number(process.env.BOT_LOOP_MS || 1000));
    }
}

main().catch((err: any) => {
    insertBotEvent("error", "bot_crash", "Bot crashed during startup", {
        error: err?.message || String(err),
    });
    setBotHealth({ status: "crashed" });
    console.error(err);
    process.exit(1);
});
