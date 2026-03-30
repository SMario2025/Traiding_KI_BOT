import { scanSafeCandidates } from "./scanner.js";
async function main() {
    const rows = await scanSafeCandidates();
    for (const r of rows.slice(0, 15)) {
        console.log(`${r.symbol} | mint=${r.mint} | liq=${r.liquidityUsd} | vol=${r.volume24hUsd} | ageMin=${r.ageMinutes} | score=${r.score} | ${r.reasons.join(",")}`);
    }
}
main().catch(console.error);
