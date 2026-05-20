import { describe, expect, it } from "vitest";
import { buildExcerptCommandArgs } from "./excerpt-command.js";

describe("excerpt command", () => {
  it("splits on full-width semicolon", () => {
    expect(buildExcerptCommandArgs("笑傲江湖；金庸的代表作之一")).toEqual([
      "book-excerpt",
      "--title",
      "笑傲江湖",
      "--text",
      "金庸的代表作之一",
    ]);
  });

  it("splits on half-width semicolon", () => {
    expect(buildExcerptCommandArgs("Sapiens;A brief history of humankind")).toEqual([
      "book-excerpt",
      "--title",
      "Sapiens",
      "--text",
      "A brief history of humankind",
    ]);
  });

  it("only splits on the first separator and preserves later separators in text", () => {
    expect(buildExcerptCommandArgs("笑傲江湖；第一段感受；夹杂的另一个；分号都保留")).toEqual([
      "book-excerpt",
      "--title",
      "笑傲江湖",
      "--text",
      "第一段感受；夹杂的另一个；分号都保留",
    ]);
  });

  it("preserves multiline content", () => {
    const input = "笑傲江湖；第一行\n第二行\n第三行";
    expect(buildExcerptCommandArgs(input)).toEqual([
      "book-excerpt",
      "--title",
      "笑傲江湖",
      "--text",
      "第一行\n第二行\n第三行",
    ]);
  });

  it("keeps 《》 in title as-is for downstream normalization", () => {
    expect(buildExcerptCommandArgs("《鹿鼎记》；继续追看")).toEqual([
      "book-excerpt",
      "--title",
      "《鹿鼎记》",
      "--text",
      "继续追看",
    ]);
  });

  it("rejects empty input", () => {
    expect(() => buildExcerptCommandArgs("")).toThrow("Usage: /excerpt");
    expect(() => buildExcerptCommandArgs(undefined)).toThrow("Usage: /excerpt");
  });

  it("rejects input without a separator", () => {
    expect(() => buildExcerptCommandArgs("笑傲江湖")).toThrow("Usage: /excerpt");
  });

  it("rejects empty title or empty text", () => {
    expect(() => buildExcerptCommandArgs("；正文")).toThrow("书名");
    expect(() => buildExcerptCommandArgs("笑傲江湖；")).toThrow("内容");
  });
});
