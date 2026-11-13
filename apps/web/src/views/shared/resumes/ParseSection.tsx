/**
 * 简历解析：选中简历的原文摘要 + LLM 八段解析结果 / 解析进度。
 *
 * 展示与编辑两态：默认展示 `ParsedChapters`，点「编辑」切 `ParsedEditor` 行内改，
 * 保存调 `resumeApi.editParse` 落库；解析轮询在页面壳，这里只吃 `run` / `detail` 展示。
 */

import { useState } from "react";
import { Box, Typography } from "@mui/material";

import {
  Button, EmptyState, ScrollArea, Skeleton, Surface, TaskPanel, useToast, pageRootSx,
} from "@/components";
import { typeScale } from "@/theme/tokens";
import { fmtTime } from "@/utils/format";
import { resumeApi } from "@/api/shared";
import { ParsedChapters } from "@/views/shared/resumes/chapters";
import { ParsedEditor } from "@/views/shared/resumes/ParsedEditor";
import {
  PARSE_TERMINAL, msgOf, type ParseRun, type ParsedData, type ResumeDetail, type ResumeListItem,
} from "@/views/shared/resumes/types";

/** 解析段：一份简历的解析进度 / 八段结果（可编辑），未解析时给发起入口。 */
export function ParseSection({
  current, detail, run, loading, rawBusyId, parseBusyId, onRunParse, onViewRaw,
}: {
  current: ResumeListItem | null;
  detail: ResumeDetail | null;
  run: ParseRun | undefined;
  /** 详情在途：骨架屏预占解析结果，别闪空态 */
  loading: boolean;
  /** 查看原文 / 发起解析在途（按钮「…中」+ 禁点防连发） */
  rawBusyId: string | null;
  parseBusyId: string | null;
  onRunParse: (item: ResumeListItem) => void;
  onViewRaw: (item: ResumeListItem) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!current) {
    return (
      <Box sx={pageRootSx}>
        <ScrollArea>
          <EmptyState title="还没有选中简历" />
        </ScrollArea>
      </Box>
    );
  }

  const parsedData = detail?.llm?.data ?? null;
  const running = run != null && !PARSE_TERMINAL.has(run.status);

  /** 保存人工修订：落库后刷新详情并退回展示态。 */
  const saveEdit = async (data: ParsedData) => {
    if (saving) return;
    setSaving(true);
    try {
      await resumeApi.editParse(current.resume_id, data as unknown as Record<string, unknown>);
      toast.toast("解析结果已更新", "ok");
      setEditing(false);
      window.dispatchEvent(new CustomEvent("resume-parse-edited", { detail: current.resume_id }));
    } catch (e) {
      toast.toast(msgOf(e), "danger");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={pageRootSx}>
      <Surface sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", flex: "0 0 auto" }}>
          <Typography sx={{ ...typeScale.l, fontWeight: 650, flex: 1, minWidth: 0 }}>
            {current.title || current.resume_id}
          </Typography>
          {detail?.llm?.edited ? (
            <Typography sx={{ ...typeScale.xs, color: "warning.main" }}>
              已人工修订{detail.llm.edited_at ? ` · ${fmtTime(detail.llm.edited_at)}` : ""}
            </Typography>
          ) : null}
          {detail?.llm?.parsed_at && !editing ? (
            <Typography sx={{ ...typeScale.xs, color: "text.secondary" }}>
              {detail.llm.model || "—"} · {fmtTime(detail.llm.parsed_at)}
            </Typography>
          ) : null}
          {parsedData && !running ? (
            editing ? null : (
              <Button
                size="small"
                variant="tinted"
                onClick={() => setEditing(true)}
              >
                编辑
              </Button>
            )
          ) : null}
          <Button
            size="small"
            variant="gray"
            disabled={rawBusyId === current.resume_id}
            onClick={() => onViewRaw(current)}
          >
            {rawBusyId === current.resume_id ? "查看中…" : "查看原文"}
          </Button>
        </Box>

        <ScrollArea sx={{ p: 0, pt: 2 }}>
          {running ? (
            <Box sx={{ mt: 2 }}>
              <TaskPanel
                title={`解析「${current.title || current.resume_id}」`}
                status={run.status}
                percent={run.percent}
                current={run.current || undefined}
                error={run.error || null}
                events={run.events}
              />
            </Box>
          ) : loading ? (
            <Box sx={{ mt: 2, display: "flex", flexDirection: "column", gap: 1 }}>
              {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={28} />)}
            </Box>
          ) : editing && parsedData ? (
            <ParsedEditor
              data={parsedData}
              saving={saving}
              onSave={(d) => void saveEdit(d)}
              onCancel={() => setEditing(false)}
            />
          ) : parsedData ? (
            <ParsedChapters data={parsedData} />
          ) : (
            <EmptyState
              title="这份简历还没解析"
              action={
                <Button
                  variant="filled"
                  disabled={parseBusyId === current.resume_id}
                  onClick={() => onRunParse(current)}
                >
                  {parseBusyId === current.resume_id ? "解析中…" : detail?.llm ? "重新解析" : "开始解析"}
                </Button>
              }
            />
          )}
        </ScrollArea>
      </Surface>
    </Box>
  );
}
