const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API 密钥",
    value: "",
    props: {
      type: "password",
      showPassword: true,
      autocomplete: "off",
      placeholder: "即梦 sessionid，或 m2a_ 开头的 Muse2API 管理密钥",
    },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "服务地址",
    value: "http://127.0.0.1:8010",
    props: { placeholder: "http://127.0.0.1:8010（jimeng-free-api-all 的地址）" },
  },
] as const;

const version = "2.0.0";

const POLL_INTERVAL_MS = 3000;
const POLL_SLOW_INTERVAL_MS = 5000;
const VIDEO_TIMEOUT_MS = 20 * 60_000;
const IMAGE_TIMEOUT_MS = 10 * 60_000;

type ApiPayload = Record<string, any>;

/** 服务地址允许用户误填 /v1，这里统一还原成根地址。 */
function normalizeBase(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || "http://127.0.0.1:8010").replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** 参考素材统一成 URL / data URL；本服务两种都接受。 */
function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function messageOf(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const data = payload as ApiPayload;
  for (const key of ["message", "msg", "detail", "error"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && typeof (value as ApiPayload).message === "string" && (value as ApiPayload).message.trim()) {
      return String((value as ApiPayload).message).trim();
    }
  }
  return fallback;
}

async function readPayload(response: any, fallback: string) {
  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) throw new Error(messageOf(payload, `${fallback}（HTTP ${response.status}）`));
  // jimeng-free-api-all 的失败响应可能仍是 HTTP 200，用 code 判断。
  if (payload && typeof payload === "object" && typeof payload.code === "number" && payload.code !== 0) {
    throw new Error(messageOf(payload, fallback));
  }
  return payload;
}

function wait(signal: AbortSignal | undefined, ms: number) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Toonflow 的 size 既可能是 1K/2K/4K，也可能是 1024x1024，分别映射到 resolution / size。 */
function imageParams(request: ImageRequest) {
  const size = typeof request.size === "string" ? request.size.trim() : "";
  const ratio = typeof request.ratio === "string" ? request.ratio.trim() : "";
  const params: Record<string, unknown> = {};
  if (/^(1k|2k|4k)$/i.test(size)) params.resolution = size.toLowerCase();
  else if (size) params.size = size;
  if (ratio) params.ratio = ratio;
  return params;
}

/** 直接取字节时按文件头修正 MIME，避免把 webp 存成 png。 */
function imageMimeOf(base64: string) {
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

function videoUrlOf(payload: ApiPayload) {
  const candidates = [payload?.url, payload?.result?.url, payload?.data?.[0]?.url, payload?.video?.url];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return "";
}

/**
 * 优先从聚合服务的 /content 取回字节：Muse2API 的媒体直链是服务端本地地址，
 * Docker 里的 Toonflow 下载不到；旧版服务没有该接口时回退到直链。
 */
async function videoAsset(context: ProviderContext, baseUrl: string, apiKey: string, taskId: string, url: string, signal: AbortSignal): Promise<MediaAsset> {
  try {
    const response = await context.tool.fetch(`${baseUrl}/v1/videos/${encodeURIComponent(taskId)}/content`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length) {
        const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
        return { mediaType: "video", type: "binary", data: bytes, mimeType };
      }
    }
  } catch {
    // 直链回退
  }
  return { mediaType: "video", type: "url", url };
}

async function pollVideo(context: ProviderContext, baseUrl: string, apiKey: string, taskId: string, signal: AbortSignal) {
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const response = await context.tool.fetch(`${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const payload = await readPayload(response, "查询视频任务失败");
    const status = String(payload?.status ?? "").toLowerCase();
    const url = videoUrlOf(payload);
    if (url && status !== "failed" && status !== "error") return url;
    if (status === "failed" || status === "error") {
      throw Object.assign(new Error(messageOf(payload, "视频生成失败")), { code: "MEDIA_TASK_FAILED" });
    }
    await wait(signal, attempt < 10 ? POLL_INTERVAL_MS : POLL_SLOW_INTERVAL_MS);
  }
  throw new Error("视频生成超时（20 分钟），请稍后到服务端确认该任务是否已完成");
}

export default {
  id: "jimengFreeApi",
  label: "即梦聚合（Jimeng / Muse2API）",
  version,
  readme: `把自建的 [jimeng-free-api-all](https://github.com/zhizinan1997/jimeng-free-api-all) 接成 Toonflow 的媒体模型：图片走 \`/v1/images/generations\`，视频走 \`/v1/videos\` + 轮询，Muse2API 模型也可一起使用。

- **服务地址**：jimeng-free-api-all 的根地址，默认 \`http://127.0.0.1:8010\`；Toonflow 服务端必须能访问它。Docker 部署时不要填浏览器里的 \`localhost\`，要填容器可达的地址（同网络用容器名，跨网络用宿主机网关）。
- **API 密钥**：即梦模型填即梦官网 Cookie 里的 \`sessionid\`；Muse2API 的 \`muse:*\` 模型可以填 \`m2a_\` 开头的管理密钥（也可留空，由服务端管理台配置兜底）。
- **图片**：支持文生图、单图/多图参考；\`1K/2K/4K\` 会映射为服务的 \`resolution\`，\`1024x1024\` 这类尺寸会原样传给 \`size\`。
- **视频**：使用异步任务并在适配器内轮询到完成，不会只返回任务 ID；服务重启后可通过任务恢复继续查询原任务。
- Muse2API 的视频模型按“参考图”方式传素材，首帧会排在参考图前面。`,
  rules,
  models: [
    {
      id: "jimeng-image-5.0-lite",
      label: "即梦 5.0 Lite（文生图 / 多参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "4K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-image-4.7",
      label: "即梦 4.7（文生图 / 多参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "4K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-image-4.6",
      label: "即梦 4.6（文生图 / 多参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "4K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-image-4.5",
      label: "即梦 4.5（文生图 / 多参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "4K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-image-4.1",
      label: "即梦 4.1（文生图 / 多参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "4K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-image-4.0",
      label: "即梦 4.0（文生图 / 多参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["2K", "4K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-image-3.1",
      label: "即梦 3.1（文生图 / 参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-image-3.0",
      label: "即梦 3.0（文生图 / 参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-image-2.0-pro",
      label: "即梦 2.0 Pro（文生图 / 参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "muse:image",
      label: "Muse Image（文生图 / 多参考图）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1024x1024", "1536x1024", "1024x1536", "2048x2048"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
    {
      id: "jimeng-video-seedance-2.0-mini",
      label: "即梦 Seedance 2.0 Mini",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p"] }],
    },
    {
      id: "jimeng-video-seedance-2.0-fast",
      label: "即梦 Seedance 2.0 Fast",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p"] }],
    },
    {
      id: "jimeng-video-seedance-2.0-pro",
      label: "即梦 Seedance 2.0 Pro",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p", "1080p", "4k"] }],
    },
    {
      id: "jimeng-video-seedance-1.5-pro",
      label: "即梦 Seedance 1.5 Pro",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p"] }],
    },
    {
      id: "jimeng-video-3.0-pro",
      label: "即梦视频 3.0 Pro",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["1080p"] }],
    },
    {
      id: "jimeng-video-3.0",
      label: "即梦视频 3.0",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p"] }],
    },
    {
      id: "jimeng-video-3.0-fast",
      label: "即梦视频 3.0 Fast",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p", "1080p"] }],
    },
    {
      id: "jimeng-video-s2.0",
      label: "即梦视频 S2.0（仅 5 秒）",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
    },
    {
      id: "jimeng-video-2.0-pro",
      label: "即梦视频 2.0 Pro（仅 5 秒）",
      type: "video",
      mode: ["text", "singleImage", "endFrameOptional"],
      durationResolutionMap: [{ duration: [5], resolution: ["720p"] }],
    },
    {
      id: "muse:video",
      label: "Muse Video（文生 / 参考图生视频）",
      type: "video",
      mode: ["text", "singleImage", ["imageReference:10"]],
      durationResolutionMap: [{ duration: [5, 10], resolution: ["720p", "1080p"] }],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const apiKey = String(this.config.apiKey ?? "").trim();
    if (!apiKey) throw new Error("请填写 API 密钥");
    const baseUrl = normalizeBase(this.config.baseUrl);
    const signal = AbortSignal.any([AbortSignal.timeout(IMAGE_TIMEOUT_MS), ...(this.signal ? [this.signal] : [])]);
    const images = (request.images ?? []).map(mediaUrl);
    // Muse2API 的媒体地址是服务端本地地址，Docker 里的 Toonflow 下载不到，直接要 base64。
    const wantsBase64 = request.model.toLowerCase().startsWith("muse:");

    const response = await this.tool.fetch(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        ...(request.n && request.n > 1 ? { n: Math.min(4, request.n) } : {}),
        ...imageParams(request),
        ...(images.length ? { images } : {}),
        response_format: wantsBase64 ? "b64_json" : "url",
      }),
      signal,
    });
    const payload = await readPayload(response, "图片生成失败");

    const assets: MediaAsset[] = [];
    for (const item of Array.isArray(payload?.data) ? payload.data : []) {
      const url = typeof item?.url === "string" ? item.url.trim() : "";
      const base64 = typeof item?.b64_json === "string" ? item.b64_json.trim() : "";
      if (url) assets.push({ mediaType: "image", type: "url", url });
      else if (base64) assets.push({ mediaType: "image", type: "base64", data: base64, mimeType: imageMimeOf(base64) });
    }
    if (!assets.length) throw new Error("接口未返回图片结果");
    return assets;
  },
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const apiKey = String(this.config.apiKey ?? "").trim();
    if (!apiKey) throw new Error("请填写 API 密钥");
    const baseUrl = normalizeBase(this.config.baseUrl);
    const signal = AbortSignal.any([AbortSignal.timeout(VIDEO_TIMEOUT_MS + 60_000), ...(this.signal ? [this.signal] : [])]);

    const frames: string[] = [];
    if (request.firstFrame) frames.push(mediaUrl(request.firstFrame));
    if (request.lastFrame) frames.push(mediaUrl(request.lastFrame));
    const images = (request.images ?? []).map(mediaUrl);
    const isMuse = request.model.toLowerCase().startsWith("muse:");

    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      ...(request.duration ? { duration: request.duration } : {}),
      ...(request.ratio ? { ratio: request.ratio } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
    };
    if (isMuse) {
      // Muse2API 没有独立的尾帧参数，首帧排在最前，其余作为参考图。
      const references = [...frames, ...images];
      if (references.length) body.images = references;
    } else if (frames.length) {
      // 首尾帧模式：不能再夹杂额外参考图，否则会被服务端当成首尾帧。
      if (images.length) throw new Error("当前即梦视频模型不支持额外参考图，请改用首帧 / 尾帧模式");
      body.file_paths = frames;
    } else if (images.length) {
      // 单图/多图参考模式：服务端按顺序取前两张作为首帧、尾帧。
      body.file_paths = images.slice(0, 2);
    }

    const response = await this.tool.fetch(`${baseUrl}/v1/videos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = await readPayload(response, "提交视频任务失败");
    const taskId = typeof payload?.id === "string" ? payload.id.trim() : "";
    if (!taskId) throw new Error("提交视频任务未返回任务 ID");

    await this.saveTaskData?.({
      kind: "video",
      taskId,
      model: request.model,
      baseUrlHash: String(this.tool.hash(baseUrl)),
    });

    const url = await pollVideo(this, baseUrl, apiKey, taskId, signal);
    return [await videoAsset(this, baseUrl, apiKey, taskId, url, signal)];
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    const baseUrl = normalizeBase(this.config.baseUrl);
    if (data.kind !== "video" || typeof data.taskId !== "string" || !data.taskId || typeof data.model !== "string"
      || data.baseUrlHash !== String(this.tool.hash(baseUrl))) {
      throw new Error("视频任务恢复数据无效或服务地址已变更");
    }
    const apiKey = String(this.config.apiKey ?? "").trim();
    if (!apiKey) throw new Error("请填写 API 密钥");
    const signal = AbortSignal.any([AbortSignal.timeout(VIDEO_TIMEOUT_MS + 60_000), ...(this.signal ? [this.signal] : [])]);
    const url = await pollVideo(this, baseUrl, apiKey, data.taskId, signal);
    return [await videoAsset(this, baseUrl, apiKey, data.taskId, url, signal)];
  },
} satisfies ProviderDefinition<typeof rules>;
