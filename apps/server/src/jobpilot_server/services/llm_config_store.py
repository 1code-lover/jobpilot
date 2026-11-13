"""LLM 配置存取：状态库 `data/jobpilot.db` 的 `doc('llm_config')`，API 回显时打码。

v2 起支持多套命名档案（ccswitch 风格）：payload 形状
`{"version": 2, "active_id": "p_x", "profiles": [{id, name, api_key, base_url, model}]}`；
旧扁平形状 `{api_key, base_url, model}` 读到时自动迁移成单档案「默认配置」。
可配置的只有 api_key / base_url / model 三项；采样与超时参数是系统固定值，
读写都会被强制成常量，界面和接口都改不动。配置类型与采样常量以本模块
（`jobpilot_server.config`）为准，`jobpilot_ai` 只负责按传入值调用。

Attributes:
    _UPDATABLE: 用户可改的字段名；其余一律忽略（旧合并接口用）。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

import jobpilot_db
from jobpilot_ai.llm import LLMConfig as _AILLMConfig

from .. import config as C
from ..errors import NotFoundError, ValidationWebError

logger = logging.getLogger(__name__)

_PAYLOAD_VERSION = 2
_DEFAULT_PROFILE_NAME = "默认配置"
_UPDATABLE = ("api_key", "base_url", "model")


@dataclass
class LLMConfig(_AILLMConfig):
    """LLM 运行配置（= 一套档案的生效值；默认值与归一化都跟随服务端常量）。

    Attributes:
        api_key: API 密钥；空串 = 未配置。
        base_url: 上游兼容 OpenAI 的接口地址。
        model: 模型名。
        temperature: 采样温度，构造时被 `normalize()` 拉齐到系统常量。
        max_tokens: 单次回答上限，同上。
        timeout: 请求超时（秒），同上。
    """

    temperature: float = C.LLM_TEMPERATURE
    max_tokens: int = C.LLM_MAX_TOKENS
    timeout: float = C.LLM_TIMEOUT

    def normalize(self) -> "LLMConfig":
        """把采样参数拉回系统常量（历史配置里可能还留着旧值）。"""
        return LLMConfig(
            api_key=self.api_key,
            base_url=self.base_url,
            model=self.model,
            temperature=C.LLM_TEMPERATURE,
            max_tokens=C.LLM_MAX_TOKENS,
            timeout=C.LLM_TIMEOUT,
        )

    def to_dict(self) -> dict[str, Any]:
        """归一化后转字典。"""
        return asdict(self.normalize())

    def masked(self) -> dict[str, Any]:
        """给网页看的形态：api_key 只留尾 4 位，采样参数标成系统固定。"""
        data = self.to_dict()
        data["api_key"] = mask_key(self.api_key)
        data["has_key"] = bool(self.api_key)
        data["configured"] = self.configured
        data["fixed"] = {
            "temperature": C.LLM_TEMPERATURE,
            "max_tokens": C.LLM_MAX_TOKENS,
            "resume_parse_max_tokens": C.LLM_RESUME_PARSE_MAX_TOKENS,
            "match_max_tokens": C.LLM_MATCH_MAX_TOKENS,
            "timeout": C.LLM_TIMEOUT,
        }
        return data


@dataclass
class LLMProfile:
    """一套命名模型档案：ccswitch 式多配置的基本单位。

    Attributes:
        id: 档案 id（`p_` 前缀随机串，落库后不变）。
        name: 展示名（如「DeepSeek」「Kimi」），必填。
        api_key: 该档案自己的密钥；空串 = 未设。
        base_url: 该档案的接口地址。
        model: 该档案的模型名。
    """

    id: str
    name: str = ""
    api_key: str = ""
    base_url: str = ""
    model: str = ""

    def to_config(self) -> LLMConfig:
        """转成给 `LLMClient` 用的运行配置（采样参数按系统常量）。"""
        return LLMConfig(
            api_key=self.api_key,
            base_url=self.base_url,
            model=self.model,
            temperature=C.LLM_TEMPERATURE,
            max_tokens=C.LLM_MAX_TOKENS,
            timeout=C.LLM_TIMEOUT,
        ).normalize()

    def masked(self) -> dict[str, Any]:
        """给网页看的形态：key 打码 + 配齐标记。"""
        return {
            "id": self.id,
            "name": self.name,
            "api_key": mask_key(self.api_key),
            "base_url": self.base_url,
            "model": self.model,
            "has_key": bool(self.api_key),
            "configured": self.to_config().configured,
        }


@dataclass
class LLMProfilesState:
    """档案库状态：全部档案 + 当前激活 id（空串 = 没有激活档案）。

    Attributes:
        active_id: 激活档案 id；失效时 `active()` 自动回退第一个。
        profiles: 全部档案，列表序即展示序。
    """

    active_id: str = ""
    profiles: list[LLMProfile] = field(default_factory=list)

    def active(self) -> LLMProfile | None:
        """当前激活档案；active_id 失效回退第一个，一个都没有回 `None`。"""
        for p in self.profiles:
            if p.id == self.active_id:
                return p
        return self.profiles[0] if self.profiles else None

    def masked(self) -> dict[str, Any]:
        """给网页看的形态：激活 id + 打码档案列表。"""
        active = self.active()
        return {
            "active_id": active.id if active else "",
            "profiles": [p.masked() for p in self.profiles],
        }


def mask_key(key: str) -> str:
    """密钥打码：只留前 3 与尾 4；短串整串打星。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:3]}***{key[-4:]}"


def _new_id() -> str:
    """造一个档案 id。"""
    return f"p_{uuid.uuid4().hex[:12]}"


def _state_from_payload(data: Any) -> LLMProfilesState:
    """payload → 状态；旧扁平形状迁移成单档案「默认配置」，坏条目跳过。"""
    if not isinstance(data, dict):
        return LLMProfilesState()
    if not isinstance(data.get("profiles"), list):
        # 旧形状（v1）：只有一份配置。全空就不迁移，免得白造一个空档案。
        known = {f.name for f in fields(LLMConfig)}
        cfg = LLMConfig(**{k: v for k, v in data.items() if k in known})
        if not (cfg.api_key or cfg.base_url or cfg.model):
            return LLMProfilesState()
        pid = _new_id()
        profile = LLMProfile(
            id=pid, name=_DEFAULT_PROFILE_NAME,
            api_key=str(cfg.api_key), base_url=str(cfg.base_url), model=str(cfg.model),
        )
        return LLMProfilesState(active_id=pid, profiles=[profile])
    profiles: list[LLMProfile] = []
    for item in data["profiles"]:
        if not isinstance(item, dict):
            continue
        profiles.append(
            LLMProfile(
                id=str(item.get("id") or "").strip() or _new_id(),
                name=str(item.get("name") or "").strip(),
                api_key=str(item.get("api_key") or ""),
                base_url=str(item.get("base_url") or "").strip(),
                model=str(item.get("model") or "").strip(),
            )
        )
    return LLMProfilesState(active_id=str(data.get("active_id") or ""), profiles=profiles)


def load_profiles(path: Path | str | None = None) -> LLMProfilesState:
    """读全部档案与激活 id；没有 / 坏了 → 空状态（不报错）。

    Args:
        path: 状态库路径；省略 = `JOBPILOT_DB` = `data/jobpilot.db`。
    """
    try:
        raw = jobpilot_db.doc_get_raw(jobpilot_db.DOC_LLM_CONFIG, path)
    except (OSError, sqlite3.Error) as exc:
        logger.warning("状态库打不开，LLM 档案按空处理：%s", exc)
        return LLMProfilesState()
    if raw is None:
        return LLMProfilesState()
    try:
        data = json.loads(raw)
    except ValueError as exc:
        logger.warning("LLM 档案读不出来，按空处理：%s", exc)
        return LLMProfilesState()
    return _state_from_payload(data)


def save_profiles(state: LLMProfilesState, path: Path | str | None = None) -> Path:
    """写回档案库；返回库路径。"""
    payload = {
        "version": _PAYLOAD_VERSION,
        "active_id": state.active_id,
        "profiles": [asdict(p) for p in state.profiles],
    }
    resolved = jobpilot_db.doc_set(jobpilot_db.DOC_LLM_CONFIG, payload, path)
    logger.info(
        "LLM 档案已保存到 %s（%d 套，激活 %s）", resolved, len(state.profiles), state.active_id or "无"
    )
    return resolved


def load_config(path: Path | str | None = None) -> LLMConfig:
    """读「当前激活档案」的运行配置；没有档案 → 空配置（不报错）。

    业务方（简历解析 / 匹配 / 面试题）都走这一个口，切档案即切模型。

    Args:
        path: 状态库路径；省略 = `JOBPILOT_DB` = `data/jobpilot.db`。
    """
    active = load_profiles(path).active()
    return active.to_config() if active else LLMConfig()


def save_config(cfg: LLMConfig, path: Path | str | None = None) -> Path:
    """把 `cfg` 写进激活档案（没有档案就建「默认配置」并激活）；其余档案不动。

    兼容旧调用（测试与历史代码）；新代码请用 `create_profile` / `update_profile`。

    Args:
        cfg: 要保存的配置。
        path: 状态库路径；省略 = `JOBPILOT_DB` = `data/jobpilot.db`。
    """
    state = load_profiles(path)
    active = state.active()
    if active is None:
        active = LLMProfile(id=_new_id(), name=_DEFAULT_PROFILE_NAME)
        state.profiles.append(active)
        state.active_id = active.id
    active.api_key = cfg.api_key
    active.base_url = cfg.base_url
    active.model = cfg.model
    return save_profiles(state, path)


def update_config(payload: dict[str, Any], path: Path | str | None = None) -> LLMConfig:
    """合并更新激活档案的三项：api_key 留空则保留旧值；系统固定字段一律忽略。

    兼容旧接口 `PUT /api/llm/config`；没有档案时先建「默认配置」并激活。
    """
    state = load_profiles(path)
    active = state.active()
    if active is None:
        active = LLMProfile(id=_new_id(), name=_DEFAULT_PROFILE_NAME)
        state.profiles.append(active)
        state.active_id = active.id
    for key in _UPDATABLE:
        if key in payload and payload[key] is not None:
            value = str(payload[key]).strip()
            if key == "api_key" and not value:
                continue
            setattr(active, key, value)
    save_profiles(state, path)
    return active.to_config()


def _require_profile(state: LLMProfilesState, pid: str) -> LLMProfile:
    """按 id 找档案，找不到直接 404。"""
    for p in state.profiles:
        if p.id == pid:
            return p
    raise NotFoundError(f"模型配置档案不存在：{pid}")


def create_profile(payload: dict[str, Any], path: Path | str | None = None) -> LLMProfile:
    """新建档案；第一套自动激活。name 必填，其余允许留空（先建后补）。

    Args:
        payload: `{name, api_key?, base_url?, model?}`。
        path: 状态库路径；省略 = 默认库。
    """
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValidationWebError("档案名称不能空着")
    state = load_profiles(path)
    profile = LLMProfile(
        id=_new_id(),
        name=name,
        api_key=str(payload.get("api_key") or "").strip(),
        base_url=str(payload.get("base_url") or "").strip(),
        model=str(payload.get("model") or "").strip(),
    )
    if not state.profiles:
        state.active_id = profile.id
    state.profiles.append(profile)
    save_profiles(state, path)
    return profile


def update_profile(pid: str, payload: dict[str, Any], path: Path | str | None = None) -> LLMProfile:
    """编辑档案；api_key 留空 = 保留旧 Key。name 必填。

    Args:
        pid: 档案 id。
        payload: `{name, api_key?, base_url?, model?}`。
        path: 状态库路径；省略 = 默认库。
    """
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValidationWebError("档案名称不能空着")
    state = load_profiles(path)
    profile = _require_profile(state, pid)
    profile.name = name
    profile.base_url = str(payload.get("base_url") or "").strip()
    profile.model = str(payload.get("model") or "").strip()
    key = str(payload.get("api_key") or "").strip()
    if key:
        profile.api_key = key
    save_profiles(state, path)
    return profile


def delete_profile(pid: str, path: Path | str | None = None) -> LLMProfilesState:
    """删档案；删的是激活档案就自动切到剩余第一个，删光则无激活。

    Args:
        pid: 档案 id。
        path: 状态库路径；省略 = 默认库。
    """
    state = load_profiles(path)
    _require_profile(state, pid)
    state.profiles = [p for p in state.profiles if p.id != pid]
    if state.active_id == pid:
        state.active_id = state.profiles[0].id if state.profiles else ""
    save_profiles(state, path)
    return state


def activate_profile(pid: str, path: Path | str | None = None) -> LLMProfilesState:
    """切换激活档案；此后 `load_config()`（所有业务）用的就是这一套。

    Args:
        pid: 档案 id。
        path: 状态库路径；省略 = 默认库。
    """
    state = load_profiles(path)
    _require_profile(state, pid)
    state.active_id = pid
    save_profiles(state, path)
    return state


def resolve_profile_config(
    *,
    profile_id: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    path: Path | str | None = None,
) -> LLMConfig:
    """按档案取运行配置：`profile_id` 指名档案（缺省=激活档案），表单临时值优先。

    给「拉模型 / 测连通」用：表单里现填的 base_url / api_key / model 覆盖档案
    存值，没填的部分回落到档案——新建档案还没落库时三样全靠表单值也测得通。

    Raises:
        NotFoundError: `profile_id` 指了个不存在的档案。
    """
    state = load_profiles(path)
    if profile_id:
        profile = _require_profile(state, profile_id)
    else:
        profile = state.active()
    return LLMConfig(
        api_key=(api_key or "").strip() or (profile.api_key if profile else ""),
        base_url=(base_url or "").strip() or (profile.base_url if profile else ""),
        model=(model or "").strip() or (profile.model if profile else ""),
        temperature=C.LLM_TEMPERATURE,
        max_tokens=C.LLM_MAX_TOKENS,
        timeout=C.LLM_TIMEOUT,
    ).normalize()
