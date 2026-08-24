"""Read Podcast 的分组子路由。

原先 1200+ 行的 ``app/router.py`` 按业务域拆分到本包下：

- ``episodes``    订阅、剧集列表、搜索、封面图代理
- ``tasks``       转录任务、上传、已读状态、稿件下载/正文
- ``assistant``   AI 助手（百科查询、文字稿问答、跨库问答、关键概念）
- ``connectors``  文件连接器与 OAuth 集成、导出
- ``settings``    健康检查、转录状态、配置面板

``app/router.py`` 保留为聚合入口，把这些子路由并入同一个 ``router`` 对象，
对外路径与挂载方式保持不变。
"""
