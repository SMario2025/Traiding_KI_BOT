import express from "express"
import crypto from "crypto"
import bs58 from "bs58"
import { Connection, Keypair } from "@solana/web3.js"
import { config } from "./config.js"
import { getMintMetrics, getMintPriceSeries } from "./live/pumpStream.js"
import {
    getBotHealth,
    getBotTradeStats,
    getBotTrades,
    getDecisionSummary,
    getRecentBotDecisions,
    getRecentBotEvents,
    getRecentEquitySnapshots,
    getRuntimePositions,
    getLatestAiSnapshot,
    getTopWalletProfiles,
    getRuntimeWatchlist,
    getDashboardControlState,
    updateDashboardControlState,
    requestAbortMint,
    getLearningHistory,
    getSeenMints,
    getSeenMintStats,
    createUser,
    createUserSession,
    deleteUserSession,
    getUserBySessionToken,
    getUserByUsername,
    getUsers,
    getUserSystemSummary,
    setUserBalanceSol,
    setUserBotEnabled,
    touchUserLogin,
} from "./db.js"

const app = express()
app.use(express.json())


const SESSION_COOKIE = "bot_session"
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14

function parseCookies(req: any) {
    const raw = String(req.headers?.cookie || "")
    const out: Record<string, string> = {}
    for (const part of raw.split(';')) {
        const [k, ...rest] = part.trim().split('=')
        if (!k) continue
        out[k] = decodeURIComponent(rest.join('=') || '')
    }
    return out
}

function hashPassword(username: string, password: string) {
    return crypto.createHash('sha256').update(`${String(username).trim().toLowerCase()}::${password}`).digest('hex')
}

function makeSessionToken() {
    return crypto.randomBytes(24).toString('hex')
}

function getAuthedUser(req: any) {
    const token = parseCookies(req)[SESSION_COOKIE]
    if (!token) return null
    return getUserBySessionToken(token)
}

async function refreshUserChainBalance(user: any) {
    const rpcUrl = process.env.RPC_URL || process.env.RPC_FALLBACK || 'https://api.mainnet-beta.solana.com'
    try {
        const conn = new Connection(rpcUrl, 'confirmed')
        const lamports = await conn.getBalance(user.wallet_public_key)
        const sol = lamports / 1e9
        return setUserBalanceSol(user.id, sol)
    } catch {
        return user
    }
}

function publicUserView(user: any) {
    if (!user) return null
    return {
        id: Number(user.id || 0),
        username: String(user.username || ''),
        wallet_public_key: String(user.wallet_public_key || ''),
        balance_sol: Number(user.balance_sol || 0),
        bot_enabled: Boolean(user.bot_enabled),
        created_at: user.created_at || '',
        updated_at: user.updated_at || '',
        last_login_at: Number(user.last_login_at || 0),
    }
}


function fmtPct(value: number) {
    return `${(Number(value || 0) * 100).toFixed(2)}%`
}


app.post("/api/auth/register", async (req, res) => {
    try {
        const username = String(req.body?.username || '').trim()
        const password = String(req.body?.password || '')
        if (username.length < 3 || password.length < 6) {
            return res.status(400).json({ ok: false, error: 'username_or_password_too_short' })
        }
        if (getUserByUsername(username)) {
            return res.status(409).json({ ok: false, error: 'username_exists' })
        }
        const kp = Keypair.generate()
        const user = createUser({
            username,
            passwordHash: hashPassword(username, password),
            walletPublicKey: kp.publicKey.toBase58(),
            walletSecretKey: bs58.encode(kp.secretKey),
        })
        const token = makeSessionToken()
        createUserSession(Number(user?.id || 0), token, Date.now() + SESSION_TTL_MS)
        touchUserLogin(Number(user?.id || 0))
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`)
        return res.json({ ok: true, user: publicUserView(await refreshUserChainBalance(user)) })
    } catch (err:any) {
        return res.status(500).json({ ok: false, error: err?.message || 'register_failed' })
    }
})

app.post("/api/auth/login", async (req, res) => {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    const user = getUserByUsername(username)
    if (!user || String((user as any).password_hash || '') !== hashPassword(username, password)) {
        return res.status(401).json({ ok: false, error: 'invalid_credentials' })
    }
    const token = makeSessionToken()
    createUserSession(Number((user as any).id || 0), token, Date.now() + SESSION_TTL_MS)
    touchUserLogin(Number((user as any).id || 0))
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS/1000)}`)
    return res.json({ ok: true, user: publicUserView(await refreshUserChainBalance(user)) })
})

app.post("/api/auth/logout", (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE]
    if (token) deleteUserSession(token)
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    return res.json({ ok: true })
})

app.get("/api/user/me", async (req, res) => {
    const user = getAuthedUser(req)
    if (!user) return res.json({ ok: true, user: null, summary: getUserSystemSummary() })
    return res.json({ ok: true, user: publicUserView(await refreshUserChainBalance(user)), summary: getUserSystemSummary() })
})

app.post("/api/user/bot", (req, res) => {
    const user = getAuthedUser(req)
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' })
    const updated = setUserBotEnabled(user.id, Boolean(req.body?.enabled))
    return res.json({ ok: true, user: publicUserView(updated) })
})

app.post("/api/user/refresh-balance", async (req, res) => {
    const user = getAuthedUser(req)
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' })
    return res.json({ ok: true, user: publicUserView(await refreshUserChainBalance(user)) })
})

app.get("/api/users", (_req, res) => {
    return res.json({ ok: true, summary: getUserSystemSummary(), items: getUsers() })
})

app.get("/api/state", (_req, res) => {
    const health = getBotHealth()
    const tradeStats = getBotTradeStats()
    const snapshots = getRecentEquitySnapshots(240)
    const positions = getRuntimePositions()
    const recentTrades = getBotTrades(50)
    const events = getRecentBotEvents(60)
    const decisions = getRecentBotDecisions(40)
    const decisionSummary = getDecisionSummary(400)
    const latestSnapshot = snapshots[snapshots.length - 1] || null
    const ai = getLatestAiSnapshot()
    const wallets = getTopWalletProfiles(8)
    const watchRows = getRuntimeWatchlist(200)
    const pipeline = {
        stage1Rejected: Number(decisionSummary.find((x:any)=> String(x.action).includes("reject"))?.count || 0),
        stage2Watching: watchRows.filter((x:any)=> x.status === "WATCH").length,
        stage3Ready: watchRows.filter((x:any)=> x.status === "READY").length,
        stage3Cooldown: watchRows.filter((x:any)=> x.status === "COOLDOWN").length,
    }
    const controls = getDashboardControlState()
    const latestLearningHistory = getLearningHistory(1).slice(-1)[0] || null

    const activeWatchlist = getRuntimeWatchlist(12).map((item: any) => ({
        ...item,
        currentPrice: Number(getMintMetrics(item.mint)?.currentPrice || item.currentPrice || 0),
        change5mPct: Number(getMintMetrics(item.mint)?.change5mPct || item.change5mPct || 0),
        change15mPct: Number(getMintMetrics(item.mint)?.change15mPct || item.change15mPct || 0),
        change1hPct: Number(getMintMetrics(item.mint)?.change1hPct || item.change1hPct || 0),
        chart: getMintPriceSeries(item.mint, 36),
    }))

    res.json({
        now: Date.now(),
        config: {
            mode: config.paperMode ? "PAPER" : "LIVE",
            liveTrading: config.liveTrading,
            pairs: config.pairs,
            maxTradeSol: config.maxTradeSol,
            minSolReserve: config.minSolReserve,
            takeProfitPct: config.takeProfitPct,
            stopLossPct: config.stopLossPct,
            maxDailyLossSol: config.maxDailyLossSol,
            pollSeconds: config.pollSeconds,
            cooldownSeconds: config.cooldownSeconds,
        },
        health,
        stats: {
            ...tradeStats,
            openPositions: positions.length,
            totalEquitySol: Number(latestSnapshot?.total_equity_sol || 0),
            walletSol: Number(latestSnapshot?.wallet_sol || 0),
            openPositionsValueSol: Number(latestSnapshot?.open_positions_value_sol || 0),
            watchedMints: Number(latestSnapshot?.watched_mints || 0),
        },
        positions: positions.map((p: any) => {
            const holdMinutes = Math.max(0, (Date.now() - Number(p.entry_time || 0)) / 60000)
            const unrealizedPct = Number(p.entry_price || 0) > 0
                ? Number(p.highest_price_seen || 0) / Number(p.entry_price || 1) - 1
                : 0

            return {
                mint: p.mint,
                symbol: p.symbol,
                entryTime: Number(p.entry_time || 0),
                entryPrice: Number(p.entry_price || 0),
                highestPriceSeen: Number(p.highest_price_seen || 0),
                sizeSol: Number(p.size_sol || 0),
                route: p.route,
                buyTxid: p.buy_txid,
                updatedAt: Number(p.updated_at || 0),
                holdMinutes,
                unrealizedPct,
            }
        }),
        trades: recentTrades.map((t: any) => ({
            ...t,
            pnl_pct_label: fmtPct(Number(t.pnl_pct || 0)),
        })),
        events,
        decisions,
        decisionSummary,
        snapshots,
        ai: ai ? {
            ts: Number(ai.ts || 0),
            enabled: Boolean(ai.ai_enabled),
            marketRegime: ai.market_regime || "NORMAL",
            aiScoreAvg: Number(ai.ai_score_avg || 0),
            aiScoreBest: Number(ai.ai_score_best || 0),
            allows: Number(ai.allows || 0),
            rejects: Number(ai.rejects || 0),
            reduceSize: Number(ai.reduce_size || 0),
            highConfidence: Number(ai.high_confidence || 0),
        } : null,
        walletIntel: wallets,
        activeWatchlist,
        controls,
        pipeline,
        users: getUserSystemSummary(),
        learning: health?.details?.learning || (latestLearningHistory ? {
            enabled: true,
            phase: latestLearningHistory.phase || 'WARMUP',
            confidenceScore: Number(latestLearningHistory.confidence_score || 0),
            sampleSize: 0,
            totalClosedTrades: Number(latestLearningHistory.total_closed_trades || 0),
            recentWinRate: Number(latestLearningHistory.recent_win_rate || 0),
            recentAvgPnlPct: Number(latestLearningHistory.recent_avg_pnl_pct || 0),
            sizeMultiplier: Number(latestLearningHistory.size_multiplier || 1),
            minAiScoreBoost: Number(latestLearningHistory.min_ai_score_boost || 0),
            watchlistQualityScore: Number(latestLearningHistory.watchlist_quality_score || 0),
            watchlistObserved: Number(latestLearningHistory.watchlist_observed || 0),
            summary: latestLearningHistory.summary || 'Learning snapshot loaded from history',
        } : null),
    })
})


app.post("/api/control", (req, res) => {
    const body = req.body || {}
    const next = updateDashboardControlState({
        killSwitch: body.killSwitch,
        sizeMultiplier: body.sizeMultiplier,
        maxPositionsOverride: body.maxPositionsOverride,
        abortAll: body.abortAll,
    })
    res.json({ ok: true, controls: next })
})

app.post("/api/control/abort/:mint", (req, res) => {
    requestAbortMint(String(req.params.mint || ""))
    res.json({ ok: true, controls: getDashboardControlState() })
})


app.get("/api/learning-history", (_req, res) => {
    res.json({ now: Date.now(), items: getLearningHistory(300) })
})

app.get("/api/market-universe", (_req, res) => {
    res.json({ now: Date.now(), stats: getSeenMintStats(5000), items: getSeenMints(500) })
})

app.get("/api/feed", (_req, res) => {
    const health = getBotHealth()
    const lastFeedAt = Number(health?.lastFeedAt || 0)
    const staleSec = lastFeedAt > 0 ? Math.max(0, (Date.now() - lastFeedAt) / 1000) : 999999
    res.json({
        now: Date.now(),
        status: health?.status || 'unknown',
        lastFeedAt,
        staleSec: Number(staleSec.toFixed(1)),
        details: health?.details || {},
        recentEvents: getRecentBotEvents(20).filter((x:any)=> String(x.type || '').includes('feed')),
    })
})

function renderMiniPage(title: string, pageId: string) {
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
body{margin:0;background:#07111f;color:#e5eefc;font-family:Inter,system-ui,sans-serif}
a{color:#53e0ff;text-decoration:none}.wrap{max-width:1300px;margin:0 auto;padding:24px}
.nav{display:flex;gap:14px;margin-bottom:18px}.card{background:rgba(18,31,56,.82);border:1px solid rgba(148,163,184,.14);border-radius:18px;padding:18px;box-shadow:0 20px 80px rgba(0,0,0,.25)}
table{width:100%;border-collapse:collapse}th,td{padding:10px 8px;border-bottom:1px solid rgba(148,163,184,.08);text-align:left;font-size:13px}
.muted{color:#8ca0c6}.good{color:#3ddc97}.bad{color:#ff6b81}.mono{font-family:ui-monospace,monospace}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.k{color:#8ca0c6;font-size:12px;text-transform:uppercase}.v{font-size:28px;font-weight:700;margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
<div class="nav"><a href="/">Dashboard</a><a href="/learning">Learning History</a><a href="/watchlist">Watchlist / Universe</a><a href="/feed">Feed Health</a><a href="/users">Users</a></div>
<div id="app" class="card"></div>
</div>
<script>
const fmt={pct:v=>((Number(v||0)*100).toFixed(2)+'%'),ago:v=>{if(!v)return '-';const s=Math.max(0,Math.floor((Date.now()-Number(v))/1000));if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m';return Math.floor(s/3600)+'h';}};
async function run(){
  const root=document.getElementById('app');
  if('${pageId}'==='learning'){
    const r=await fetch('/api/learning-history'); const d=await r.json();
    root.innerHTML='<h2>Learning History</h2><p class="muted">Verlauf der Lernwerte über Zeit.</p><table><thead><tr><th>Zeit</th><th>Phase</th><th>Confidence</th><th>Size</th><th>AI+</th><th>Winrate</th><th>Avg PnL</th><th>Closed</th><th>Watch Q</th></tr></thead><tbody>'+((d.items||[]).slice().reverse().map(x=>'<tr><td>'+new Date(x.ts).toLocaleString('de-DE')+'</td><td>'+x.phase+'</td><td>'+Number(x.confidence_score||0).toFixed(0)+'</td><td>'+Number(x.size_multiplier||1).toFixed(2)+'x</td><td>'+Number(x.min_ai_score_boost||0)+'</td><td>'+fmt.pct(x.recent_win_rate||0)+'</td><td>'+fmt.pct(x.recent_avg_pnl_pct||0)+'</td><td>'+Number(x.total_closed_trades||0)+'</td><td>'+Number(x.watchlist_quality_score||0).toFixed(0)+'</td></tr>').join('')||'<tr><td colspan="9">Noch keine Lernhistorie</td></tr>')+'</tbody></table>';
    return;
  }
  if('${pageId}'==='watchlist'){
    const r=await fetch('/api/market-universe'); const d=await r.json();
    root.innerHTML='<h2>Marktuniversum</h2><div class="grid"><div class="card"><div class="k">Observed</div><div class="v">'+Number(d.stats?.observed||0)+'</div></div><div class="card"><div class="k">Ready Rate</div><div class="v">'+fmt.pct(d.stats?.readyRate||0)+'</div></div><div class="card"><div class="k">Positive Closes</div><div class="v">'+fmt.pct(d.stats?.positiveCloseRate||0)+'</div></div><div class="card"><div class="k">Follow Through</div><div class="v">'+fmt.pct(d.stats?.followThroughRate||0)+'</div></div></div><table><thead><tr><th>Mint</th><th>Symbol</th><th>Obs</th><th>Move</th><th>Drawdown</th><th>Best Score</th><th>Best AI</th><th>Ready Hits</th><th>Seen</th></tr></thead><tbody>'+((d.items||[]).map(x=>{const move=Number(x.first_price||0)>0&&Number(x.last_price||0)>0?(Number(x.last_price)/Number(x.first_price)-1):0;const dd=Number(x.highest_price||0)>0&&Number(x.last_price||0)>0?(Number(x.last_price)/Number(x.highest_price)-1):0;return '<tr><td class="mono">'+String(x.mint).slice(0,6)+'…'+String(x.mint).slice(-5)+'</td><td>'+x.symbol+'</td><td>'+Number(x.observations||0)+'</td><td class="'+(move>=0?'good':'bad')+'">'+fmt.pct(move)+'</td><td class="'+(dd>=0?'good':'bad')+'">'+fmt.pct(dd)+'</td><td>'+Number(x.best_score||0).toFixed(1)+'</td><td>'+Number(x.best_ai_score||0).toFixed(1)+'</td><td>'+Number(x.ready_hits||0)+'</td><td>'+fmt.ago(x.last_seen_at)+' ago</td></tr>';}).join('')||'<tr><td colspan="9">Noch keine Marktbeobachtungen</td></tr>')+'</tbody></table>';
    return;
  }

  if('${pageId}'==='users'){
    const [meRes, usersRes]=await Promise.all([fetch('/api/user/me'), fetch('/api/users')]);
    const me=await meRes.json(); const users=await usersRes.json();
    const current=me.user;
    const summary=users.summary||{};
    const authHtml=current
      ? '<div class="card"><div class="k">Eingeloggt als</div><div class="v" style="font-size:22px">'+current.username+'</div><div class="muted">Deposit Wallet: <span class="mono">'+current.wallet_public_key+'</span></div><div class="muted" style="margin-top:8px">Onchain Guthaben: '+Number(current.balance_sol||0).toFixed(4)+' SOL</div><div style="margin-top:12px;display:flex;gap:10px"><button id="toggleBot">'+(current.bot_enabled?'Bot deaktivieren':'Bot aktivieren')+'</button><button id="refreshBal">Guthaben aktualisieren</button><button id="logoutBtn">Logout</button></div></div>'
      : '<div class="card"><h3>Login / Register</h3><div style="display:grid;gap:10px;max-width:360px"><input id="u" placeholder="Username" /><input id="p" type="password" placeholder="Passwort" /><div style="display:flex;gap:10px"><button id="loginBtn">Login</button><button id="registerBtn">Register</button></div></div></div>'
    root.innerHTML='<h2>User System</h2><div class="grid"><div class="card"><div class="k">Users</div><div class="v">'+Number(summary.totalUsers||0)+'</div></div><div class="card"><div class="k">Bots ON</div><div class="v">'+Number(summary.enabledBots||0)+'</div></div><div class="card"><div class="k">Bots OFF</div><div class="v">'+Number(summary.disabledBots||0)+'</div></div><div class="card"><div class="k">User Guthaben</div><div class="v">'+Number(summary.totalBalanceSol||0).toFixed(4)+' SOL</div></div></div>'+authHtml+'<div class="card" style="margin-top:18px"><h3>Registrierte User</h3><table><thead><tr><th>User</th><th>Wallet</th><th>Guthaben</th><th>Bot</th><th>Last Login</th></tr></thead><tbody>'+((users.items||[]).map(x=>'<tr><td>'+x.username+'</td><td class="mono">'+String(x.wallet_public_key).slice(0,8)+'…'+String(x.wallet_public_key).slice(-6)+'</td><td>'+Number(x.balance_sol||0).toFixed(4)+' SOL</td><td>'+(x.bot_enabled?'ON':'OFF')+'</td><td>'+(x.last_login_at?new Date(x.last_login_at).toLocaleString('de-DE'):'-')+'</td></tr>').join('')||'<tr><td colspan="5">Noch keine User</td></tr>')+'</tbody></table></div>'
    setTimeout(()=>{
      const u=document.getElementById('u'); const p=document.getElementById('p');
      const post=async(url,body)=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); if(!r.ok){alert('Fehler: '+(await r.text())); return;} location.reload();};
      const loginBtn=document.getElementById('loginBtn'); if(loginBtn) loginBtn.onclick=()=>post('/api/auth/login',{username:u.value,password:p.value});
      const registerBtn=document.getElementById('registerBtn'); if(registerBtn) registerBtn.onclick=()=>post('/api/auth/register',{username:u.value,password:p.value});
      const logoutBtn=document.getElementById('logoutBtn'); if(logoutBtn) logoutBtn.onclick=()=>post('/api/auth/logout',{});
      const refreshBal=document.getElementById('refreshBal'); if(refreshBal) refreshBal.onclick=()=>post('/api/user/refresh-balance',{});
      const toggleBot=document.getElementById('toggleBot'); if(toggleBot) toggleBot.onclick=()=>post('/api/user/bot',{enabled: !(current && current.bot_enabled)});
    },50)
    return;
  }
  if('${pageId}'==='feed'){
    const r=await fetch('/api/feed'); const d=await r.json();
    root.innerHTML='<h2>Feed Health</h2><div class="grid"><div class="card"><div class="k">Status</div><div class="v">'+String(d.status||'-')+'</div></div><div class="card"><div class="k">Last Feed</div><div class="v">'+fmt.ago(d.lastFeedAt)+' ago</div></div><div class="card"><div class="k">Stale</div><div class="v">'+Number(d.staleSec||0).toFixed(1)+'s</div></div><div class="card"><div class="k">Feed State</div><div class="v">'+String(d.details?.feedState||'-')+'</div></div></div><table><thead><tr><th>Zeit</th><th>Type</th><th>Message</th></tr></thead><tbody>'+((d.recentEvents||[]).map(x=>'<tr><td>'+new Date(x.created_at).toLocaleString('de-DE')+'</td><td>'+x.type+'</td><td>'+x.message+'</td></tr>').join('')||'<tr><td colspan="3">Keine Feed-Events</td></tr>')+'</tbody></table>';
    return;
  }
}
run();setInterval(run,1000);
</script>
</body>
</html>`
}

app.get("/learning", (_req, res) => res.type("html").send(renderMiniPage("Learning History", "learning")))
app.get("/watchlist", (_req, res) => res.type("html").send(renderMiniPage("Watchlist / Universe", "watchlist")))
app.get("/feed", (_req, res) => res.type("html").send(renderMiniPage("Feed Health", "feed")))
app.get("/users", (_req, res) => res.type("html").send(renderMiniPage("Users", "users")))

app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pump Profi Dashboard</title>
  <style>
    :root {
      --bg: #07111f;
      --panel: rgba(10, 20, 38, .76);
      --panel-2: rgba(18, 31, 56, .82);
      --border: rgba(148, 163, 184, .14);
      --text: #e5eefc;
      --muted: #8ca0c6;
      --good: #3ddc97;
      --bad: #ff6b81;
      --warn: #ffd166;
      --blue: #6ea8fe;
      --cyan: #53e0ff;
      --shadow: 0 20px 80px rgba(0,0,0,.35);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background:
      radial-gradient(circle at top left, rgba(83,224,255,.14), transparent 30%),
      radial-gradient(circle at top right, rgba(110,168,254,.14), transparent 26%),
      linear-gradient(180deg, #07111f 0%, #050b14 100%);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap { max-width: 1500px; margin: 0 auto; padding: 28px; }
    .hero { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; margin-bottom:24px; }
    .title h1 { margin:0; font-size:34px; letter-spacing:.2px; }
    .title p { color:var(--muted); margin:8px 0 0; }
    .status-pill { display:inline-flex; align-items:center; gap:10px; padding:10px 14px; border-radius:999px; border:1px solid var(--border); background:rgba(255,255,255,.03); color:var(--text); }
    .dot { width:10px; height:10px; border-radius:999px; background:var(--warn); box-shadow:0 0 18px currentColor; }
    .dot.ok { background: var(--good); }
    .dot.bad { background: var(--bad); }
    .grid { display:grid; grid-template-columns: repeat(12, 1fr); gap:18px; }
    .card { background: linear-gradient(180deg, var(--panel), var(--panel-2)); border:1px solid var(--border); border-radius:22px; box-shadow: var(--shadow); backdrop-filter: blur(14px); }
    .metric { padding:18px 20px; min-height:132px; }
    .metric .label { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.12em; }
    .metric .value { font-size:34px; font-weight:700; margin-top:16px; }
    .metric .sub { margin-top:12px; color:var(--muted); font-size:13px; }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .section-head { display:flex; justify-content:space-between; align-items:center; padding:18px 20px 0; }
    .section-head h3 { margin:0; font-size:18px; }
    .section-head .meta { color:var(--muted); font-size:13px; }
    .panel-body { padding: 18px 20px 20px; }
    .spark { width:160px; height:52px; display:block; }
    .tiny { font-size:11px; color:var(--muted); }
    canvas { width:100%; height:320px; border-radius:16px; background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01)); }
    table { width:100%; border-collapse: collapse; }
    th, td { padding: 12px 10px; border-bottom:1px solid rgba(148,163,184,.08); text-align:left; font-size:13px; }
    th { color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.08em; font-size:11px; }
    tr:hover td { background: rgba(255,255,255,.02); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .badge { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius:999px; padding:6px 10px; font-size:12px; }
    .good { color: var(--good); }
    .bad { color: var(--bad); }
    .warn { color: var(--warn); }
    .events { display:flex; flex-direction:column; gap:10px; }
    .event { padding:14px 16px; border-radius:16px; background: rgba(255,255,255,.03); border:1px solid rgba(148,163,184,.08); }
    .event-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; }
    .event-type { font-size:12px; text-transform:uppercase; letter-spacing:.12em; color:var(--muted); }
    .event-message { font-size:14px; }
    .event-meta { color:var(--muted); font-size:12px; margin-top:6px; }
    .empty { padding:22px; border:1px dashed rgba(148,163,184,.2); border-radius:16px; color:var(--muted); text-align:center; }
    .footer { color:var(--muted); font-size:12px; margin-top:18px; text-align:right; }
    .kv { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:12px; }
    .kv .item { padding:12px 14px; border-radius:16px; background: rgba(255,255,255,.03); border:1px solid rgba(148,163,184,.08); }
    .kv .item .k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
    .kv .item .v { font-size:20px; font-weight:700; margin-top:6px; }
    .learning-summary { margin-top:14px; padding:14px 16px; border-radius:16px; background:rgba(83,224,255,.06); border:1px solid rgba(83,224,255,.12); }
    .chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    @media (max-width: 1180px) {
      .span-3, .span-4, .span-5, .span-6, .span-7, .span-8 { grid-column: span 12; }
      .hero { flex-direction:column; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div style="display:flex;gap:14px;margin-bottom:14px"><a href="/" style="color:var(--cyan);text-decoration:none">Dashboard</a><a href="/learning" style="color:var(--cyan);text-decoration:none">Learning History</a><a href="/watchlist" style="color:var(--cyan);text-decoration:none">Watchlist / Universe</a><a href="/feed" style="color:var(--cyan);text-decoration:none">Feed Health</a><a href="/users" style="color:var(--cyan);text-decoration:none">Users</a></div><div class="hero">
      <div class="title">
        <h1>🚀 Pump Profi Dashboard</h1>
        <p>Live-Monitoring für Feed, Positions, PnL, Health und Execution-Events.</p>
      </div>
      <div class="status-pill"><span id="statusDot" class="dot"></span><span id="statusText">Verbinde…</span></div>
    </div>

    <div class="grid">
      <div class="card metric span-3"><div class="label">Total Equity</div><div class="value" id="equity">-</div><div class="sub" id="equitySub">-</div></div>
      <div class="card metric span-3"><div class="label">Wallet SOL</div><div class="value" id="wallet">-</div><div class="sub" id="walletSub">inkl. freie Liquidität</div></div>
      <div class="card metric span-3"><div class="label">Realized PnL</div><div class="value" id="realized">-</div><div class="sub" id="winrate">-</div></div>
      <div class="card metric span-3"><div class="label">Open Positions</div><div class="value" id="positionsCount">-</div><div class="sub" id="watchCount">-</div></div>

      <div class="card span-8">
        <div class="section-head"><h3>Equity Curve</h3><div class="meta" id="modeBadge">-</div></div>
        <div class="panel-body"><canvas id="equityChart" width="1100" height="320"></canvas></div>
      </div>

      <div class="card span-4">
        <div class="section-head"><h3>Engine Health</h3><div class="meta">Loop / Feed / Actions</div></div>
        <div class="panel-body">
          <div style="display:grid; gap:12px;">
            <div class="badge">Status <strong id="healthStatus">-</strong></div>
            <div class="badge">Last Loop <span id="lastLoop">-</span></div>
            <div class="badge">Last Feed <span id="lastFeed">-</span></div>
            <div class="badge">Last Buy <span id="lastBuy">-</span></div>
            <div class="badge">Last Sell <span id="lastSell">-</span></div>
            <div class="badge">Pairs <span id="pairs">-</span></div>
          </div>
        </div>
      </div>

      <div class="card span-4">
        <div class="section-head"><h3>AI Pipeline</h3><div class="meta">Stage Monitor</div></div>
        <div class="panel-body">
          <div style="display:grid; gap:12px;">
            <div class="badge" style="justify-content:space-between; width:100%;"><span>Stage 1 Rejected</span><strong id="pipeReject">-</strong></div>
            <div class="badge" style="justify-content:space-between; width:100%;"><span>Stage 2 Watching</span><strong id="pipeWatch">-</strong></div>
            <div class="badge good" style="justify-content:space-between; width:100%;"><span>Stage 3 Ready</span><strong id="pipeReady">-</strong></div>
            <div class="badge warn" style="justify-content:space-between; width:100%;"><span>Cooldown</span><strong id="pipeCooldown">-</strong></div>
          </div>
        </div>
      </div>

      <div class="card span-4">
        <div class="section-head"><h3>Control Center</h3><div class="meta">manuell eingreifen</div></div>
        <div class="panel-body">
          <div style="display:grid; gap:12px;">
            <label class="badge" style="justify-content:space-between; width:100%;"><span>Kill Switch</span><input id="killSwitch" type="checkbox" /></label>
            <label class="badge" style="justify-content:space-between; width:100%;"><span>Size Multiplier</span><input id="sizeMultiplier" type="range" min="0.25" max="2" step="0.05" value="1" /></label>
            <div class="tiny" id="sizeMultiplierValue">1.00x</div>
            <label class="badge" style="justify-content:space-between; width:100%;"><span>Max Positions Override</span><input id="maxPositionsOverride" type="number" min="1" max="10" placeholder="auto" style="width:80px;background:transparent;border:none;color:inherit;" /></label>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button class="badge" id="saveControlsBtn" style="cursor:pointer;background:rgba(83,224,255,.08);">Save</button>
              <button class="badge warn" id="abortAllBtn" style="cursor:pointer;background:rgba(255,209,102,.1);">Abort all</button>
            </div>
            <div class="tiny" id="controlStateText">-</div>
          </div>
        </div>
      </div>

      <div class="card span-4">
        <div class="section-head"><h3>Learning Engine</h3><div class="meta" id="learningPhase">-</div></div>
        <div class="panel-body">
          <div class="kv">
            <div class="item"><div class="k">Confidence</div><div class="v" id="learningConfidence">-</div></div>
            <div class="item"><div class="k">Recent Window</div><div class="v" id="learningWindow">-</div></div>
            <div class="item"><div class="k">Recent Winrate</div><div class="v" id="learningWinrate">-</div></div>
            <div class="item"><div class="k">Recent Avg PnL</div><div class="v" id="learningAvg">-</div></div>
            <div class="item"><div class="k">Size Multiplier</div><div class="v" id="learningSize">-</div></div>
            <div class="item"><div class="k">AI Floor Boost</div><div class="v" id="learningAiBoost">-</div></div>
          </div>
          <div class="chips" id="learningRules"></div>
          <div class="learning-summary">
            <div class="tiny">Learning Summary</div>
            <div id="learningSummary" style="margin-top:6px; line-height:1.5;">-</div>
            <div class="tiny" id="learningLifetime" style="margin-top:8px;">-</div>
          </div>
        </div>
      </div>

      <div class="card span-4">
        <div class="section-head"><h3>AI Copilot</h3><div class="meta" id="aiModeBadge">AI OFF</div></div>
        <div class="panel-body">
          <div style="display:grid; gap:12px;">
            <div class="badge">Regime <strong id="aiRegime">-</strong></div>
            <div class="badge">AI Avg <strong id="aiAvg">-</strong></div>
            <div class="badge">AI Best <strong id="aiBest">-</strong></div>
            <div class="badge">Allow / Reject <strong id="aiAllowReject">-</strong></div>
            <div id="aiBreakdown"></div>
          </div>
        </div>
      </div>

      <div class="card span-7">
        <div class="section-head"><h3>Open Positions</h3><div class="meta">Aktive Holdings</div></div>
        <div class="panel-body"><div id="positions"></div></div>
      </div>

      <div class="card span-12">
        <div class="section-head"><h3>Active Watchlist</h3><div class="meta">beobachtet, prozentuale Charts, Ready-to-Buy Status</div></div>
        <div class="panel-body"><div id="watchlist"></div></div>
      </div>

      <div class="card span-4">
        <div class="section-head"><h3>Wallet Intel</h3><div class="meta">gute Creator Wallets</div></div>
        <div class="panel-body"><div id="walletIntel"></div></div>
      </div>

      <div class="card span-8">
        <div class="section-head"><h3>Recent Events</h3><div class="meta">Feed & Execution</div></div>
        <div class="panel-body"><div id="events" class="events"></div></div>
      </div>

      <div class="card span-12">
        <div class="section-head"><h3>Sniper + Trend Decisions</h3><div class="meta">Warum Sniper- und Trend-Trades abgelehnt oder genommen wurden</div></div>
        <div class="panel-body">
          <div style="display:grid; grid-template-columns: 1.1fr 1.9fr; gap:16px;">
            <div>
              <div id="decisionSummary"></div>
            </div>
            <div><div id="decisions" class="events"></div></div>
          </div>
        </div>
      </div>

      <div class="card span-12">
        <div class="section-head"><h3>Trade Tape</h3><div class="meta">Letzte 50 Orders</div></div>
        <div class="panel-body">
          <table>
            <thead>
              <tr>
                <th>Zeit</th><th>Side</th><th>Symbol</th><th>Size (SOL)</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Reason</th><th>Tx</th>
              </tr>
            </thead>
            <tbody id="tradeRows"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="footer">Auto-Refresh alle 4 Sekunden</div>
  </div>

<script>
const fmt = {
  sol: (n) => Number(n || 0).toFixed(4) + ' SOL',
  price: (n) => Number(n || 0).toFixed(8),
  pct: (n) => (Number(n || 0) * 100).toFixed(2) + '%',
  ago(ts) {
    if (!ts) return '-';
    const diff = Math.max(0, Date.now() - Number(ts));
    const s = Math.floor(diff / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    return Math.floor(s / 3600) + 'h';
  },
  time(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('de-DE');
  },
  sql(ts) {
    if (!ts) return '-';
    return new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('de-DE');
  }
};

function setStatus(status) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const normalized = String(status || '').toLowerCase();
  dot.classList.remove('ok', 'bad');
  if (normalized.includes('running') || normalized.includes('connected')) dot.classList.add('ok');
  else if (normalized.includes('error') || normalized.includes('crash')) dot.classList.add('bad');
  text.textContent = status || 'unknown';
}

function renderPositions(positions) {
  const root = document.getElementById('positions');
  if (!positions.length) {
    root.innerHTML = '<div class="empty">Keine offenen Positionen</div>';
    return;
  }
  root.innerHTML = '<table><thead><tr><th>Symbol</th><th>Size</th><th>Entry</th><th>High</th><th>Uptime</th><th>Unrealized*</th><th>Mint</th></tr></thead><tbody>' +
    positions.map((p) => {
      const cls = p.unrealizedPct >= 0 ? 'good' : 'bad';
      return '<tr>' +
        '<td><strong>' + p.symbol + '</strong></td>' +
        '<td>' + fmt.sol(p.sizeSol) + '</td>' +
        '<td class="mono">' + fmt.price(p.entryPrice) + '</td>' +
        '<td class="mono">' + fmt.price(p.highestPriceSeen) + '</td>' +
        '<td>' + Math.max(0, p.holdMinutes).toFixed(1) + 'm</td>' +
        '<td class="' + cls + '">' + fmt.pct(p.unrealizedPct) + '</td>' +
        '<td class="mono">' + String(p.mint).slice(0, 8) + '…' + String(p.mint).slice(-6) + '</td>' +
      '</tr>';
    }).join('') + '</tbody></table><div class="event-meta" style="margin-top:10px;">*Unrealized basiert hier auf Entry → Highest Seen. Für exakte Mark-to-Market zählt der Bot intern mit Feed-Daten.</div>';
}


function sparkline(points) {
  const width = 160;
  const height = 52;
  if (!points || !points.length) return '<div class="tiny">kein Chart</div>';
  const vals = points.map((p) => Number(p.pctFromFirst || 0));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(0.0001, max - min);
  const path = vals.map((v, i) => {
    const x = (i / Math.max(1, vals.length - 1)) * width;
    const y = height - (((v - min) / span) * (height - 6) + 3);
    return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
  const last = vals[vals.length - 1] || 0;
  const stroke = last >= 0 ? 'var(--good)' : 'var(--bad)';
  return '<svg class="spark" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
    '<path d="' + path + '" fill="none" stroke="' + stroke + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>' +
    '</svg>';
}

function renderWatchlist(items) {
  const root = document.getElementById('watchlist');
  if (!root) return;
  if (!items || !items.length) {
    root.innerHTML = '<div class="empty">Aktuell keine Coins im Beobachtungsmodus</div>';
    return;
  }
  root.innerHTML = '<table><thead><tr><th>Symbol</th><th>Status</th><th>AI / Score</th><th>Setup</th><th>Chart %</th><th>Moves</th><th>Zuletzt</th></tr></thead><tbody>' +
    items.map((w) => {
      const pb = Number(w.pullbackFromLocalHighPct || 0);
      const ready = Boolean(w.readyToBuy);
      const label = ready ? 'READY' : (w.entryLabel || 'WATCH');
      const entryCls = ready ? 'good' : String(label).includes('LATE') ? 'warn' : 'good';
      return '<tr>' +
        '<td><strong>' + (w.symbol || 'PUMP') + '</strong><div class="event-meta mono">' + String(w.mint).slice(0, 8) + '…' + String(w.mint).slice(-6) + '</div></td>' +
        '<td><span class="badge ' + entryCls + '">' + label + '</span><div class="event-meta">' + (ready ? 'wird bei freien Limits gekauft' : 'wartet auf Bestätigung') + '</div></td>' +
        '<td>' + Number(w.aiScore || 0).toFixed(1) + '<div class="event-meta">Score ' + Number(w.score || 0).toFixed(1) + '</div></td>' +
        '<td>' + Number(w.seenCount || 0) + 'x • ' + Number(w.stableSeconds || 0) + 's<div class="event-meta">Pullback ' + fmt.pct(pb) + '</div></td>' +
        '<td>' + sparkline(w.chart || []) + '<div class="tiny">aktuell ' + fmt.price(w.currentPrice) + '</div></td>' +
        '<td><div class="good">5m ' + fmt.pct(w.change5mPct || 0) + '</div><div class="event-meta">15m ' + fmt.pct(w.change15mPct || 0) + ' • 1h ' + fmt.pct(w.change1hPct || 0) + '</div></td>' +
        '<td>' + fmt.sql(w.created_at) + '<div class="event-meta">' + (w.summary || '-') + '</div></td>' +
      '</tr>';
    }).join('') + '</tbody></table>';
}

function renderEvents(events) {
  const root = document.getElementById('events');
  if (!events.length) {
    root.innerHTML = '<div class="empty">Noch keine Events</div>';
    return;
  }
  root.innerHTML = events.slice(0, 12).map((e) => {
    const cls = e.level === 'success' ? 'good' : e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : '';
    const meta = e.meta && Object.keys(e.meta).length ? JSON.stringify(e.meta) : '';
    return '<div class="event">' +
      '<div class="event-head"><div class="event-type ' + cls + '">' + e.type + '</div><div class="event-type">' + fmt.sql(e.created_at) + '</div></div>' +
      '<div class="event-message">' + e.message + '</div>' +
      (meta ? '<div class="event-meta mono">' + meta + '</div>' : '') +
      '</div>';
  }).join('');
}



function renderAi(ai) {
  if (!document.getElementById('aiModeBadge')) return;
  document.getElementById('aiModeBadge').textContent = ai && ai.enabled ? 'AI ON' : 'AI OFF';
  document.getElementById('aiRegime').textContent = ai ? (ai.marketRegime || '-') : '-';
  document.getElementById('aiAvg').textContent = ai ? Number(ai.aiScoreAvg || 0).toFixed(1) : '-';
  document.getElementById('aiBest').textContent = ai ? Number(ai.aiScoreBest || 0).toFixed(1) : '-';
  document.getElementById('aiAllowReject').textContent = ai ? (Number(ai.allows || 0) + ' / ' + Number(ai.rejects || 0)) : '-';
  const root = document.getElementById('aiBreakdown');
  if (!ai) {
    root.innerHTML = '<div class="empty">Noch keine AI-Snapshots</div>';
    return;
  }
  root.innerHTML = '<div style="display:grid; gap:10px;">' +
    '<div class="badge" style="justify-content:space-between; width:100%;"><span>HIGH_CONFIDENCE</span><strong>' + Number(ai.highConfidence || 0) + '</strong></div>' +
    '<div class="badge warn" style="justify-content:space-between; width:100%;"><span>REDUCE_SIZE</span><strong>' + Number(ai.reduceSize || 0) + '</strong></div>' +
    '<div class="badge" style="justify-content:space-between; width:100%;"><span>Updated</span><strong>' + fmt.ago(ai.ts) + '</strong></div>' +
  '</div>';
}

function renderDecisionSummary(items) {
  const root = document.getElementById('decisionSummary');
  if (!items.length) {
    root.innerHTML = '<div class="empty">Noch keine Sniper- oder Trend-Entscheidungen</div>';
    return;
  }
  root.innerHTML = '<div style="display:grid; gap:10px;">' + items.slice(0, 8).map((item) => {
    const cls = String(item.action).includes('reject') || String(item.action).includes('guard') ? 'warn' : String(item.action).includes('loss') ? 'bad' : 'good';
    return '<div class="badge ' + cls + '" style="justify-content:space-between; width:100%;"><span>' + item.action + '</span><strong>' + item.count + '</strong></div>';
  }).join('') + '</div>';
}

function renderDecisions(items) {
  const root = document.getElementById('decisions');
  if (!items.length) {
    root.innerHTML = '<div class="empty">Noch keine Sniper- oder Trend-Entscheidungen</div>';
    return;
  }
  root.innerHTML = items.slice(0, 10).map((e) => {
    const cls = e.action === 'buy' || e.action === 'sell_win' ? 'good' : e.action === 'sell_loss' ? 'bad' : 'warn';
    const details = e.details && Object.keys(e.details).length ? JSON.stringify(e.details) : '';
    return '<div class="event">' +
      '<div class="event-head"><div class="event-type ' + cls + '">' + e.action + ' • ' + e.symbol + ' • score ' + Number(e.score || 0).toFixed(1) + '</div><div class="event-type">' + fmt.sql(e.created_at) + '</div></div>' +
      '<div class="event-message">' + (e.summary || '-') + '</div>' +
      (details ? '<div class="event-meta mono">' + details + '</div>' : '') +
      '</div>';
  }).join('');
}



function renderLearning(learning) {
  const phaseEl = document.getElementById('learningPhase');
  const confidenceEl = document.getElementById('learningConfidence');
  const windowEl = document.getElementById('learningWindow');
  const winrateEl = document.getElementById('learningWinrate');
  const avgEl = document.getElementById('learningAvg');
  const sizeEl = document.getElementById('learningSize');
  const aiBoostEl = document.getElementById('learningAiBoost');
  const summaryEl = document.getElementById('learningSummary');
  const lifetimeEl = document.getElementById('learningLifetime');
  const rulesEl = document.getElementById('learningRules');
  if (!phaseEl) return;
  if (!learning) {
    phaseEl.textContent = 'NO DATA';
    confidenceEl.textContent = '-';
    windowEl.textContent = '-';
    winrateEl.textContent = '-';
    avgEl.textContent = '-';
    sizeEl.textContent = '-';
    aiBoostEl.textContent = '-';
    summaryEl.textContent = 'Noch keine Learning-Daten im Runtime-State.';
    lifetimeEl.textContent = 'Sobald der Bot einige geschlossene Trades hat, wird hier die Lernphase angezeigt.';
    rulesEl.innerHTML = '<span class="badge warn">warmup</span>';
    return;
  }
  phaseEl.textContent = learning.phase || (learning.enabled ? 'ACTIVE' : 'DISABLED');
  confidenceEl.textContent = Number(learning.confidenceScore || 0).toFixed(0) + '/99';
  windowEl.textContent = String(learning.sampleSize ?? 0);
  winrateEl.textContent = fmt.pct(learning.recentWinRate || 0);
  avgEl.textContent = fmt.pct(learning.recentAvgPnlPct || 0);
  sizeEl.textContent = Number(learning.sizeMultiplier ?? 1).toFixed(2) + 'x';
  aiBoostEl.textContent = (Number(learning.minAiScoreBoost || 0) >= 0 ? '+' : '') + String(learning.minAiScoreBoost || 0);
  const watchlistLine = ' • watchlist ' + (learning.watchlistObserved ?? 0) + ' obs • ready ' + fmt.pct(learning.watchlistReadyRate || 0) + ' • q ' + Number(learning.watchlistQualityScore || 0).toFixed(0) + '/99' + ' • +close ' + fmt.pct(learning.watchlistPositiveCloseRate || 0) + ' • follow ' + fmt.pct(learning.watchlistFollowThroughRate || 0) + ' • avg move ' + fmt.pct(learning.watchlistAvgMovePct || 0) + ' • avg dd ' + fmt.pct(learning.watchlistAvgDrawdownPct || 0) + ' • fresh ' + String(learning.watchlistFreshSamples || 0);
  const universeLine = ' • universe ' + (learning.universeObserved ?? 0) + ' obs • ready ' + fmt.pct(learning.universeReadyRate || 0) + ' • +close ' + fmt.pct(learning.universePositiveCloseRate || 0) + ' • follow ' + fmt.pct(learning.universeFollowThroughRate || 0) + ' • avg move ' + fmt.pct(learning.universeAvgMovePct || 0) + ' • avg dd ' + fmt.pct(learning.universeAvgDrawdownPct || 0);
  summaryEl.textContent = (learning.summary || 'Learning aktiv') + ((learning.watchlistSummary && learning.watchlistObserved !== undefined) ? '' : '');
  lifetimeEl.textContent = 'Lifetime: ' + (learning.totalClosedTrades ?? 0) + ' closed • winrate ' + fmt.pct(learning.lifetimeWinRate || 0) + ' • avg ' + fmt.pct(learning.lifetimeAvgPnlPct || 0) + ' • loss streak ' + (learning.consecutiveLosses ?? 0) + watchlistLine + universeLine;
  const chips = [];
  chips.push('<span class="badge ' + (learning.enabled ? 'good' : 'warn') + '">' + (learning.enabled ? 'learning on' : 'learning off') + '</span>');
  chips.push('<span class="badge">phase ' + (learning.phase || 'n/a') + '</span>');
  chips.push('<span class="badge">watch q ' + Number(learning.watchlistQualityScore || 0).toFixed(0) + '/99</span>');
  if ((learning.watchlistObserved || 0) > 0) chips.push('<span class="badge good">watch obs ' + (learning.watchlistObserved || 0) + '</span>');
  if ((learning.universeObserved || 0) > 0) chips.push('<span class="badge good">universe ' + (learning.universeObserved || 0) + '</span>');
  if ((learning.watchlistFreshSamples || 0) > 0) chips.push('<span class="badge">fresh ' + (learning.watchlistFreshSamples || 0) + '</span>');
  if ((learning.watchlistPositiveCloseRate || 0) >= 0.55) chips.push('<span class="badge good">positive closes strong</span>');
  if ((learning.watchlistFollowThroughRate || 0) >= 0.45) chips.push('<span class="badge good">follow-through strong</span>');
  if ((learning.watchlistBias || 0) > 0.08) chips.push('<span class="badge good">watch bias risk on</span>');
  if ((learning.watchlistBias || 0) < -0.08) chips.push('<span class="badge warn">watch bias defensive</span>');
  if (learning.preferOnlyPreferredEntries) chips.push('<span class="badge warn">preferred only</span>');
  if (learning.avoidLateEntries) chips.push('<span class="badge warn">late entries blocked</span>');
  if (!learning.preferOnlyPreferredEntries && !learning.avoidLateEntries) chips.push('<span class="badge good">entries flexible</span>');
  if ((learning.sampleSize || 0) < 5) chips.push('<span class="badge">warmup sample</span>');
  rulesEl.innerHTML = chips.join('');
}

function renderWalletIntel(items) {
  const root = document.getElementById('walletIntel');
  if (!root) return;
  if (!items || !items.length) {
    root.innerHTML = '<div class="empty">Noch keine Wallet-Lerndaten</div>';
    return;
  }
  root.innerHTML = '<table><thead><tr><th>Wallet</th><th>Score</th><th>W/L</th><th>PnL</th></tr></thead><tbody>' +
    items.map((w) => '<tr>' +
      '<td class="mono">' + String(w.wallet).slice(0,6) + '…' + String(w.wallet).slice(-5) + '</td>' +
      '<td>' + Number(w.confidenceScore || 0).toFixed(1) + '</td>' +
      '<td>' + Number(w.wins || 0) + '/' + Number(w.losses || 0) + '</td>' +
      '<td class="' + (Number(w.totalPnlSol || 0) >= 0 ? 'good' : 'bad') + '">' + fmt.sol(w.totalPnlSol || 0) + '</td>' +
    '</tr>').join('') + '</tbody></table>';
}

function renderTrades(trades) {
  const rows = document.getElementById('tradeRows');
  if (!trades.length) {
    rows.innerHTML = '<tr><td colspan="9"><div class="empty">Noch keine Trades geloggt</div></td></tr>';
    return;
  }
  rows.innerHTML = trades.map((t) => {
    const pnlClass = Number(t.pnl_sol || 0) >= 0 ? 'good' : 'bad';
    return '<tr>' +
      '<td>' + fmt.sql(t.created_at) + '</td>' +
      '<td><strong>' + t.side + '</strong></td>' +
      '<td>' + t.symbol + '</td>' +
      '<td>' + fmt.sol(t.size_sol) + '</td>' +
      '<td class="mono">' + fmt.price(t.entry_price) + '</td>' +
      '<td class="mono">' + fmt.price(t.exit_price) + '</td>' +
      '<td class="' + pnlClass + '">' + fmt.sol(t.pnl_sol) + ' / ' + t.pnl_pct_label + '</td>' +
      '<td>' + (t.reason || '-') + '</td>' +
      '<td class="mono">' + (t.txid ? String(t.txid).slice(0, 8) + '…' : '-') + '</td>' +
    '</tr>';
  }).join('');
}

function drawChart(points) {
  const canvas = document.getElementById('equityChart');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!points.length) return;

  const values = points.map((p) => Number(p.total_equity_sol || 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 28;
  const w = canvas.width - pad * 2;
  const h = canvas.height - pad * 2;

  ctx.strokeStyle = 'rgba(148,163,184,.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = pad + (h / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(canvas.width - pad, y);
    ctx.stroke();
  }

  const gradient = ctx.createLinearGradient(0, pad, 0, canvas.height - pad);
  gradient.addColorStop(0, 'rgba(83,224,255,.35)');
  gradient.addColorStop(1, 'rgba(83,224,255,0)');

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad + (i / Math.max(values.length - 1, 1)) * w;
    const y = pad + h - ((v - min) / Math.max(max - min, 1e-9)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(canvas.width - pad, canvas.height - pad);
  ctx.lineTo(pad, canvas.height - pad);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.strokeStyle = '#53e0ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad + (i / Math.max(values.length - 1, 1)) * w;
    const y = pad + h - ((v - min) / Math.max(max - min, 1e-9)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const last = values[values.length - 1];
  ctx.fillStyle = '#e5eefc';
  ctx.font = '12px sans-serif';
  ctx.fillText('High ' + max.toFixed(4) + ' SOL', pad, pad - 8);
  ctx.fillText('Last ' + last.toFixed(4) + ' SOL', canvas.width - pad - 120, pad - 8);
}


async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'sizeMultiplier') {
    document.getElementById('sizeMultiplierValue').textContent = Number(e.target.value || 1).toFixed(2) + 'x';
  }
});

document.addEventListener('click', async (e) => {
  const abortBtn = e.target.closest('[data-abort-mint]');
  if (abortBtn) {
    await fetch('/api/control/abort/' + abortBtn.getAttribute('data-abort-mint'), { method: 'POST' });
    load();
    return;
  }
  if (e.target && e.target.id === 'saveControlsBtn') {
    await postJson('/api/control', {
      killSwitch: document.getElementById('killSwitch').checked,
      sizeMultiplier: Number(document.getElementById('sizeMultiplier').value || 1),
      maxPositionsOverride: document.getElementById('maxPositionsOverride').value ? Number(document.getElementById('maxPositionsOverride').value) : null,
    });
    load();
    return;
  }
  if (e.target && e.target.id === 'abortAllBtn') {
    await postJson('/api/control', { abortAll: true });
    load();
  }
});

async function load() {
  try {
  const res = await fetch('/api/state');
  const data = await res.json();

  setStatus(data.health.status);
  document.getElementById('equity').textContent = fmt.sol(data.stats.totalEquitySol);
  document.getElementById('equitySub').textContent = 'Open Value ' + fmt.sol(data.stats.openPositionsValueSol);
  document.getElementById('wallet').textContent = fmt.sol(data.stats.walletSol);
  document.getElementById('realized').textContent = fmt.sol(data.stats.realizedPnlSol);
  const closedTrades = Math.max(0, Number(data.stats.wins || 0) + Number(data.stats.losses || 0));
  const winrate = closedTrades ? ((Number(data.stats.wins || 0) / closedTrades) * 100).toFixed(1) + '%' : '-';
  document.getElementById('winrate').textContent = 'Winrate ' + winrate + ' • Closed ' + closedTrades;
  document.getElementById('positionsCount').textContent = String(data.stats.openPositions);
  document.getElementById('watchCount').textContent = 'Watched Mints ' + data.stats.watchedMints;
  document.getElementById('modeBadge').textContent = data.config.mode + ' • ' + data.config.pairs.join(', ');

  document.getElementById('healthStatus').textContent = data.health.status || '-';
  document.getElementById('lastLoop').textContent = fmt.ago(data.health.lastLoopAt) + ' ago';
  document.getElementById('lastFeed').textContent = fmt.ago(data.health.lastFeedAt) + ' ago';
  document.getElementById('lastBuy').textContent = fmt.ago(data.health.lastBuyAt) + ' ago';
  document.getElementById('lastSell').textContent = fmt.ago(data.health.lastSellAt) + ' ago';
  document.getElementById('pairs').textContent = data.config.pairs.join(', ');

  document.getElementById('pipeReject').textContent = String(data.pipeline?.stage1Rejected ?? 0);
  document.getElementById('pipeWatch').textContent = String(data.pipeline?.stage2Watching ?? 0);
  document.getElementById('pipeReady').textContent = String(data.pipeline?.stage3Ready ?? 0);
  document.getElementById('pipeCooldown').textContent = String(data.pipeline?.stage3Cooldown ?? 0);
  document.getElementById('killSwitch').checked = Boolean(data.controls?.killSwitch);
  document.getElementById('sizeMultiplier').value = String(data.controls?.sizeMultiplier ?? 1);
  document.getElementById('sizeMultiplierValue').textContent = Number(data.controls?.sizeMultiplier ?? 1).toFixed(2) + 'x';
  document.getElementById('maxPositionsOverride').value = data.controls?.maxPositionsOverride == null ? '' : String(data.controls.maxPositionsOverride);
  document.getElementById('controlStateText').textContent = 'Updated ' + fmt.ago(data.controls?.updatedAt || 0) + ' ago';
  renderAi(data.ai || null);
  renderLearning(data.learning || data.health?.details?.learning || null);
  renderWalletIntel(data.walletIntel || []);
  renderWatchlist(data.activeWatchlist || []);
  renderPositions(data.positions || []);
  renderEvents(data.events || []);
  renderDecisionSummary(data.decisionSummary || []);
  renderDecisions(data.decisions || []);
  renderTrades(data.trades || []);
  drawChart(data.snapshots || []);
  } catch (err) { console.error(err); }
}

load();
setInterval(load, 1000);
</script>
</body>
</html>`)
})

app.listen(config.port, "0.0.0.0", () => {
    console.log(`Dashboard läuft auf http://localhost:${config.port}`)
})
