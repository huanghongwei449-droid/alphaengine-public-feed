import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const USER_AGENT = "AlphaEngine-Public-Feed/1.0";
export const MARKET_PAGE_SIZE = 200;
export const MAX_MARKET_PAGES = 30;
const indexCodes = ["sh000001", "sz399001", "sz399006", "sh000688", "sh000300"];
const indexNames = { "000001": "上证指数", "399001": "深证成指", "399006": "创业板指", "000688": "科创50", "000300": "沪深300" };
const eastmoneyHeaders = { "user-agent": USER_AGENT, referer: "https://quote.eastmoney.com/", accept: "application/json,text/plain,*/*" };

function numeric(value) {
  if (value === null || value === undefined || String(value).trim() === "") return Number.NaN;
  return Number(value);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function quote(symbol) {
  const response = await fetchWithTimeout(`https://qt.gtimg.cn/q=${symbol}`, { headers: { "user-agent": USER_AGENT, referer: "https://gu.qq.com/" } });
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

export async function eastmoneyPage(params) {
  const response = await fetchWithTimeout(`https://push2.eastmoney.com/api/qt/clist/get?${new URLSearchParams(params)}`, { headers: eastmoneyHeaders });
  if (!response.ok) throw new Error(`eastmoney HTTP ${response.status}`);
  return response.json();
}

export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function collectMarketSummary({ page = eastmoneyPage, sleepFn = sleep, maxPages = MAX_MARKET_PAGES } = {}) {
  const base = { pz: String(MARKET_PAGE_SIZE), po: "1", np: "1", ut: "bd1d9ddb04089700cf9c27f6f7426281", fltt: "2", invt: "2", fid: "f62", fs: "m:0+t:6,m:0+t:80,m:1+t:2", fields: "f12,f14,f2,f3,f5,f6,f62" };
  const first = await page({ ...base, pn: "1" });
  const total = Number(first?.data?.total || 0);
  const expectedPages = total > 0 ? Math.ceil(total / MARKET_PAGE_SIZE) : 0;
  const pagesToFetch = Math.min(expectedPages, maxPages);
  let raw = [...(first?.data?.diff || [])];
  let fetchedPages = 1;
  const pageErrors = [];
  for (let pn = 2; pn <= pagesToFetch; pn += 1) {
    await sleepFn(120);
    try {
      const response = await page({ ...base, pn: String(pn) });
      raw.push(...(response?.data?.diff || []));
      fetchedPages += 1;
    } catch (error) {
      pageErrors.push({ page: pn, error: String(error).slice(0, 160) });
    }
  }
  const unique = new Map();
  raw.forEach((item, index) => {
    const code = String(item?.f12 || `row-${index}`);
    if (!unique.has(code)) unique.set(code, item);
  });
  const rows = [...unique.values()].map((item) => ({ pctChange: numeric(item.f3), amount: numeric(item.f6), mainNet: numeric(item.f62) }));
  const usableRows = rows.filter((item) => Number.isFinite(item.amount));
  if (!usableRows.length) throw new Error("market rows unavailable");
  const missingFieldRows = rows.length - usableRows.length;
  const missingRows = Math.max(total - usableRows.length, 0);
  const coverageRatio = total > 0 ? Number(Math.min(usableRows.length / total, 1).toFixed(4)) : 0;
  const coverage = {
    total,
    rawRows: raw.length,
    uniqueRows: rows.length,
    usableRows: usableRows.length,
    missingRows,
    missingFieldRows,
    coverageRatio,
    pagination: {
      pageSize: MARKET_PAGE_SIZE,
      expectedPages,
      maxPages,
      fetchedPages,
      pagesWithErrors: pageErrors.map((item) => item.page),
      capped: expectedPages > maxPages,
    },
    pageErrors,
  };
  return {
    turnoverBillion: Number((usableRows.reduce((sum, item) => sum + item.amount, 0) / 1e8).toFixed(2)),
    mainFundBillion: Number((usableRows.reduce((sum, item) => sum + (Number.isFinite(item.mainNet) ? item.mainNet : 0), 0) / 1e8).toFixed(2)),
    risingCount: usableRows.filter((item) => item.pctChange > 0).length,
    fallingCount: usableRows.filter((item) => item.pctChange < 0).length,
    limitUpCount: usableRows.filter((item) => item.pctChange >= 9.8).length,
    limitDownCount: usableRows.filter((item) => item.pctChange <= -9.8).length,
    rows: usableRows.length,
    total,
    complete: Boolean(total && usableRows.length >= total && fetchedPages === expectedPages && pageErrors.length === 0),
    coverage,
    source: "东方财富 push2 clist 全市场公开行情",
  };
}

export async function boardSummary(boardType, { page = eastmoneyPage } = {}) {
  const params = { pn: "1", pz: "200", po: "1", np: "1", ut: "bd1d9ddb04089700cf9c27f6f7426281", fltt: "2", invt: "2", fid: "f62", fs: boardType === "concept" ? "m:90+t:3" : "m:90+t:2", fields: "f12,f14,f3,f62,f184,f104,f105,f106" };
  const data = await page(params);
  return (data?.data?.diff || []).map((item) => ({ code: item.f12 || "", name: item.f14 || "", pctChange: Number(item.f3), mainNetBillion: Number((Number(item.f62) / 1e8).toFixed(2)), mainPct: Number(item.f184), advanceCount: Number(item.f104), declineCount: Number(item.f105) })).filter((item) => item.name && Number.isFinite(item.mainNetBillion));
}

export async function buildLiveMarketPayload({ page = eastmoneyPage, quoteFn = quote, boardFn = boardSummary, sleepFn = sleep, now = () => new Date() } = {}) {
  const results = await Promise.all(indexCodes.map(async (symbol) => {
    try { return { ok: true, value: await quoteFn(symbol) }; }
    catch (error) { return { ok: false, symbol, error: String(error).slice(0, 160) }; }
  }));
  const marketResult = collectMarketSummary({ page, sleepFn }).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error).slice(0, 160) }));
  const industryResult = boardFn("industry", { page }).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error).slice(0, 160) }));
  const conceptResult = boardFn("concept", { page }).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: String(error).slice(0, 160) }));
  const [market, industry, concept] = await Promise.all([marketResult, industryResult, conceptResult]);
  const indexStatus = Object.fromEntries(results.map((item) => [item.ok ? item.value.code : item.symbol, item.ok ? { status: "ok", source: item.value.source } : { status: "failed", error: item.error }]));
  const fetchedAt = new Date(typeof now === "function" ? now() : now).toISOString();
  return {
    schemaVersion: "alphaengine-public-market-live-v2",
    publicSafe: true,
    fetchedAt,
    asOfDate: results.find((item) => item.ok)?.value.asOfDate || "",
    sourceStatus: {
      ...indexStatus,
      market: market.ok ? { status: market.value.complete ? "ok" : "partial", source: market.value.source, coverage: market.value.coverage } : { status: "failed", error: market.error },
      industry: industry.ok ? { status: "ok", source: "东方财富公开板块资金" } : { status: "failed", error: industry.error },
      concept: concept.ok ? { status: "ok", source: "东方财富公开板块资金" } : { status: "failed", error: concept.error },
    },
    indices: results.filter((item) => item.ok).map((item) => item.value),
    market: market.ok ? market.value : null,
    sectorFlows: { date: results.find((item) => item.ok)?.value.asOfDate || "", industry: industry.ok ? industry.value.slice(0, 10) : [], concept: concept.ok ? concept.value.slice(0, 10) : [], source: industry.ok || concept.ok ? "东方财富公开板块资金" : "" },
    note: "GitHub 公开 Feed 保存公开市场快照；公司查询会在应用运行时按代码在线补抓更新。",
  };
}

export function writeLiveMarketFiles(payload, target = path.join(root, "data", "live-market.json")) {
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
  return { fetchedAt: payload.fetchedAt, asOfDate: payload.asOfDate, indices: payload.indices.length, marketStatus: payload.sourceStatus.market.status };
}

export async function main() {
  const payload = await buildLiveMarketPayload();
  console.log(JSON.stringify(writeLiveMarketFiles(payload), null, 2));
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
