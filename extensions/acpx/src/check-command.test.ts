import { describe, expect, it } from "vitest";
import { buildCheckCommandArgs } from "./check-command.js";

describe("raycheck command", () => {
  it("builds checklist CRUD commands", () => {
    expect(buildCheckCommandArgs("help")).toEqual(["checklist-help"]);
    expect(buildCheckCommandArgs("list")).toEqual(["checklist-list"]);
    expect(buildCheckCommandArgs("list templates")).toEqual(["checklist-list", "--templates"]);
    expect(buildCheckCommandArgs("add 本周作业")).toEqual(["checklist-add", "--title", "本周作业"]);
    expect(buildCheckCommandArgs("add 外出携带清单 --template")).toEqual([
      "checklist-add",
      "--title",
      "外出携带清单",
      "--template",
    ]);
    expect(buildCheckCommandArgs("edit cl_a81f --title 新标题")).toEqual([
      "checklist-edit",
      "--match",
      "cl_a81f",
      "--title",
      "新标题",
    ]);
    expect(buildCheckCommandArgs("remove cl_a81f")).toEqual([
      "checklist-remove",
      "--id",
      "cl_a81f",
    ]);
  });

  it("builds item commands with due and priority options", () => {
    expect(buildCheckCommandArgs("item add cl_a81f 完成数学作业")).toEqual([
      "checklist-item-add",
      "--checklist-id",
      "cl_a81f",
      "--title",
      "完成数学作业",
    ]);
    expect(buildCheckCommandArgs("item add cl_a81f 整理书包 --due 2026-09-12 --priority")).toEqual([
      "checklist-item-add",
      "--checklist-id",
      "cl_a81f",
      "--title",
      "整理书包",
      "--due",
      "2026-09-12",
      "--priority",
    ]);
    expect(
      buildCheckCommandArgs("item edit cl_a81f ci_a81f --title 新内容 --due 2026-09-13 --priority"),
    ).toEqual([
      "checklist-item-edit",
      "--checklist-id",
      "cl_a81f",
      "--item-id",
      "ci_a81f",
      "--title",
      "新内容",
      "--due",
      "2026-09-13",
      "--priority",
    ]);
    expect(buildCheckCommandArgs("item edit cl_a81f ci_a81f --no-due --normal")).toEqual([
      "checklist-item-edit",
      "--checklist-id",
      "cl_a81f",
      "--item-id",
      "ci_a81f",
      "--no-due",
      "--normal",
    ]);
    expect(buildCheckCommandArgs("item remove cl_a81f ci_a81f")).toEqual([
      "checklist-item-remove",
      "--checklist-id",
      "cl_a81f",
      "--item-id",
      "ci_a81f",
    ]);
  });

  it("joins unquoted titles and accepts unicode option dashes", () => {
    expect(buildCheckCommandArgs("add 外出 携带 清单 —template")).toEqual([
      "checklist-add",
      "--title",
      "外出 携带 清单",
      "--template",
    ]);
    expect(buildCheckCommandArgs("item add cl_a81f 整理书包 —due 2026-09-12")).toEqual([
      "checklist-item-add",
      "--checklist-id",
      "cl_a81f",
      "--title",
      "整理书包",
      "--due",
      "2026-09-12",
    ]);
  });

  it("rejects malformed commands before invoking the wrapper", () => {
    expect(() => buildCheckCommandArgs("add")).toThrow("Usage: /raycheck add");
    expect(() => buildCheckCommandArgs("edit cl_a81f")).toThrow("--title");
    expect(() => buildCheckCommandArgs("remove 本周作业 额外参数")).toThrow("remove");
    expect(() => buildCheckCommandArgs("item edit cl_a81f ci_a81f")).toThrow("field option");
    expect(() =>
      buildCheckCommandArgs("item edit cl_a81f ci_a81f --due 2026-09-12 --no-due"),
    ).toThrow("cannot be combined");
    expect(() => buildCheckCommandArgs("item add cl_a81f 整理 --unknown")).toThrow(
      "Unknown option",
    );
  });
});
