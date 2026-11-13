/**
 * 招呼语：全局提示词（要求 + 内置默认对照），改完保存对下次生成 / 重新生成立即生效。
 *
 * 旧页是右侧 Sheet，拆分后独立成段（与设置页各段同款）：进来才拉一次，保存后回读真实状态。
 */

import { useEffect, useState } from "react";
import { Box, Typography } from "@mui/material";

import { Button, ConfirmSheet, Surface, Switch, TextField, useToast } from "@/components";
import { fontFamilyMono, typeScale } from "@/theme/tokens";
import { systemApi } from "@/api/shared";
import { errText, GREETING_MAX } from "@/views/shared/match/types";

/** 招呼语段：编辑全局提示词，可恢复内置默认。 */
export function GreetingSection() {
  const toast = useToast();
  const [promptCustom, setPromptCustom] = useState("");
  const [promptDefault, setPromptDefault] = useState("");
  const [promptIsDefault, setPromptIsDefault] = useState(true);
  const [fixedGreeting, setFixedGreeting] = useState("");
  /** 只建会话不发正文（正文用 BOSS 账号默认打招呼语）。 */
  const [sessionOnly, setSessionOnly] = useState(false);
  /** 固定招呼语保存 / 关闭在途。 */
  const [savingFixed, setSavingFixed] = useState(false);
  /** 恢复默认会丢掉自定义文案——破坏性动作走二次确认（缺陷清单「破坏性操作」）。 */
  const [confirmReset, setConfirmReset] = useState(false);
  /** 网络请求在途：按钮转文案并禁用（缺陷清单「加载态」）。 */
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  /** 读取招呼语提示词；失败弹 toast 并回 null。 */
  const loadPrompt = async () => {
    try {
      const raw = (await systemApi.greetingPrompt()) as unknown as {
        prompt?: string;
        requirement?: string;
        custom?: string | null;
        default?: string;
        is_default?: boolean;
        fixed?: string;
        session_only?: boolean;
      };
      const custom = raw.custom ?? raw.requirement ?? raw.prompt ?? "";
      setPromptCustom(custom);
      setPromptDefault(raw.default ?? "");
      setPromptIsDefault(raw.is_default ?? !custom);
      setFixedGreeting(raw.fixed ?? "");
      setSessionOnly(Boolean(raw.session_only));
      return raw;
    } catch (e) {
      toast.toast(errText(e), "danger");
      return null;
    }
  };

  /** 进段拉一次提示词（含内置默认）。 */
  useEffect(() => {
    void loadPrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 保存自定义提示词；保存后回读真实状态并提示是否生效。 */
  const savePrompt = async () => {
    setSaving(true);
    try {
      await systemApi.saveGreetingPrompt(promptCustom.trim());
      const raw = await loadPrompt();
      if (promptCustom.trim() && raw?.is_default) {
        toast.toast("保存后仍是内置默认，没生效——看 MatchPage 文件头注释", "warn");
      } else {
        toast.toast("已保存", "ok");
      }
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setSaving(false);
    }
  };

  /** 恢复内置默认提示词。 */
  const resetPrompt = async () => {
    setResetting(true);
    try {
      await systemApi.saveGreetingPrompt("");
      await loadPrompt();
      toast.toast("已恢复默认", "ok");
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setResetting(false);
    }
  };

  /** 保存固定招呼语：非空 = 所有岗位都用它、不再 AI 生成；空 = 关闭固定。 */
  const saveFixed = async () => {
    setSavingFixed(true);
    try {
      await systemApi.saveGreetingPrompt(promptCustom.trim(), fixedGreeting.trim());
      await loadPrompt();
      toast.toast(fixedGreeting.trim() ? "固定招呼语已保存" : "已关闭固定招呼语", "ok");
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setSavingFixed(false);
    }
  };

  /** 切「只建会话不发正文」：立即保存，失败回滚开关。 */
  const toggleSessionOnly = async (next: boolean) => {
    setSessionOnly(next);
    setSavingFixed(true);
    try {
      await systemApi.saveGreetingPrompt(promptCustom.trim(), fixedGreeting.trim(), next);
      toast.toast(next ? "已切换：只建会话，正文用 BOSS 默认招呼语" : "已恢复：由程序发送招呼语", "ok");
    } catch (e) {
      setSessionOnly(!next);
      toast.toast(errText(e), "danger");
    } finally {
      setSavingFixed(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
        <Typography sx={{ ...typeScale.m, fontWeight: 600, flex: 1 }}>固定招呼语</Typography>
        <Button size="small" variant="filled" disabled={savingFixed} onClick={() => void saveFixed()}>
          {savingFixed ? "保存中…" : fixedGreeting.trim() ? "保存固定招呼语" : "关闭固定"}
        </Button>
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, mb: 3 }}>
        <TextField
          label="固定招呼语"
          multiline
          rows={3}
          fullWidth
          inputProps={{ maxLength: GREETING_MAX }}
          value={fixedGreeting}
          onChange={(e) => setFixedGreeting(e.target.value)}
          placeholder="填了就所有岗位统一用它，不再让 AI 生成；留空保存 = 关闭固定"
        />
        <Typography sx={{ ...typeScale.s, color: "text.secondary" }}>
          {fixedGreeting.trim()
            ? "已启用：匹配与重新生成都直接用这段文案，不再调用 AI。"
            : "未启用：每条岗位由下面的要求交给 AI 生成。"}
        </Typography>
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 3, flexWrap: "wrap" }}>
        <Switch
          checked={sessionOnly}
          disabled={savingFixed}
          onChange={(e) => void toggleSessionOnly(e.target.checked)}
          label="只建会话，不发自定义招呼语（正文用 BOSS 账号默认打招呼语）"
        />
        <Typography sx={{ ...typeScale.xs, color: "text.secondary", flexBasis: "100%" }}>
          开启后投递只点「立即沟通」，程序不再发上面的招呼语，避免「账号默认 + 程序」各发一条。
        </Typography>
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
        <Typography sx={{ ...typeScale.m, fontWeight: 600, flex: 1 }}>打招呼语</Typography>
        <Button size="small" variant="gray" disabled={resetting || saving} onClick={() => setConfirmReset(true)}>
          {resetting ? "恢复中…" : "恢复默认"}
        </Button>
        <Button size="small" variant="filled" disabled={saving || resetting} onClick={() => void savePrompt()}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        <TextField
          label="招呼语要求"
          multiline
          rows={4}
          fullWidth
          inputProps={{ maxLength: GREETING_MAX }}
          value={promptCustom}
          onChange={(e) => setPromptCustom(e.target.value)}
          placeholder="留空 = 用内置默认"
        />
        <Typography sx={{ ...typeScale.s, color: "text.secondary" }}>
          当前状态：{promptIsDefault ? "使用内置默认" : "使用自定义"} · 最多 {GREETING_MAX} 字
        </Typography>
        <Typography sx={{ ...typeScale.xs, color: "text.secondary" }}>内置默认</Typography>
        <Surface sx={{ maxHeight: 180, overflowY: "auto" }}>
          <Typography
            component="pre"
            sx={{ ...typeScale.s, fontFamily: fontFamilyMono, whiteSpace: "pre-wrap", m: 0 }}
          >
            {promptDefault || "—"}
          </Typography>
        </Surface>
      </Box>

      <ConfirmSheet
        open={confirmReset}
        title="恢复为内置默认？"
        description="当前自定义的招呼语要求会被清掉，恢复后不可找回。"
        confirmText="恢复默认"
        danger
        onConfirm={() => {
          setConfirmReset(false);
          void resetPrompt();
        }}
        onClose={() => setConfirmReset(false)}
      />
    </Box>
  );
}
