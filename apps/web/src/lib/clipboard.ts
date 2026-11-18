import axios from "axios";
import { actualPlatform } from "./platform";

const headers = { "x-toonflow-desktop": "1" };
let writingClipboard = false;

export function isWritingClipboard() {
  return writingClipboard;
}

function clipboardAccessDenied(): never {
  throw new DOMException("当前环境不支持读取剪贴板", "NotAllowedError");
}

function asyncClipboard() {
  const clipboard = navigator.clipboard;
  return window.isSecureContext && clipboard ? clipboard : undefined;
}

export async function readClipboardText(): Promise<string> {
  if (!actualPlatform.isDesktop) {
    const clipboard = asyncClipboard();
    if (!clipboard?.readText) clipboardAccessDenied();
    return clipboard.readText();
  }
  const { data } = await axios.post<{ code: number; data: { text: string }; message: string }>("/api/desktop/clipboard/read", {}, { headers });
  if (data.code !== 200) throw new Error(data.message || "读取剪贴板失败");
  return data.data.text;
}

export async function readClipboardImage(): Promise<Blob | null> {
  if (actualPlatform.isDesktop) {
    const { data } = await axios.post<{ code: number; data: { image: string | null }; message: string }>("/api/desktop/clipboard/read", { format: "image" }, { headers });
    if (data.code !== 200) throw new Error(data.message || "读取剪贴板图片失败");
    if (!data.data.image) return null;
    const binary = atob(data.data.image);
    return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: "image/png" });
  }
  const clipboard = asyncClipboard();
  if (!clipboard?.read) clipboardAccessDenied();
  for (const item of await clipboard.read()) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (imageType) return item.getType(imageType);
  }
  return null;
}

function clipboardFile(type: string, base64: string, name: string) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new File([bytes], name, { type });
}

export async function readClipboardFiles(): Promise<File[]> {
  if (actualPlatform.isDesktop) {
    const { data } = await axios.post<{ code: number; data: { files: { name: string; mimeType: string; data: string }[] }; message: string }>(
      "/api/desktop/clipboard/read",
      { format: "files" },
      { headers }
    );
    if (data.code !== 200) throw new Error(data.message || "读取剪贴板文件失败");
    return data.data.files.map(file => clipboardFile(file.mimeType, file.data, file.name));
  }
  const clipboard = asyncClipboard();
  if (!clipboard?.read) clipboardAccessDenied();
  const files: File[] = [];
  for (const item of await clipboard.read()) {
    for (const type of item.types.filter(type => /^(image|audio|video)\//.test(type))) {
      const extension = type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
      files.push(new File([await item.getType(type)], "pasted-media-" + (files.length + 1) + "." + extension, { type }));
    }
  }
  return files;
}

function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function imagePngBlob(image: Blob) {
  if (image.type === "image/png") return image;
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法处理图片");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片转换失败")), "image/png"));
  } finally {
    bitmap.close();
  }
}
export async function writeClipboardImage(image: Blob): Promise<void> {
  if (actualPlatform.isDesktop) {
    const { data } = await axios.post<{ code: number; message: string }>("/api/desktop/clipboard/write", {
      format: "image",
      image: await blobBase64(image),
    }, { headers });
    if (data.code !== 200) throw new Error(data.message || "写入剪贴板图片失败");
    return;
  }
  const png = await imagePngBlob(image);
  const clipboard = asyncClipboard();
  if (clipboard?.write) {
    await clipboard.write([new ClipboardItem({ "image/png": png })]);
    return;
  }
  // ACT: 局域网 HTTP 没有异步剪贴板，blob 文件也写不进系统剪贴板。data URL 的 HTML 可以在粘贴时还原成图片。
  await writeImageFallback(png);
}

export function imageBlobsFromClipboardHtml(html: string) {
  const blobs: Blob[] = [];
  const pattern = /<img\b[^>]*\bsrc=["'](data:image\/[a-z0-9.+-]+;base64,[^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const url = match[1];
    if (!url) continue;
    const mime = url.slice(5, url.indexOf(";"));
    try {
      const binary = atob(url.slice(url.indexOf(",") + 1));
      blobs.push(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: mime }));
    } catch {
      continue;
    }
  }
  return blobs;
}

async function writeImageFallback(image: Blob) {
  const html = `<img src="data:image/png;base64,${await blobBase64(image)}">`;
  let written = false;
  const onCopy = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data) return;
    data.setData("text/html", html);
    event.preventDefault();
    written = true;
  };
  document.addEventListener("copy", onCopy, true);
  writingClipboard = true;
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    writingClipboard = false;
    document.removeEventListener("copy", onCopy, true);
  }
  if (!copied || !written) throw new Error("当前环境不支持写入剪贴板图片");
}
function writeTextFallback(text: string) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;left:-10000px;top:0";
  document.body.append(area);
  const previous = document.activeElement;
  writingClipboard = true;
  let copied = false;
  try {
    area.focus();
    area.select();
    copied = document.execCommand("copy");
  } finally {
    writingClipboard = false;
    area.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
  if (!copied) throw new Error("当前环境不支持写入剪贴板");
}
export async function writeClipboardText(text: string): Promise<void> {
  if (!actualPlatform.isDesktop) {
    const clipboard = asyncClipboard();
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return;
    }
    writeTextFallback(text);
    return;
  }
  const { data } = await axios.post<{ code: number; message: string }>("/api/desktop/clipboard/write", { text }, { headers });
  if (data.code !== 200) throw new Error(data.message || "写入剪贴板失败");
}
