import {
  assertOkOrThrowHttpError,
  buildAudioTranscriptionFormData,
  postTranscriptionRequest,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "./shared.js";
import type { AudioTranscriptionRequest, AudioTranscriptionResult } from "./types.js";

type OpenAiCompatibleAudioParams = AudioTranscriptionRequest & {
  defaultBaseUrl: string;
  defaultModel: string;
  provider?: string;
};

function resolveModel(model: string | undefined, fallback: string): string {
  const trimmed = model?.trim();
  return trimmed || fallback;
}

export async function transcribeOpenAiCompatibleAudio(
  params: OpenAiCompatibleAudioParams,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const { baseUrl, allowPrivateNetwork, headers } = resolveProviderHttpRequestConfig({
    baseUrl: params.baseUrl,
    defaultBaseUrl: params.defaultBaseUrl,
    headers: params.headers,
    request: params.request,
    defaultHeaders: {
      authorization: `Bearer ${params.apiKey}`,
    },
    provider: params.provider,
    api: "openai-audio-transcriptions",
    capability: "audio",
    transport: "media-understanding",
  });
  const url = `${baseUrl}/audio/transcriptions`;

  const model = resolveModel(params.model, params.defaultModel);
  const form = buildAudioTranscriptionFormData({
    buffer: params.buffer,
    fileName: params.fileName,
    mime: params.mime,
    fields: {
      model,
      language: params.language,
      prompt: params.prompt,
    },
  });

  // Skip dispatcherPolicy and disable DNS pinning so the SSRF guard does not
  // attach an undici dispatcher to the request.  Node 22's globalThis.fetch
  // delegates to undici when a dispatcher is present, and undici's FormData
  // serialisation produces multipart bodies that litellm-style proxies reject
  // with HTTP 400 "Invalid JSON payload".  SSRF IP validation still runs; only
  // the per-request dispatcher (and its side-effect on body encoding) is
  // removed.
  const { response: res, release } = await postTranscriptionRequest({
    url,
    headers,
    body: form,
    timeoutMs: params.timeoutMs,
    fetchFn,
    pinDns: false,
    allowPrivateNetwork,
    pinDns: false,
  });

  try {
    await assertOkOrThrowHttpError(res, "Audio transcription failed");

    const payload = await readProviderJsonObjectResponse(res, "Audio transcription failed");
    const text = requireTranscriptionText(
      typeof payload.text === "string" ? payload.text : undefined,
      "Audio transcription response missing text",
    );
    return { text, model };
  } finally {
    await release();
  }
}
