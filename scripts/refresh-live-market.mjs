import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const USER_AGENT = "AlphaEngine-Public-Feed/1.0";
const indexCodes = ["sh000001", "sz399001", "sz399006", "sh000688", "sh000300"];
const indexNames = { "000001": "上证指数", "399001": "深证成指", "399006": "创业板指", "000688": "科创50", "000300": "沪深300" };

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

const results = await Promise.all(indexCodes.map(async (symbol) => {
  try { return { ok: true, value: await quote(symbol) }; }
  catch (error) { return { ok: false, symbol, error: String(error) }; }
}));
const payload = {
  schemaVersion: "alphaengine-public-market-live-v1",
  publicSafe: true,
  fetchedAt: new Date().toISOString(),
  asOfDate: results.find((item) => item.ok)?.value.asOfDate || "",
  sourceStatus: Object.fromEntries(results.map((item) => [item.ok ? item.value.code : item.symbol, item.ok ? { status: "ok", source: item.value.source } : { status: "failed", error: item.error }])),
  indices: results.filter((item) => item.ok).map((item) => item.value),
  note: "GitHub 公开 Feed 只承载公开市场快照；公司查询会在应用运行时按代码在线补抓更新。",
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
