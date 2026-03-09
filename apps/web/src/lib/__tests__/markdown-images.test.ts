import { describe, it, expect } from "vitest";
import { extractImages, stripImages } from "../markdown-images";

describe("extractImages", () => {
  it("extracts single image URL", () => {
    const text = "some text ![alt](/api/projects/foo/tasks/images/img-1.png) more text";
    expect(extractImages(text)).toEqual(["/api/projects/foo/tasks/images/img-1.png"]);
  });

  it("extracts multiple images", () => {
    const text = "![a](url1.png) text ![b](url2.jpg)";
    expect(extractImages(text)).toEqual(["url1.png", "url2.jpg"]);
  });

  it("handles image glued to text (no space before !)", () => {
    const text = "skonczyc![screenshot](/api/projects/agentOrchestrator/tasks/images/img-86df448a.png)";
    expect(extractImages(text)).toEqual(["/api/projects/agentOrchestrator/tasks/images/img-86df448a.png"]);
  });

  it("returns empty for null", () => {
    expect(extractImages(null)).toEqual([]);
  });

  it("returns empty when no images", () => {
    expect(extractImages("just plain text")).toEqual([]);
  });

  it("handles empty alt text", () => {
    const text = "![](/images/test.png)";
    expect(extractImages(text)).toEqual(["/images/test.png"]);
  });
});

describe("stripImages", () => {
  it("removes image markdown and trims", () => {
    const text = "some text ![alt](url.png) more text";
    expect(stripImages(text)).toBe("some text  more text");
  });

  it("removes image glued to text", () => {
    const text = "skonczyc![screenshot](/api/projects/agentOrchestrator/tasks/images/img-86df448a.png)";
    expect(stripImages(text)).toBe("skonczyc");
  });

  it("removes multiple images", () => {
    const text = "![a](u1) hello ![b](u2) world";
    expect(stripImages(text)).toBe("hello  world");
  });

  it("handles text with only an image", () => {
    const text = "![screenshot](img.png)";
    expect(stripImages(text)).toBe("");
  });
});
