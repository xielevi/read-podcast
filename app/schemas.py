"""Read Podcast API 的请求/响应模型。

从原 ``app/router.py`` 抽出集中管理；这些模型不被测试 monkeypatch，可安全共享。
"""
from __future__ import annotations

from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from app.models.task import TaskStatus
from modules.wikipedia import MAX_CONCEPTS, MIN_CONCEPTS


class AddPodcastRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    rss_url: str = Field(min_length=1, max_length=2048)
    image: str = Field(default="", max_length=2048)


class CreateTaskRequest(BaseModel):
    podcast_name: str = Field(min_length=1, max_length=200)
    # 与 EpisodeReadStateRequest 对齐，给个别超长的节目标题留足余量。
    episode_title: str = Field(min_length=1, max_length=1000)
    force: bool = False


class CustomTaskRequest(BaseModel):
    audio_filename: str = Field(min_length=1, max_length=255)
    custom_prompt: str = Field(min_length=1, max_length=100_000)


class LookupRequest(BaseModel):
    term: str = Field(min_length=1, max_length=200)
    context: str = Field(default="", max_length=4000)


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: List[ChatMessage] = Field(default_factory=list)


class LibraryChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: List[ChatMessage] = Field(default_factory=list)


class ExportRequest(BaseModel):
    connector: str = Field(min_length=1, max_length=200)
    # manuscript：推送整篇成稿；summary：推送 AI 提炼的知识条目
    mode: str = Field(default="manuscript", pattern="^(manuscript|summary)$")


class ConceptsRequest(BaseModel):
    """关键概念抽取；limit 缺省时用配置里的值。"""
    limit: Optional[int] = Field(default=None, ge=MIN_CONCEPTS, le=MAX_CONCEPTS)
    refresh: bool = False


class SettingsUpdateRequest(BaseModel):
    """普通配置与机密分开提交；机密缺省表示不改动，空串表示清除。"""
    values: Dict[str, str] = Field(default_factory=dict)
    secrets: Dict[str, str] = Field(default_factory=dict)


class SettingsTestRequest(BaseModel):
    target: str = Field(pattern="^(refiner|transcription)$")


class OAuthAppCredentialsRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=2048)
    client_secret: str = Field(min_length=1, max_length=2048)


class OAuthAuthorizeRequest(BaseModel):
    redirect_uri: str = Field(min_length=1, max_length=2048)


class EpisodeReadStateRequest(BaseModel):
    podcast_name: str = Field(min_length=1, max_length=500)
    episode_title: str = Field(min_length=1, max_length=1000)
    read: bool


class PublicTask(BaseModel):
    id: str
    podcast_name: str
    episode_title: str
    status: TaskStatus
    progress_pct: int
    stage: str
    message: str
    created_at: datetime
    updated_at: datetime
