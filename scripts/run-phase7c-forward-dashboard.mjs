import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { dedupeAutoDecisions, eventTimeMs } from "./phase7c-forward-report-utils.mjs";

const host = (process.env.ZIQ_PHASE7C_DASHBOARD_HOST || "127.0.0.1").trim();
const port = clampInt(process.env.ZIQ_PHASE7C_DASHBOARD_PORT, 5727, 1, 65535);
const workDir = path.resolve(process.env.ZIQ_PHASE7C_DASHBOARD_WORK_DIR || ".runtime");
const controlApi = (process.env.ZIQ_PHASE7C_CONTROL_API_URL || "http://127.0.0.1:3711").trim().replace(/\/$/, "");
const refreshMs = clampInt(process.env.ZIQ_PHASE7C_DASHBOARD_REFRESH_MS, 15_000, 5_000, 300_000);
const reportDir = path.join(workDir, "phase7c-reports");
const decisionPath = path.join(workDir, "phase7c-executors", "auto-decisions.jsonl");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

if (!loopbackHosts.has(host.toLowerCase())) {
  throw new Error(`Phase7C forward dashboard is loopback-only; refused host=${host}`);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "READ_ONLY_GET_ONLY" });
      return;
    }

    if (url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        readOnly: true,
        mt5Mutation: false,
        workDir,
        reportAvailable: Boolean(findLatestReport()),
      });
      return;
    }

    if (url.pathname === "/api/dashboard") {
      sendJson(response, 200, await buildDashboardSnapshot());
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendHtml(response, dashboardHtml());
      return;
    }

    sendJson(response, 404, { error: "NOT_FOUND" });
  } catch (error) {
    sendJson(response, 500, { error: errorMessage(error) });
  }
});

server.listen(port, host, () => {
  console.log("PHASE7C_FORWARD_DASHBOARD=RUNNING");
  console.log(`PHASE7C_FORWARD_DASHBOARD_URL=http://${host}:${port}/`);
  console.log(`PHASE7C_FORWARD_DASHBOARD_WORK_DIR=${workDir}`);
  console.log(`PHASE7C_FORWARD_DASHBOARD_CONTROL_API=${controlApi}`);
  console.log("PHASE7C_FORWARD_DASHBOARD_READ_ONLY=TRUE");
  console.log("PHASE7C_FORWARD_DASHBOARD_MT5_MUTATION=NONE");
});

async function buildDashboardSnapshot() {
  const reportFile = findLatestReport();
  const report = reportFile ? readJson(reportFile) : null;
  const recentDecisions = readRecentDecisions(12);
  let live = null;
  let liveError = null;
  try {
    const [modeResponse, regimeResponse] = await Promise.all([
      apiGet("/api/v1/phase7c/bot-mode", 5_000),
      apiGet("/api/v1/phase7c/live-regime?symbol=XAUUSD&count=320", 10_000),
    ]);
    live = {
      mode: modeResponse?.state?.mode ?? null,
      modeUpdatedAt: modeResponse?.state?.updatedAt ?? null,
      modeUpdatedBy: modeResponse?.state?.updatedBy ?? null,
      regime: regimeResponse?.regime ?? null,
      recommendedMode: regimeResponse?.recommendedMode ?? null,
      confidence: finiteNumber(regimeResponse?.confidence),
      modeMatchesRecommendation: regimeResponse?.modeMatchesRecommendation ?? null,
      metrics: regimeResponse?.metrics ?? null,
      supplyDemandRange: regimeResponse?.supplyDemandRange ?? null,
      lastCandleCloseTime: finiteNumber(regimeResponse?.lastCandleCloseTime),
    };
  } catch (error) {
    liveError = errorMessage(error);
  }

  return {
    generatedAt: Date.now(),
    generatedAtIso: new Date().toISOString(),
    readOnly: true,
    mt5Mutation: false,
    refreshMs,
    reportFile,
    report,
    live,
    liveError,
    recentDecisions,
  };
}

function findLatestReport() {
  if (!fs.existsSync(reportDir)) return null;
  const files = fs.readdirSync(reportDir)
    .filter((name) => /^phase7c-forward-.*\.json$/i.test(name))
    .map((name) => {
      const fullPath = path.join(reportDir, name);
      const stats = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.fullPath ?? null;
}

function readRecentDecisions(limit) {
  if (!fs.existsSync(decisionPath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(decisionPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row?.type === "AUTO_DECISION") rows.push(row);
    } catch {}
  }
  return dedupeAutoDecisions(rows)
    .sort((a, b) => (eventTimeMs(b) ?? 0) - (eventTimeMs(a) ?? 0))
    .slice(0, limit);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function apiGet(endpoint, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${controlApi}${endpoint}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Control API ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  response.end(html);
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>XAUUSD Phase7C Forward DEMO</title>
<style>
:root{color-scheme:dark;--bg:#07111f;--panel:#0d1b2b;--line:#203247;--text:#e7edf5;--muted:#8fa3b8;--ok:#48d597;--warn:#f2bf59;--bad:#ff6b7d;--accent:#67a8ff}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#07111f,#091522 45%,#07111f);color:var(--text);font-family:Inter,Segoe UI,Arial,sans-serif}.wrap{max-width:1440px;margin:auto;padding:20px}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:16px}.title h1{margin:0;font-size:26px}.sub{color:var(--muted);margin-top:6px;font-size:13px}.badge{padding:8px 12px;border:1px solid #2f644d;background:#0d2a20;border-radius:999px;color:var(--ok);font-weight:700;font-size:12px;white-space:nowrap}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}.card{background:rgba(13,27,43,.94);border:1px solid var(--line);border-radius:14px;padding:14px;min-width:0}.span3{grid-column:span 3}.span4{grid-column:span 4}.span6{grid-column:span 6}.span8{grid-column:span 8}.span12{grid-column:span 12}.label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.value{font-size:28px;font-weight:800;margin-top:7px}.small{font-size:13px;color:var(--muted);margin-top:5px}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.accent{color:var(--accent)}h2{font-size:16px;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 7px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}.kv{display:grid;grid-template-columns:1fr auto;gap:8px;border-bottom:1px solid var(--line);padding:7px 0}.kv:last-child{border:0}.mono{font-family:Consolas,monospace;font-size:12px}.empty{color:var(--muted);padding:10px 0}.footer{color:var(--muted);font-size:12px;margin:16px 0 4px}.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);margin-right:6px}.error{border-color:#6c2733;background:#25131a;color:#ffb2bc;padding:10px;border-radius:10px;margin-bottom:12px;display:none}@media(max-width:980px){.span3,.span4{grid-column:span 6}.span6,.span8{grid-column:span 12}}@media(max-width:620px){.wrap{padding:12px}.span3,.span4,.span6,.span8,.span12{grid-column:span 12}.top{display:block}.badge{display:inline-block;margin-top:10px}.value{font-size:24px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="title"><h1>XAUUSD AI MASTER · Phase7C Forward DEMO</h1><div class="sub">Dashboard chỉ đọc · không gửi lệnh MT5 · tự làm mới dữ liệu</div></div><div class="badge">🔒 DEMO · READ ONLY</div></div>
  <div id="error" class="error"></div>
  <div class="grid">
    <div class="card span3"><div class="label">Active mode</div><div id="mode" class="value accent">—</div><div id="modeNote" class="small">—</div></div>
    <div class="card span3"><div class="label">Market regime</div><div id="regime" class="value">—</div><div id="confidence" class="small">—</div></div>
    <div class="card span3"><div class="label">Recommended</div><div id="recommended" class="value">—</div><div id="gate" class="small">—</div></div>
    <div class="card span3"><div class="label">Forward total P/L</div><div id="totalPnl" class="value">0</div><div class="small">Chỉ position mở sau baseline</div></div>

    <div class="card span6"><h2>Trend Forward</h2><div class="grid"><div class="span4"><div class="label">Net P/L</div><div id="trendPnl" class="value">0</div></div><div class="span4"><div class="label">Closed trades</div><div id="trendTrades" class="value">0</div></div><div class="span4"><div class="label">Win rate</div><div id="trendWinRate" class="value">0%</div></div></div><div id="trendMgmt" class="small"></div></div>
    <div class="card span6"><h2>Sideway Forward</h2><div class="grid"><div class="span4"><div class="label">Net P/L</div><div id="sidewayPnl" class="value">0</div></div><div class="span4"><div class="label">Closed trades</div><div id="sidewayTrades" class="value">0</div></div><div class="span4"><div class="label">Win rate</div><div id="sidewayWinRate" class="value">0%</div></div></div><div id="sidewayMgmt" class="small"></div></div>

    <div class="card span4"><h2>Monitoring</h2><div id="monitoring"></div></div>
    <div class="card span4"><h2>Regime observations</h2><div id="regimes"></div></div>
    <div class="card span4"><h2>Raw broker diagnostic</h2><div id="raw"></div></div>

    <div class="card span6"><h2>Trend block reasons</h2><div id="trendBlocks"></div></div>
    <div class="card span6"><h2>Sideway block reasons</h2><div id="sidewayBlocks"></div></div>

    <div class="card span12"><h2>Recent closed monitored trades</h2><div id="closedTrades"></div></div>
    <div class="card span12"><h2>Recent AUTO decisions</h2><div id="decisions"></div></div>
  </div>
  <div id="footer" class="footer"></div>
</div>
<script>
const money = new Intl.NumberFormat('en-US',{maximumFractionDigits:2,minimumFractionDigits:0});
function el(id){return document.getElementById(id)}
function pnlClass(value){return value>0?'ok':value<0?'bad':''}
function setPnl(id,value){const node=el(id);const n=Number(value||0);node.textContent=money.format(n);node.className='value '+pnlClass(n)}
function kv(target,key,value){const row=document.createElement('div');row.className='kv';const a=document.createElement('span');a.textContent=key;const b=document.createElement('strong');b.textContent=String(value);row.append(a,b);target.append(row)}
function renderObject(targetId,obj){const target=el(targetId);target.replaceChildren();const entries=Object.entries(obj||{});if(!entries.length){target.innerHTML='<div class="empty">None</div>';return}for(const [k,v] of entries)kv(target,k,v)}
function text(value,fallback='—'){return value===null||value===undefined||value===''?fallback:String(value)}
function fmtTime(value){if(!value)return '—';const d=new Date(value);return Number.isNaN(d.valueOf())?String(value):d.toLocaleString()}
function table(targetId,headers,rows){const target=el(targetId);target.replaceChildren();if(!rows.length){target.innerHTML='<div class="empty">Chưa có dữ liệu</div>';return}const t=document.createElement('table');const thead=document.createElement('thead');const trh=document.createElement('tr');headers.forEach(h=>{const th=document.createElement('th');th.textContent=h;trh.append(th)});thead.append(trh);t.append(thead);const tb=document.createElement('tbody');rows.forEach(row=>{const tr=document.createElement('tr');row.forEach(v=>{const td=document.createElement('td');td.textContent=text(v,'');tr.append(td)});tb.append(tr)});t.append(tb);target.append(t)}
async function refresh(){try{const r=await fetch('/api/dashboard',{cache:'no-store'});const data=await r.json();if(!r.ok)throw new Error(data.error||'Dashboard API error');render(data)}catch(err){const box=el('error');box.style.display='block';box.textContent=String(err.message||err)}}
function render(data){el('error').style.display=data.liveError?'block':'none';el('error').textContent=data.liveError?'Live API: '+data.liveError:'';const live=data.live||{};const report=data.report||{};const broker=report.brokerDeals||{};const monitored=broker.summary||{};const trend=monitored.TREND||{};const sideway=monitored.SIDEWAY||{};const closed=report.closedTradePerformance||{};const ct=closed.TREND||{};const cs=closed.SIDEWAY||{};const mg=report.management||{};
  el('mode').textContent=text(live.mode);el('modeNote').textContent='Updated by: '+text(live.modeUpdatedBy,'n/a');
  el('regime').textContent=text(live.regime);el('confidence').textContent='Confidence: '+text(live.confidence,'n/a')+'%';
  el('recommended').textContent=text(live.recommendedMode);el('gate').textContent=live.regime==='UNCERTAIN'||live.regime==='REVERSAL'?'Entry gate: PAUSE':'Regime-directed execution';
  setPnl('trendPnl',trend.netPnl);setPnl('sidewayPnl',sideway.netPnl);setPnl('totalPnl',Number(trend.netPnl||0)+Number(sideway.netPnl||0));
  el('trendTrades').textContent=text(ct.trades,0);el('trendWinRate').textContent=text(ct.winRate,0)+'%';el('sidewayTrades').textContent=text(cs.trades,0);el('sidewayWinRate').textContent=text(cs.winRate,0)+'%';
  el('trendMgmt').textContent='W '+text(ct.wins,0)+' · L '+text(ct.losses,0)+' · BE '+text(ct.breakeven,0)+' · Entry '+text(mg.TREND?.entriesFilled,0)+' · BE move '+text(mg.TREND?.breakEvenApplied,0)+' · Partial '+text(mg.TREND?.partialsFilled,0);
  el('sidewayMgmt').textContent='W '+text(cs.wins,0)+' · L '+text(cs.losses,0)+' · BE '+text(cs.breakeven,0)+' · Entry '+text(mg.SIDEWAY?.entriesFilled,0)+' · BE move '+text(mg.SIDEWAY?.breakEvenApplied,0)+' · TP1 partial '+text(mg.SIDEWAY?.tp1PartialsFilled,0);
  const mon=el('monitoring');mon.replaceChildren();kv(mon,'Status',text(report.monitoring?.status));kv(mon,'Baseline',fmtTime(report.monitoring?.baselineIso));kv(mon,'Report generated',fmtTime(report.generatedAtIso));kv(mon,'AUTO decisions',text(report.monitoring?.deduplicatedDecisionRowsInMonitoredWindow,0)+' / raw '+text(report.monitoring?.rawDecisionRowsInWindow,0));
  renderObject('regimes',report.regimeDistribution?.regime);
  const raw=el('raw');raw.replaceChildren();const rw=broker.rawWindowSummary||{};kv(raw,'Trend raw P/L',text(rw.TREND?.netPnl,0));kv(raw,'Sideway raw P/L',text(rw.SIDEWAY?.netPnl,0));kv(raw,'Purpose','Reconciliation only');
  renderObject('trendBlocks',report.blockedReasons?.TREND);renderObject('sidewayBlocks',report.blockedReasons?.SIDEWAY);
  table('closedTrades',['Closed','Strategy','Position','Volume','Net P/L'],(closed.rows||[]).slice(0,20).map(x=>[fmtTime(x.closedAtIso),x.strategy,x.positionId,x.openedVolume,x.netPnl]));
  table('decisions',['Time','Active','Regime','Recommended','Confidence','Reasons'],(data.recentDecisions||[]).map(x=>[fmtTime(x.timestampIso||x.timestamp),x.activeMode,x.regime,x.recommendedMode,x.confidence,(x.reasons||[]).join(', ')]));
  el('footer').textContent='Dashboard snapshot '+fmtTime(data.generatedAtIso)+' · report '+text(data.reportFile,'none')+' · refresh '+Math.round((data.refreshMs||15000)/1000)+'s';
}
refresh();setInterval(refresh,${refreshMs});
</script>
</body>
</html>`;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
