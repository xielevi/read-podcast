import asyncio
import json
from typing import Dict, List, AsyncGenerator

class Notifier:
    def __init__(self):
        # Map task_id to a list of subscriber queues
        self.queues: Dict[str, List[asyncio.Queue]] = {}
        self.global_queues: List[asyncio.Queue] = []

    async def subscribe(self, task_id: str | None = None) -> AsyncGenerator[str, None]:
        # Bounded queue size of 200 to prevent unbounded memory growth (OOM)
        queue = asyncio.Queue(maxsize=200)
        if task_id:
            self.queues.setdefault(task_id, []).append(queue)
        else:
            self.global_queues.append(queue)
        
        try:
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(message)}\n\n"
                if task_id and message.get("level") in ("done", "error"):
                    break
        finally:
            if task_id and task_id in self.queues:
                if queue in self.queues[task_id]:
                    self.queues[task_id].remove(queue)
                if not self.queues[task_id]:
                    self.queues.pop(task_id, None)
            elif queue in self.global_queues:
                self.global_queues.remove(queue)

    async def push(self, task_id: str, message: dict):
        task_queues = list(self.queues.get(task_id, []))
        global_message = {"task_id": task_id, **message}
        for queue in [*task_queues, *self.global_queues]:
            try:
                if queue.full():
                    # Drop the oldest message to make room
                    queue.get_nowait()
                queue.put_nowait(message if queue in task_queues else global_message)
            except Exception:
                pass

notifier = Notifier()
