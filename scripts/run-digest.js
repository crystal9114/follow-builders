#!/usr/bin/env node

// Follow Builders headless runner.
// Fetches feed context, asks a SiliconFlow chat model for a Chinese digest,
// and delivers it to a WeCom group robot webhook.

import { spawn } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, "..");
const LOG_DIR = join(ROOT_DIR, "logs");
const DATA_DIR = join(ROOT_DIR, "data");
const SENT_STATE_PATH = join(DATA_DIR, "sent-items.json");
const ENV_PATH = join(ROOT_DIR, ".env");

loadEnv({ path: ENV_PATH });

const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_TIME = "09:00";
const DEFAULT_MAX_CONTEXT_CHARS = 60000;
const DEFAULT_MAX_ITEMS = 10;

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function boolEnv(name, fallback = false) {
  const value = env(name);
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseArgs() {
  const args = process.argv.slice(2);
  const mode = args.find((arg) => !arg.startsWith("--")) || "once";
  return {
    mode,
    dryRun: args.includes("--dry-run") || boolEnv("DRY_RUN"),
    skipLlm: args.includes("--skip-llm") || boolEnv("SKIP_LLM"),
    untilNow: args.includes("--until-now") || boolEnv("UNTIL_NOW"),
    ignoreDedup: args.includes("--ignore-dedup") || boolEnv("IGNORE_DEDUP"),
  };
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
}

function assertConfig() {
  const missing = [];
  if (!env("SILICONFLOW_API_KEY")) missing.push("SILICONFLOW_API_KEY");
  if (!env("WECOM_WEBHOOK_URL")) missing.push("WECOM_WEBHOOK_URL");
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

async function runPrepareDigest() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(SCRIPT_DIR, "prepare-digest.js")], {
      cwd: SCRIPT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`prepare-digest failed with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`prepare-digest returned invalid JSON: ${err.message}`));
      }
    });
  });
}

function truncate(text, maxChars) {
  if (!text) return "";
  const normalized = String(text).replace(/\s+\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n...[truncated]`;
}

function parseDigestTime() {
  const [hour, minute] = env("DIGEST_TIME", DEFAULT_TIME).split(":").map(Number);
  return {
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

function dailyAnchor(now = new Date()) {
  const { hour, minute } = parseDigestTime();
  const anchor = new Date(now);
  anchor.setHours(hour, minute, 0, 0);
  if (anchor > now) anchor.setDate(anchor.getDate() - 1);
  return anchor;
}

function reportingWindow({ untilNow = false } = {}) {
  const now = new Date();
  const scheduledEnd = dailyAnchor(now);
  const start = new Date(scheduledEnd);
  start.setDate(start.getDate() - 1);
  return {
    start,
    end: untilNow ? now : scheduledEnd,
    mode: untilNow ? "manual-until-now" : "daily-anchored",
  };
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: env("REPORT_TIMEZONE", "Asia/Shanghai"),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function itemInWindow(item, field, window) {
  const value = item?.[field];
  if (!value) return false;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return false;
  return timestamp >= window.start && timestamp <= window.end;
}

function scoreTweet(tweet) {
  return (tweet.likes || 0) + (tweet.retweets || 0) * 2 + (tweet.replies || 0);
}

function isLowSignalTweet(tweet) {
  const text = String(tweet.text || "").trim();
  const withoutUrls = text.replace(/https?:\/\/\S+/g, "").trim();
  const withoutMentions = withoutUrls.replace(/@\w+/g, "").trim();
  return text.startsWith("@") && withoutMentions.length < 20;
}

function buildCandidates(digest, window) {
  const candidates = [];

  for (const account of digest.x || []) {
    for (const tweet of account.tweets || []) {
      if (!itemInWindow(tweet, "createdAt", window)) continue;
      if (isLowSignalTweet(tweet)) continue;
      candidates.push({
        sourceId: `x:${tweet.id || tweet.url}`,
        type: "x",
        sourceName: `${account.name} (@${account.handle})`,
        title: `${account.name} 的 X 动态`,
        publishedAt: tweet.createdAt,
        url: tweet.url,
        score: scoreTweet(tweet),
        content: truncate(tweet.text, 1200),
      });
    }
  }

  for (const podcast of digest.podcasts || []) {
    if (!itemInWindow(podcast, "publishedAt", window)) continue;
    candidates.push({
      sourceId: `podcast:${podcast.guid || podcast.url}`,
      type: "podcast",
      sourceName: podcast.name,
      title: podcast.title,
      publishedAt: podcast.publishedAt,
      url: podcast.url,
      score: 100,
      content: truncate(podcast.transcript, 5000),
    });
  }

  for (const blog of digest.blogs || []) {
    if (!itemInWindow(blog, "publishedAt", window)) continue;
    candidates.push({
      sourceId: `blog:${blog.url}`,
      type: "blog",
      sourceName: blog.name,
      title: blog.title,
      publishedAt: blog.publishedAt,
      url: blog.url,
      score: 90,
      content: truncate(blog.content, 5000),
    });
  }

  return candidates
    .filter((item) => item.url)
    .sort((a, b) => b.score - a.score || new Date(b.publishedAt) - new Date(a.publishedAt));
}

async function loadSentState() {
  try {
    const state = JSON.parse(await readFile(SENT_STATE_PATH, "utf8"));
    return {
      sent: state.sent && typeof state.sent === "object" ? state.sent : {},
    };
  } catch {
    return { sent: {} };
  }
}

async function saveSentState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  const cutoff = Date.now() - Number(env("DEDUP_RETENTION_DAYS", 30)) * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.sent)) {
    if (new Date(ts).getTime() < cutoff) delete state.sent[id];
  }
  await writeFile(SENT_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function filterUnsent(candidates, sentState, ignoreDedup) {
  if (ignoreDedup) return candidates;
  return candidates.filter((item) => !sentState.sent[item.sourceId]);
}

function selectCandidates(candidates) {
  return candidates.slice(0, Number(env("MAX_DIGEST_ITEMS", DEFAULT_MAX_ITEMS)));
}

function buildModelInput(digest, window, candidates) {
  const maxContextChars = Number(env("MAX_CONTEXT_CHARS", DEFAULT_MAX_CONTEXT_CHARS));
  const compact = {
    generatedAt: digest.generatedAt,
    reportWindow: {
      mode: window.mode,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      display: `${formatDateTime(window.start)} - ${formatDateTime(window.end)}`,
      timezone: env("REPORT_TIMEZONE", "Asia/Shanghai"),
    },
    stats: digest.stats,
    filteredStats: {
      candidateItems: candidates.length,
      xItems: candidates.filter((item) => item.type === "x").length,
      podcastItems: candidates.filter((item) => item.type === "podcast").length,
      blogItems: candidates.filter((item) => item.type === "blog").length,
    },
    errors: digest.errors || [],
    candidates,
  };

  return truncate(JSON.stringify(compact, null, 2), maxContextChars);
}

function buildMessages(modelInput, window) {
  return [
    {
      role: "system",
      content:
        "你是一个严谨的 AI 行业资讯编辑。根据提供的 podcast、博客和 X/Twitter 原始内容，生成一份中文企业微信群日报。只依据输入内容，不编造事实。保留重要英文产品名、人名、公司名和原文链接。",
    },
    {
      role: "user",
      content: [
        "请从候选资讯中挑选并改写为适合企业微信逐条推送的 Top 10 简报。",
        `本期时间范围：${formatDateTime(window.start)} 到 ${formatDateTime(window.end)}（${env("REPORT_TIMEZONE", "Asia/Shanghai")}）。`,
        "",
        "只输出 JSON，不要输出 Markdown，不要解释。",
        "JSON schema:",
        "{",
        '  "items": [',
        "    {",
        '      "sourceId": "必须原样复制候选资讯的 sourceId",',
        '      "title": "20字以内标题",',
        '      "summary": "40-80字，说明发生了什么",',
        '      "whyItMatters": "40-80字，说明为什么重要",',
        '      "url": "必须原样复制候选资讯的 url"',
        "    }",
        "  ]",
        "}",
        "",
        "规则：",
        `- 最多 ${env("MAX_DIGEST_ITEMS", DEFAULT_MAX_ITEMS)} 条，不足则按实际数量输出`,
        "- 每条只保留一个源链接 url，不要再写讨论链接、详情链接、参考链接",
        "- 不要使用“讨论链接”“补充链接”“详情链接”这类说法，统一叫“来源”",
        "- 不要编造候选资讯中没有的事实",
        "- 内容简洁，避免营销腔",
        "- 按重要性排序",
        "",
        "原始数据：",
        modelInput,
      ].join("\n"),
    },
  ];
}

function parseModelItems(content) {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const data = JSON.parse(cleaned);
  if (!Array.isArray(data.items)) {
    throw new Error("Model output JSON has no items array");
  }
  return data.items;
}

async function createDigestItems(modelInput, window, candidates) {
  const apiKey = env("SILICONFLOW_API_KEY");
  const baseUrl = env("SILICONFLOW_API_BASE", DEFAULT_API_BASE).replace(/\/$/, "");
  const model = env("SILICONFLOW_MODEL", DEFAULT_MODEL);

  const body = {
    model,
    messages: buildMessages(modelInput, window),
    stream: false,
    temperature: Number(env("DIGEST_TEMPERATURE", 0.4)),
    max_tokens: Number(env("DIGEST_MAX_TOKENS", 4096)),
  };

  if (model.includes("DeepSeek-V4")) {
    body.reasoning_effort = env("SILICONFLOW_REASONING_EFFORT", "high");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(env("SILICONFLOW_TIMEOUT_MS", 120000))),
  });

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    data = { raw: responseText };
  }

  if (!response.ok) {
    throw new Error(`SiliconFlow API ${response.status}: ${JSON.stringify(data)}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`SiliconFlow API returned no content: ${JSON.stringify(data)}`);
  }

  const candidateById = new Map(candidates.map((item) => [item.sourceId, item]));
  const seen = new Set();
  return parseModelItems(content)
    .filter((item) => candidateById.has(item.sourceId))
    .filter((item) => {
      if (seen.has(item.sourceId)) return false;
      seen.add(item.sourceId);
      return true;
    })
    .slice(0, Number(env("MAX_DIGEST_ITEMS", DEFAULT_MAX_ITEMS)))
    .map((item) => {
      const source = candidateById.get(item.sourceId);
      return {
        sourceId: source.sourceId,
        title: truncate(item.title || source.title, 40),
        summary: truncate(item.summary || source.content, 140),
        whyItMatters: truncate(item.whyItMatters || "值得关注。", 140),
        url: source.url,
      };
    });
}

function splitMessage(text, maxBytes = 3000) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (Buffer.byteLength(remaining, "utf8") <= maxBytes) {
      chunks.push(remaining);
      break;
    }
    let splitAt = 0;
    let bytes = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      bytes += Buffer.byteLength(remaining[i], "utf8");
      if (bytes > maxBytes) break;
      splitAt = i + 1;
    }
    const newlineSplit = remaining.lastIndexOf("\n", splitAt);
    if (newlineSplit > splitAt * 0.5) splitAt = newlineSplit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks;
}

async function sendWeCom(text) {
  const webhookUrl = env("WECOM_WEBHOOK_URL");
  const msgtype = env("WECOM_MSGTYPE", "markdown");
  const chunks = splitMessage(text);

  for (const [index, chunk] of chunks.entries()) {
    const content = chunks.length > 1 ? `${chunk}\n\n(${index + 1}/${chunks.length})` : chunk;
    const payload =
      msgtype === "text"
        ? { msgtype: "text", text: { content } }
        : { msgtype: "markdown", markdown: { content } };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(env("WECOM_TIMEOUT_MS", 15000))),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.errcode !== 0) {
      throw new Error(`WeCom webhook failed: HTTP ${response.status} ${JSON.stringify(data)}`);
    }
    if (chunks.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
}

function formatItemMessage(item, index, total, window) {
  return [
    `# ${index + 1}/${total} ${item.title}`,
    "",
    `**结论**：${item.summary}`,
    "",
    `**为什么重要**：${item.whyItMatters}`,
    "",
    `**来源**：${item.url}`,
    "",
    `<font color=\"comment\">${formatDateTime(window.start)} - ${formatDateTime(window.end)}</font>`,
  ].join("\n");
}

async function sendWeComItems(items, window) {
  if (items.length === 0) {
    await sendWeCom(
      [
        "# AI Builders 日报",
        "",
        "本期没有新的未推送资讯。",
        "",
        `<font color=\"comment\">${formatDateTime(window.start)} - ${formatDateTime(window.end)}</font>`,
      ].join("\n"),
    );
    return;
  }

  for (const [index, item] of items.entries()) {
    await sendWeCom(formatItemMessage(item, index, items.length, window));
    if (index < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, Number(env("WECOM_ITEM_DELAY_MS", 1500))));
    }
  }
}

async function writeRunLog(items, window) {
  await mkdir(LOG_DIR, { recursive: true });
  const filename = `digest-${new Date().toISOString().slice(0, 10)}.json`;
  await writeFile(
    join(LOG_DIR, filename),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        window: {
          start: window.start.toISOString(),
          end: window.end.toISOString(),
          display: `${formatDateTime(window.start)} - ${formatDateTime(window.end)}`,
        },
        items,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function runOnce({ dryRun = false, skipLlm = false, untilNow = false, ignoreDedup = false } = {}) {
  assertConfig();
  log("Preparing digest input");
  const digest = await runPrepareDigest();
  const window = reportingWindow({ untilNow });
  log(`Report window: ${formatDateTime(window.start)} - ${formatDateTime(window.end)}`);
  const sentState = await loadSentState();
  const allCandidates = buildCandidates(digest, window);
  const candidates = selectCandidates(filterUnsent(allCandidates, sentState, ignoreDedup));
  const modelInput = buildModelInput(digest, window, candidates);

  if (skipLlm) {
    log(
      `Prepared ${candidates.length} candidate items (${modelInput.length} chars), skipping LLM`,
    );
    return;
  }

  if (candidates.length === 0) {
    log("No unsent candidate items");
    if (!dryRun) await sendWeComItems([], window);
    return;
  }

  log(`Calling SiliconFlow model ${env("SILICONFLOW_MODEL", DEFAULT_MODEL)}`);
  const items = await createDigestItems(modelInput, window, candidates);
  await writeRunLog(items, window);

  if (dryRun) {
    log("Dry run enabled; not sending WeCom message");
    console.log(JSON.stringify({ items }, null, 2));
    return;
  }

  log(`Sending ${items.length} item(s) to WeCom`);
  await sendWeComItems(items, window);
  for (const item of items) {
    sentState.sent[item.sourceId] = new Date().toISOString();
  }
  await saveSentState(sentState);
  log("Digest items sent");
}

function nextRunAt() {
  const { hour, minute } = parseDigestTime();
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute || 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

async function runScheduled(args) {
  assertConfig();
  log(`Scheduler started. Daily run time: ${env("DIGEST_TIME", DEFAULT_TIME)}, TZ=${env("TZ", "system")}`);
  if (boolEnv("RUN_ON_START")) {
    await runOnce(args).catch((err) => log(`Run-on-start failed: ${err.message}`));
  }

  const scheduleNext = () => {
    const next = nextRunAt();
    const delay = next.getTime() - Date.now();
    log(`Next run scheduled at ${next.toISOString()}`);
    setTimeout(async () => {
      try {
        await runOnce(args);
      } catch (err) {
        log(`Scheduled run failed: ${err.message}`);
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}

async function main() {
  const args = parseArgs();
  if (args.mode === "healthcheck") {
    assertConfig();
    log("Healthcheck ok");
    return;
  }
  if (args.mode === "scheduled") {
    await runScheduled(args);
    return;
  }
  if (args.mode === "once") {
    await runOnce(args);
    return;
  }
  throw new Error(`Unknown mode: ${args.mode}`);
}

main().catch((err) => {
  log(err.message);
  process.exit(1);
});
