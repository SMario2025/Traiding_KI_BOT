export function shouldBuyNow(prices, entryDipPct, reboundPct) {
    if (prices.length < 20)
        return false;
    const last = prices[prices.length - 1];
    const prev = prices[prices.length - 2];
    const recentHigh = Math.max(...prices.slice(-20));
    const recentLow = Math.min(...prices.slice(-20));
    const dippedEnough = last <= recentHigh * (1 - entryDipPct);
    const rebounding = prev > 0 ? (last / prev - 1) >= reboundPct : false;
    // Extra Aggro-Filter:
    // nur kaufen, wenn wir nicht direkt am Hoch h�ngen
    const roomFromLow = recentLow > 0 ? (last / recentLow - 1) : 0;
    const notTooExtended = roomFromLow < 0.015;
    return dippedEnough && rebounding && notTooExtended;
}
export function shouldSellNow(currentPrice, entryPrice, stopLossPct, takeProfitPct) {
    if (currentPrice <= entryPrice * (1 - stopLossPct)) {
        return { sell: true, reason: 'stop_loss' };
    }
    if (currentPrice >= entryPrice * (1 + takeProfitPct)) {
        return { sell: true, reason: 'take_profit' };
    }
    return { sell: false, reason: '' };
}
