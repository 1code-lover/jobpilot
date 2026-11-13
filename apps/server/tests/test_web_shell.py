"""壳路由：新壳 `/` 与 SPA 深链兜底。"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from jobpilot_server import create_app


@pytest.fixture
def static_tree(tmp_path: Path, monkeypatch) -> Path:
    """造一棵只有新壳的静态树，并把它设成 `STATIC_DIR`。"""
    from jobpilot_server import config as C

    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "index.html").write_text("<html>新壳</html>", encoding="utf-8")
    monkeypatch.setattr(C, "STATIC_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def client(static_tree: Path) -> TestClient:
    """提供隔离库下的 TestClient。"""
    return TestClient(create_app())


def test_根回新壳(client: TestClient):
    """验 `/` 出新壳。"""
    res = client.get("/")
    assert res.status_code == 200
    assert "新壳" in res.text


def test_未知路径回新壳(client: TestClient):
    """验新壳的深链落回新壳（刷新不 404）。"""
    res = client.get("/overview/deep")
    assert res.status_code == 200
    assert "新壳" in res.text


def test_assets路径映射到dist_不再回HTML壳(static_tree: Path):
    """回归：`/assets/*.js` 要回真文件（dist/assets/），不能被兜底成 index.html 白屏。"""
    assets = static_tree / "dist" / "assets"
    assets.mkdir(parents=True)
    (assets / "index-abc.js").write_text("console.log('真bundle')", encoding="utf-8")
    client = TestClient(create_app())
    res = client.get("/assets/index-abc.js")
    assert res.status_code == 200
    assert "真bundle" in res.text
    assert "新壳" not in res.text


def test_static根下的文件也直接回文件(static_tree: Path):
    """兼容旧行为：落在 static 根（不在 dist/ 里）的真文件照样回文件。"""
    (static_tree / "favicon.ico").write_text("ICON", encoding="utf-8")
    client = TestClient(create_app())
    res = client.get("/favicon.ico")
    assert res.status_code == 200
    assert res.text == "ICON"
