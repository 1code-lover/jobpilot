/**
 * 设置（共用路由 `#/settings`）：LLM 配置 / 程序更新 / 黑名单规则 / 外观。
 *
 * 共用页面不带平台作用域，黑名单接口一律取 `usePlatform().activeSiteId`；
 * 采集配置属站点作用域，不在本页。迁移与接口细节见
 * `notes/apps/web/src/views/shared/settings/SettingsPage.md`。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Typography } from "@mui/material";

import {
  Button, ConfirmSheet, EmptyState, InlineAlert, InsetGroup, InsetRow, PageHeader, Pill,
  ScrollArea, SegmentedControl, Select, Sheet, Skeleton, StatusDot, TaskPanel, TextField, ViewFade,
  pageRootSx, useToast,
} from "@/components";
import { usePlatform } from "@/platform/PlatformProvider";
import { useTaskStore } from "@/stores/taskStore";
import { useThemeMode } from "@/theme/ThemeModeProvider";
import { fontFamilyMono, radius, typeScale } from "@/theme/tokens";
import { fmtNumber, fmtTime } from "@/utils/format";
import {
  blacklistApi,
  llmApi,
  systemApi,
  type BlacklistRule,
  type LlmProfile,
  type LlmProfilesState,
} from "@/api/shared";

/** 接口错误统一转人话（client 抛的都是带 message 的 ApiError）。 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `GET /api/system/update` 的载荷（`update_check.build_status`）。 */
interface UpdateStatus {
  current?: string;
  latest?: string | null;
  has_update?: boolean;
  should_prompt?: boolean;
  ignored?: string | null;
  notes?: string;
  error?: string | null;
  checked_at?: number | null;
  can_self_update?: boolean;
  zip_asset?: { name: string; url: string } | null;
}

/** `GET /api/system/update/log` 的载荷（日志文件 + 诊断摘要）。 */
interface UpdateLogFile {
  name: string;
  exists?: boolean;
  size?: number;
  truncated?: boolean;
  read_error?: string;
  content?: string;
}

/** `/api/system/update/log` 的诊断摘要（含阶段与版本信息）。 */
interface UpdateDiagnostics {
  current?: string;
  latest?: string | null;
  has_update?: boolean;
  should_prompt?: boolean;
  ignored?: string | null;
  error?: string | null;
  checked_at?: number | null;
  install_mode_label?: string;
  can_self_update?: boolean;
  zip_asset?: { name: string; url: string } | null;
  last_stage?: string;
  last_stage_text?: string;
}

/** `/api/system/update/log` 整包：提示语 + 日志文件 + 诊断摘要。 */
interface UpdateLogPayload {
  hint?: string;
  files?: UpdateLogFile[];
  diagnostics?: UpdateDiagnostics;
}

/** 规则行视图：repos 的 BlacklistRule + 展示字段（后端 to_dict 里有，类型上落在索引签名）。 */
interface RuleView extends BlacklistRule {
  description?: string;
  hit_count?: number;
  last_error?: string;
  /** `''` = 全站生效，非空 = 本站专属（后端 2026-10-28 起写入并回传）。 */
  site?: string;
}

/** 命中流水行（`blacklist_hits` 表字段）。 */
interface HitView {
  job_name?: string;
  brand_name?: string;
  matched_text?: string;
  action?: string;
  created_at?: string;
}

/** 规则类型文案。 */
const RULE_TYPE_LABEL: Record<string, string> = {
  company: "公司",
  jd_keyword: "JD 关键词",
};

/** 匹配方式文案。 */
const MODE_LABEL: Record<string, string> = {
  exact: "精确匹配",
  contains: "包含匹配",
  regex: "正则匹配",
};

/** 匹配范围文案（仅 JD 关键词规则用）。 */
const SCOPE_LABEL: Record<string, string> = {
  both: "职位名 + JD 正文",
  job_name: "职位名",
  job_desc: "JD 正文",
};

/** 按规则类型给匹配方式选项：公司无「包含」，JD 无「精确」。 */
function modeOptions(ruleType: string): { code: string; name: string }[] {
  return ruleType === "company"
    ? [{ code: "exact", name: MODE_LABEL.exact }, { code: "regex", name: MODE_LABEL.regex }]
    : [{ code: "contains", name: MODE_LABEL.contains }, { code: "regex", name: MODE_LABEL.regex }];
}

/** LLM 配置段：ccswitch 式模型档案——多套命名配置，一键切换当前生效的那套。 */
function LlmSection() {
  const toast = useToast();
  const [state, setState] = useState<LlmProfilesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheetProfile, setSheetProfile] = useState<LlmProfile | null | undefined>(undefined);
  const [removeTarget, setRemoveTarget] = useState<LlmProfile | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    try {
      setState(await llmApi.profiles());
    } catch (e) {
      toast.toast(`读模型档案失败：${errText(e)}`, "danger");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  /** 一键切换激活档案；此后所有 AI 任务（解析/匹配/出题）用的就是这套。 */
  const activate = async (p: LlmProfile) => {
    if (busyKey) return;
    setBusyKey(`act:${p.id}`);
    try {
      setState(await llmApi.activateProfile(p.id));
      toast.toast(`已切换到「${p.name}」`, "ok");
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (p: LlmProfile) => {
    if (busyKey) return;
    setBusyKey(`del:${p.id}`);
    try {
      setState(await llmApi.removeProfile(p.id));
      toast.toast(`已删除「${p.name}」`, "ok");
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setBusyKey(null);
      setRemoveTarget(null);
    }
  };

  return (
    <Box>
      <InsetGroup
        header="模型配置"
        footer={
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <Button size="small" onClick={() => setSheetProfile(null)}>
              新增配置
            </Button>
          </Box>
        }
      >
        {loading ? (
          <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Skeleton height={36} />
            <Skeleton height={36} />
          </Box>
        ) : !state || state.profiles.length === 0 ? (
          <Box sx={{ p: 3 }}>
            <EmptyState
              title="还没有模型配置"
              description="新增一套：填接口地址和 API Key，拉取模型选一个后保存；可以建多套随时切换。"
            />
          </Box>
        ) : (
          state.profiles.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              activeId={state.active_id}
              busyKey={busyKey}
              onActivate={() => void activate(p)}
              onEdit={() => setSheetProfile(p)}
              onDelete={() => setRemoveTarget(p)}
            />
          ))
        )}
      </InsetGroup>

      {sheetProfile !== undefined && (
        <ProfileSheet profile={sheetProfile} onClose={() => setSheetProfile(undefined)} onSaved={() => { setSheetProfile(undefined); void loadProfiles(); }} />
      )}
      <ConfirmSheet
        open={removeTarget !== null}
        title={`删除「${removeTarget?.name ?? ""}」？`}
        description="删除后这套配置不能再启用；删的是正在用的一套，会自动切到剩余第一套。"
        confirmText={busyKey === `del:${removeTarget?.id}` ? "删除中…" : "确认删除"}
        danger
        busy={busyKey === `del:${removeTarget?.id}`}
        onConfirm={() => removeTarget && void remove(removeTarget)}
        onClose={() => {
          if (busyKey !== `del:${removeTarget?.id}`) setRemoveTarget(null);
        }}
      />
    </Box>
  );
}

/** 单条档案行：激活点 + 名称 + 模型徽标 + 地址副文本 + 操作按钮。 */
function ProfileRow({
  profile, activeId, busyKey, onActivate, onEdit, onDelete,
}: {
  profile: LlmProfile;
  activeId: string;
  /** 这个请求是否在飞（`act:`/`del:` + id）；按钮转文案并禁用，防连点 */
  busyKey: string | null;
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isActive = profile.id === activeId;
  const activating = busyKey === `act:${profile.id}`;
  return (
    <Box sx={{ p: 2, "& + &": { borderTop: "1px solid", borderColor: "divider" } }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", mb: 0.75 }}>
        <StatusDot tone={isActive ? "ok" : "idle"} label={isActive ? "使用中" : "未启用"} />
        <Typography sx={{ ...typeScale.bodySm, fontWeight: 590, flex: 1, minWidth: 100, wordBreak: "break-all" }}>
          {profile.name}
        </Typography>
        {profile.model ? (
          <Pill tone="static">{profile.model}</Pill>
        ) : (
          <Pill tone="warn">未配模型</Pill>
        )}
        {!profile.has_key && <Pill tone="warn">未设 Key</Pill>}
        {!profile.configured && <Pill tone="warn">未配全</Pill>}
      </Box>
      <Typography sx={{ ...typeScale.s, color: "text.secondary", mb: 1 }}>
        {profile.base_url || "未填接口地址"} · Key：{profile.api_key || "未设"}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        {isActive ? (
          <Pill tone="accent">使用中</Pill>
        ) : (
          <Button size="small" variant="gray" disabled={activating} onClick={onActivate}>
            {activating ? "切换中…" : "启用"}
          </Button>
        )}
        <Button size="small" variant="plain" onClick={onEdit}>编辑</Button>
        <Button size="small" variant="danger" onClick={onDelete}>删除</Button>
      </Box>
    </Box>
  );
}

/** 档案编辑弹窗：新建/编辑一套模型配置；拉模型与测连通都按当前表单值（编辑时未填部分回落档案存值）。 */
function ProfileSheet({
  profile, onClose, onSaved,
}: {
  profile: LlmProfile | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(profile?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(profile?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(profile?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  /** 模型下拉：拉到的列表 + 当前已填模型（不在列表里也留着，别静默丢）。 */
  const modelOptions = useMemo(() => {
    const ids = [...models];
    if (model && !ids.includes(model)) ids.unshift(model);
    return ids.map((id) => ({ code: id, name: id }));
  }, [models, model]);

  /** 拉模型列表：表单现填的地址/Key 优先；编辑时其余回落档案存值（后端按 profile_id）。 */
  const fetchModels = async () => {
    setModelsBusy(true);
    try {
      const r = await llmApi.models({
        base_url: baseUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
        profile_id: profile?.id,
      });
      setModels(r.models ?? []);
      setModel((cur) => cur || r.selected || "");
      toast.toast(`已拉到 ${r.models?.length ?? 0} 个模型`, "ok");
    } catch (e) {
      toast.toast(`拉模型失败：${errText(e)}`, "danger");
    } finally {
      setModelsBusy(false);
    }
  };

  /** 测连通：失败也回 200 带人话，细节走行内提示。 */
  const runTest = async () => {
    setTesting(true);
    try {
      const r = await llmApi.test({
        base_url: baseUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
        model: model.trim() || undefined,
        profile_id: profile?.id,
      });
      setTest(r);
      toast.toast(r.ok ? "AI 连接正常" : "测试没通过", r.ok ? "ok" : "danger");
    } catch (e) {
      setTest({ ok: false, message: errText(e) });
      toast.toast("测试没通过", "danger");
    } finally {
      setTesting(false);
    }
  };

  /** 保存；Key 留空表示编辑时不改旧 Key。 */
  const save = async () => {
    if (!name.trim()) {
      toast.toast("先给这套配置起个名字", "warn");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        base_url: baseUrl.trim(),
        model: model.trim(),
        api_key: apiKey.trim() || undefined,
      };
      if (profile?.id) await llmApi.updateProfile(profile.id, body);
      else await llmApi.createProfile(body);
      toast.toast("配置已保存", "ok");
      onSaved();
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      anchor="center"
      title={profile?.id ? `编辑「${profile.name}」` : "新增模型配置"}
      footer={
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button onClick={() => void fetchModels()} disabled={modelsBusy}>
            {modelsBusy ? "拉取中…" : "拉取模型"}
          </Button>
          <Button onClick={() => void runTest()} disabled={testing}>
            {testing ? "测试中…" : "测试连通"}
          </Button>
          <Button variant="filled" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </Box>
      }
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <TextField
          label="配置名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如 DeepSeek / Kimi / 本地 vLLM"
          autoComplete="off"
        />
        <TextField
          label="接口地址"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.deepseek.com/v1"
          autoComplete="off"
        />
        <TextField
          label="API Key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={profile?.has_key ? `已保存 ${profile.api_key}（留空 = 不修改）` : "sk-…"}
          autoComplete="off"
        />
        <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
          <Select
            label="模型"
            options={modelOptions}
            value={model}
            onChange={setModel}
            emptyLabel={models.length ? "请选择模型" : "可手填或先拉取列表"}
            sx={{ flex: 1, minWidth: 0 }}
          />
          <Button
            variant="plain"
            onClick={() => setBaseUrl("https://api.deepseek.com/v1")}
          >
            DeepSeek 预设
          </Button>
        </Box>
        {test && (
          <InlineAlert tone={test.ok ? "ok" : "danger"}>
            {test.message || (test.ok ? "连接正常" : "测试没通过")}
          </InlineAlert>
        )}
      </Box>
    </Sheet>
  );
}

/** 立即更新后的本地进度（真实进度来自 update.log 的诊断摘要，2s 轮询一次）。 */
interface ApplyState {
  status: string;
  percent?: number;
  current?: string;
  error?: string;
}

/** 程序更新段：检查更新 / 忽略版本 / 更新日志 / 立即更新（TaskPanel 出进度）。 */
function UpdateSection({
  status,
  onStatus,
}: {
  status: UpdateStatus | null;
  onStatus: (s: UpdateStatus) => void;
}) {
  const toast = useToast();
  const [log, setLog] = useState<UpdateLogPayload | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const [logBusy, setLogBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [apply, setApply] = useState<ApplyState | null>(null);

  /** 拉更新日志与诊断摘要。 */
  const loadLog = useCallback(async () => {
    setLogBusy(true);
    try {
      setLog((await systemApi.updateLog()) as unknown as UpdateLogPayload);
      setLogError(null);
    } catch (e) {
      setLogError(errText(e));
    } finally {
      setLogBusy(false);
    }
  }, []);

  /** 进段读一次更新日志。 */
  useEffect(() => {
    void loadLog();
  }, [loadLog]);

  /** 更新由外部进程干活，跑着就 2s 读一次日志诊断；只跟状态走，避免重建定时器。 */
  useEffect(() => {
    if (!apply || apply.status !== "running") return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const p = (await systemApi.updateLog()) as unknown as UpdateLogPayload;
          const d = p.diagnostics ?? {};
          const text = String(d.last_stage_text ?? "");
          const pct = Number(/(\d+)%/.exec(text)?.[1] ?? NaN);
          const stage = String(d.last_stage ?? "");
          setApply({
            status: stage === "done" ? "done" : stage === "error" ? "error" : "running",
            percent: Number.isFinite(pct) ? pct : undefined,
            current: text || undefined,
            error: stage === "error" ? text : undefined,
          });
        } catch {}
      })();
    }, 2000);
    return () => clearInterval(timer);
  }, [apply?.status]);

  const d = log?.diagnostics ?? {};
  const latest = d.latest || status?.latest || "";
  const hasUpdate = Boolean(d.has_update ?? status?.has_update);
  const ignored = d.ignored || status?.ignored || null;
  const canApply = Boolean(hasUpdate && (d.can_self_update ?? status?.can_self_update) && (d.zip_asset?.url ?? status?.zip_asset?.url));

  /** 强制检查一次更新并刷新日志。 */
  const check = async () => {
    setBusy(true);
    try {
      const s = (await systemApi.update(true)) as unknown as UpdateStatus;
      onStatus(s);
      if (s.error) toast.toast(String(s.error), "danger");
      else if (s.has_update) toast.toast(`发现新版本 v${s.latest}`, "ok");
      else toast.toast("已是最新", "ok");
      await loadLog();
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setBusy(false);
    }
  };

  /** 忽略当前最新版本，不再提示。 */
  const ignore = async () => {
    if (ignoring) return;
    setIgnoring(true);
    try {
      const r = (await systemApi.updateIgnore({ version: String(latest) })) as { message?: string };
      toast.toast(r.message || "已忽略", "ok");
      await loadLog();
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setIgnoring(false);
    }
  };

  /** 启动立即更新；期间禁用按钮，防连点开出两个更新进程。 */
  const applyNow = async () => {
    if (applying || apply?.status === "running") return;
    setApplying(true);
    try {
      const r = (await systemApi.updateApply()) as { message?: string };
      setApply({ status: "running", current: r.message || "更新已开始" });
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setApplying(false);
    }
  };

  const resultText = d.error
    ? `检测失败：${d.error}`
    : hasUpdate
      ? `有新版本 v${latest}${(d.should_prompt ?? status?.should_prompt) ? "" : "（已忽略，不再提醒）"}`
      : "已是最新";

  return (
    <Box>
      {logError && <InlineAlert tone="danger">{logError}</InlineAlert>}

      <InsetGroup header="版本摘要" footer={resultText}>
        <InsetRow label="当前版本" detail={`v${d.current || status?.current || "—"}`} />
        <InsetRow label="最新版本" detail={latest ? `v${latest}` : "未测到"} />
        <InsetRow label="安装方式" detail={d.install_mode_label || "—"} />
        <InsetRow label="忽略版本" detail={ignored ? `v${ignored}` : "无"} />
        <InsetRow label="上次检查" detail={fmtTime(d.checked_at ?? status?.checked_at ?? null)} />
      </InsetGroup>

      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 3 }}>
        <Button variant="filled" onClick={() => void check()} disabled={busy}>
          {busy ? "检测中…" : "检查更新"}
        </Button>
        <Button onClick={() => void ignore()} disabled={!hasUpdate || !latest || ignoring}>
          {ignoring ? "忽略中…" : "忽略此版本"}
        </Button>
        {canApply && (
          <Button
            variant="filled"
            disabled={applying || apply?.status === "running"}
            onClick={() => void applyNow()}
          >
            {applying || apply?.status === "running" ? "更新中…" : "立即更新"}
          </Button>
        )}
        <Button onClick={() => void loadLog()} disabled={logBusy}>
          {logBusy ? "刷新中…" : "刷新日志"}
        </Button>
      </Box>

      {apply && (
        <Box sx={{ mb: 3 }}>
          <TaskPanel
            title="程序更新"
            status={apply.status}
            percent={apply.percent}
            current={apply.current}
            error={apply.error ?? null}
            stopLabel="停止"
            onStop={undefined}
          />
        </Box>
      )}

      <InsetGroup header="更新日志" footer={log?.hint || undefined}>
        {(log?.files ?? []).map((f) => (
          <Box key={f.name} sx={{ p: 2, "& + &": { borderTop: "1px solid", borderColor: "divider" } }}>
            <Typography sx={{ ...typeScale.s, fontWeight: 590, color: "text.secondary", mb: 1 }}>
              {f.name}
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0, p: 1.5, borderRadius: "12px", maxHeight: 220, overflowY: "auto",
                fontFamily: fontFamilyMono, ...typeScale.xs, whiteSpace: "pre-wrap", wordBreak: "break-word",
                bgcolor: (t) => (t.palette.mode === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)"),
              }}
            >
              {!f.exists
                ? log?.hint || "（没有日志）"
                : f.read_error
                  ? `（读取失败：${f.read_error}）\n更新结束后点「刷新日志」再看。`
                  : `${f.truncated ? `（只显示最后 ${fmtNumber(f.size ?? 0)} 字节的尾部）\n` : ""}${f.content || "（空文件）"}`}
            </Box>
          </Box>
        ))}
        {!log?.files?.length && (
          <Box sx={{ p: 2 }}>
            <Typography sx={{ ...typeScale.s, color: "text.secondary" }}>
              {log?.hint || "（没有日志）"}
            </Typography>
          </Box>
        )}
      </InsetGroup>
    </Box>
  );
}

/** 规则弹窗模式：新建 / 编辑 / 试跑。 */
type RuleSheetMode = "create" | "edit" | "test";

/** 新建/编辑/试跑规则的弹窗。公司规则只有精确/正则；JD 规则多一个匹配范围。 */
function RuleSheet({
  site, mode, rule, onClose, onSaved,
}: {
  site: string;
  mode: RuleSheetMode;
  rule?: RuleView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const ruleType = rule?.rule_type ?? "company";
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [matchMode, setMatchMode] = useState(
    rule?.match_mode ?? (ruleType === "company" ? "exact" : "contains"),
  );
  const [scope, setScope] = useState(rule?.scope || "both");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [jobName, setJobName] = useState("");
  const [jobDesc, setJobDesc] = useState("");
  const [brandName, setBrandName] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 试跑/验证都走 `blacklist/test`：拿样例岗位跑一次，不落库。 */
  const validate = async (testOnly: boolean) => {
    setBusy(true);
    try {
      const r = await blacklistApi.testRule(site, {
        rule_type: ruleType,
        pattern: pattern.trim(),
        match_mode: matchMode,
        scope: ruleType === "company" ? "" : scope,
        description: description.trim(),
        brand_name: brandName,
        job_name: jobName,
        job_desc: jobDesc,
      });
      setResult(
        testOnly
          ? r.matched
            ? `命中 ${r.matches?.length ?? 0} 条`
            : "未命中"
          : "规则格式有效，可以保存",
      );
    } catch (e) {
      setResult(errText(e));
    } finally {
      setBusy(false);
    }
  };

  /** 新建或更新一条规则，保存后刷新列表并关弹窗。 */
  const save = async () => {
    if (!pattern.trim()) {
      toast.toast("规则内容不能空着", "warn");
      return;
    }
    setBusy(true);
    try {
      const body = {
        rule_type: ruleType,
        pattern: pattern.trim(),
        match_mode: matchMode,
        scope: ruleType === "company" ? "" : scope,
        description: description.trim(),
        enabled: rule ? rule.enabled !== false : true,
      };
      if (rule?.rule_id) await blacklistApi.updateRule(site, rule.rule_id, body);
      else await blacklistApi.createRule(site, body);
      toast.toast("规则已保存", "ok");
      onSaved();
      onClose();
    } catch (e) {
      setResult(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      anchor="center"
      title={
        mode === "test"
          ? "测试黑名单规则"
          : rule?.rule_id
            ? "编辑黑名单规则"
            : `新增${RULE_TYPE_LABEL[ruleType] ?? ""}规则`
      }
      footer={
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button onClick={() => void validate(mode === "test")} disabled={busy}>
            {busy
              ? mode === "test" ? "测试中…" : "验证中…"
              : mode === "test" ? "测试匹配" : "验证规则"}
          </Button>
          {mode !== "test" && (
            <Button variant="filled" onClick={() => void save()} disabled={busy}>
              {busy ? "保存中…" : "保存规则"}
            </Button>
          )}
        </Box>
      }
    >
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
          <Typography sx={{ ...typeScale.s, color: "text.secondary" }}>规则类型</Typography>
          <Pill tone="static">{RULE_TYPE_LABEL[ruleType] ?? ruleType}</Pill>
        </Box>
        <TextField
          label="规则内容"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          autoComplete="off"
        />
        <Select
          label="匹配方式"
          options={modeOptions(ruleType)}
          value={matchMode}
          onChange={setMatchMode}
          emptyLabel={null}
        />
        {ruleType !== "company" && (
          <Select
            label="匹配范围"
            options={Object.entries(SCOPE_LABEL).map(([code, name]) => ({ code, name }))}
            value={scope}
            onChange={setScope}
            emptyLabel={null}
          />
        )}
        <TextField
          label="说明"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoComplete="off"
        />
        {mode === "test" && (
          <>
            <TextField
              label="测试职位名"
              value={jobName}
              onChange={(e) => setJobName(e.target.value)}
              autoComplete="off"
            />
            <TextField
              label="测试 JD 正文"
              value={jobDesc}
              onChange={(e) => setJobDesc(e.target.value)}
              multiline
              minRows={3}
            />
            <TextField
              label="测试公司名"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              autoComplete="off"
            />
          </>
        )}
        {result && (
          <InlineAlert tone={result.startsWith("命中") || result.startsWith("规则格式") ? "ok" : "warn"}>
            {result}
          </InlineAlert>
        )}
      </Box>
    </Sheet>
  );
}

/** 命中记录弹窗（单条规则的或全站最近的，共用一个壳）。 */
function HitsSheet({ title, items, onClose }: { title: string; items: HitView[]; onClose: () => void }) {
  return (
    <Sheet open onClose={onClose} anchor="center" title={title}>
      {items.length === 0 ? (
        <Typography sx={{ ...typeScale.bodySm, color: "text.secondary" }}>暂无命中记录</Typography>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          {items.map((h, i) => (
            <Box key={i} sx={{ p: 1.5, borderRadius: radius.s, bgcolor: (t) => (t.palette.mode === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)") }}>
              <Typography sx={{ ...typeScale.bodySm, fontWeight: 590 }}>{h.job_name || "未知职位"}</Typography>
              <Typography sx={{ ...typeScale.s, color: "text.secondary" }}>
                {h.brand_name || ""} · {h.matched_text || ""}
              </Typography>
              <Typography sx={{ ...typeScale.xs, color: "text.secondary" }}>
                {h.action || ""} · {h.created_at || ""}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Sheet>
  );
}

/** 单条规则行：状态点 + 模式徽标 + 操作按钮。 */
function RuleRow({
  rule, busyKey, onToggle, onDelete, onEdit, onTest, onHits,
}: {
  rule: RuleView;
  /** 这条规则哪个请求在飞（`toggle:`/`hits:` + rule_id）；按钮转文案并禁用，防连点 */
  busyKey: string | null;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onTest: () => void;
  onHits: () => void;
}) {
  const toggling = busyKey === `toggle:${rule.rule_id}`;
  const hitting = busyKey === `hits:${rule.rule_id}`;
  return (
    <Box sx={{ p: 2, "& + &": { borderTop: "1px solid", borderColor: "divider" } }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", mb: 0.75 }}>
        <StatusDot tone={rule.enabled ? "ok" : "idle"} label={rule.enabled ? "已启用" : "已停用"} />
        <Typography sx={{ ...typeScale.bodySm, fontWeight: 590, flex: 1, minWidth: 120, wordBreak: "break-all" }}>
          {rule.pattern}
        </Typography>
        <Pill tone="static">{RULE_TYPE_LABEL[rule.rule_type] ?? rule.rule_type}</Pill>
        <Pill tone="static">{MODE_LABEL[rule.match_mode] ?? rule.match_mode}</Pill>
        {rule.rule_type !== "company" && rule.scope && (
          <Pill tone="static">{SCOPE_LABEL[rule.scope] ?? rule.scope}</Pill>
        )}
        <Pill tone={rule.site ? "accent" : "static"}>{rule.site ? "本站" : "全站"}</Pill>
      </Box>
      <Typography sx={{ ...typeScale.s, color: "text.secondary", mb: 1 }}>
        {rule.description || "无描述"} · 命中 {rule.hit_count ?? 0} 次
        {rule.last_error ? ` · 规则错误：${rule.last_error}` : ""}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Button size="small" variant="plain" onClick={onTest}>测试</Button>
        <Button size="small" variant="plain" disabled={hitting} onClick={onHits}>
          {hitting ? "加载中…" : "命中详情"}
        </Button>
        <Button size="small" variant="plain" onClick={onEdit}>编辑</Button>
        <Button size="small" variant="gray" disabled={toggling} onClick={onToggle}>
          {toggling ? "处理中…" : rule.enabled ? "停用" : "启用"}
        </Button>
        <Button size="small" variant="danger" onClick={onDelete}>删除</Button>
      </Box>
    </Box>
  );
}

/** 黑名单规则段：规则增删改/启停/试跑/命中记录 + 已入库职位重检（重检进度在任务中心）。 */
function BlacklistSection() {
  const toast = useToast();
  const { activeSiteId: site } = usePlatform();
  const tasks = useTaskStore((s) => s.tasks);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [typeFilter, setTypeFilter] = useState("");
  /** 首屏必拉一次：初值 true，别让空态在拉取前闪一下。 */
  const [rulesLoading, setRulesLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ mode: RuleSheetMode; rule?: RuleView | null } | null>(null);
  const [hits, setHits] = useState<{ title: string; items: HitView[] } | null>(null);
  /** 单条规则 / 命中查询的在飞请求键（`toggle:`/`hits:`/`remove:` + id）：按钮转文案并禁用。 */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** 在跑的重检任务 id——进度 / 停止都在任务中心（缺陷清单「黑名单重检」），这里只跟到收口好刷规则。 */
  const [recheckTaskId, setRecheckTaskId] = useState<string | null>(null);
  /** 重检启动请求在飞（与任务在跑的 recheckTaskId 分开记，防连点开两个）。 */
  const [recheckStarting, setRecheckStarting] = useState(false);
  /** 破坏性操作二次确认（缺陷清单「破坏性操作」）。 */
  const [removeTarget, setRemoveTarget] = useState<RuleView | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const recheckTask = recheckTaskId ? tasks[recheckTaskId] ?? null : null;

  /** 按站点与类型筛选拉规则列表。 */
  const loadRules = useCallback(async () => {
    if (!site) {
      setRulesLoading(false);
      return;
    }
    setRulesLoading(true);
    try {
      const data = await blacklistApi.rules(site, (typeFilter || undefined) as "company" | "jd_keyword" | undefined);
      setRules((data.items ?? []) as RuleView[]);
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e));
    } finally {
      setRulesLoading(false);
    }
  }, [site, typeFilter]);

  /** 平台或类型筛选变化时重拉规则。 */
  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  /** 重检收口就刷新规则（命中数会变），细进度与停止都去任务中心。 */
  useEffect(() => {
    if (recheckTask && ["done", "error", "cancelled"].includes(recheckTask.status)) {
      const st = recheckTask.status;
      setRecheckTaskId(null);
      void loadRules();
      toast.toast(st === "error" ? `重检出错：${recheckTask.error ?? ""}` : "重检结束", st === "error" ? "danger" : "ok");
    }
  }, [recheckTask, loadRules, toast]);

  if (!site) {
    return <EmptyState title="还没有可用平台" />;
  }

  /** 启用 / 停用一条规则，回包就地替换该行。 */
  const toggle = async (rule: RuleView) => {
    const key = `toggle:${rule.rule_id}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      const r = (await blacklistApi.toggleRule(site, rule.rule_id, !rule.enabled)) as { item?: RuleView };
      if (r.item) {
        setRules((prev) => prev.map((x) => (x.rule_id === rule.rule_id ? { ...x, ...r.item } : x)));
      }
      toast.toast(!rule.enabled ? "规则已启用" : "规则已停用", "ok");
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setBusyKey((prev) => (prev === key ? null : prev));
    }
  };

  /** 打开删除确认弹窗。 */
  const remove = (rule: RuleView) => setRemoveTarget(rule);

  /** 确认后真删，并同步移除列表行。 */
  const runRemove = async () => {
    const rule = removeTarget;
    if (!rule || removeBusy) return;
    const key = `remove:${rule.rule_id}`;
    setBusyKey(key);
    setRemoveBusy(true);
    try {
      await blacklistApi.removeRule(site, rule.rule_id);
      setRules((prev) => prev.filter((x) => x.rule_id !== rule.rule_id));
      toast.toast("规则已删除", "ok");
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setBusyKey((prev) => (prev === key ? null : prev));
      setRemoveBusy(false);
      setRemoveTarget(null);
    }
  };

  /** 打开命中记录弹窗；不传规则即查全站最近命中。 */
  const openHits = async (rule?: RuleView) => {
    const key = rule ? `hits:${rule.rule_id}` : "hits:all";
    if (busyKey) return;
    setBusyKey(key);
    try {
      const r = rule
        ? await blacklistApi.ruleHits(site, rule.rule_id, 100)
        : await blacklistApi.hits(site, 100);
      setHits({
        title: rule ? `规则命中详情：${rule.pattern}` : "最近命中记录",
        items: (r.items ?? []) as HitView[],
      });
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setBusyKey((prev) => (prev === key ? null : prev));
    }
  };

  /** 触发重检：返回 task_id，进度 / 停止都去任务中心（缺陷清单「黑名单重检应该放在任务中心」）。 */
  const startRecheck = async () => {
    if (recheckStarting || recheckTaskId) return;
    setRecheckStarting(true);
    try {
      const s = (await blacklistApi.recheck(site)) as unknown as { task_id?: string | number };
      const id = s.task_id != null ? String(s.task_id) : "";
      if (!id) {
        toast.toast("重检没起来，稍后再试", "warn");
        return;
      }
      setRecheckTaskId(id);
      toast.toast("已开始重检，进度去任务中心看", "ok");
    } catch (e) {
      toast.toast(errText(e), "danger");
    } finally {
      setRecheckStarting(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center", mb: 2 }}>
        <Select
          label="规则类型"
          options={[
            { code: "company", name: "公司黑名单" },
            { code: "jd_keyword", name: "JD 关键词" },
          ]}
          value={typeFilter}
          onChange={setTypeFilter}
          emptyLabel="全部"
          sx={{ minWidth: 150 }}
        />
        <Button onClick={() => setSheet({ mode: "create", rule: { rule_id: "", rule_type: "company", pattern: "", match_mode: "exact", scope: "", enabled: true } })}>
          新增公司规则
        </Button>
        <Button onClick={() => setSheet({ mode: "create", rule: { rule_id: "", rule_type: "jd_keyword", pattern: "", match_mode: "contains", scope: "both", enabled: true } })}>
          新增 JD 规则
        </Button>
        <Button disabled={busyKey !== null} onClick={() => void openHits()}>
          {busyKey === "hits:all" ? "加载中…" : "最近命中"}
        </Button>
        <Button
          variant="gray"
          disabled={recheckTaskId !== null || recheckStarting}
          onClick={() => void startRecheck()}
        >
          {recheckStarting ? "启动中…" : recheckTaskId ? "重检中…" : "重新检查已入库职位"}
        </Button>
      </Box>

      {loadError && <InlineAlert tone="danger">{loadError}</InlineAlert>}

      <InsetGroup header="规则列表">
        {rulesLoading && rules.length === 0 ? (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1, p: 2 }}>
            <Skeleton height={64} sx={{ borderRadius: radius.s }} />
            <Skeleton height={64} sx={{ borderRadius: radius.s }} />
          </Box>
        ) : rules.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography sx={{ ...typeScale.s, color: "text.secondary" }}>还没有黑名单规则</Typography>
          </Box>
        ) : (
          rules.map((r) => (
            <RuleRow
              key={r.rule_id}
              rule={r}
              busyKey={busyKey}
              onToggle={() => void toggle(r)}
              onDelete={() => void remove(r)}
              onEdit={() => setSheet({ mode: "edit", rule: r })}
              onTest={() => setSheet({ mode: "test", rule: r })}
              onHits={() => void openHits(r)}
            />
          ))
        )}
      </InsetGroup>

      {sheet && (
        <RuleSheet
          site={site}
          mode={sheet.mode}
          rule={sheet.rule}
          onClose={() => setSheet(null)}
          onSaved={() => void loadRules()}
        />
      )}
      {hits && (
        <HitsSheet title={hits.title} items={hits.items} onClose={() => setHits(null)} />
      )}
      <ConfirmSheet
        open={removeTarget !== null}
        title="删除当前规则？"
        description="历史命中记录不会删除。删除后不可恢复。"
        confirmText={removeBusy ? "删除中…" : "确认删除"}
        danger
        busy={removeBusy}
        onConfirm={() => void runRemove()}
        onClose={() => {
          if (!removeBusy) setRemoveTarget(null);
        }}
      />
    </Box>
  );
}

/** 外观段：浅色/深色切换（持久化由 ThemeModeProvider 负责，这里只调 setMode）。 */
function AppearanceSection() {
  const { mode, setMode } = useThemeMode();
  return (
    <InsetGroup header="外观" footer="主题记住你的选择（本机 localStorage）。">
      <InsetRow
        label="主题"
        control={
          <SegmentedControl
            aria-label="外观"
            size="sm"
            value={mode}
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onChange={(v) => setMode(v)}
          />
        }
      />
    </InsetGroup>
  );
}

/** 设置分区的页签定义。 */
const TABS = [
  { value: "llm", label: "LLM 配置" },
  { value: "update", label: "程序更新" },
  { value: "blacklist", label: "黑名单规则" },
  { value: "appearance", label: "外观" },
] as const;

/** 分段取值。 */
type TabValue = (typeof TABS)[number]["value"];

/** 设置页壳：四段切换，跨段共享更新状态供页签小圆点使用。 */
export function SettingsPage() {
  const [tab, setTab] = useState<TabValue>("llm");
  /** 更新状态常挂：关掉弹窗不等于忽略，进页面先查一次，不能只等 WS 推送。 */
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  /** 进页面先查一次更新状态（页签小圆点用）。 */
  useEffect(() => {
    let alive = true;
    void systemApi
      .update()
      .then((s) => {
        if (alive) setUpdateStatus(s as unknown as UpdateStatus);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const tabOptions = useMemo(
    () =>
      TABS.map((t) => ({
        value: t.value,
        label: t.label,
        status:
          t.value === "update" && updateStatus?.has_update && updateStatus?.should_prompt
            ? ("warn" as const)
            : undefined,
      })),
    [updateStatus],
  );

  return (
    <Box sx={pageRootSx}>
      <PageHeader
        title="设置"
      />

      <Box sx={{ flex: "0 0 auto", mb: 3 }}>
        <SegmentedControl<TabValue>
          aria-label="设置分区"
          value={tab}
          options={tabOptions}
          onChange={setTab}
        />
      </Box>

      <ScrollArea>
        <ViewFade slotKey={tab}>
          {tab === "llm" && <LlmSection />}
          {tab === "update" && <UpdateSection status={updateStatus} onStatus={setUpdateStatus} />}
          {tab === "blacklist" && <BlacklistSection />}
          {tab === "appearance" && <AppearanceSection />}
        </ViewFade>
      </ScrollArea>
    </Box>
  );
}
