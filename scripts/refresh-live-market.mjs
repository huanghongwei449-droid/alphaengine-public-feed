import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const USER_AGENT = "AlphaEngine-Public-Feed/1.0";
const indexCodes = ["sh000001", "sz399001", "sz399006", "sh000688", "sh000300"];
const indexNames = { "000001": "上证指数", "399001": "深证成指", "399006": "创业板指", "000688": "科创50", "000300": "沪深300" };
const eastmoneyHeaders = { "user-agent": USER_AGENT, referer: "https://quote.eastmoney.com/", accept: "application/json,text/plain,*/*" };

async function quote(symbol) {
  const response = await fetch(`https://qt.gtimg.cn/q=${symbol}`, { headers: { "user-agent": USER_AGENT, referer: "https://gu.qq.com/" } });
  const text = await response.text();
  const match = text.match(/=\"([\s\S]*)\";?\s*$/);
  if (!response.ok || !match) throw new Error(`quote ${symbol} unavailable`);
  const parts = match[1].split("~");
  const code = symbol.slice(2);
  const close = Number(parts[3]);
  const previousClose = Number(parts[4]);
  return {
    code,
    name: indexNames[code] || code,
    close: Number.isFinite(close) ? close : null,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    dailyPct: Number.isFinite(close) && Number.isFinite(previousClose) && previousClose ? Number(((close / previousClose - 1) * 100).toFixed(2)) : null,
    high: Number(parts[33]) || null,
    low: Number(parts[34]) || null,
    asOfDate: parts[30] ? `${parts[30].slice(0, 4)}-${parts[30].slice(4, 6)}-${parts[30].slice(6, 8)}` : "",
    source: "腾讯 qt.gtimg.cn",
  };
}

async function eastmoneyPage(params) {
  const response = await fetch(`https://push2.eastmoney.com/api/qt/clist/get?${new URLSearchParams(params)}`, { headers: eastmoneyHeaders });
  if (!response.ok) throw new Error(`eastmoney HTTP ${response.status}`);
  return response.json();
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function marketSummary() {
  const base = { pz: "200", po: "1", np: "1", ut: "bd1d9ddb04089700cf9c27f6f7426281", fltt: "2", invt: "2", fid: "f62", fs: "m:0+t:6,m:0+t:80,m:1+t:2", fields: "f12,f14,f2,f3,f5,f6,f62" };
  const first = await eastmoneyPage({ ...base, pn: "1" });
  const total = Number(first?.data?.total || 0);
  const raw = [...(first?.data?.diff || [])];
  for (let pn = 2; pn <= Math.min(30, Math.ceil(total / 200)); pn += 1) {
    await sleep(120);
    raw.push(...((await eastmoneyPage({ ...base, pn: String(pn) }))?.data?.diff || []));
  }
  const rows = raw.map((item) => ({ pctChange: Number(item.f3), amount: Number(item.f6), mainNet: Number(item.f62) })).filter((item) => Number.isFinite(item.amount));
  if (!rows.length) throw new Error("market rows unavailable");
  return {
    turnoverBillion: Number((rows.reduce((sum, item) => sum + item.amount, 0) / 1e8).toFixed(2)),
    mainFundBillion: Number((rows.reduce((sum, item) => sum + (Number.isFinite(item.mainNet) ? item.mainNet : 0), 0) / 1e8).toFixed(2)),
    risingCount: rows.filter((item) => item.pctChange > 0).length,
    fallingCount: rows.filter((item) => item.pctChange < 0).length,
    limitUpCount: rows.filter((item) => item.pctChange >= 9.8).length,
    limitDownCount: rows.filter((item) => item.pctChange <= -9.8).length,
    rows: rows.length,
    total,
    complete: Boolean(total && rows.length >= total),
    source: "东方财富 push2 clist 全市场公开行情",
  };
}

async function boardSummary(boardType) {
  const params = { pn: "1", pz: "200", po: "1", np: "1", ut: "bd1d9ddb04089700cf9c27f6f7426281", fltt: "2", invt: "2", fid: "f62", fs: boardType === "concept" ? "m:90+t:3" : "m:90+t:2", fields: "f12,f14,f3,f62,f184,f104,f105,f106" };
  const data = await eastmoneyPage(params);
  return (data?.data?.diff || []).map((item) => ({ code: item.f12 || "", name: item.f14 || "", pctChange: Number(item.f3), mainNetBillion: Number((Number(item.f62) / 1e8).toFixed(2)), mainPct: Number(item.f184), advanceCount: Number(item.f104), declineCount: Number(item.f105) })).filter((item) => item.name && Number.isFinite(item.mainNetBillion));
}

const results = await Promise.all(indexCodes.map(async (symbol) => {
  try { return { ok: true, value: await quote(symbol) }; }
  catch (error) { return { ok: false, symbol, error: String(error) }; }
}));
const marketResult = await marketSummary().then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error) }));
const industryResult = await boardSummary("industry").then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error) }));
const conceptResult = await boardSummary("concept").then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error) }));
const indexStatus = Object.fromEntries(results.map((item) => [item.ok ? item.value.code : item.symbol, item.ok ? { status: "ok", source: item.value.source } : { status: "failed", error: item.error }]));
const payload = {
  schemaVersion: "alphaengine-public-market-live-v2",
  publicSafe: true,
  fetchedAt: new Date().toISOString(),
  asOfDate: results.find((item) => item.ok)?.value.asOfDate || "",
  sourceStatus: {
    ...indexStatus,
    market: marketResult.ok ? { status: marketResult.value.complete ? "ok" : "partial", source: marketResult.value.source } : { status: "failed", error: marketResult.error },
    industry: industryResult.ok ? { status: "ok", source: "东方财富公开板块资金" } : { status: "failed", error: industryResult.error },
    concept: conceptResult.ok ? { status: "ok", source: "东方财富公开板块资金" } : { status: "failed", error: conceptResult.error },
  },
  indices: results.filter((item) => item.ok).map((item) => item.value),
  market: marketResult.ok && marketResult.value.complete ? marketResult.value : null,
  sectorFlows: { date: results.find((item) => item.ok)?.value.asOfDate || "", industry: industryResult.ok ? industryResult.value.slice(0, 10) : [], concept: conceptResult.ok ? conceptResult.value.slice(0, 10) : [], source: industryResult.ok || conceptResult.ok ? "东方财富公开板块资金" : "" },
  note: "GitHub 公开 Feed 保存公开市场快照；公司查询会在应用运行时按代码在线补抓更新。",
};
const target = path.join(root, "data", "live-market.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const manifestFile = path.join(root, "feed-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const buffer = fs.readFileSync(target);
const entry = { path: "data/live-market.json", bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
manifest.files = [...(manifest.files || []).filter((item) => item.path !== entry.path), entry];
manifest.generatedAt = payload.fetchedAt;
manifest.asOfDate = payload.asOfDate || manifest.asOfDate;
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ fetchedAt: payload.fetchedAt, asOfDate: payload.asOfDate, indices: payload.indices.length }, null, 2));
