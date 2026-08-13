"""SSE 订阅生命周期回归测试。"""
import asyncio

from app.sse import Notifier


def test_subscribe_sends_headers_immediately_and_unregisters():
    async def exercise():
        notifier = Notifier()
        stream = notifier.subscribe()

        assert await anext(stream) == ": connected\n\n"
        assert len(notifier.global_queues) == 1

        await stream.aclose()
        assert notifier.global_queues == []

    asyncio.run(exercise())
