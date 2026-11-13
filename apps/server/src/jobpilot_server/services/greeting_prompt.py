"""招呼语生成约束，供完整匹配和单独重生成共用。

`GREETING_REQUIREMENT` 是出厂默认（定义在 `jobpilot_ai.greeting`）；用户可在
「系统配置 → 招呼语」改写，改写结果存在 `app_settings` 里。组装提示词时用
`resolve_greeting_requirement` 现读——自定义非空用自定义，空则回落本常量。
"""

from __future__ import annotations

from pathlib import Path

from jobpilot_ai.greeting import GREETING_REQUIREMENT

__all__ = [
    "GREETING_REQUIREMENT",
    "resolve_fixed_greeting",
    "resolve_greeting_requirement",
    "resolve_session_only_greeting",
]


def resolve_fixed_greeting(path: Path | str | None = None) -> str:
    """取当前生效的固定招呼语；空串 = 没启用、走 AI 生成。

    Args:
        path: 状态库路径；省略 = `JOBPILOT_DB` = `data/jobpilot.db`。

    Returns:
        用户设定的固定文案（空串 = 不启用）。
    """
    from .app_settings_store import load_settings

    return load_settings(path).fixed_greeting.strip()


def resolve_session_only_greeting(path: Path | str | None = None) -> bool:
    """投递是否只建会话、不发正文（正文用 BOSS 账号默认打招呼语）。

    Args:
        path: 状态库路径；省略 = `JOBPILOT_DB` = `data/jobpilot.db`。
    """
    from .app_settings_store import load_settings

    return bool(load_settings(path).session_only_greeting)


def resolve_greeting_requirement(path: Path | str | None = None) -> str:
    """取当前生效的招呼语约束：用户自定义优先，空则用出厂默认。

    Args:
        path: 状态库路径；省略 = `JOBPILOT_DB` = `data/jobpilot.db`。

    Returns:
        要插进提示词的约束文本。
    """
    from .app_settings_store import load_settings

    custom = load_settings(path).greeting_requirement.strip()
    return custom or GREETING_REQUIREMENT
