import "dotenv/config";
import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";

type SniperCandidate = {
    mint: string;
    symbol: string;
    score: number;
    source: string;
    firstSeenAt: number;
};

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

const PUMP_PROGRAM_ID = process.env.PUMP_PROGRAM_ID || "";

const queue: SniperCandidate[] = [];
let started = false;
let subscriptionId: number | null = null;
let lastFetch = 0;

const seenSignatures = new Set<string>();
const seenMints = new Set<string>();
const firstSeenMap = new Map<string, number>();

function isFreshPumpMint(mint: string) {
    return typeof mint === "string" && mint.endsWith("pump") && mint.length > 20;
}

function pushCandidate(mint: string, source: string) {
    const cleanMint = String(mint || "").trim();
    if (!isFreshPumpMint(cleanMint)) return;
    if (seenMints.has(cleanMint)) return;

    const firstSeenAt = Date.now();
    seenMints.add(cleanMint);
    firstSeenMap.set(cleanMint, firstSeenAt);

    queue.push({
        mint: cleanMint,
        symbol: "PUMP",
        score: 10,
        source,
        firstSeenAt,
    });

    if (queue.length > 100) queue.shift();

    console.log(`🚀 Neuer RPC Kandidat: ${cleanMint} | source=${source}`);
}

async function tryExtractMintFromTx(signature: string) {
    const now = Date.now();

    if (now - lastFetch < 500) return;
    lastFetch = now;

    try {
        const tx: ParsedTransactionWithMeta | null = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
        });

        if (!tx) return;

        const balances = [
            ...(tx.meta?.postTokenBalances || []),
            ...(tx.meta?.preTokenBalances || []),
        ];

        for (const b of balances) {
            const mint = String(b?.mint || "").trim();
            if (isFreshPumpMint(mint)) {
                pushCandidate(mint, "parsed-transaction");
            }
        }

        for (const ix of tx.transaction.message.instructions) {
            const parsed: any = (ix as any)?.parsed;
            const info: any = parsed?.info;

            const mint =
                info?.mint ||
                info?.tokenMint ||
                info?.newAccount ||
                info?.account;

            if (typeof mint === "string" && isFreshPumpMint(mint)) {
                pushCandidate(mint, "parsed-instruction");
            }
        }
    } catch (err) {
        console.log("⚠️ getParsedTransaction Fehler:", err);
    }
}

export async function startRpcSniper() {
    if (started) return;
    started = true;

    console.log("🛰️ RPC Sniper startet...");
    console.log(`🌐 RPC URL: ${RPC_URL.includes("helius") ? "Helius" : "Standard RPC"}`);

    if (PUMP_PROGRAM_ID) {
        console.log(`🎯 logsSubscribe mit mentions=${PUMP_PROGRAM_ID}`);

        subscriptionId = connection.onLogs(
            new PublicKey(PUMP_PROGRAM_ID),
            async (logInfo) => {
                const signature = logInfo.signature;
                if (!signature || seenSignatures.has(signature)) return;

                seenSignatures.add(signature);
                await tryExtractMintFromTx(signature);
            },
            "confirmed"
        );

        return;
    }

    console.log("⚠️ Kein PUMP_PROGRAM_ID gesetzt – Fallback auf all logs");

    subscriptionId = connection.onLogs(
        "all",
        async (logInfo) => {
            const signature = logInfo.signature;
            if (!signature || seenSignatures.has(signature)) return;

            const logs = logInfo.logs || [];
            const looksInteresting = logs.some((l) => {
                const s = String(l).toLowerCase();
                return s.includes("pump") || s.includes("initialize") || s.includes("mint");
            });

            if (!looksInteresting) return;

            seenSignatures.add(signature);
            await tryExtractMintFromTx(signature);
        },
        "confirmed"
    );
}

export async function stopRpcSniper() {
    if (subscriptionId !== null) {
        await connection.removeOnLogsListener(subscriptionId);
        subscriptionId = null;
    }
    started = false;
}

export async function getRpcSniperCandidates(): Promise<SniperCandidate[]> {
    if (!started) {
        await startRpcSniper();
    }

    const now = Date.now();
    const maxAgeMs = Number(process.env.FRESH_LAUNCH_MAX_AGE_SECONDS || 600) * 1000;

    const freshOnly = queue.filter((c) => now - c.firstSeenAt <= maxAgeMs);

    queue.length = 0;

    console.log(`📡 RPC Sniper Queue: ${freshOnly.length}`);
    return freshOnly;
}