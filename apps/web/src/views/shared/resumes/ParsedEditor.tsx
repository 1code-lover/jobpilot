/**
 * 解析八段的可编辑形态：每段行内改文本、增删改经历条目与技能标签。
 *
 * 编辑只改本地草稿（`draft`），点「保存」由外层调 `resumeApi.editParse` 落库；
 * 展示形态在 `chapters.tsx` 的 `ParsedChapters`，两处共享 `ParsedData` 形状。
 */

import { useMemo, useState } from "react";
import { Box, IconButton, Typography } from "@mui/material";

import { Button, TextField } from "@/components";
import { typeScale } from "@/theme/tokens";
import type { ParsedData, ParsedEntry } from "@/views/shared/resumes/types";

/** 可编辑解析数据的入参。 */
export interface ParsedEditorProps {
  data: ParsedData;
  /** 保存中（按钮转圈禁用） */
  saving: boolean;
  onSave: (data: ParsedData) => void;
  onCancel: () => void;
}

/** 段落小标题行：标题 + 右侧动作区。 */
function SecHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
      <Typography sx={{ ...typeScale.s, fontWeight: 590, color: "text.secondary", flex: 1 }}>
        {title}
      </Typography>
      {action}
    </Box>
  );
}

/** 一行文本字段的编辑：label + TextField。 */
function TextRow({
  label, value, onChange, multiline, rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  rows?: number;
}) {
  return (
    <TextField
      label={label}
      value={value}
      fullWidth
      multiline={multiline}
      rows={rows}
      size="small"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 经历条目编辑卡：period + 标题/副标题 + highlights 逐条改、增删。 */
function EntryCard({
  kind, entry, onChange, onRemove,
}: {
  kind: "work" | "project" | "education";
  entry: ParsedEntry;
  onChange: (next: ParsedEntry) => void;
  onRemove: () => void;
}) {
  const titleKey = kind === "work" ? "company" : kind === "project" ? "name" : "school";
  const subKey = kind === "work" ? "title" : kind === "project" ? "role" : "major";
  const title = entry[titleKey] ?? "";
  const sub = entry[subKey] ?? "";
  const degree = kind === "education" ? entry.degree ?? "" : "";
  const highlights = entry.highlights ?? [];

  const setField = (key: keyof ParsedEntry, value: string) =>
    onChange({ ...entry, [key]: value });
  const setHighlight = (i: number, value: string) =>
    onChange({ ...entry, highlights: highlights.map((h, j) => (j === i ? value : h)) });
  const addHighlight = () =>
    onChange({ ...entry, highlights: [...highlights, ""] });
  const removeHighlight = (i: number) =>
    onChange({ ...entry, highlights: highlights.filter((_, j) => j !== i) });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1, py: 1.5, borderTop: "1px solid", borderColor: "divider" }}>
      <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
        <Box sx={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
          <TextField size="small" label={kind === "work" ? "公司" : kind === "project" ? "项目名" : "学校"}
            value={title} onChange={(e) => setField(titleKey as keyof ParsedEntry, e.target.value)} />
          <TextField size="small" label={kind === "work" ? "职位" : kind === "project" ? "角色" : "专业"}
            value={sub} onChange={(e) => setField(subKey as keyof ParsedEntry, e.target.value)} />
        </Box>
        <IconButton size="small" aria-label="删除这条" onClick={onRemove} sx={{ color: "error.main" }}>✕</IconButton>
      </Box>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
        <TextField size="small" label="时间段" value={entry.period ?? ""}
          onChange={(e) => setField("period", e.target.value)} />
        {kind === "education" && (
          <TextField size="small" label="学历" value={degree}
            onChange={(e) => setField("degree", e.target.value)} />
        )}
      </Box>
      {kind !== "education" && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          {highlights.map((h, i) => (
            <Box key={i} sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
              <TextField size="small" fullWidth value={h} multiline rows={1}
                placeholder={`亮点 ${i + 1}`}
                onChange={(e) => setHighlight(i, e.target.value)} />
              <IconButton size="small" aria-label={`删除亮点 ${i + 1}`} onClick={() => removeHighlight(i)}
                sx={{ color: "text.secondary" }}>✕</IconButton>
            </Box>
          ))}
          <Button size="small" variant="plain" onClick={addHighlight} sx={{ alignSelf: "flex-start" }}>
            + 加一条亮点
          </Button>
        </Box>
      )}
    </Box>
  );
}

/** 解析八段的可编辑形态。 */
export function ParsedEditor({ data, saving, onSave, onCancel }: ParsedEditorProps) {
  const [draft, setDraft] = useState<ParsedData>(() => structuredClone(data));

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(data),
    [draft, data],
  );

  const basic = draft.basic ?? {};
  const intent = draft.intent ?? {};
  const setBasic = (k: string, v: string) => setDraft({ ...draft, basic: { ...basic, [k]: v } });
  const setIntent = (k: string, v: string) => setDraft({ ...draft, intent: { ...intent, [k]: v } });

  const setEntries = (kind: "work" | "project" | "education") => (list: ParsedEntry[]) =>
    setDraft({ ...draft, [kind]: list });
  const patchEntry = (kind: "work" | "project" | "education", i: number, next: ParsedEntry) => {
    const list = [...((draft[kind] as ParsedEntry[]) ?? [])];
    list[i] = next;
    setEntries(kind)(list);
  };
  const removeEntry = (kind: "work" | "project" | "education", i: number) => {
    setEntries(kind)(((draft[kind] as ParsedEntry[]) ?? []).filter((_, j) => j !== i));
  };
  const addEntry = (kind: "work" | "project" | "education", blank: ParsedEntry) => {
    setEntries(kind)([...((draft[kind] as ParsedEntry[]) ?? []), blank]);
  };

  const skills = draft.skills ?? [];
  const [skillDraft, setSkillDraft] = useState("");

  const addSkill = () => {
    const v = skillDraft.trim();
    if (v && !skills.includes(v)) setDraft({ ...draft, skills: [...skills, v] });
    setSkillDraft("");
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, mt: 2 }}>
      <Box>
        <SecHead title="基本信息" />
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
          <TextRow label="姓名" value={basic.name ?? ""} onChange={(v) => setBasic("name", v)} />
          <TextRow label="城市" value={basic.city ?? ""} onChange={(v) => setBasic("city", v)} />
          <TextRow label="电话" value={basic.phone ?? ""} onChange={(v) => setBasic("phone", v)} />
          <TextRow label="邮箱" value={basic.email ?? ""} onChange={(v) => setBasic("email", v)} />
        </Box>
      </Box>

      <Box>
        <SecHead title="求职意向" />
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1 }}>
          <TextRow label="岗位" value={intent.position ?? ""} onChange={(v) => setIntent("position", v)} />
          <TextRow label="城市" value={intent.city ?? ""} onChange={(v) => setIntent("city", v)} />
          <TextRow label="薪资" value={intent.salary ?? ""} onChange={(v) => setIntent("salary", v)} />
        </Box>
      </Box>

      <Box>
        <SecHead
          title="工作经历"
          action={
            <Button size="small" variant="plain"
              onClick={() => addEntry("work", { company: "", title: "", period: "", highlights: [] })}>
              + 加一段
            </Button>
          }
        />
        {((draft.work as ParsedEntry[]) ?? []).map((w, i) => (
          <EntryCard key={i} kind="work" entry={w}
            onChange={(next) => patchEntry("work", i, next)}
            onRemove={() => removeEntry("work", i)} />
        ))}
      </Box>

      <Box>
        <SecHead
          title="项目经历"
          action={
            <Button size="small" variant="plain"
              onClick={() => addEntry("project", { name: "", role: "", period: "", highlights: [] })}>
              + 加一段
            </Button>
          }
        />
        {((draft.project as ParsedEntry[]) ?? []).map((p, i) => (
          <EntryCard key={i} kind="project" entry={p}
            onChange={(next) => patchEntry("project", i, next)}
            onRemove={() => removeEntry("project", i)} />
        ))}
      </Box>

      <Box>
        <SecHead
          title="教育经历"
          action={
            <Button size="small" variant="plain"
              onClick={() => addEntry("education", { school: "", major: "", degree: "", period: "" })}>
              + 加一段
            </Button>
          }
        />
        {((draft.education as ParsedEntry[]) ?? []).map((e, i) => (
          <EntryCard key={i} kind="education" entry={e}
            onChange={(next) => patchEntry("education", i, next)}
            onRemove={() => removeEntry("education", i)} />
        ))}
      </Box>

      <Box>
        <SecHead title="技能标签" />
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 1 }}>
          {skills.map((s, i) => (
            <Box
              key={`${s}-${i}`}
              component="button"
              type="button"
              onClick={() => setDraft({ ...draft, skills: skills.filter((_, j) => j !== i) })}
              sx={{
                border: 0, cursor: "pointer", bgcolor: "surface2", color: "text.secondary",
                borderRadius: "999px", px: 1.25, height: 22, display: "inline-flex", alignItems: "center",
                ...typeScale.s, fontWeight: 590, whiteSpace: "nowrap",
              }}
            >
              {s} ✕
            </Box>
          ))}
          {skills.length === 0 && (
            <Typography sx={{ ...typeScale.s, color: "text.secondary" }}>暂无技能标签</Typography>
          )}
        </Box>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
          <TextField size="small" label="加一个技能" value={skillDraft}
            sx={{ maxWidth: 240 }}
            onChange={(e) => setSkillDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSkill();
              }
            }} />
          <Button size="small" variant="gray" onClick={addSkill}>添加</Button>
        </Box>
      </Box>

      <Box>
        <SecHead title="自我评价" />
        <TextRow label="自我评价" value={draft.self_evaluation ?? ""} multiline rows={3}
          onChange={(v) => setDraft({ ...draft, self_evaluation: v })} />
      </Box>

      <Box>
        <SecHead title="摘要（匹配页读这段）" />
        <TextRow label="摘要" value={draft.summary ?? ""} multiline rows={4}
          onChange={(v) => setDraft({ ...draft, summary: v })} />
      </Box>

      <Box sx={{ display: "flex", gap: 1, alignItems: "center", pb: 2 }}>
        <Button variant="filled" disabled={!dirty || saving} onClick={() => onSave(draft)}>
          {saving ? "保存中…" : "保存修订"}
        </Button>
        <Button variant="gray" disabled={saving} onClick={onCancel}>取消</Button>
        {dirty && !saving && (
          <Typography sx={{ ...typeScale.xs, color: "warning.main" }}>
            有未保存的修订，点「保存修订」才落库
          </Typography>
        )}
      </Box>
    </Box>
  );
}
