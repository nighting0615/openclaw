import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import type { EmbeddedRunReplayMetadata } from "../replay-state.js";

export const EVIDENCE_GUARD_RETRY_INSTRUCTION =
  "The previous visible answer included a source-required claim without sufficient support, or it invented an explanation for an earlier mistake. Rewrite the final answer now. Only state facts supported by the current transcript, loaded files, or tool results. For location, nearby, distance, travel-time, or route claims, use current or recent same-session map/geocoding/routing tool results that match the exact locations; generic web search snippets are not enough. If no matching map result exists in the transcript, call a map/geocoding/routing tool before answering. If a fact needs verification and no source/tool result is available, say that it is not verified and do not guess. If explaining an earlier mistake, describe only observable facts such as missing tool/source checks; do not invent internal impressions, assumptions, or thought processes.";

const CHINESE_TEXT_RE = /[\u3400-\u9fff]/u;

const SAFE_UNCERTAINTY_RE =
  /(?:没有|无|缺少|找不到|未|没)(?:可验证|核验|核实|查证|来源|依据|证据)|(?:不能|无法|不应|不该)(?:确定|断言|当成事实|当作事实)|(?:not|no)\s+(?:verified|verifiable|sourced|source|evidence)|(?:cannot|can't)\s+(?:verify|confirm|say for sure|state as fact)|unverified/i;

const SELF_EXPLANATION_PROMPT_RE =
  /(?:哪来|哪儿来|从哪|来源|依据|证据|为什么|为啥|怎么会|怎么能|胡说|瞎编|乱说|编造|放屁|错了|犯错|道歉|印象|assumption|impression|source|evidence|why did you|made up|hallucinat)/i;

const INVENTED_SELF_EXPLANATION_RE =
  /(?:我(?:刚才|之前|当时)?[^。！？.!?\n]{0,18}(?:脑子里|印象|感觉|以为|估计|想当然|误把|理解成)|(?:按|凭)(?:感觉|印象)|糊上去|I\s+(?:thought|assumed|guessed|figured|had the impression))/i;

const LOCATION_PROMPT_RE =
  /(?:附近|周边|路线|骑行|车程|距离|开车|导航|路程|通勤|怎么去|适合.*骑|推荐.*(?:地点|地方|路线)|nearby|route|drive|driving|distance|cycling|bike ride|commute)/i;

const LOCATION_CLAIM_RE =
  /(?:\d+(?:\.\d+)?\s*(?:公里|千米|km|公里左右|分钟|小时|min|mins|minutes?|hours?|h)|车程|开车|步行|骑行|离你家|附近|周边|中距离|远|近|路线|公园|绿地|湖|景区|环湖|沿江|环线|drive|driving|distance|nearby|route)/i;

const MAP_TOOL_NAME_RE =
  /^(?:amap_|map_|maps_|google_maps_|geocode|reverse_geocode|route|routing|navigation)/i;

const MAP_TOOL_RESULT_TEXT_RE =
  /(?:"source"\s*:\s*"amap"|"tool"\s*:\s*"(?:amap_|map_|maps_|google_maps_|geocode|reverse_geocode|route|routing|navigation)|\b(?:amap_|map_|maps_|google_maps_|geocode|reverse_geocode|route|routing|navigation)[\w-]*)/i;

const CJK_RUN_RE = /[\u3400-\u9fff]{3,}/gu;

const ASCII_TOKEN_RE = /[a-z0-9][a-z0-9._-]{3,}/giu;

const GENERIC_EVIDENCE_TOKEN_RE =
  /^(?:route|routes|routing|distance|duration|minute|minutes|driving|walking|bicycling|cycling|nearby|source|amap|maps|google|request|response|result|origin|destination|geocode)$/iu;

const GENERIC_CJK_EVIDENCE_TOKEN_RE =
  /^(?:骑行|开车|步行|导航|路线|地图|距离|耗时|预计|主要|路段|必须|基于|附近|周边|分钟|小时|公里|结果|显示|来自|高德)/u;

const RECENT_MAP_EVIDENCE_MESSAGE_LIMIT = 16;

const MUTABLE_FACT_PROMPT_RE =
  /(?:最新|最近|今天|昨日|昨天|明天|现在|目前|实时|价格|票价|政策|规则|法律|医疗|天气|股票|汇率|CEO|总统|版本|发布|开放|营业|倒闭|停运|推荐.*(?:餐厅|景点|产品|店)|查|搜|核|current|latest|recent|today|price|policy|law|medical|weather|stock|exchange rate|release|open|closed|recommend)/i;

const MUTABLE_FACT_CLAIM_RE =
  /(?:\d|20\d{2}|目前|现在|已(?:经)?|开放|关闭|营业|停运|价格|票价|美元|人民币|公里|分钟|小时|排名|CEO|总统|版本|发布|支持|current|currently|latest|released|open|closed|price|rank|version)/i;

type EvidenceGuardViolationKind =
  | "invented_self_explanation"
  | "unsupported_location_claim"
  | "unsupported_mutable_fact";

export type EvidenceGuardDecision =
  | { action: "pass" }
  | {
      action: "revise";
      kind: EvidenceGuardViolationKind;
      reason: string;
      retryInstruction: string;
    }
  | {
      action: "fallback";
      kind: EvidenceGuardViolationKind;
      reason: string;
      text: string;
    };

export type EvidenceGuardAttempt = {
  toolMetas?: Array<{ toolName?: string; meta?: string }>;
  replayMetadata?: EmbeddedRunReplayMetadata | null;
  messagesSnapshot?: AgentMessage[];
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
};

export function joinEvidenceGuardPayloadText(
  payloads: readonly ReplyPayload[] | undefined,
): string {
  return (payloads ?? [])
    .map((payload) => (typeof payload.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function containsCjk(text: string): boolean {
  return CHINESE_TEXT_RE.test(text);
}

function hasSafeUncertainty(text: string): boolean {
  return SAFE_UNCERTAINTY_RE.test(text);
}

function hasCurrentTurnToolEvidence(attempt: EvidenceGuardAttempt): boolean {
  return (attempt.toolMetas ?? []).some(
    (entry) => typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
  );
}

function hasCurrentTurnMapEvidence(attempt: EvidenceGuardAttempt): boolean {
  return (attempt.toolMetas ?? []).some((entry) => {
    const toolName = typeof entry.toolName === "string" ? entry.toolName.trim() : "";
    return toolName.length > 0 && MAP_TOOL_NAME_RE.test(toolName);
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readStringField(record: Record<string, unknown>, fieldNames: readonly string[]): string {
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function valueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => valueText(entry))
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const text = readStringField(record, ["text", "content", "message", "summary"]);
  const fallback = jsonText(record);
  return [text, fallback].filter(Boolean).join("\n");
}

function messageToolName(message: AgentMessage): string {
  const record = asRecord(message);
  if (!record) {
    return "";
  }
  const direct = readStringField(record, ["toolName", "tool_name", "name", "tool"]);
  if (direct) {
    return direct;
  }
  const details = asRecord(record.details);
  return details ? readStringField(details, ["toolName", "tool_name", "name", "tool"]) : "";
}

function messageText(message: AgentMessage): string {
  const record = asRecord(message);
  if (!record) {
    return "";
  }
  return [
    valueText(record.content),
    valueText(record.details),
    valueText(record.metadata),
    readStringField(record, ["text", "message", "summary"]),
  ]
    .filter(Boolean)
    .join("\n");
}

function isMapToolResultMessage(message: AgentMessage): boolean {
  const record = asRecord(message);
  if (!record || record.role !== "toolResult") {
    return false;
  }
  const toolName = messageToolName(message);
  if (toolName && MAP_TOOL_NAME_RE.test(toolName)) {
    return true;
  }
  return MAP_TOOL_RESULT_TEXT_RE.test(messageText(message));
}

function addCjkEvidenceTokens(tokens: Set<string>, text: string): void {
  for (const match of text.matchAll(CJK_RUN_RE)) {
    const run = match[0];
    const maxSize = Math.min(8, run.length);
    for (let size = 3; size <= maxSize; size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        const token = run.slice(index, index + size);
        if (!GENERIC_CJK_EVIDENCE_TOKEN_RE.test(token)) {
          tokens.add(token);
        }
      }
    }
  }
}

function extractEvidenceTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  addCjkEvidenceTokens(tokens, text);
  for (const match of text.matchAll(ASCII_TOKEN_RE)) {
    const token = match[0].toLowerCase();
    if (!GENERIC_EVIDENCE_TOKEN_RE.test(token)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function hasSharedEvidenceToken(sourceTokens: Set<string>, evidenceText: string): boolean {
  if (sourceTokens.size === 0) {
    return false;
  }
  const evidenceTokens = extractEvidenceTokens(evidenceText);
  for (const token of sourceTokens) {
    if (evidenceTokens.has(token)) {
      return true;
    }
  }
  return false;
}

function hasRecentMatchingMapEvidence(params: {
  attempt: EvidenceGuardAttempt;
  prompt: string;
  assistantText: string;
}): boolean {
  const messages = params.attempt.messagesSnapshot ?? [];
  if (messages.length === 0) {
    return false;
  }
  const sourceTokens = extractEvidenceTokens(`${params.prompt}\n${params.assistantText}`);
  const recentMessages = messages.slice(-RECENT_MAP_EVIDENCE_MESSAGE_LIMIT);
  return recentMessages.some(
    (message) =>
      isMapToolResultMessage(message) && hasSharedEvidenceToken(sourceTokens, messageText(message)),
  );
}

function hasMapEvidenceForLocationClaim(params: {
  attempt: EvidenceGuardAttempt;
  prompt: string;
  assistantText: string;
}): boolean {
  return (
    hasCurrentTurnMapEvidence(params.attempt) ||
    hasRecentMatchingMapEvidence({
      attempt: params.attempt,
      prompt: params.prompt,
      assistantText: params.assistantText,
    })
  );
}

function shouldSkipGuard(params: {
  prompt: string;
  assistantText: string;
  trigger?: string;
  attempt: EvidenceGuardAttempt;
}): boolean {
  if (!params.assistantText.trim()) {
    return true;
  }
  if (params.trigger === "cron" || params.trigger === "heartbeat" || params.trigger === "memory") {
    return true;
  }
  if (
    params.attempt.didSendViaMessagingTool === true ||
    params.attempt.didSendDeterministicApprovalPrompt === true
  ) {
    return true;
  }
  return false;
}

function fallbackTextFor(prompt: string): string {
  return containsCjk(prompt)
    ? "我没有可验证来源，不能把这个当确定事实说。请让我先查来源，或提供可核验材料。"
    : "I do not have a verifiable source for that, so I cannot present it as a fact. Please let me check a source or provide verifiable material.";
}

function buildReviseDecision(params: {
  kind: EvidenceGuardViolationKind;
  reason: string;
  retryAttempts: number;
  prompt: string;
}): EvidenceGuardDecision {
  if (params.retryAttempts > 0) {
    return {
      action: "fallback",
      kind: params.kind,
      reason: params.reason,
      text: fallbackTextFor(params.prompt),
    };
  }
  return {
    action: "revise",
    kind: params.kind,
    reason: params.reason,
    retryInstruction: EVIDENCE_GUARD_RETRY_INSTRUCTION,
  };
}

export function evaluateEvidenceGuard(params: {
  prompt: string;
  assistantText: string;
  retryAttempts?: number;
  trigger?: string;
  attempt: EvidenceGuardAttempt;
}): EvidenceGuardDecision {
  const prompt = params.prompt.trim();
  const assistantText = params.assistantText.trim();
  const retryAttempts = Math.max(0, params.retryAttempts ?? 0);
  if (
    shouldSkipGuard({ prompt, assistantText, trigger: params.trigger, attempt: params.attempt })
  ) {
    return { action: "pass" };
  }

  if (SELF_EXPLANATION_PROMPT_RE.test(prompt) && INVENTED_SELF_EXPLANATION_RE.test(assistantText)) {
    return buildReviseDecision({
      kind: "invented_self_explanation",
      reason: "answer invented an internal explanation for an earlier mistake",
      retryAttempts,
      prompt,
    });
  }

  if (hasSafeUncertainty(assistantText)) {
    return { action: "pass" };
  }

  if (LOCATION_PROMPT_RE.test(prompt) && LOCATION_CLAIM_RE.test(assistantText)) {
    if (
      !hasMapEvidenceForLocationClaim({
        attempt: params.attempt,
        prompt,
        assistantText,
      })
    ) {
      return buildReviseDecision({
        kind: "unsupported_location_claim",
        reason:
          "location or route claim requires current or recent matching map/geocoding/routing evidence or explicit uncertainty",
        retryAttempts,
        prompt,
      });
    }
    return { action: "pass" };
  }

  const hasToolEvidence = hasCurrentTurnToolEvidence(params.attempt);
  if (hasToolEvidence) {
    return { action: "pass" };
  }

  if (MUTABLE_FACT_PROMPT_RE.test(prompt) && MUTABLE_FACT_CLAIM_RE.test(assistantText)) {
    return buildReviseDecision({
      kind: "unsupported_mutable_fact",
      reason: "mutable factual claim requires a source/tool result or explicit uncertainty",
      retryAttempts,
      prompt,
    });
  }

  return { action: "pass" };
}
