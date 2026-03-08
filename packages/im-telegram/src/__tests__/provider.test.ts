import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramIMProvider, telegramSchema } from "../index.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function tgResponse(result: any, ok = true) {
  return {
    ok: true,
    json: () => Promise.resolve({ ok, result }),
  };
}

describe("TelegramIMProvider", () => {
  let provider: TelegramIMProvider;

  beforeEach(() => {
    provider = new TelegramIMProvider();
    mockFetch.mockReset();
  });

  it("has correct metadata", () => {
    expect(provider.name).toBe("telegram");
    expect(provider.schema.category).toBe("im");
    expect(provider.schema.displayName).toBe("Telegram Bot");
  });

  it("schema has required fields", () => {
    const required = telegramSchema.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toContain("botToken");
    expect(required).toContain("chatId");
  });

  describe("send", () => {
    it("no-op when chatId missing", async () => {
      await provider.send({ botToken: "tok" }, "ISS-1", "hello");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("no-op when botToken missing", async () => {
      await provider.send({ chatId: "123" }, "ISS-1", "hello");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("creates topic then sends message when no existing topic", async () => {
      // createForumTopic
      mockFetch.mockResolvedValueOnce(tgResponse({ message_thread_id: 777 }));
      // sendMessage (pin intro)
      mockFetch.mockResolvedValueOnce(tgResponse({ message_id: 100 }));
      // pinChatMessage
      mockFetch.mockResolvedValueOnce(tgResponse(true));
      // sendMessage (the actual message)
      mockFetch.mockResolvedValueOnce(tgResponse({ message_id: 101 }));

      const onTopicCreated = vi.fn();
      provider.onTopicCreated = onTopicCreated;

      await provider.send({ botToken: "tok", chatId: "123" }, "ISS-1", "hello");

      expect(onTopicCreated).toHaveBeenCalledWith("ISS-1", "777");
      // Last call should be sendMessage with the actual message
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toContain("/sendMessage");
      const body = JSON.parse(lastCall[1].body);
      expect(body.text).toBe("hello");
      expect(body.message_thread_id).toBe(777);
    });

    it("uses existing topic from getTopicId callback", async () => {
      provider.getTopicId = vi.fn().mockReturnValue("555");
      // sendMessage
      mockFetch.mockResolvedValueOnce(tgResponse({ message_id: 101 }));

      await provider.send({ botToken: "tok", chatId: "123" }, "ISS-1", "hi");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message_thread_id).toBe(555);
      expect(body.chat_id).toBe("123");
    });

    it("sends HTML parse mode", async () => {
      provider.getTopicId = vi.fn().mockReturnValue("555");
      mockFetch.mockResolvedValueOnce(tgResponse({}));

      await provider.send({ botToken: "tok", chatId: "123" }, "ISS-1", "<b>bold</b>");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.parse_mode).toBe("HTML");
    });
  });

  describe("ensureTopic", () => {
    it("returns existing topic ID without API call", async () => {
      provider.getTopicId = vi.fn().mockReturnValue("existing-42");

      const result = await provider.ensureTopic!({ botToken: "tok", chatId: "123" }, "ISS-1", "Title");
      expect(result).toBe("existing-42");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("creates new topic and returns ID", async () => {
      provider.getTopicId = vi.fn().mockReturnValue(null);
      const onTopicCreated = vi.fn();
      provider.onTopicCreated = onTopicCreated;

      // createForumTopic
      mockFetch.mockResolvedValueOnce(tgResponse({ message_thread_id: 999 }));
      // sendMessage (pin)
      mockFetch.mockResolvedValueOnce(tgResponse({ message_id: 50 }));
      // pinChatMessage
      mockFetch.mockResolvedValueOnce(tgResponse(true));

      const result = await provider.ensureTopic!({ botToken: "tok", chatId: "123" }, "ISS-1", "My Topic");
      expect(result).toBe("999");
      expect(onTopicCreated).toHaveBeenCalledWith("ISS-1", "999");

      // Verify topic name sent to API
      const createBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(createBody.name).toBe("My Topic");
    });

    it("truncates topic name to 128 chars", async () => {
      provider.getTopicId = vi.fn().mockReturnValue(null);
      mockFetch.mockResolvedValueOnce(tgResponse({ message_thread_id: 1 }));
      mockFetch.mockResolvedValueOnce(tgResponse({ message_id: 1 }));
      mockFetch.mockResolvedValueOnce(tgResponse(true));

      const longTitle = "A".repeat(200);
      await provider.ensureTopic!({ botToken: "tok", chatId: "123" }, "ISS-1", longTitle);

      const createBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(createBody.name).toHaveLength(128);
    });

    it("returns null when config incomplete", async () => {
      const result = await provider.ensureTopic!({}, "ISS-1", "Title");
      expect(result).toBeNull();
    });
  });

  describe("closeTopic", () => {
    it("calls closeForumTopic API", async () => {
      provider.getTopicId = vi.fn().mockReturnValue("333");
      mockFetch.mockResolvedValueOnce(tgResponse(true));

      await provider.closeTopic!({ botToken: "tok", chatId: "123" }, "ISS-1");

      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0][0]).toContain("/closeForumTopic");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.message_thread_id).toBe(333);
      expect(body.chat_id).toBe("123");
    });

    it("no-op when no topic exists", async () => {
      provider.getTopicId = vi.fn().mockReturnValue(null);
      await provider.closeTopic!({ botToken: "tok", chatId: "123" }, "ISS-1");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("no-op when config incomplete", async () => {
      await provider.closeTopic!({}, "ISS-1");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
