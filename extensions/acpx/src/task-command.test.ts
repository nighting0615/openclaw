import { describe, expect, it } from "vitest";
import { buildTaskCommandArgs } from "./task-command.js";

describe("task command", () => {
  it("builds deterministic add command args with due and cat", () => {
    expect(buildTaskCommandArgs("add 写周报 --due 明天 --cat work")).toEqual([
      "append",
      "--kind",
      "plan",
      "--text",
      "写周报；明天；#work",
    ]);
  });

  it("accepts common unicode dash variants for options", () => {
    expect(buildTaskCommandArgs("add 天城脚本审核 —due 明天 —cat work")).toEqual([
      "append",
      "--kind",
      "plan",
      "--text",
      "天城脚本审核；明天；#work",
    ]);
  });

  it("builds deterministic done and cancel command args", () => {
    expect(buildTaskCommandArgs("done 写周报")).toEqual([
      "task-update",
      "--match",
      "写周报",
      "--status",
      "done",
    ]);
    expect(buildTaskCommandArgs("cancel 写周报")).toEqual([
      "task-update",
      "--match",
      "写周报",
      "--status",
      "cancelled",
    ]);
  });

  it("builds deterministic edit command args", () => {
    expect(
      buildTaskCommandArgs('edit "旧任务" --title "新任务" --due 下周三 --cat personal'),
    ).toEqual([
      "task-edit",
      "--match",
      "旧任务",
      "--title",
      "新任务",
      "--due",
      "下周三",
      "--category",
      "personal",
    ]);
  });

  it("builds deterministic list command args", () => {
    expect(buildTaskCommandArgs("list")).toEqual(["tasks", "--group", "board"]);
    expect(buildTaskCommandArgs("list --cat memo")).toEqual([
      "tasks",
      "--group",
      "board",
      "--category",
      "memo",
    ]);
  });

  it("rejects unknown categories and unsupported actions", () => {
    expect(() => buildTaskCommandArgs("add 写周报 --cat 工作")).toThrow("--cat must be one of");
    expect(() => buildTaskCommandArgs("start 写周报")).toThrow("Usage: /task");
  });
});
