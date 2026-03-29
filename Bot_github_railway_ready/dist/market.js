import fetch from "node-fetch";
// ?? Token Mints (wichtig!)
const TOKENS = {
    SOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    BONK: "DezXAZ8z7PnrnRJjz3wXBo9wKk1v1Yz4qS1bQn5Qh1c",
    WIF: "EKpQGSJtjMFqKZ9m1x8h7kZ9b7z4r1HhJ9k5s8xWif",
    POPCAT: "7GCihgDB8fe6KnF5HgCVwKz9dZYkTf5ZNVVRhk1kYyqS"
};
// Raydium API
const API = "https://transaction-v1.raydium.io";
// Pair ? Mints
function getMints(pair) {
    const [base, quote] = pair.split("/");
    return {
        baseMint: TOKENS[base],
        quoteMint: TOKENS[quote]
    };
}
// ================= PRICE =================
export async function getLivePrice(pair) {
    const { baseMint, quoteMint } = getMints(pair);
    const amount = 0.01 * 1e9; // 0.01 SOL
    const url = `${API}/compute/swap-base-in?inputMint=${baseMint}&outputMint=${quoteMint}&amount=${amount}&slippageBps=100&txVersion=V0`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json?.data?.outputAmount) {
        throw new Error("Preis konnte nicht geladen werden");
    }
    const out = Number(json.data.outputAmount) / 1e6;
    return out / 0.01;
}
// ================= BUY =================
export async function buyToken(pair, solAmount) {
    const { baseMint, quoteMint } = getMints(pair);
    const amount = solAmount * 1e9;
    const url = `${API}/compute/swap-base-in?inputMint=${baseMint}&outputMint=${quoteMint}&amount=${amount}&slippageBps=1000&txVersion=V0`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json?.data)
        throw new Error("Buy fehlgeschlagen");
    const tokens = Number(json.data.outputAmount);
    return {
        tokens: tokens / 1e6,
        tx: "SIMULATED_TX"
    };
}
// ================= SELL =================
export async function sellToken(pair, tokenAmount) {
    const { baseMint, quoteMint } = getMints(pair);
    const amount = tokenAmount * 1e6;
    const url = `${API}/compute/swap-base-in?inputMint=${quoteMint}&outputMint=${baseMint}&amount=${amount}&slippageBps=1000&txVersion=V0`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json?.data)
        throw new Error("Sell fehlgeschlagen");
    const sol = Number(json.data.outputAmount);
    return {
        sol: sol / 1e9,
        usdc: sol / 1e9 // vereinfachung
    };
}
