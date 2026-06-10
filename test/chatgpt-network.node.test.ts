import { describe, expect, test, vi } from "vitest";
import { chatgptNetworkConfig } from "@/adapters/chatgpt";
import type { NetworkPayload } from "@/adapters/strategies/network";

describe("ChatGPT network capture", () => {
  test("does not match the sidebar conversations endpoint", () => {
    const url = "https://chatgpt.com/backend-api/conversations?offset=0&limit=28";

    expect(chatgptNetworkConfig.urlPatterns.some((pattern) => pattern.test(url))).toBe(false);
  });

  test("rejects non-thread conversation endpoints that would produce fallback net ids", () => {
    withLocation("/c/00000000-0000-4000-8000-000000000000", () => {
      const exchanges = chatgptNetworkConfig.parse(
        payload({
          url: "https://chatgpt.com/backend-api/conversation/experimental",
          responseText: JSON.stringify({
            id: "experimental",
            message: "i prefer to explore historical places, what are some interesting spots?",
          }),
        }),
      );

      expect(exchanges).toEqual([]);
    });
  });

  test("captures assistant turns for the active thread", () => {
    const threadId = "11111111-2222-4333-8444-555555555555";
    withLocation(`/c/${threadId}`, () => {
      const exchanges = chatgptNetworkConfig.parse(
        payload({
          requestText: JSON.stringify({
            messages: [
              {
                author: { role: "user" },
                content: { parts: ["Remember that I prefer poha for breakfast."] },
              },
            ],
          }),
          responseText: JSON.stringify({
            conversation_id: threadId,
            message: {
              id: "msg_abc",
              author: { role: "assistant" },
              content: { parts: ["Saved that you prefer poha for breakfast."] },
            },
          }),
        }),
      );

      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]).toMatchObject({
        provider: "chatgpt",
        threadId,
        messageId: "msg_abc",
        userText: "Remember that I prefer poha for breakfast.",
        assistantText: "Saved that you prefer poha for breakfast.",
      });
    });
  });
});

function payload(overrides: Partial<NetworkPayload>): NetworkPayload {
  return {
    url: "https://chatgpt.com/backend-api/conversation",
    method: "POST",
    requestText: "",
    responseText: "",
    transport: "fetch",
    ts: 1,
    ...overrides,
  };
}

function withLocation(pathname: string, fn: () => void): void {
  vi.stubGlobal("location", {
    origin: "https://chatgpt.com",
    pathname,
  });
  try {
    fn();
  } finally {
    vi.unstubAllGlobals();
  }
}
