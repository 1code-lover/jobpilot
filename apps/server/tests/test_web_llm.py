"""LLM 配置与客户端的单元测试（离线，网络层可注入）。

配置落状态库 `doc('llm_config')`；这里传的 `p` 是库路径。

Attributes:
    REQUESTS_ERRORS: 抄自真实 requests 异常的文本。
"""

from __future__ import annotations

import json

import pytest

import jobpilot_db
from jobpilot_server import config as C
from jobpilot_server.errors import NotFoundError, UpstreamError
from jobpilot_server.services.llm_client import LLMClient, extract_json
from jobpilot_server.services.llm_config_store import (
    LLMConfig,
    activate_profile,
    create_profile,
    delete_profile,
    load_config,
    load_profiles,
    mask_key,
    resolve_profile_config,
    save_config,
    update_config,
    update_profile,
)


class FakeResp:
    """假 HTTP 响应。"""
    def __init__(self, payload, status=200):
        """初始化。"""
        self._payload = payload
        self.status_code = status
        self.text = json.dumps(payload, ensure_ascii=False)

    def json(self):
        """返回预置 payload。"""
        return self._payload


class FakeHttp:
    """假 HTTP 客户端，记录调用并返回预置响应。"""
    def __init__(self, resp=None, exc=None):
        """初始化。"""
        self.resp = resp
        self.exc = exc
        self.calls = []

    def _hit(self, method, url, **kwargs):
        """记录一次调用并返回响应或抛出预置异常。"""
        self.calls.append((method, url, kwargs))
        if self.exc:
            raise self.exc
        return self.resp

    def post(self, url, **kwargs):
        """记录 POST 调用。"""
        return self._hit("POST", url, **kwargs)

    def get(self, url, **kwargs):
        """记录 GET 调用。"""
        return self._hit("GET", url, **kwargs)


class SeqHttp:
    """按序返回响应的假 HTTP 客户端（429 重试用）。"""
    def __init__(self, resps):
        """初始化。"""
        self.resps = list(resps)
        self.calls = []

    def post(self, url, **kwargs):
        """弹出下一条响应并记录调用。"""
        self.calls.append((url, kwargs))
        return self.resps.pop(0)


def test_mask_key():
    """验证 mask_key 打码前后保留可辨识片段。"""
    assert mask_key("") == ""
    assert mask_key("sk-abcdef123456").startswith("sk-")
    assert mask_key("sk-abcdef123456").endswith("3456")


def test_save_load_roundtrip(tmp_path):
    """验证 LLM 配置存取往返与默认采样参数。"""
    p = tmp_path / "boss.db"
    cfg = LLMConfig(api_key="sk-secret", base_url="https://x/v1", model="m1", temperature=0.3)
    save_config(cfg, p)
    loaded = load_config(p)
    assert loaded.api_key == "sk-secret"
    assert loaded.model == "m1"
    assert loaded.configured
    assert loaded.masked()["api_key"] == "sk-***cret"
    assert loaded.masked()["has_key"] is True
    assert loaded.temperature == C.LLM_TEMPERATURE
    assert loaded.max_tokens == C.LLM_MAX_TOKENS
    assert loaded.timeout == C.LLM_TIMEOUT


def test_update_keeps_old_key(tmp_path):
    """验证空 api_key 更新时保留旧密钥。"""
    p = tmp_path / "boss.db"
    save_config(LLMConfig(api_key="sk-old", model="m"), p)
    cfg = update_config({"api_key": "", "model": "m2"}, p)
    assert cfg.api_key == "sk-old"
    assert cfg.model == "m2"


def test_update_ignores_sampling_params(tmp_path):
    """温度 / max_tokens / 超时是系统固定值，传进来也要被丢掉。"""
    p = tmp_path / "boss.db"
    save_config(LLMConfig(api_key="sk-a", model="m1"), p)
    cfg = update_config(
        {
            "model": "m2",
            "temperature": 1.9,
            "max_tokens": 16,
            "timeout": 5.0,
        },
        p,
    )
    assert cfg.model == "m2"
    assert cfg.temperature == C.LLM_TEMPERATURE
    assert cfg.max_tokens == C.LLM_MAX_TOKENS
    assert cfg.timeout == C.LLM_TIMEOUT
    # v2 payload 不存采样参数（它们是常量，不是数据）；档案里只有三项可变字段
    raw = jobpilot_db.doc_get(jobpilot_db.DOC_LLM_CONFIG, p)
    assert "temperature" not in raw and "max_tokens" not in raw
    profile = raw["profiles"][0]
    assert profile["model"] == "m2"
    assert set(profile) == {"id", "name", "api_key", "base_url", "model"}


def test_load_normalizes_legacy_values(tmp_path):
    """历史配置里若写过采样参数，读出来也要被拉齐。"""
    p = tmp_path / "boss.db"
    jobpilot_db.doc_set(
        jobpilot_db.DOC_LLM_CONFIG,
        {
            "api_key": "sk-x",
            "base_url": "https://x/v1",
            "model": "m",
            "temperature": 1.5,
            "max_tokens": 99,
            "timeout": 7.0,
        },
        p,
    )
    cfg = load_config(p)
    assert cfg.temperature == C.LLM_TEMPERATURE
    assert cfg.max_tokens == C.LLM_MAX_TOKENS
    assert cfg.timeout == C.LLM_TIMEOUT


def test_masked_exposes_fixed_params():
    """验证 masked() 暴露固定采样参数。"""
    cfg = LLMConfig(api_key="sk-12345678", model="m").masked()
    assert cfg["fixed"]["temperature"] == C.LLM_TEMPERATURE
    assert cfg["fixed"]["max_tokens"] == C.LLM_MAX_TOKENS
    assert cfg["fixed"]["resume_parse_max_tokens"] == C.LLM_RESUME_PARSE_MAX_TOKENS
    assert cfg["fixed"]["match_max_tokens"] == C.LLM_MATCH_MAX_TOKENS
    assert cfg["fixed"]["timeout"] == C.LLM_TIMEOUT


def test_chat_with_metadata_returns_finish_reason_without_changing_chat_contract():
    """验证 chat_with_metadata 带回 finish_reason 且不改 chat 契约。"""
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"),
        http=FakeHttp(FakeResp({"choices": [{"message": {"content": "你好"}, "finish_reason": "length"}]})),
    )

    result = client.chat_with_metadata([{"role": "user", "content": "hi"}])
    assert result.content == "你好"
    assert result.finish_reason == "length"


def test_chat_with_metadata_accepts_missing_finish_reason():
    """验证 finish_reason 缺失时返回 None。"""
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"),
        http=FakeHttp(FakeResp({"choices": [{"message": {"content": "你好"}}]})),
    )

    result = client.chat_with_metadata([{"role": "user", "content": "hi"}])
    assert result.content == "你好"
    assert result.finish_reason is None


def test_chat_posts_to_completions():
    """验证 chat 打到 chat/completions 并带上固定参数。"""
    http = FakeHttp(
        FakeResp({"choices": [{"message": {"content": "你好"}}], "model": "m1"})
    )
    client = LLMClient(LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"), http=http)
    out = client.chat([{"role": "user", "content": "hi"}])
    assert out == "你好"
    method, url, kwargs = http.calls[0]
    assert method == "POST"
    assert url == "https://api.x/v1/chat/completions"
    assert kwargs["headers"]["Authorization"] == "Bearer sk-1"
    body = json.loads(kwargs["data"].decode("utf-8"))
    assert body["model"] == "m1"
    assert body["temperature"] == C.LLM_TEMPERATURE
    assert body["max_tokens"] == C.LLM_MAX_TOKENS


def test_chat_retries_on_429_and_switches_to_serial(monkeypatch):
    """被限流时退避重试同一地址，成功后本实例改串行。"""
    from jobpilot_ai import llm as ai_llm

    monkeypatch.setattr(ai_llm.time, "sleep", lambda _s: None)
    http = SeqHttp([
        FakeResp({"error": "rate limited"}, status=429),
        FakeResp({"choices": [{"message": {"content": "好"}}]}),
    ])
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"), http=http
    )

    assert client.chat([{"role": "user", "content": "hi"}]) == "好"
    assert len(http.calls) == 2
    assert client._serial is True


def test_chat_gives_up_after_429_retries(monkeypatch):
    """限流重试耗尽后抛可读错误。"""
    from jobpilot_ai import llm as ai_llm

    monkeypatch.setattr(ai_llm.time, "sleep", lambda _s: None)
    http = SeqHttp([FakeResp({"error": "rate limited"}, status=429) for _ in range(5)])
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"), http=http
    )

    with pytest.raises(Exception) as exc:
        client.chat([{"role": "user", "content": "hi"}])
    assert "频繁" in str(exc.value)
    assert len(http.calls) == 5


def test_connection_test_uses_small_token_limit():
    """验证连通性测试使用小 token 上限。"""
    http = FakeHttp(FakeResp({"choices": [{"message": {"content": "正常"}}]}))
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"),
        http=http,
    )

    result = client.test()

    assert result["ok"] is True
    body = json.loads(http.calls[0][2]["data"].decode("utf-8"))
    assert body["max_tokens"] == 16


def test_chat_requires_config():
    """验证未配置时 chat 直接报错。"""
    client = LLMClient(LLMConfig())
    with pytest.raises(Exception):
        client.chat([{"role": "user", "content": "hi"}])


def test_list_models():
    """验证 list_models 去重并丢掉空 id。"""
    http = FakeHttp(
        FakeResp(
            {
                "data": [
                    {"id": "deepseek-chat"},
                    {"id": "deepseek-reasoner"},
                    {"id": "deepseek-chat"},
                    {"id": ""},
                ]
            }
        )
    )
    client = LLMClient(LLMConfig(api_key="sk-1", base_url="https://api.x/v1"), http=http)
    assert client.list_models() == ["deepseek-chat", "deepseek-reasoner"]
    method, url, kwargs = http.calls[0]
    assert method == "GET"
    assert url == "https://api.x/v1/models"
    assert kwargs["headers"]["Authorization"] == "Bearer sk-1"


def test_list_models_requires_key():
    """验证无密钥时 list_models 报错。"""
    client = LLMClient(LLMConfig(base_url="https://api.x/v1"), http=FakeHttp())
    with pytest.raises(Exception):
        client.list_models()


def test_list_models_rejects_bad_payload():
    """验证 list_models 拒绝非 OpenAI 结构。"""
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://api.x/v1"),
        http=FakeHttp(FakeResp({"oops": 1})),
    )
    with pytest.raises(Exception):
        client.list_models()


def test_extract_json_variants():
    """验证 extract_json 的各种包裹形式。"""
    assert extract_json('{"a":1}') == {"a": 1}
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('前言 {"match_score": 80} 后语')["match_score"] == 80
    assert extract_json("没有 JSON") is None



REQUESTS_ERRORS = [
    "HTTPSConnectionPool(host='api.deepseek.com', port=443): Max retries exceeded "
    "with url: /v1/chat/completions (Caused by ConnectTimeoutError("
    "<urllib3.connection.HTTPSConnection object at 0x1>, "
    "'Connection to api.deepseek.com timed out. (connect timeout=120)'))",
    "HTTPSConnectionPool(host='api.x.com', port=443): Max retries exceeded with url: "
    "/v1/chat/completions (Caused by SSLError(SSLCertVerificationError(1, "
    "'[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed')))",
    "HTTPSConnectionPool(host='127.0.0.1', port=9999): Max retries exceeded with url: "
    "/v1/chat/completions (Caused by NewConnectionError('<urllib3.connection.HTTPConnection "
    "object at 0x2>: Failed to establish a new connection: [WinError 10061] 由于目标计算机积极拒绝'))",
]


def _client(resp=None, exc=None):
    """造一个注入假 HTTP 的 LLMClient。"""
    import requests

    kwargs = {}
    if exc is not None:
        kwargs["exc"] = exc
    else:
        kwargs["resp"] = resp
    return LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"),
        http=FakeHttp(**kwargs),
    )


@pytest.mark.parametrize("raw", REQUESTS_ERRORS)
def test_network_error_never_shows_requests_internals(raw):
    """验证网络错误文案不泄漏 requests 内部细节。"""
    import requests

    exc = requests.ConnectionError(raw)
    with pytest.raises(UpstreamError) as ei:
        _client(exc=exc).chat([{"role": "user", "content": "hi"}])

    message = str(ei.value)
    assert message != raw
    for leak in ("HTTPSConnectionPool", "urllib3", "WinError", "SSLError", "0x1", "url:"):
        assert leak not in message, f"漏了 {leak}：{message}"
    assert "网" in message or "网络" in message or "连接" in message


@pytest.mark.parametrize(
    "status,hint",
    [
        (401, "API Key"),
        (402, "余额"),
        (404, "接口地址"),
        (429, "频繁"),
    ],
)
def test_upstream_status_becomes_actionable(status, hint):
    """验证上游状态码转成可操作中文提示。"""
    resp = FakeResp({"error": {"message": "some upstream english text"}}, status=status)
    with pytest.raises(UpstreamError) as ei:
        _client(resp=resp).chat([{"role": "user", "content": "hi"}])

    message = str(ei.value)
    assert hint in message, message
    assert "some upstream english text" not in message, "上游响应体不许出现在界面上"


def test_upstream_5xx_blames_the_server_not_the_user():
    """验证 5xx 归咎服务商而非用户。"""
    resp = FakeResp({"error": "internal"}, status=503)
    with pytest.raises(UpstreamError) as ei:
        _client(resp=resp).chat([{"role": "user", "content": "hi"}])
    assert "不是你" in str(ei.value) or "服务商" in str(ei.value)


def test_keyword_in_body_wins_over_plain_status_table():
    """同一个 400，有的服务商说余额不足、有的说模型不存在——按原文判更准。"""
    from jobpilot_server.services.llm_client import _friendly_http_error

    assert "模型" in _friendly_http_error(400, '{"error":"Model Not Exist"}')
    assert "余额" in _friendly_http_error(400, '{"error":"Insufficient Balance"}')


def test_unknown_status_keeps_the_code_but_not_the_body():
    """验证未知状态保留状态码但不透出响应体。"""
    from jobpilot_server.services.llm_client import _friendly_http_error

    out = _friendly_http_error(418, "<html>teapot 内部堆栈 xxx</html>")
    assert "418" in out, "认不出来至少要把状态码给出来，方便用户报障"
    assert "teapot" not in out
    assert "<html>" not in out


def test_bad_json_response_is_explained_not_dumped():
    """验证非 JSON 响应被解释而非原文倾倒。"""
    class NotJson(FakeResp):
        """json() 会抛错的假响应。"""
        def json(self):
            """抛出 ValueError。"""
            raise ValueError("Expecting value: line 1 column 1 (char 0)")

    resp = NotJson({"x": 1})
    with pytest.raises(UpstreamError) as ei:
        _client(resp=resp).chat([{"role": "user", "content": "hi"}])
    message = str(ei.value)
    assert "Expecting value" not in message
    assert "接口地址" in message


def test_models_error_paths_also_humanized():
    """验证 models 接口错误同样人话化。"""
    resp = FakeResp({"error": "Unauthorized"}, status=401)
    with pytest.raises(UpstreamError) as ei:
        _client(resp=resp).list_models()
    assert "API Key" in str(ei.value)


def test_models_rejects_non_openai_shape_with_advice():
    """验证 models 非 OpenAI 结构给出改配建议。"""
    with pytest.raises(UpstreamError) as ei:
        _client(resp=FakeResp({"oops": 1})).list_models()
    assert "OpenAI" in str(ei.value)



# ---------- 多档案（ccswitch 风格） ----------


def test_旧扁平形状自动迁移成单档案(tmp_path):
    """v1 扁平 payload 读出来自动变成「默认配置」档案并激活，load_config 不变。"""
    p = tmp_path / "boss.db"
    jobpilot_db.doc_set(
        jobpilot_db.DOC_LLM_CONFIG,
        {"api_key": "sk-old", "base_url": "https://old.example/v1", "model": "m-old"},
        p,
    )
    cfg = load_config(p)
    assert (cfg.api_key, cfg.base_url, cfg.model) == ("sk-old", "https://old.example/v1", "m-old")
    state = load_profiles(p)
    assert len(state.profiles) == 1 and state.profiles[0].name == "默认配置"
    assert state.active_id == state.profiles[0].id


def test_旧配置全空_不造空档案(tmp_path):
    """空配置迁移不出档案，免得列表里躺一行没用的。"""
    p = tmp_path / "boss.db"
    jobpilot_db.doc_set(jobpilot_db.DOC_LLM_CONFIG, {"api_key": "", "base_url": "", "model": ""}, p)
    assert load_profiles(p).profiles == []
    assert load_config(p) == LLMConfig()


def test_档案CRUD与切换(tmp_path):
    """建两套档案 → 切换 → load_config 跟随激活档案走。"""
    p = tmp_path / "boss.db"
    a = create_profile({"name": "DeepSeek", "api_key": "sk-a", "base_url": "https://a/v1", "model": "ma"}, p)
    b = create_profile({"name": "Kimi", "api_key": "sk-b", "base_url": "https://b/v1", "model": "mb"}, p)
    # 第一套自动激活
    assert load_profiles(p).active_id == a.id
    assert load_config(p).model == "ma"
    # 切到第二套
    state = activate_profile(b.id, p)
    assert state.active_id == b.id
    cfg = load_config(p)
    assert (cfg.api_key, cfg.base_url, cfg.model) == ("sk-b", "https://b/v1", "mb")
    # 编辑：key 留空保留旧值
    upd = update_profile(b.id, {"name": "Kimi 改", "base_url": "https://b2/v1", "model": "mb2", "api_key": ""}, p)
    assert upd.api_key == "sk-b" and upd.model == "mb2" and upd.name == "Kimi 改"
    # 列表回显打码
    masks = [q.masked() for q in load_profiles(p).profiles]
    assert masks[1]["api_key"] == mask_key("sk-b") and masks[1]["has_key"] is True


def test_删激活档案自动回退(tmp_path):
    """删掉激活档案 → 回退剩余第一个；删光 → 无激活（未配置态）。"""
    p = tmp_path / "boss.db"
    a = create_profile({"name": "A", "api_key": "sk-a", "model": "ma"}, p)
    b = create_profile({"name": "B", "api_key": "sk-b", "model": "mb"}, p)
    activate_profile(b.id, p)
    state = delete_profile(b.id, p)
    assert state.active_id == a.id and load_config(p).model == "ma"
    delete_profile(a.id, p)
    state = load_profiles(p)
    assert state.profiles == [] and state.active_id == ""
    assert load_config(p) == LLMConfig()


def test_档案名字不能空_未知id报404(tmp_path):
    """name 必填；未知 id 一律 NotFoundError（接口层转 404）。"""
    p = tmp_path / "boss.db"
    with pytest.raises(Exception):
        create_profile({"name": "  "}, p)
    with pytest.raises(NotFoundError):
        update_profile("p_不存在", {"name": "x"}, p)
    with pytest.raises(NotFoundError):
        activate_profile("p_不存在", p)
    with pytest.raises(NotFoundError):
        delete_profile("p_不存在", p)
    with pytest.raises(NotFoundError):
        resolve_profile_config(profile_id="p_不存在")


def test_resolve_临时凭据优先于档案(tmp_path):
    """拉模型/测连通：表单现填的 base_url/key 覆盖档案存值，没填的回落档案。"""
    p = tmp_path / "boss.db"
    a = create_profile({"name": "A", "api_key": "sk-a", "base_url": "https://a/v1", "model": "ma"}, p)
    cfg = resolve_profile_config(base_url="https://tmp/v1", api_key="sk-tmp", path=p)
    assert (cfg.base_url, cfg.api_key, cfg.model) == ("https://tmp/v1", "sk-tmp", "ma")
    cfg = resolve_profile_config(profile_id=a.id, path=p)
    assert (cfg.base_url, cfg.api_key, cfg.model) == ("https://a/v1", "sk-a", "ma")


def test_旧update_config落到激活档案(tmp_path):
    """PUT /config 兼容路径：改的是激活档案；没有档案时先建「默认配置」。"""
    p = tmp_path / "boss.db"
    cfg = update_config({"api_key": "sk-new", "base_url": "https://n/v1", "model": "mn"}, p)
    assert (cfg.api_key, cfg.model) == ("sk-new", "mn")
    state = load_profiles(p)
    assert len(state.profiles) == 1 and state.profiles[0].name == "默认配置"
    assert state.active_id == state.profiles[0].id
    # 再建一套并激活，旧接口更新的是新激活档案
    b = create_profile({"name": "B", "api_key": "sk-b", "model": "mb"}, p)
    activate_profile(b.id, p)
    update_config({"model": "mb-new"}, p)
    assert load_profiles(p).active().model == "mb-new"
    assert load_profiles(p).profiles[0].model == "mn"  # 旧档案没被波及


# ---------- 接口层：/api/llm/profiles ----------


def test_api_档案全流程(tmp_path):
    """建 → 列表 → 切换 → 编辑 → 删除，走一遍 HTTP 接口。"""
    from fastapi.testclient import TestClient

    from jobpilot_server import create_app

    client = TestClient(create_app())
    r1 = client.post("/api/llm/profiles", json={"name": "DeepSeek", "api_key": "sk-a", "base_url": "https://a/v1", "model": "ma"})
    assert r1.status_code == 200
    pid_a = r1.json()["id"]
    r2 = client.post("/api/llm/profiles", json={"name": "Kimi", "api_key": "sk-b", "model": "mb"})
    pid_b = r2.json()["id"]
    # 列表：第一套自动激活，key 打码
    lst = client.get("/api/llm/profiles").json()
    assert lst["active_id"] == pid_a
    assert lst["profiles"][0]["api_key"] == mask_key("sk-a")
    # 切换
    assert client.put(f"/api/llm/profiles/{pid_b}/activate").json()["active_id"] == pid_b
    assert client.get("/api/llm/config").json()["model"] == "mb"
    # 编辑：key 留空保留
    upd = client.put(f"/api/llm/profiles/{pid_b}", json={"name": "Kimi2", "model": "mb2", "api_key": ""})
    assert upd.json()["name"] == "Kimi2" and upd.json()["has_key"] is True
    # 删除激活档案 → 回退第一套
    assert client.delete(f"/api/llm/profiles/{pid_b}").json()["active_id"] == pid_a
    # 未知 id → 404
    assert client.put("/api/llm/profiles/p_xxx/activate").status_code == 404
    # name 必填 → 422/错误
    assert client.post("/api/llm/profiles", json={"name": ""}).status_code == 422


# ---------- 接口地址候选（根域名自动补 /v1，ccswitch 式兜底） ----------


class HtmlResp:
    """假响应：模拟中转站根路径返回的网页（json() 必炸）。"""

    def __init__(self, text="<html>站点首页</html>", status=200):
        self.status_code = status
        self.text = text

    def json(self):
        raise ValueError("Expecting value")


class UrlFakeHttp:
    """按 URL 分流的假 HTTP：候选地址探测用，get/post 都记录调用。"""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def _hit(self, method, url, **kwargs):
        self.calls.append((method, url))
        return self.routes[url]

    def get(self, url, **kwargs):
        return self._hit("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self._hit("POST", url, **kwargs)


def _chat_ok():
    """标准 chat/completions 成功回包。"""
    return FakeResp({"choices": [{"message": {"content": "正常"}, "finish_reason": "stop"}]})


def test_拉模型_根域名撞网页_自动补v1拉到并记住入口():
    """只填根域名：第一个候选撞网页，自动补 /v1 拉到模型并记住真入口。"""
    http = UrlFakeHttp({
        "https://relay.example/models": HtmlResp(),
        "https://relay.example/v1/models": FakeResp({"data": [{"id": "m1"}, {"id": "m2"}]}),
    })
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://relay.example", model="m1"), http=http
    )
    assert client.list_models() == ["m1", "m2"]
    assert http.calls == [
        ("GET", "https://relay.example/models"),
        ("GET", "https://relay.example/v1/models"),
    ]
    # 记住真入口：再拉只打 /v1 一个候选
    client.list_models()
    assert http.calls[-1] == ("GET", "https://relay.example/v1/models")


def test_拉模型_两个候选都不行_报错带v1提示():
    """原样和补 /v1 都撞网页：报错里明确说 /v1 也试过了。"""
    http = UrlFakeHttp({
        "https://relay.example/models": HtmlResp(),
        "https://relay.example/v1/models": HtmlResp(),
    })
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://relay.example", model="m1"), http=http
    )
    with pytest.raises(UpstreamError) as ei:
        client.list_models()
    assert "/v1" in ei.value.message


def test_拉模型_已带v1_只打一个候选():
    """地址本身以 /v1 结尾：行为跟旧版完全一致，只发一次请求。"""
    http = UrlFakeHttp({"https://api.x/v1/models": FakeResp({"data": [{"id": "m1"}]})})
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"), http=http
    )
    assert client.list_models() == ["m1"]
    assert http.calls == [("GET", "https://api.x/v1/models")]


def test_对话_根域名404_自动补v1成功():
    """chat 撞 404 换下一个候选；同一实例的后续对话直接走记住的入口。"""
    http = UrlFakeHttp({
        "https://relay.example/chat/completions": FakeResp({"error": "not found"}, status=404),
        "https://relay.example/v1/chat/completions": _chat_ok(),
    })
    client = LLMClient(
        LLMConfig(api_key="sk-1", base_url="https://relay.example", model="m1"), http=http
    )
    assert client.chat([{"role": "user", "content": "在吗"}]) == "正常"
    assert http.calls == [
        ("POST", "https://relay.example/chat/completions"),
        ("POST", "https://relay.example/v1/chat/completions"),
    ]
    client.chat([{"role": "user", "content": "再来"}])
    assert http.calls[-1] == ("POST", "https://relay.example/v1/chat/completions")


# ---------- 上游报错原因透传（中转站的响应体最说真话） ----------


def test_报错带上游原话_json格式():
    """new-api 系中转站的 400 带具体原因（如「无可用渠道」），要原样透传给用户。"""
    http = FakeHttp(FakeResp({"error": {"message": "无可用渠道", "type": "new_api_error"}}, status=400))
    client = LLMClient(LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"), http=http)
    with pytest.raises(UpstreamError) as ei:
        client.chat([{"role": "user", "content": "hi"}])
    assert "无可用渠道" in ei.value.message
    assert "上游说" in ei.value.message


def test_报错_上游返回网页_不带原话也不炸():
    """HTML 响应体抠不出原因：维持通用文案，不追加空话。"""
    http = FakeHttp(HtmlResp(status=400))
    client = LLMClient(LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"), http=http)
    with pytest.raises(UpstreamError) as ei:
        client.chat([{"role": "user", "content": "hi"}])
    assert "上游说" not in ei.value.message
    assert "对方没接受" in ei.value.message


def test_报错_命中关键词提示优先():
    """响应体里出现已知英文关键词（如 insufficient balance）仍走专属提示，不叠原话。"""
    body = {"error": {"message": "insufficient balance for this request"}}
    http = FakeHttp(FakeResp(body, status=400))
    client = LLMClient(LLMConfig(api_key="sk-1", base_url="https://api.x/v1", model="m1"), http=http)
    with pytest.raises(UpstreamError) as ei:
        client.chat([{"role": "user", "content": "hi"}])
    assert "余额不足" in ei.value.message
    assert "上游说" not in ei.value.message
