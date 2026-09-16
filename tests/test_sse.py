"""SSE 订阅生命周期回归测试。"""
import asyncio
import json

from app.sse import Notifier


def test_fanout_drops_oldest_and_preserves_recipient_payloads():
    async def exercise():
        notifier = Notifier()
        task_stream = notifier.subscribe("one")
        global_stream = notifier.subscribe()
        other_stream = notifier.subscribe("two")
        streams = (task_stream, global_stream, other_stream)
        for stream in streams:
            await anext(stream)
        try:
            for progress in range(201):
                await notifier.push("one", {"progress": progress})
            assert notifier.queues["two"][0].empty()
            assert notifier.queues["one"][0].qsize() == 200
            assert json.loads((await anext(task_stream))[6:]) == {"progress": 1}
            assert json.loads((await anext(global_stream))[6:]) == {"task_id": "one", "progress": 1}
        finally:
            for stream in streams:
                await stream.aclose()
        assert not notifier.queues
        assert not notifier.global_queues

    asyncio.run(exercise())


def test_subscribe_sends_headers_immediately_and_unregisters():
    async def exercise():
        notifier = Notifier()
        stream = notifier.subscribe()

        assert await anext(stream) == ": connected\n\n"
        assert len(notifier.global_queues) == 1

        await stream.aclose()
        assert notifier.global_queues == []

    asyncio.run(exercise())
