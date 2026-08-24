"""Read Podcast API 路由聚合入口。

原先集中在本文件的 1200+ 行路由已按业务域拆分到 ``app/routers/`` 包下
（episodes / tasks / assistant / connectors / settings）。这里只把这些子路由
并入同一个 ``router`` 对象，对外路径与在 ``app/standalone.py`` 的挂载方式保持不变。

包含顺序保持「静态/更具体的路径先于同前缀的参数路径」这一约束：``/tasks`` 相关
的静态路由（如 ``/tasks/completed-keys``、``/tasks/stream``）与 ``/tasks/{task_id}``
都在 ``tasks`` 子路由内部按原顺序注册，跨子路由之间不存在会互相遮蔽的同方法路径。
"""
from __future__ import annotations

from fastapi import APIRouter

from app.routers import assistant, connectors, episodes, settings, tasks

router = APIRouter(tags=["Read Podcast"])
router.include_router(episodes.router)
router.include_router(tasks.router)
router.include_router(assistant.router)
router.include_router(connectors.router)
router.include_router(settings.router)

# 兼容旧引用。
api_router = router
