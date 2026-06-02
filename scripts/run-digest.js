#!/usr/bin/env node

// Follow Builders headless runner.
// Fetches feed context, asks a SiliconFlow chat model for a Chinese digest,
// and delivers it to a WeCom group robot webhook.

import { spawn } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, "..");
const LOG_DIR = join(ROOT_DIR, "logs");
const ENV_PATH = join(ROOT_DIR, ".env");

loadEnv({ path: ENV_PATH });

const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_TIME = "08:30";
const DEFAULT_MAX_CONTEXT_CHARS = 60000;

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

function topTweets(accounts, maxBuilders, maxTweetsPerBuilder) {
  return (accounts || [])
    .filter((account) => account.tweets?.length)
    .map((account) => ({
      ...account,
      score: account.tweets.reduce(
        (sum, tweet) =>
          sum + (tweet.likes || 0) + (tweet.retweets || 0) * 2 + (tweet.replies || 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxBuilders)
    .map((account) => ({
      name: account.name,
      handle: account.handle,
      tweets: account.tweets
        .slice()
        .sort(
          (a, b) =>
            (b.likes || 0) +
            (b.retweets || 0) * 2 +
            (b.replies || 0) -
            ((a.likes || 0) + (a.retweets || 0) * 2 + (a.replies || 0)),
        )
        .slice(0, maxTweetsPerBuilder)
        .map((tweet) => ({
          text: truncate(tweet.text, 900),
          url: tweet.url,
          createdAt: tweet.createdAt,
          likes: tweet.likes,
          retweets: tweet.retweets,
          replies: tweet.replies,
        })),
    }));
}

function buildModelInput(digest) {
  const maxContextChars = Number(env("MAX_CONTEXT_CHARS", DEFAULT_MAX_CONTEXT_CHARS));
  const maxPodcasts = Number(env("MAX_PODCASTS", 3));
  const maxBlogs = Number(env("MAX_BLOGS", 5));
  const maxBuilders = Number(env("MAX_BUILDERS", 12));
  const maxTweetsPerBuilder = Number(env("MAX_TWEETS_PER_BUILDER", 3));

  const compact = {
    generatedAt: digest.generatedAt,
    stats: digest.stats,
    errors: digest.errors || [],
    podcasts: (digest.podcasts || []).slice(0, maxPodcasts).map((podcast) => ({
      name: podcast.name,
      title: podcast.title,
      publishedAt: podcast.publishedAt,
      url: podcast.url,
      transcript: truncate(podcast.transcript, 6000),
    })),
    blogs: (digest.blogs || []).slice(0, maxBlogs).map((blog) => ({
      name: blog.name,
      title: blog.title,
      publishedAt: blog.publishedAt,
      url: blog.url,
      content: truncate(blog.content, 6000),
    })),
    x: topTweets(digest.x, maxBuilders, maxTweetsPerBuilder),
  };

  return truncate(JSON.stringify(compact, null, 2), maxContextChars);
}

function buildMessages(modelInput) {
  return [
    {
      role: "system",
      content:
        "你是一个严谨的 AI 行业资讯编辑。根据提供的 podcast、博客和 X/Twitter 原始内容，生成一份中文企业微信群日报。只依据输入内容，不编造事实。保留重要英文产品名、人名、公司名和原文链接。",
    },
    {
      role: "user",
      content: [
        "请输出一份适合企业微信推送的中文 AI Builders 日报。",
        "",
        "格式要求：",
        "- 标题：AI Builders 日报 - YYYY-MM-DD",
        "- 先给 5 条以内的“今日最值得关注”",
        "- 再按“播客 / X 观点 / 官方博客”分组",
        "- 每条包含：一句话结论、为什么重要、原始链接",
        "- 内容务实，避免营销腔",
        "- 如果某个分组没有内容，直接省略",
        "- 总长度控制在 2500-3500 中文字",
        "",
        "原始数据：",
        modelInput,
      ].join("\n"),
    },
  ];
}

async function createDigestText(modelInput) {
  const apiKey = env("SILICONFLOW_API_KEY");
  const baseUrl = env("SILICONFLOW_API_BASE", DEFAULT_API_BASE).replace(/\/$/, "");
  const model = env("SILICONFLOW_MODEL", DEFAULT_MODEL);

  const body = {
    model,
    messages: buildMessages(modelInput),
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

  return content.trim();
}

function splitMessage(text, maxChars = 3500) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < maxChars * 0.5) splitAt = maxChars;
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

async function writeRunLog(digestText) {
  await mkdir(LOG_DIR, { recursive: true });
  const filename = `digest-${new Date().toISOString().slice(0, 10)}.md`;
  await writeFile(join(LOG_DIR, filename), digestText, "utf8");
}

async function runOnce({ dryRun = false, skipLlm = false } = {}) {
  assertConfig();
  log("Preparing digest input");
  const digest = await runPrepareDigest();
  const modelInput = buildModelInput(digest);

  if (skipLlm) {
    log(`Prepared model input (${modelInput.length} chars), skipping LLM`);
    return;
  }

  log(`Calling SiliconFlow model ${env("SILICONFLOW_MODEL", DEFAULT_MODEL)}`);
  const digestText = await createDigestText(modelInput);
  await writeRunLog(digestText);

  if (dryRun) {
    log("Dry run enabled; not sending WeCom message");
    console.log(digestText);
    return;
  }

  log("Sending digest to WeCom");
  await sendWeCom(digestText);
  log("Digest sent");
}

function nextRunAt() {
  const [hour, minute] = env("DIGEST_TIME", DEFAULT_TIME).split(":").map(Number);
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
