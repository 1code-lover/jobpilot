"""LLM 配置档案（ccswitch 式多套模型一键切换）+ 在线模型列表 + 连通性测试。

可配置的只有 api_key / base_url / model；温度、max_tokens、超时是系统固定值。
`GET/PUT /config` 是旧接口，映射到「当前激活档案」，保持兼容。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from ..errors import UpstreamError
from ..services.llm_client import LLMClient
from ..services.llm_config_store import (
    LLMConfig,
    activate_profile,
    create_profile,
    delete_profile,
    load_profiles,
    resolve_profile_config,
    update_config,
    update_profile,
)

router = APIRouter()


class ConfigBody(BaseModel):
    """旧接口：只有这三项能改（作用在激活档案上）；采样参数即使传进来也会被丢掉。"""

    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None


class ProfileBody(BaseModel):
    """档案字段：name 必填；api_key 编辑时留空 = 保留旧 Key。"""

    name: str
    base_url: str = ""
    api_key: str = ""
    model: str = ""


class ModelsBody(BaseModel):
    """拉模型列表：临时凭据（不落盘）优先于档案存值。

    `profile_id` 缺省 = 激活档案——这样用户改完 Key 先「拉取」再「保存」也行。
    """

    base_url: str | None = None
    api_key: str | None = None
    profile_id: str | None = None


class TestBody(BaseModel):
    """连通性测试：按档案或表单临时值；全空 = 激活档案。

    `model` 也要收：新建档案还没落库时三样全靠表单值，缺了会被当成没配置。
    """

    profile_id: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


@router.get("/config")
def get_config() -> dict[str, Any]:
    """读激活档案的生效配置（key 打码）。旧接口，兼容保留。"""
    active = load_profiles().active()
    return active.to_config().masked() if active else LLMConfig().masked()


@router.put("/config")
def put_config(body: ConfigBody) -> dict[str, Any]:
    """写激活档案。旧接口，兼容保留。"""
    return update_config(body.model_dump(exclude_none=True)).masked()


@router.get("/profiles")
def get_profiles() -> dict[str, Any]:
    """档案列表（key 打码）+ 当前激活 id。"""
    return load_profiles().masked()


@router.post("/profiles")
def post_profile(body: ProfileBody) -> dict[str, Any]:
    """新建档案；第一套自动激活。"""
    return create_profile(body.model_dump()).masked()


@router.put("/profiles/{pid}")
def put_profile(pid: str, body: ProfileBody) -> dict[str, Any]:
    """编辑档案；api_key 留空 = 保留旧 Key。"""
    return update_profile(pid, body.model_dump()).masked()


@router.delete("/profiles/{pid}")
def remove_profile(pid: str) -> dict[str, Any]:
    """删档案；删激活档案自动回退到剩余第一个。"""
    return delete_profile(pid).masked()


@router.put("/profiles/{pid}/activate")
def activate(pid: str) -> dict[str, Any]:
    """切换激活档案；此后所有 AI 任务用的就是这一套。"""
    return activate_profile(pid).masked()


@router.post("/models")
def list_models(body: ModelsBody | None = None) -> dict[str, Any]:
    """代理 `GET {base_url}/models`，拉可用模型名给下拉框用。

    走 POST 是为了不把 API Key 塞进 URL。
    """
    body = body or ModelsBody()
    cfg = resolve_profile_config(
        profile_id=body.profile_id, base_url=body.base_url, api_key=body.api_key
    )
    client = LLMClient(cfg)
    models = client.list_models()
    return {
        "models": models,
        "source": cfg.base_url.rstrip("/") + "/models",
        "selected": cfg.model,
    }


@router.post("/test")
def test_connection(body: TestBody | None = None) -> dict[str, Any]:
    """连通性测试（按档案或表单临时值）；失败也回 200 带人话。"""
    body = body or TestBody()
    cfg = resolve_profile_config(
        profile_id=body.profile_id,
        base_url=body.base_url,
        api_key=body.api_key,
        model=body.model,
    )
    client = LLMClient(cfg)
    try:
        return client.test()
    except UpstreamError as exc:
        return {"ok": False, "message": exc.message}
