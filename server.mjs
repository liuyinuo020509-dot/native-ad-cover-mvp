import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  strategySystemPrompt,
  buildGenerationSystemPrompt,
  nativeAdImageMasterPrompt,
  preferenceAttributionSystemPrompt,
  platformResultAttributionSystemPrompt,
  qualitySystemPrompt,
} from "./prompts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = globalThis.process?.env || {};
await loadDotEnv(path.join(__dirname, ".env"));
await loadDotEnv(path.join(__dirname, "API set.env"));
if (!env.OPENAI_API_KEY && env.OPENAI_API_IKEY) {
  env.OPENAI_API_KEY = env.OPENAI_API_IKEY;
}

const publicDir = path.join(__dirname, "public");
const generatedDir = path.join(publicDir, "generated");
const memoryDir = path.join(__dirname, "memory");
const humanPreferenceMemoryPath = path.join(memoryDir, "human_preference_memory.json");
const qualityFailureMemoryPath = path.join(memoryDir, "quality_failure_memory.json");
const platformResultMemoryPath = path.join(memoryDir, "platform_result_memory.json");
const feedbackRecordsPath = path.join(memoryDir, "human_feedback_records.json");
const preferredPort = Number(env.PORT || 8787);
let currentPort = preferredPort;
const textModel = env.TEXT_MODEL || "gpt-5";
const imageModel = env.IMAGE_MODEL || "gpt-image-2";
const imageSize = env.IMAGE_SIZE || "auto";
const generationSystemPrompt = buildGenerationSystemPrompt(nativeAdImageMasterPrompt);
const strictImageRules = {
  aspectRatio: "16:9",
  mustBeHorizontal: true,
  forbiddenVisuals: ["logo", "icon", "二维码", "下载按钮", "联系方式", "水印"],
  forbiddenCopy: ["立即下载", "点击领取", "限时抢购"],
};

async function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = await readFile(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && env[key] === undefined) env[key] = value;
  }
}

function resolveApiKey(input = {}) {
  return String(input.apiKey || env.OPENAI_API_KEY || "").trim();
}

function requireApiKey(input = {}) {
  const apiKey = resolveApiKey(input);
  if (apiKey) return apiKey;
  throw new Error("缺少 OpenAI API Key。请在页面顶部填写你自己的 API Key，或在服务器环境变量里配置 OPENAI_API_KEY。");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, data) {
  if (!existsSync(memoryDir)) await mkdir(memoryDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function loadMemoryBundle() {
  const humanPreferenceMemory = await readJsonFile(humanPreferenceMemoryPath, {
    version: 1,
    updatedAt: null,
    positivePreferences: [],
    negativePreferences: [],
    titlePreferences: [],
    visualPreferences: [],
    compositionPreferences: [],
    avoidanceRules: [],
    records: [],
  });
  const previousQualityFailures = await readJsonFile(qualityFailureMemoryPath, {
    version: 1,
    updatedAt: null,
    failures: [],
    tags: [],
  });
  const platformIndustryMemory = await readJsonFile(platformResultMemoryPath, {
    version: 1,
    updatedAt: null,
    results: [],
    platformIndustryRules: [],
  });
  return { humanPreferenceMemory, previousQualityFailures, platformIndustryMemory };
}

function appendLimited(list, items, limit = 200) {
  const next = Array.isArray(list) ? [...list] : [];
  for (const item of items || []) {
    if (item === undefined || item === null || item === "") continue;
    next.push(item);
  }
  return next.slice(-limit);
}

function normalizeAction(action) {
  const allowed = new Set(["selected", "rejected", "edited", "shortlisted"]);
  return allowed.has(action) ? action : null;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("请求太大"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === "string") return responseJson.output_text;
  const texts = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) texts.push(content.text);
      if (content.type === "text" && content.text) texts.push(content.text);
    }
  }
  return texts.join("\n").trim();
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("模型没有返回可解析 JSON");
    return JSON.parse(match[0]);
  }
}

async function repairModelJson({ text, parseError, apiKey }) {
  const resolvedApiKey = requireApiKey({ apiKey });
  let rsp;
  try {
    rsp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resolvedApiKey}`,
      },
      body: JSON.stringify({
        model: textModel,
        instructions: "你是 JSON 修复器。把用户提供的内容修复成严格合法 JSON。只输出 JSON，不要解释，不要 Markdown。",
        input: `解析错误：${parseError.message}\n\n待修复内容：\n${text}`,
      }),
    });
  } catch (error) {
    throw new Error(`模型返回的 JSON 格式有误，自动修复时连接失败。原始解析错误：${parseError.message}`);
  }
  const data = await rsp.json();
  if (!rsp.ok) {
    throw new Error(`模型返回的 JSON 格式有误，自动修复失败：${data.error?.message || rsp.status}`);
  }
  return parseJsonLoose(extractOutputText(data));
}

async function parseModelJson(text, apiKey) {
  try {
    return parseJsonLoose(text);
  } catch (error) {
    return repairModelJson({ text, parseError: error, apiKey });
  }
}

async function callResponses({ instructions, input, apiKey }) {
  const resolvedApiKey = requireApiKey({ apiKey });

  let rsp;
  try {
    rsp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resolvedApiKey}`,
      },
      body: JSON.stringify({
        model: textModel,
        instructions,
        input,
      }),
    });
  } catch (error) {
    throw new Error(`无法连接 OpenAI Responses API。请确认电脑网络/VPN/代理能访问 api.openai.com，然后重启 start.ps1。原始错误：${error.message}`);
  }

  const data = await rsp.json();
  if (!rsp.ok) {
    throw new Error(data.error?.message || `Responses API 请求失败：${rsp.status}`);
  }
  return parseModelJson(extractOutputText(data), resolvedApiKey);
}

async function callResponsesWithImage({ instructions, text, imageDataUrl, apiKey }) {
  const resolvedApiKey = requireApiKey({ apiKey });

  let rsp;
  try {
    rsp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resolvedApiKey}`,
      },
      body: JSON.stringify({
        model: textModel,
        instructions,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text },
              { type: "input_image", image_url: imageDataUrl },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    throw new Error(`无法连接 OpenAI 图片质检接口。请确认电脑网络/VPN/代理能访问 api.openai.com，然后重启 start.ps1。原始错误：${error.message}`);
  }

  const data = await rsp.json();
  if (!rsp.ok) {
    throw new Error(data.error?.message || `图片质检请求失败：${rsp.status}`);
  }
  return parseModelJson(extractOutputText(data), resolvedApiKey);
}

async function generateImage(prompt, apiKey) {
  const resolvedApiKey = requireApiKey({ apiKey });

  const body = {
    model: imageModel,
    prompt,
    size: imageSize,
  };

  let rsp;
  try {
    rsp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resolvedApiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`无法连接 OpenAI 图片生成接口。请确认电脑网络/VPN/代理能访问 api.openai.com，然后重启 start.ps1。原始错误：${error.message}`);
  }

  const data = await rsp.json();
  if (!rsp.ok) {
    throw new Error(data.error?.message || `图片生成失败：${rsp.status}`);
  }

  if (!existsSync(generatedDir)) await mkdir(generatedDir, { recursive: true });
  const fileName = `cover-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  const filePath = path.join(generatedDir, fileName);
  const imageResult = data.data?.[0];
  const b64 = imageResult?.b64_json;

  if (b64) {
    await writeFile(filePath, Buffer.from(b64, "base64"));
    return {
      imageUrl: `/generated/${fileName}`,
      imageDataUrl: `data:image/png;base64,${b64}`,
    };
  }

  if (imageResult?.url) {
    const imageRsp = await fetch(imageResult.url);
    if (!imageRsp.ok) throw new Error(`图片下载失败：${imageRsp.status}`);
    const bytes = Buffer.from(await imageRsp.arrayBuffer());
    await writeFile(filePath, bytes);
    return {
      imageUrl: `/generated/${fileName}`,
      imageDataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    };
  }

  throw new Error("图片接口没有返回可保存的图片数据");
}

function buildStrategyInput(input) {
  return `
应用名称：${input.appName}
广告文案：${input.adCopy}
投放平台：${input.platform || "未填写"}
行业/品类：${input.industry || "未填写"}
目标人群：${input.targetAudience || "未填写"}
禁用词/禁用元素：${input.forbiddenItems || "二维码、下载按钮、水印、联系方式、夸张承诺"}
构图/生成备注：${input.visualPreference || "未填写"}
`;
}

function buildGenerationInput(input, strategy, memory) {
  return `
应用名称：${input.appName}
广告文案：${input.adCopy}
构图/生成备注：${input.visualPreference || "未填写"}

策略理解结果：
${JSON.stringify(strategy, null, 2)}

humanPreferenceMemory：
${JSON.stringify(memory.humanPreferenceMemory, null, 2)}

previousQualityFailures：
${JSON.stringify(memory.previousQualityFailures, null, 2)}

platformIndustryMemory：
${JSON.stringify(memory.platformIndustryMemory, null, 2)}

请生成横版 16:9 原生广告封面 Prompt。
`;
}

function buildQualityInput(input, strategy, generation, memory) {
  return `
应用名称：${input.appName}
广告文案：${input.adCopy}
投放平台：${input.platform || "未填写"}
行业/品类：${input.industry || "未填写"}
目标人群：${input.targetAudience || "未填写"}
禁用词/禁用元素：${input.forbiddenItems || "二维码、下载按钮、水印、联系方式、夸张承诺"}
构图/生成备注：${input.visualPreference || "未填写"}

策略理解结果：
${JSON.stringify(strategy, null, 2)}

封面生成结果：
${JSON.stringify(generation, null, 2)}

humanPreferenceMemory：
${JSON.stringify(memory.humanPreferenceMemory, null, 2)}

previousQualityFailures：
${JSON.stringify(memory.previousQualityFailures, null, 2)}

platformIndustryMemory：
${JSON.stringify(memory.platformIndustryMemory, null, 2)}

请判断该封面是否通过质检，并输出结构化结果。
`;
}

function fillMasterPrompt(input) {
  return nativeAdImageMasterPrompt
    .replaceAll("{{appName}}", input.appName || "")
    .replaceAll("{{adCopy}}", input.adCopy || "");
}

function buildFinalImagePrompt(input, strategy, generation, variant) {
  return `${fillMasterPrompt(input)}

以下是本次广告的策略理解结果：
${JSON.stringify(strategy, null, 2)}

本次人工构图/生成备注：
${input.visualPreference || "未填写"}

以下是封面生成 Agent 产出的标题、场景和构图要求：
${JSON.stringify({
  mainTitle: generation.mainTitle,
  assistantText: generation.assistantText,
  composition: generation.composition,
  subject: generation.subject,
  scene: generation.scene,
  textLayout: generation.textLayout,
  styleKeywords: generation.styleKeywords,
}, null, 2)}

本次需要生成的版本：
版本名称：${variant.variantName || "默认版本"}
版本 Prompt：${variant.prompt || generation.imagePrompt}

负向要求：
${generation.negativePrompt || "不要二维码、下载按钮、水印、大段小字、乱码、错别字、传统商业海报感"}

最终不可违背硬约束：
- 必须是横版 16:9 构图，不要生成竖版、方图、9:16 或 1:1。
- 不要渲染 logo、icon、二维码、联系方式、水印、下载按钮。
- 不要出现“立即下载”“点击领取”“限时抢购”等强转化文案。
- 应用名称只能以纯文字出现，不能画成品牌图形标识。
`;
}

async function updateQualityFailureMemory(input, asset) {
  const memory = await readJsonFile(qualityFailureMemoryPath, {
    version: 1,
    updatedAt: null,
    failures: [],
    tags: [],
  });
  const quality = asset.quality || {};
  const shouldRemember =
    quality.passed === false ||
    (quality.scores?.commercialPosterRisk || 0) > 35 ||
    (quality.detectedFailurePatterns || []).length > 0 ||
    (quality.suggestedTagsForMemory || []).length > 0;

  if (!shouldRemember) return memory;

  memory.updatedAt = new Date().toISOString();
  memory.failures = appendLimited(memory.failures, [{
    recordedAt: memory.updatedAt,
    appName: input.appName,
    platform: input.platform || "",
    industry: input.industry || "",
    assetId: asset.assetId,
    variantName: asset.variantName,
    issues: quality.issues || [],
    detectedFailurePatterns: quality.detectedFailurePatterns || [],
    revisionInstructions: quality.revisionInstructions || {},
    totalScore: quality.totalScore ?? null,
    commercialPosterRisk: quality.scores?.commercialPosterRisk ?? null,
  }]);
  memory.tags = appendLimited(memory.tags, quality.suggestedTagsForMemory || [], 300);
  await writeJsonFile(qualityFailureMemoryPath, memory);
  return memory;
}

function mergePreferenceMemory(memory, attribution, record) {
  const now = new Date().toISOString();
  return {
    version: 1,
    updatedAt: now,
    positivePreferences: appendLimited(memory.positivePreferences, attribution.positivePreferences || [], 200),
    negativePreferences: appendLimited(memory.negativePreferences, attribution.negativePreferences || [], 200),
    titlePreferences: appendLimited(memory.titlePreferences, attribution.titlePreferences || [], 200),
    visualPreferences: appendLimited(memory.visualPreferences, attribution.visualPreferences || [], 200),
    compositionPreferences: appendLimited(memory.compositionPreferences, attribution.compositionPreferences || [], 200),
    avoidanceRules: appendLimited(memory.avoidanceRules, attribution.avoidanceRules || [], 200),
    records: appendLimited(memory.records, [record], 300),
  };
}

async function handleGenerate(req, res) {
  const raw = await collectBody(req);
  const input = JSON.parse(raw || "{}");
  if (!input.appName || !input.adCopy) {
    return sendJson(res, 400, { error: "appName 和 adCopy 必填" });
  }
  const apiKey = resolveApiKey(input);
  if (!apiKey) {
    return sendJson(res, 400, { error: "请先在页面顶部填写你自己的 OpenAI API Key。" });
  }

  const count = Math.max(1, Math.min(Number(input.count || 1), 4));
  const safeInput = { ...input };
  delete safeInput.apiKey;
  const memory = await loadMemoryBundle();
  const strategy = await callResponses({
    instructions: strategySystemPrompt,
    input: buildStrategyInput(input),
    apiKey,
  });

  const generation = await callResponses({
    instructions: generationSystemPrompt,
    input: buildGenerationInput(input, strategy, memory),
    apiKey,
  });

  const variants = generation.generationVariants?.length
    ? generation.generationVariants
    : [{ variantName: "默认版本", prompt: generation.imagePrompt }];

  const assets = [];
  for (let i = 0; i < count; i += 1) {
    const variant = variants[i % variants.length];
    const prompt = buildFinalImagePrompt(input, strategy, generation, variant);
    const image = await generateImage(prompt, apiKey);
    const quality = await callResponsesWithImage({
      instructions: qualitySystemPrompt,
      text: buildQualityInput(input, strategy, generation, memory),
      imageDataUrl: image.imageDataUrl,
      apiKey,
    });
    const asset = {
      assetId: `asset_${i + 1}`,
      variantName: variant.variantName || `版本 ${i + 1}`,
      imageUrl: image.imageUrl,
      prompt,
      quality,
    };
    await updateQualityFailureMemory(input, asset);
    assets.push(asset);
  }

  assets.sort((a, b) => (b.quality?.totalScore || 0) - (a.quality?.totalScore || 0));
  sendJson(res, 200, {
    status: "completed",
    input: safeInput,
    strictImageRules,
    memoryUsed: memory,
    strategy,
    generation,
    assets,
    bestAsset: assets[0] || null,
  });
}

async function handleFeedback(req, res) {
  const raw = await collectBody(req);
  const body = JSON.parse(raw || "{}");
  const apiKey = resolveApiKey(body);
  const action = normalizeAction(body.action);
  if (!action) {
    return sendJson(res, 400, { error: "action 必须是 selected/rejected/edited/shortlisted 之一" });
  }

  const now = new Date().toISOString();
  const record = {
    id: `feedback_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    recordedAt: now,
    action,
    appName: body.input?.appName || body.appName || "",
    platform: body.input?.platform || body.platform || "",
    industry: body.input?.industry || body.industry || "",
    assetId: body.asset?.assetId || body.assetId || "",
    variantName: body.asset?.variantName || body.variantName || "",
    note: body.note || "",
    editedFields: body.editedFields || {},
    input: body.input || null,
    asset: body.asset || null,
    quality: body.asset?.quality || body.quality || null,
  };

  const records = await readJsonFile(feedbackRecordsPath, { version: 1, records: [] });
  records.records = appendLimited(records.records, [record], 500);
  records.updatedAt = now;
  await writeJsonFile(feedbackRecordsPath, records);

  const currentMemory = await readJsonFile(humanPreferenceMemoryPath, {
    version: 1,
    updatedAt: null,
    positivePreferences: [],
    negativePreferences: [],
    titlePreferences: [],
    visualPreferences: [],
    compositionPreferences: [],
    avoidanceRules: [],
    records: [],
  });

  let attribution = null;
  let attributionSkipped = false;
  if (apiKey) {
    attribution = await callResponses({
      instructions: preferenceAttributionSystemPrompt,
      input: JSON.stringify({
        feedbackRecord: record,
        currentHumanPreferenceMemory: currentMemory,
        strictImageRules,
      }, null, 2),
      apiKey,
    });
    await writeJsonFile(humanPreferenceMemoryPath, mergePreferenceMemory(currentMemory, attribution, record));
  } else {
    attributionSkipped = true;
    await writeJsonFile(humanPreferenceMemoryPath, mergePreferenceMemory(currentMemory, {
      positivePreferences: action === "selected" || action === "shortlisted"
        ? [{ tag: action, rule: body.note || `${action} asset`, evidence: record.assetId, confidence: 0.4 }]
        : [],
      negativePreferences: action === "rejected"
        ? [{ tag: "rejected", rule: body.note || "人工拒绝该素材方向", evidence: record.assetId, confidence: 0.4 }]
        : [],
      avoidanceRules: action === "rejected" && body.note ? [body.note] : [],
    }, record));
  }

  sendJson(res, 200, {
    status: "recorded",
    record,
    attribution,
    attributionSkipped,
    message: attributionSkipped ? "已记录人工筛选；缺少 OPENAI_API_KEY，偏好归因使用本地简化写入。" : "已记录人工筛选，并完成偏好归因。",
  });
}

async function handlePlatformResult(req, res) {
  const raw = await collectBody(req);
  const body = JSON.parse(raw || "{}");
  const apiKey = resolveApiKey(body);
  const now = new Date().toISOString();
  const memory = await readJsonFile(platformResultMemoryPath, {
    version: 1,
    updatedAt: null,
    results: [],
    platformIndustryRules: [],
  });

  const resultRecord = {
    id: `platform_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    recordedAt: now,
    appName: body.input?.appName || body.appName || "",
    platform: body.platform || body.input?.platform || "",
    industry: body.industry || body.input?.industry || "",
    assetId: body.assetId || body.asset?.assetId || "",
    ctr: body.ctr ?? null,
    cvr: body.cvr ?? null,
    cpa: body.cpa ?? null,
    reviewStatus: body.reviewStatus || "",
    rejectReason: body.rejectReason || "",
    negativeFeedback: body.negativeFeedback || "",
    input: body.input || null,
    asset: body.asset || null,
  };

  let attribution = null;
  let attributionSkipped = false;
  if (apiKey) {
    attribution = await callResponses({
      instructions: platformResultAttributionSystemPrompt,
      input: JSON.stringify({
        platformResult: resultRecord,
        currentPlatformResultMemory: memory,
        strictImageRules,
      }, null, 2),
      apiKey,
    });
  } else {
    attributionSkipped = true;
  }

  memory.updatedAt = now;
  memory.results = appendLimited(memory.results, [resultRecord], 500);
  memory.platformIndustryRules = appendLimited(memory.platformIndustryRules, attribution ? [attribution] : [], 300);
  await writeJsonFile(platformResultMemoryPath, memory);

  sendJson(res, 200, {
    status: "recorded",
    record: resultRecord,
    attribution,
    attributionSkipped,
    message: attributionSkipped ? "已预留并记录投放结果；缺少 OPENAI_API_KEY，暂未做投放归因。" : "已记录投放结果，并更新平台/行业记忆。",
  });
}

async function handleMemory(req, res) {
  sendJson(res, 200, await loadMemoryBundle());
}

function handleConfig(req, res) {
  sendJson(res, 200, {
    hasServerApiKey: !!env.OPENAI_API_KEY,
    acceptsUserApiKey: true,
    textModel,
    imageModel,
    imageSize,
    port: currentPort,
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    status: "ok",
    service: "native-ad-cover-mvp",
    hasServerApiKey: !!env.OPENAI_API_KEY,
    acceptsUserApiKey: true,
    time: new Date().toISOString(),
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${currentPort}`);
  const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".png": "image/png",
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/generate") {
        await handleGenerate(req, res);
        return;
      }
      if (req.method === "GET" && req.url === "/api/memory") {
        await handleMemory(req, res);
        return;
      }
      if (req.method === "GET" && req.url === "/api/config") {
        handleConfig(req, res);
        return;
      }
      if (req.method === "GET" && req.url === "/api/health") {
        handleHealth(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/feedback") {
        await handleFeedback(req, res);
        return;
      }
      if (req.method === "POST" && req.url === "/api/platform-result") {
        await handlePlatformResult(req, res);
        return;
      }
      await serveStatic(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "未知错误" });
    }
  });
}

function listen(portToTry) {
  currentPort = portToTry;
  const appServer = createAppServer();
  appServer.once("error", (error) => {
    if (error.code === "EADDRINUSE" && portToTry < preferredPort + 20) {
      console.log(`Port ${portToTry} is busy, trying ${portToTry + 1}...`);
      listen(portToTry + 1);
      return;
    }
    throw error;
  });
  appServer.listen(portToTry, () => {
    console.log(`Native ad cover MVP running at http://localhost:${portToTry}`);
  });
}

listen(preferredPort);
