import "dotenv/config";
import { startPumpFeed } from "./live/pumpFeed.js";
import { runAutoTrader } from "./autoTrader.js";
import { insertBotEvent, setBotHealth } from "./db.js";
function sleep(ms) {
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
        }
        catch (err) {
            console.log("❌ Bot Fehler:", err);
            insertBotEvent("error", "bot_loop_error", "Bot loop error", {
                error: err?.message || String(err),
            });
            setBotHealth({ status: "error" });
        }
        console.log("⏳ Warten auf nächste Runde...");
        await sleep(4000);
    }
}
main().catch((err) => {
    insertBotEvent("error", "bot_crash", "Bot crashed during startup", {
        error: err?.message || String(err),
    });
    setBotHealth({ status: "crashed" });
    console.error(err);
    process.exit(1);
});
