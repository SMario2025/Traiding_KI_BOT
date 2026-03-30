export type Candidate = {
    mint: string
    symbol: string
    liquidityUsd: number
    volume24hUsd: number
    ageMinutes: number
    score: number
    reasons: string[]
}

function num(v: unknown): number {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
}

export async function scanSafeCandidates(): Promise<Candidate[]> {
    try {
        console.log("🔎 Lade Daten von Dexscreener...")

        const res = await fetch("https://api.dexscreener.com/latest/dex/search?q=sol")
        const text = await res.text()

        if (text.startsWith("<")) {
            console.log("⚠️ API liefert HTML statt JSON")
            return []
        }

        const json = JSON.parse(text)
        const pairs = Array.isArray(json?.pairs) ? json.pairs : []

        console.log(`📦 Paare geladen: ${pairs.length}`)

        const candidates: Candidate[] = pairs
            .map((p: any): Candidate => {
                const mint = String(p?.baseToken?.address || "").trim()
                const symbol = String(p?.baseToken?.symbol || "").trim().toUpperCase()
                const liquidityUsd = num(p?.liquidity?.usd)
                const volume24hUsd = num(p?.volume?.h24)
                const h1 = num(p?.priceChange?.h1)
                const ageMinutes = 0
                const reasons = [
                    `h1=${h1.toFixed(2)}%`,
                    `liq=$${liquidityUsd.toFixed(0)}`,
                    `vol24h=$${volume24hUsd.toFixed(0)}`,
                ]

                return {
                    mint,
                    symbol,
                    liquidityUsd,
                    volume24hUsd,
                    ageMinutes,
                    reasons,
                    score: h1 + volume24hUsd / 100000 + liquidityUsd / 10000,
                }
            })
            .filter((c: Candidate) => {
                if (!c.mint) return false
                if (!c.symbol) return false
                if (["SOL", "USDC", "USDT"].includes(c.symbol)) return false
                if (c.liquidityUsd < 1000) return false
                return true
            })
            .sort((a: Candidate, b: Candidate) => b.score - a.score)
            .slice(0, 10)

        console.log(`✅ Kandidaten gefunden: ${candidates.length}`)
        return candidates
    } catch (err) {
        console.log("❌ Scanner Fehler:", err)
        return []
    }
}
