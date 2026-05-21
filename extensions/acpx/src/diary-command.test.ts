import { describe, expect, it } from "vitest";
import { buildDiaryCommandArgs, buildHabitCommandArgs } from "./diary-command.js";

describe("diary command", () => {
  it("builds deterministic append args for diary text entries", () => {
    expect(buildDiaryCommandArgs("thought 今天这个交互方式更顺手了", 1779320473000)).toEqual([
      "append",
      "--kind",
      "thought",
      "--text",
      "今天这个交互方式更顺手了",
      "--at",
      "1779320473000",
    ]);
    expect(buildDiaryCommandArgs("成就 把 cron 状态入口理顺了")).toEqual([
      "append",
      "--kind",
      "achievement",
      "--text",
      "把 cron 状态入口理顺了",
    ]);
  });

  it("builds deterministic frontmatter update args", () => {
    expect(buildDiaryCommandArgs("weight 170.2", 1779320473000)).toEqual([
      "weight",
      "--value",
      "170.2",
      "--at",
      "1779320473000",
    ]);
    expect(buildDiaryCommandArgs("情绪 平静")).toEqual(["mood", "--value", "平静"]);
    expect(buildDiaryCommandArgs("梗概 推进几个关键任务")).toEqual([
      "synopsis",
      "--value",
      "推进几个关键任务",
    ]);
  });

  it("supports habit through /habit and /diary habit", () => {
    expect(buildHabitCommandArgs("english", 1779320473000)).toEqual([
      "habit",
      "--name",
      "english",
      "--at",
      "1779320473000",
    ]);
    expect(buildHabitCommandArgs("英语")).toEqual(["habit", "--name", "english"]);
    expect(buildDiaryCommandArgs("habit 早睡完成", 1779291960000)).toEqual([
      "habit",
      "--name",
      "sleep",
      "--at",
      "1779291960000",
    ]);
  });

  it("preserves multiline payloads after the subcommand", () => {
    expect(buildDiaryCommandArgs("thought 第一行\n第二行")).toEqual([
      "append",
      "--kind",
      "thought",
      "--text",
      "第一行\n第二行",
    ]);
  });

  it("rejects malformed commands", () => {
    expect(() => buildDiaryCommandArgs("")).toThrow("Usage: /diary");
    expect(() => buildDiaryCommandArgs("thought")).toThrow("requires content");
    expect(() => buildDiaryCommandArgs("unknown value")).toThrow("Usage: /diary");
    expect(() => buildHabitCommandArgs("english done")).toThrow("Usage: /habit");
    expect(() => buildHabitCommandArgs("跑步")).toThrow("Usage: /habit");
  });
});
