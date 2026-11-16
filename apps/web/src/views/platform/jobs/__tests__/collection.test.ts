/** collection.ts 纯函数测试：关键词拆分与采集摘要。 */

import { describe, expect, it } from "vitest";

import { collectionSummary, emptyCollectionConfig, MAX_KEYWORDS, parseKeywords } from "@/views/platform/jobs/collection";

describe("parseKeywords", () => {
  it("中英文逗号/顿号/分号/换行都算分隔，去空去重保序", () => {
    expect(parseKeywords("后端开发，AI应用,Python、全栈")).toEqual([
      "后端开发", "AI应用", "Python", "全栈",
    ]);
    expect(parseKeywords("a,,b\nc；；a")).toEqual(["a", "b", "c"]);
  });

  it("空输入回空列表；超出上限截断", () => {
    expect(parseKeywords("")).toEqual([]);
    expect(parseKeywords(undefined)).toEqual([]);
    const many = Array.from({ length: 15 }, (_, i) => `词${i}`);
    expect(parseKeywords(many.join(","))).toHaveLength(MAX_KEYWORDS);
  });
});

describe("collectionSummary", () => {
  it("单个关键词照旧显示原样", () => {
    const cfg = emptyCollectionConfig();
    cfg.search.query = "后端开发";
    expect(collectionSummary(cfg)).toContain("关键词「后端开发」");
  });

  it("多个关键词按分隔符拆开、顿号连接并报数量", () => {
    const cfg = emptyCollectionConfig();
    cfg.search.query = "后端开发,AI应用，Python";
    const summary = collectionSummary(cfg);
    expect(summary).toContain("关键词 3 个「后端开发、AI应用、Python」");
    expect(summary).toContain("最多 5 页");
  });
});
