export async function getNewPumpTokens() {
    try {
        console.log("🌐 Lade neue Pump Tokens...");
        const res = await fetch("https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=DESC", {
            headers: {
                accept: "application/json",
                "user-agent": "Mozilla/5.0",
                origin: "https://pump.fun",
                referer: "https://pump.fun/",
            },
        });
        const text = await res.text();
        if (!res.ok) {
            console.log(`❌ Pump API HTTP Fehler: ${res.status}`);
            console.log(text.slice(0, 500));
            return [];
        }
        if (text.startsWith("<")) {
            console.log("❌ Pump API liefert HTML statt JSON");
            return [];
        }
        const json = JSON.parse(text);
        let coins = [];
        if (Array.isArray(json)) {
            coins = json;
        }
        else if (Array.isArray(json.coins)) {
            coins = json.coins;
        }
        else if (Array.isArray(json.data)) {
            coins = json.data;
        }
        else {
            console.log("❌ Unbekanntes Format:", json);
            return [];
        }
        return coins
            .map((c) => ({
            mint: c?.mint,
            symbol: c?.symbol || "PUMP",
        }))
            .filter((c) => c.mint);
    }
    catch (err) {
        console.log("❌ Pump Scanner Fehler:", err);
        return [];
    }
}
