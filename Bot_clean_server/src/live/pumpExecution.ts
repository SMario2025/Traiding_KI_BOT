import "dotenv/config";
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const BOT_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY || process.env.PRIVATE_KEY;
const LIVE_TRADING_ENABLED = String(process.env.LIVE_TRADING_ENABLED || process.env.LIVE_TRADING || "false").toLowerCase() === "true";

const connection = new Connection(RPC_URL, "confirmed");
const wallet = LIVE_TRADING_ENABLED && BOT_PRIVATE_KEY
    ? Keypair.fromSecretKey(bs58.decode(BOT_PRIVATE_KEY.trim()))
    : Keypair.generate();

type PreferredDex = "pump" | "auto";

type ExecutionOptions = {
    preferredDex?: PreferredDex;
    entryRoute?: string;
};

export async function getPumpWalletPubkey() {
    return LIVE_TRADING_ENABLED ? wallet.publicKey.toBase58() : "LEARNING_ONLY";
}

export async function getPumpSolBalance() {
    if (!LIVE_TRADING_ENABLED) return 0;
    const lamports = await connection.getBalance(wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
}

async function buildLocalTradeTx(payload: {
    action: "buy" | "sell";
    mint: string;
    amount: number | string;
    denominatedInSol: "true" | "false";
    slippage?: number;
    priorityFee?: number;
    pool?: "auto" | "pump" | "pump-amm" | "launchlab" | "bonk";
}) {
    const requestBody = {
        publicKey: wallet.publicKey.toBase58(),
        action: payload.action,
        mint: payload.mint,
        amount: payload.amount,
        denominatedInSol: payload.denominatedInSol,
        slippage: payload.slippage ?? Number(process.env.PUMP_SLIPPAGE_BPS || 10),
        priorityFee: payload.priorityFee ?? Number(process.env.PUMP_PRIORITY_FEE_SOL || 0.00001),
        pool: payload.pool ?? "auto",
    };

    console.log("🧪 trade-local request:", requestBody);

    const response = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`PumpPortal trade-local HTTP ${response.status}: ${text}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) {
        throw new Error("PumpPortal hat keine serialisierte Transaktion zurückgegeben");
    }

    return VersionedTransaction.deserialize(bytes);
}

async function signAndSend(tx: VersionedTransaction) {
    tx.sign([wallet]);

    const signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
    });

    const latest = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
        {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
    );

    return signature;
}

async function executeViaPumpPortal(
    action: "buy" | "sell",
    mint: string,
    amount: number | string,
    denominatedInSol: "true" | "false",
    pool: "auto" | "pump"
) {
    if (!LIVE_TRADING_ENABLED) {
        throw new Error("LIVE_TRADING_ENABLED=false (learning mode)");
    }
    const tx = await buildLocalTradeTx({
        action,
        mint,
        amount,
        denominatedInSol,
        slippage: Number(process.env.PUMP_SLIPPAGE_BPS || 10),
        priorityFee: Number(process.env.PUMP_PRIORITY_FEE_SOL || 0.00001),
        pool,
    });

    const txid = await signAndSend(tx);

    return {
        txid,
        outputAmountRaw: 0,
        route: pool === "auto" ? "pumpportal-auto" : `pumpportal-${pool}`,
    };
}

function resolveBuyPreference(preferredDex?: PreferredDex): PreferredDex {
    return preferredDex === "pump" ? "pump" : "auto";
}

function resolveSellPreference(entryRoute?: string): PreferredDex {
    if (String(entryRoute || "").includes("pump")) return "pump";
    return "auto";
}

export async function liveBuyPumpMint(mint: string, solAmount: number, options: ExecutionOptions = {}) {
    const preferred = resolveBuyPreference(options.preferredDex);

    try {
        console.log("🔥 LOCAL BUY:", mint, "|", solAmount, "SOL", "| pref=", preferred);

        if (preferred === "pump") {
            return await executeViaPumpPortal("buy", mint, solAmount, "true", "pump");
        }

        return await executeViaPumpPortal("buy", mint, solAmount, "true", "auto");
    } catch (err) {
        console.log("❌ LOCAL BUY ERROR:", err);
        throw err;
    }
}

export async function liveSellPumpMint(mint: string, amountRaw: number, options: ExecutionOptions = {}) {
    const preferred = resolveSellPreference(options.entryRoute);

    try {
        console.log("💰 LOCAL SELL:", mint, "| 100% | pref=", preferred, "| raw=", amountRaw);

        if (preferred === "pump") {
            return await executeViaPumpPortal("sell", mint, "100%", "false", "pump");
        }

        return await executeViaPumpPortal("sell", mint, "100%", "false", "auto");
    } catch (err) {
        console.log("❌ LOCAL SELL ERROR:", err);
        throw err;
    }
}
