import { requiredEnv } from "./server-config";

type MoviderResponse = {
  code?: string;
  name?: string;
  description?: string;
  request_id?: string;
};

async function moviderPost(path: string, values: Record<string, string>) {
  const body = new URLSearchParams({
    ...values,
    api_key: requiredEnv("MOVIDER_API_KEY"),
    api_secret: requiredEnv("MOVIDER_API_SECRET"),
  });
  const base = process.env.MOVIDER_API_BASE_URL?.trim() ||
    "https://movider-api-gateway.1mobyline.com";
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const data = (await response.json()) as MoviderResponse;
  if (!response.ok || data.code || data.name) {
    throw new Error(data.description || data.name || "Movider request failed");
  }
  return data;
}

export async function requestSmsOtp(phone: string): Promise<string> {
  const data = await moviderPost("/v1/verify", {
    to: phone,
    code_length: "6",
    language: "en-gb",
    next_event_wait: "60",
    pin_expire: "300",
    tag: "creator-livetech-signup",
  });
  if (!data.request_id) throw new Error("Movider did not return request_id");
  return data.request_id;
}

export async function verifySmsOtp(requestId: string, code: string) {
  await moviderPost("/v1/acknowledge", {
    request_id: requestId,
    code,
  });
}
