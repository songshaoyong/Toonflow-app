// 部分 OpenAI 兼容网关拒绝带自引用 $ref 的工具参数。运行时仍用原来的 Zod schema 校验，这里只改发出去的 JSON Schema。

type PayloadHook<Model> = (payload: unknown, model: Model) => unknown;

function pointer(parent: string, key: string) {
  return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function resolveRef(root: unknown, ref: string) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function breakRecursiveJsonSchema<T>(schema: T): T {
  const copy = structuredClone(schema);
  const visiting = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object" || visiting.has(path)) return;
    visiting.add(path);
    if (Array.isArray(node)) node.forEach((item, index) => walk(item, pointer(path, String(index))));
    else {
      const record = node as Record<string, unknown>;
      const ref = record.$ref;
      if (typeof ref === "string" && (visiting.has(ref) || ref === path || (ref !== "#" && path.startsWith(`${ref}/`)))) {
        delete record.$ref;
        if (typeof record.description !== "string") record.description = "任意 JSON 值";
      } else {
        if (typeof ref === "string") walk(resolveRef(copy, ref), ref);
        for (const [key, value] of Object.entries(record)) {
          if (key !== "$ref") walk(value, pointer(path, key));
        }
      }
    }
    visiting.delete(path);
  };
  walk(copy, "#");
  return copy;
}

export function sanitizeModelPayload(body: object) {
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as Record<string, unknown>;
    const fn = record.function;
    if (fn && typeof fn === "object") {
      const parameters = (fn as { parameters?: unknown }).parameters;
      if (parameters && typeof parameters === "object") (fn as { parameters: unknown }).parameters = breakRecursiveJsonSchema(parameters);
    }
    for (const key of ["parameters", "input_schema"] as const) {
      const parameters = record[key];
      if (parameters && typeof parameters === "object") record[key] = breakRecursiveJsonSchema(parameters);
    }
  }
}

export function installModelPayloadCompat<Model>(agent: { onPayload?: PayloadHook<Model> }) {
  const previous = agent.onPayload;
  agent.onPayload = async (payload, model) => {
    const next = await previous?.(payload, model);
    const body = next === undefined ? payload : next;
    if (body && typeof body === "object") sanitizeModelPayload(body);
    return body;
  };
}
