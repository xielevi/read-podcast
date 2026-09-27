"""测试隔离：把运行态数据与日志目录指向临时目录，绝不写用户真实的平台目录。

必须在任何 test_ / 被测模块导入之前生效——conftest.py 由 pytest 最先加载。
"""
import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="read-podcast-transcription-tests-"))
os.environ["READ_PODCAST_LOG_DIR"] = str(_TMP / "logs")
os.environ["READ_PODCAST_TRANSCRIPTION_DATA"] = str(_TMP / "data")
