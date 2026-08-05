import fcntl
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class StateManager:
    """管理播客节目处理状态的持久化类。"""

    def __init__(self, state_file):
        self.state_file = Path(state_file)
        self.processed_ids = self._load_state()

    def _load_state(self):
        if self.state_file.exists():
            try:
                with self.state_file.open("r", encoding="utf-8") as handle:
                    return set(json.load(handle))
            except Exception as exc:
                import logging

                logging.error("加载状态文件失败: %s", exc)
        return set()

    def is_processed(self, episode_id):
        return episode_id in self.processed_ids

    def mark_processed(self, episode_id):
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.state_file.with_suffix(f"{self.state_file.suffix}.lock")
        with lock_path.open("a+") as lock_handle:
            fcntl.flock(lock_handle, fcntl.LOCK_EX)
            self.processed_ids = self._load_state()
            self.processed_ids.add(episode_id)
            self._save_state()

    def _save_state(self):
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            temp_path = self.state_file.with_suffix(f"{self.state_file.suffix}.part")
            with temp_path.open("w", encoding="utf-8") as handle:
                json.dump(sorted(self.processed_ids), handle)
            temp_path.replace(self.state_file)
        except Exception as exc:
            import logging

            logging.error("保存状态文件失败: %s", exc)


def acquire_lock(lock_name="podcast_worker"):
    """使用文件锁防止多个脚本实例同时运行产生冲突。"""
    lock_dir = PROJECT_ROOT / "workspace/data"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_file = lock_dir / f"{lock_name}.lock"
    handle = lock_file.open("w")
    try:
        fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except IOError:
        print(f"警告：锁获取失败，可能已有实例在运行 ({lock_name})。")
        return None
