"""健康检查、转录后端状态，以及个人配置面板（服务商地址、模型、路径与机密）。"""
from __future__ import annotations

import asyncio
import logging
from typing import Dict

from fastapi import APIRouter, HTTPException

from app.routers._shared import config_lock
from app.schemas import SettingsTestRequest, SettingsUpdateRequest
from modules.config import settings
from modules.user_settings import (
    SettingsError,
    SettingsProbeError,
    apply_settings,
    describe_settings,
    probe_refiner,
    probe_transcription,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Read Podcast"])


@router.get("/health")
async def health_check() -> Dict[str, str]:
    return {"status": "healthy", "service": "read-podcast"}


@router.get("/transcription/status")
async def transcription_status() -> Dict:
    from modules.transcriber import describe_transcriber

    return describe_transcriber(settings.TRANSCRIPTION_CONFIG)


@router.get("/settings")
async def get_settings() -> Dict:
    """面板字段与当前取值；机密只回传「是否已配置」，绝不回传内容。"""
    return await asyncio.to_thread(describe_settings)


@router.put("/settings")
async def update_settings(body: SettingsUpdateRequest) -> Dict:
    """普通配置写入 config.yaml，机密写入 config/secrets.env，随后热重载。"""
    async with config_lock:
        try:
            return await asyncio.to_thread(apply_settings, body.values, body.secrets)
        except SettingsError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/settings/test")
async def test_settings(body: SettingsTestRequest) -> Dict:
    """按当前配置做一次只读预检，不产生正式内容，也不回传服务地址。"""
    probe = probe_refiner if body.target == "refiner" else probe_transcription
    try:
        return await asyncio.to_thread(probe)
    except SettingsProbeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
