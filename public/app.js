'use strict';
    // ── 图标体系（SF Symbols 风格自绘 stroke 图标）────────────
    // 只经 uiIcon() 输出；aria-hidden 由函数统一注入。
    // 注意：分片中不得出现 'use strict'，由 scripts/build_frontend.py 统一写在 bundle 第一行。

    var UI_ICONS = {
      logo: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
      settings: '<path d="M4 8h8M16 8h4M4 16h4M12 16h8"/><circle cx="14" cy="8" r="2.4"/><circle cx="10" cy="16" r="2.4"/>',
      refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
      'rotate-cw': '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
      activity: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
      document: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',
      'x-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/>',
      search: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 21 21"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      'chev-left': '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
      'chev-right': '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
      upload: '<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5"/><path d="M4 16.5v1.8A2.7 2.7 0 0 0 6.7 21h10.6a2.7 2.7 0 0 0 2.7-2.7v-1.8"/>',
      download: '<path d="M12 5v11M7.5 11.5 12 16l4.5-4.5"/><path d="M4 16.5v1.8A2.7 2.7 0 0 0 6.7 21h10.6a2.7 2.7 0 0 0 2.7-2.7v-1.8"/>',
      'book-open': '<path d="M12 6.5C10.5 5 8 4.5 4.5 4.5v13C8 17.5 10.5 18 12 19.5c1.5-1.5 4-2 7.5-2v-13C16 4.5 13.5 5 12 6.5z"/><path d="M12 6.5v13"/>',
      mic: '<path d="M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3z"/><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6"/>',
      rss: '<path d="M5 5.5a13.5 13.5 0 0 1 13.5 13.5"/><path d="M5 11.5a7.5 7.5 0 0 1 7.5 7.5"/><circle cx="5.8" cy="18.2" r="1.4" fill="currentColor" stroke="none"/>',
      trash: '<path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7M6.5 7l.8 12.1A1.9 1.9 0 0 0 9.2 21h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7"/><path d="M10 11v6M14 11v6"/>',
      'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
      'alert-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5M12 16.4v.2"/>',
      info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8v.2"/>',
      check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
      'type-minus': '<path d="M4.5 17 8.5 7l4 10M6.2 13.5h4.6"/><path d="M15.5 12H20"/>',
      'type-plus': '<path d="M4.5 17 8.5 7l4 10M6.2 13.5h4.6"/><path d="M17.75 9.75v4.5M15.5 12h4.5"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
      moon: '<path d="M20 13.5A8 8 0 1 1 10.5 4 6.5 6.5 0 0 0 20 13.5z"/>',
      auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>'
    };

    function uiIcon(name, cls) {
      var body = UI_ICONS[name];
      if (!body) return '';
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true">' + body + '</svg>';
    }
    // ── 国际化与双语界面（中文 / 英文）───────────────────────────
    // 注意：分片中不得出现 'use strict'，由 scripts/build_frontend.py 统一写在 bundle 第一行。

        var TRANSLATIONS = {
      zh: {
        'skip.link': '跳到单集列表',
        'brand.kicker': '让播客，从声音变成阅读',
        'lang.toggle': '中 / EN',
        'lang.toggle_label': '切换语言',
        'appearance.theme': '外观',
        'appearance.auto': '自动',
        'appearance.light': '浅色',
        'appearance.dark': '深色',
        'appearance.choose': '选择外观',
        'appearance.group': '应用外观',
        'appearance.desc': '选择界面外观；「自动」跟随系统深浅色。',
        'masthead.manage': '登录管理',
        'masthead.settings': '设置',
        'masthead.settings_open': '打开设置',

        'nav.aria_label': '主导航',
        'nav.workspace': '工作区',
        'nav.podcast': '订阅',
        'nav.custom': '导入',
        'nav.library': '稿件',
        'nav.add_podcast': '添加订阅',

        'cover.kicker': '播客电子杂志',
        'cover.aria_label': '订阅封面合集',
        'content.latest_episodes': '最新单集',
        'content.all_subscriptions': '全部订阅',
        'content.search_placeholder': '搜索单集标题',
        'content.refresh': '刷新单集',
        'filter.all': '全部',
        'filter.readable': '待读',
        'filter.unread': '未生成',
        'filter.read': '已读',
        'filter.label': '阅读状态过滤',
        'pagination.aria_label': '单集分页',
        'pagination.prev': '上一页',
        'pagination.next': '下一页',
        'pagination.page': '第 {0} / {1} 页',
        'pagination.page_single': '第 {0} 页',
        'pagination.initial_page': '第 1 页',
        'empty.no_episodes': '暂无单集',
        'empty.no_episodes_found': '没有找到匹配的单集。',
        'empty.no_subscriptions': '还没有订阅',
        'empty.no_subscriptions_desc': '添加一档播客，最新单集会自动出现在这里。',

        'custom.title': '导入音频',
        'custom.desc': '把录音、访谈或其他音频整理成可以阅读的稿件。',
        'custom.audio_file': '音频文件',
        'custom.audio_hint': '支持常见音频格式，单个文件最大 200 MiB',
        'custom.drop_hint': '点击或拖拽上传音频',
        'custom.choose_audio': '选择音频文件',
        'custom.drop_or_drag': '也可以拖到这里',
        'custom.formats': '支持 MP3, M4A, WAV, AAC, OGG 等格式',
        'custom.podcast_name': '节目名称',
        'custom.podcast_placeholder': '例如：忽左忽右',
        'custom.episode_title': '单集标题',
        'custom.episode_placeholder': '例如：漫谈欧洲历史',
        'custom.prompt': '补充整理要求',
        'custom.prompt_placeholder': '例如：保留问答结构，统一人名写法。',
        'custom.prompt_template': '稿件风格',
        'custom.template_standard': '标准整理',
        'custom.advanced': '高级说明',
        'custom.submit': '生成稿件',
        'custom.generating': '生成中…',
        'custom.uploading': '正在上传…',
        'custom.upload_progress': '正在上传 {0}%',
        'custom.upload_complete': '上传完成',
        'custom.upload_merging': '合并分片中…',
        'custom.upload_ready': '准备上传…',
        'custom.processing': '处理中…',
        'custom.local_audio': '本地音频',
        'custom.custom_audio': '自定义音频',

        'library.title': '稿件',
        'library.search_placeholder': '搜索标题或节目',
        'library.filter_all': '全部',
        'library.filter_subscription': '待读',
        'library.filter_read': '已读',
        'library.read': '阅读',
        'library.download': '下载',
        'library.empty': '还没有可以阅读的稿件',
        'library.empty_hint': '从订阅里选择一期，或导入一段音频。',
        'library.empty_query': '没有找到匹配的稿件',
        'library.empty_query_hint': '换个关键词试试。',
        'library.view_subscriptions': '查看订阅',
        'library.import_audio': '导入音频',

        'inspector.select_title': '选择一期节目',
        'inspector.select_meta': '点击单集卡片，在这里查看介绍。',
        'inspector.select_summary': '选择一期单集，在这里查看介绍并生成稿件。',
        'inspector.summary_title': '本期简介',
        'inspector.close_summary': '关闭本期简介',
        'inspector.loading_desc': '正在加载介绍…',
        'inspector.load_failed': '介绍暂时加载不出来，请稍后再试。',
        'inspector.no_desc': '这期节目暂时没有介绍。',

        'tasks.title': '任务',
        'tasks.close': '关闭任务面板',
        'tasks.empty': '暂无任务',
        'tasks.retry': '重试',
        'tasks.retrying': '重试中…',
        'tasks.cancel': '停止',
        'tasks.cancelling': '取消中…',
        'tasks.cancel_task': '取消任务',
        'tasks.delete': '移除',
        'tasks.deleting': '移除中…',
        'tasks.processing_count': '处理中 {0}',
        'tasks.processing_default': '处理中 0',
        'tasks.list_label': '任务列表',
        'tasks.attention_count': '{0} 个任务需要处理',
        'tasks.default_title': '稿件生成',
        'tasks.cancel_aria': '停止「{0}」',
        'tasks.dismissed': '记录已移除。',
        'tasks.restarted': '已重新开始生成。',
        'tasks.cancelling_msg': '已发送取消请求，正在停止任务…',
        'tasks.cancelled_msg': '任务已取消',
        'tasks.success_msg': '稿件已经准备好了。',

        'stage.queued': '排队中',
        'stage.downloading': '下载音频中',
        'stage.resolving': '解析中',
        'stage.transcribing': '转写中',
        'stage.refining': '整理中',
        'stage.finalizing': '保存中',
        'stage.done': '已完成',
        'stage.success': '已完成',
        'stage.failed': '失败',
        'stage.cancelled': '已取消',
        'stage.step_audio': '获取音频',
        'stage.step_transcribe': '转写',
        'stage.step_refine': '整理',
        'stage.step_save': '保存',

        'fail.audio': '无法获取音频，请稍后重试。',
        'fail.transcribe': '这次没有完成转写，请重试。',
        'fail.refine': '文字整理暂时没有完成，请重试。',
        'fail.finalize': '稿件保存失败，请重试。',
        'fail.default': '这次没有生成成功，请稍后再试。',
        'fail.cancelled': '任务已停止，可以稍后重试。',

        'episode.generate': '生成稿件',
        'episode.generating': '生成中…',
        'episode.regenerate': '重新生成',
        'episode.read': '阅读稿件',
        'episode.download_md': '下载 Markdown',
        'episode.download_audio': '下载音频',
        'episode.no_audio': '无音频',
        'episode.duration_min': '{0} 分钟',
        'episode.duration_hour_min': '{0} 小时 {1} 分钟',
        'episode.no_desc': '无节目说明',
        'episode.untitled': '未命名单集',
        'episode.status_readable': '可阅读',
        'episode.status_unread': '未生成',
        'episode.status_generating': '生成中 · ',
        'episode.status_failed': '失败',
        'episode.status_read': '已读',
        'episode.mark_read': '标记为已读',
        'episode.mark_unread': '改为未读',

        'reader.title': '阅读',
        'reader.appearance': '排版与主题',
        'reader.preset': '版式预设',
        'reader.preset_classical': '文雅经典',
        'reader.preset_modern': '现代清晰',
        'reader.font': '字体',
        'reader.font_size': '字号',
        'reader.font_dec': '减小字号',
        'reader.font_inc': '增大字号',
        'reader.line_height': '行距',
        'reader.leading_compact': '紧凑',
        'reader.leading_normal': '舒适',
        'reader.leading_relaxed': '宽松',
        'reader.theme': '主题',
        'reader.theme_follow': '跟随应用',
        'reader.theme_paper': '杏仁纸张',
        'reader.theme_warm': '暖阳羊皮',
        'reader.theme_green': '护眼绿',
        'reader.theme_dark': '极夜黑',
        'reader.download_md': '下载 Markdown',
        'reader.mark_read': '标记为已读',
        'reader.mark_unread': '标记为未读',
        'reader.close': '关闭阅读',
        'reader.toc': '大纲',
        'reader.toc_label': '大纲目录',
        'reader.progress': '阅读进度',
        'reader.progress_val': '进度 {0}%',
        'reader.jump_start': '返回顶部',
        'reader.jump_end': '翻至文末',
        'reader.initial_state': '选择一份已完成稿件开始阅读。',
        'reader.words_wan': '{0} 万字',
        'reader.words': '{0} 字',
        'reader.characters_large': '{0} 万字',
        'reader.characters': '{0} 字',
        'reader.word_count_large': '{0}k 词',
        'reader.word_count': '{0} 词',
        'reader.est_time': '约 {0} 分钟',
        'reader.bar_appearance': '排版',
        'reader.toolbar_label': '阅读工具栏',
        'reader.progress_initial': '进度 0%',
        'reader.theme_picker_label': '阅读主题',
        'reader.font_preset_label': '字体预设',
        'reader.sheet_label': '阅读进度调整',
        'reader.sheet_progress_label': '移动端阅读进度',
        'reader.close_progress': '关闭进度面板',
        'reader.loading': '正在展开稿纸',
        'reader.empty_content': '稿件内容为空。',
        'reader.close_toc': '关闭目录',

        'concepts.title': '关键概念',
        'concepts.extracting': '正在抽取关键概念…',
        'concepts.reading': '正在读取关键概念…',
        'concepts.empty': '没有找到可链接到维基百科的概念。',
        'concepts.failed': '抽取失败：',
        'concepts.retry': '重试',
        'concepts.wiki_title': '维基百科',

        'settings.title': '设置',
        'settings.desc': '调整外观和文字整理方式。',
        'settings.close': '关闭设置',
        'settings.cancel': '取消',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.saved': '保存成功',
        'settings.save_failed': '保存失败：',
        'settings.testing': '测试中…',
        'settings.test_success': '连接正常。',
        'settings.test_failed': '测试失败：',
        'settings.lang': '语言',
        'settings.lang_desc': '选择界面与概念核验语言。',
        'settings.lang_zh': '中文',
        'settings.lang_en': 'English',
        'settings.loading': '正在读取配置…',

        'drawer.title': '添加订阅',
        'drawer.desc': '搜索节目名称或粘贴 RSS 地址',
        'drawer.search_placeholder': '搜索节目名称或粘贴 RSS 地址',
        'drawer.close': '关闭添加订阅',
        'drawer.subscribe': '订阅',
        'drawer.subscribed': '已订阅',
        'drawer.subscribing': '正在订阅…',
        'drawer.searching': '搜索中…',
        'drawer.identifying': '正在识别订阅地址…',
        'drawer.rss_feed': 'RSS 订阅地址',
        'drawer.no_matches': '没有找到匹配内容',
        'drawer.no_matches_hint': '试试更短的关键词。',
        'drawer.episodes_count': ' 集',

        'common.unknown_error': '未知错误',
        'toast.close': '关闭提示',

        'read_state.save_failed': '保存已读状态失败：',
        'episode.mark_read_title': '标记这期已经读完',
        'episode.mark_unread_title': '将这期改回未读',

        'custom.untitled_template': '未命名模板',
        'custom.templates_load_failed': '稿件风格加载失败',
        'custom.file_size_exceeded': '文件体积超出 200 MiB 上限',
        'custom.file_size_hint': '文件超出 200 MiB 限制（约 {0} MiB），请压缩或截取后重试',
        'custom.upload_success': '文件上传成功：{0}',
        'custom.upload_failed': '上传失败',
        'custom.upload_failed_msg': '文件上传失败：{0}',
        'subscription.unsubscribed': '已取消订阅节目「{0}」',
        'subscription.timeline_desc': '按时间线展示所有订阅',
        'subscription.delete_failed': '删除订阅失败：',
        'subscription.untitled': '未命名节目',
        'subscription.unsubscribe': '取消订阅',
        'subscription.unsubscribe_aria': '取消订阅 {0}',
        'subscription.confirm_delete': '确认删除',
        'subscription.confirm_delete_aria': '再次点击确认取消订阅 {0}',
        'subscription.timeline_browse': '按时间线浏览',
        'subscription.empty_shows': '暂无订阅节目',
        'cover.collection': '订阅合集',
        'subscription.load_failed': '加载订阅失败：',
        'subscription.timeline': '按时间线',
        'subscription.episodes_count': '{0} 期',
        'subscription.shows_episodes_count': '{0} 档节目 · {1} 期',
        'subscription.loading': '正在读取订阅…',
        'subscription.add_first_hint': '先添加一档节目，时间线会从这里开始',

        'episode.this_episode': '这期节目',
        'episode.regenerate_aria': '重新生成「{0}」',
        'inspector.generating_head': '正在生成稿件',
        'inspector.failed_head': '生成未成功',
        'episode.opening': '正在打开节目…',
        'content.stale_warning': '部分节目暂时没有刷新成功，先显示已有单集。',
        'content.load_failed': '加载单集失败：{0}',
        'episode.view_desc_aria': '查看「{0}」的介绍',
        'episode.subscription_show': '订阅节目',
        'episode.filter_by_show_aria': '只看「{0}」的节目',

        'tasks.no_source': '错误：未找到节目来源',
        'tasks.generating_progress': '这期稿件正在生成，已打开处理进度。',
        'tasks.already_generated': '这期稿件已经生成，可从更多菜单重新生成。',
        'tasks.completed_badge': '已完成',
        'tasks.already_generated_log': '稿件已经生成',
        'tasks.failed_retry_msg': '这次没有生成成功，请稍后再试。',
        'tasks.failed_badge': '未成功',
        'tasks.need_audio_file': '请先选择音频文件。',
        'tasks.step_missing_badge': '还差一步',
        'tasks.failed_prefix': '这次没有生成成功：',
        'tasks.retry_hint': '请稍后再试',
        'tasks.success_log': '任务全流程处理成功',
        'tasks.failed_log': '任务处理失败',

        'drawer.untitled_podcast': '未命名播客',
        'drawer.invalid_rss': '请输入有效的 RSS 地址。',
        'drawer.subscribed_log': '已订阅「{0}」',
        'drawer.new_podcast': '新节目',
        'drawer.add_failed': '添加失败：',

        'reader.load_failed': '稿件读取失败：',

        'settings.read_failed': '配置读取失败：',
        'settings.configured': '已配置',
        'settings.not_configured': '未配置',
        'settings.not_editable': '此项不能在这里修改',
        'settings.empty': '没有可编辑的配置项。',
        'settings.refinement': '文字整理',
        'settings.test': '测试',
        'settings.advanced': '高级设置',
        'settings.quality_hint': '成稿明显过短时不会发布。',
        'setting.refiner.model.label': '模型',
        'setting.refiner.model.placeholder': '服务商提供的模型 ID',
        'setting.refiner.api_base.label': '服务地址',
        'setting.refiner.api_base.placeholder': 'https://api.example.com/v1',
        'setting.refiner.temperature.label': '创作温度',
        'setting.refiner.temperature.placeholder': '0.3',
        'setting.refiner.max_tokens.label': '最大输出',
        'setting.refiner.max_tokens.placeholder': '65536',
        'setting.refiner.min_output_ratio.label': '完整度保护',
        'setting.refiner.min_output_ratio.placeholder': '0.7',
        'setting.refiner.min_output_ratio.hint': '这是发布硬下限；默认 Prompt 的编辑目标约为原始转录的 80%。',
        'template.magazine.name': '默认杂志精修',
        'template.magazine.desc': '杂志级访谈文稿，保留全部实质对话与语气细节，按话题优雅分段，附大纲与时间线。',
        'template.clean_verbatim.name': '清洁逐字稿',
        'template.clean_verbatim.desc': '高保真逐字稿，仅剔除纯卡顿与错别字，严格保留全部原文说话顺序与完整表述。',
        'template.structured_interview.name': '结构化访谈',
        'template.structured_interview.desc': '重点突出问答结构与关键论据，按深度话题划分层次，完整呈现对话脉络。',
        'appearance.summary_title': '外观：{0}',
        'appearance.summary_aria': '选择外观，当前 {0}'
      },
      en: {
        'skip.link': 'Skip to episode list',
        'brand.kicker': 'Turn podcasts from sound into reading',
        'lang.toggle': '中 / EN',
        'lang.toggle_label': 'Switch language',
        'appearance.theme': 'Theme',
        'appearance.auto': 'Auto',
        'appearance.light': 'Light',
        'appearance.dark': 'Dark',
        'appearance.choose': 'Choose appearance',
        'appearance.group': 'App appearance',
        'appearance.desc': 'Choose app appearance; "Auto" follows system settings.',
        'masthead.manage': 'Manage',
        'masthead.settings': 'Settings',
        'masthead.settings_open': 'Open settings',

        'nav.aria_label': 'Main navigation',
        'nav.workspace': 'Workspace',
        'nav.podcast': 'Subscriptions',
        'nav.custom': 'Import',
        'nav.library': 'Articles',
        'nav.add_podcast': 'Add Subscription',

        'cover.kicker': 'Podcast Magazine',
        'cover.aria_label': 'Subscription cover collection',
        'content.latest_episodes': 'Latest Episodes',
        'content.all_subscriptions': 'All Subscriptions',
        'content.search_placeholder': 'Search episode title…',
        'content.refresh': 'Refresh episodes',
        'filter.all': 'All',
        'filter.readable': 'To Read',
        'filter.unread': 'Not Generated',
        'filter.read': 'Read',
        'filter.label': 'Filter by reading status',
        'pagination.aria_label': 'Episode pagination',
        'pagination.prev': 'Previous',
        'pagination.next': 'Next',
        'pagination.page': 'Page {0} of {1}',
        'pagination.page_single': 'Page {0}',
        'pagination.initial_page': 'Page 1',
        'empty.no_episodes': 'No episodes',
        'empty.no_episodes_found': 'No matching episodes found.',
        'empty.no_subscriptions': 'No subscriptions yet',
        'empty.no_subscriptions_desc': 'Add a podcast, and the latest episodes will appear here.',

        'custom.title': 'Import Audio',
        'custom.desc': 'Turn recordings, interviews, or other audio into readable manuscripts.',
        'custom.audio_file': 'Audio File',
        'custom.audio_hint': 'Supports common audio formats, max 200 MiB per file',
        'custom.drop_hint': 'Click or drag & drop to upload audio',
        'custom.choose_audio': 'Choose audio file',
        'custom.drop_or_drag': 'or drag & drop here',
        'custom.formats': 'Supports MP3, M4A, WAV, AAC, OGG formats',
        'custom.podcast_name': 'Show Name',
        'custom.podcast_placeholder': 'e.g., Hardcore History',
        'custom.episode_title': 'Episode Title',
        'custom.episode_placeholder': 'e.g., Episode 1: The Beginning',
        'custom.prompt': 'Additional Instructions',
        'custom.prompt_placeholder': 'e.g., Preserve Q&A structure, standardize character names.',
        'custom.prompt_template': 'Editorial Style',
        'custom.template_standard': 'Standard Refinement',
        'custom.advanced': 'Advanced Instructions',
        'custom.submit': 'Generate Manuscript',
        'custom.generating': 'Generating…',
        'custom.uploading': 'Uploading…',
        'custom.upload_progress': 'Uploading {0}%',
        'custom.upload_complete': 'Upload complete',
        'custom.upload_merging': 'Merging chunks…',
        'custom.upload_ready': 'Preparing upload…',
        'custom.processing': 'Processing…',
        'custom.local_audio': 'Imported Audio',
        'custom.custom_audio': 'Custom Audio',

        'library.title': 'Articles',
        'library.search_placeholder': 'Search title or podcast…',
        'library.filter_all': 'All',
        'library.filter_subscription': 'To Read',
        'library.filter_read': 'Read',
        'library.read': 'Read',
        'library.download': 'Download',
        'library.empty': 'No readable manuscripts yet',
        'library.empty_hint': 'Select an episode from subscriptions, or import audio.',
        'library.empty_query': 'No matching manuscripts found',
        'library.empty_query_hint': 'Try different keywords.',
        'library.view_subscriptions': 'View Subscriptions',
        'library.import_audio': 'Import Audio',

        'inspector.select_title': 'Select an episode',
        'inspector.select_meta': 'Click an episode card to view details here.',
        'inspector.select_summary': 'Select an episode to view introduction and generate manuscript.',
        'inspector.summary_title': 'Episode Intro',
        'inspector.close_summary': 'Close episode intro',
        'inspector.loading_desc': 'Loading description…',
        'inspector.load_failed': 'Could not load description. Please try again later.',
        'inspector.no_desc': 'No description available for this episode.',

        'tasks.title': 'Tasks',
        'tasks.close': 'Close task panel',
        'tasks.empty': 'No tasks',
        'tasks.retry': 'Retry',
        'tasks.retrying': 'Retrying…',
        'tasks.cancel': 'Stop',
        'tasks.cancelling': 'Cancelling…',
        'tasks.cancel_task': 'Cancel Task',
        'tasks.delete': 'Dismiss',
        'tasks.deleting': 'Dismissing…',
        'tasks.processing_count': 'Processing {0}',
        'tasks.processing_default': 'Processing 0',
        'tasks.list_label': 'Task List',
        'tasks.attention_count': '{0} task(s) require attention',
        'tasks.default_title': 'Manuscript Generation',
        'tasks.cancel_aria': 'Stop "{0}"',
        'tasks.dismissed': 'Record dismissed.',
        'tasks.restarted': 'Generation restarted.',
        'tasks.cancelling_msg': 'Cancellation requested, stopping task…',
        'tasks.cancelled_msg': 'Task cancelled',
        'tasks.success_msg': 'Manuscript is ready.',

        'stage.queued': 'Queued',
        'stage.downloading': 'Downloading audio',
        'stage.resolving': 'Resolving',
        'stage.transcribing': 'Transcribing',
        'stage.refining': 'Refining',
        'stage.finalizing': 'Saving',
        'stage.done': 'Completed',
        'stage.success': 'Completed',
        'stage.failed': 'Failed',
        'stage.cancelled': 'Cancelled',
        'stage.step_audio': 'Fetch Audio',
        'stage.step_transcribe': 'Transcribe',
        'stage.step_refine': 'Refine',
        'stage.step_save': 'Save',

        'fail.audio': 'Failed to fetch audio. Please try again later.',
        'fail.transcribe': 'Transcription failed. Please try again.',
        'fail.refine': 'Refinement failed. Please try again.',
        'fail.finalize': 'Failed to save manuscript. Please try again.',
        'fail.default': 'Generation was not successful. Please try again later.',
        'fail.cancelled': 'Task stopped. You can retry later.',

        'episode.generate': 'Generate Manuscript',
        'episode.generating': 'Generating…',
        'episode.regenerate': 'Regenerate',
        'episode.read': 'Read Manuscript',
        'episode.download_md': 'Download Markdown',
        'episode.download_audio': 'Download Audio',
        'episode.no_audio': 'No audio',
        'episode.duration_min': '{0} min',
        'episode.duration_hour_min': '{0}h {1}m',
        'episode.no_desc': 'No description available',
        'episode.untitled': 'Untitled Episode',
        'episode.status_readable': 'Readable',
        'episode.status_unread': 'Not Generated',
        'episode.status_generating': 'Generating · ',
        'episode.status_failed': 'Failed',
        'episode.status_read': 'Read',
        'episode.mark_read': 'Mark as Read',
        'episode.mark_unread': 'Mark as Unread',

        'reader.title': 'Reading',
        'reader.appearance': 'Typography & Theme',
        'reader.preset': 'Layout Preset',
        'reader.preset_classical': 'Classical',
        'reader.preset_modern': 'Modern',
        'reader.font': 'Font',
        'reader.font_size': 'Font Size',
        'reader.font_dec': 'Decrease font size',
        'reader.font_inc': 'Increase font size',
        'reader.line_height': 'Line Spacing',
        'reader.leading_compact': 'Compact',
        'reader.leading_normal': 'Comfortable',
        'reader.leading_relaxed': 'Relaxed',
        'reader.theme': 'Theme',
        'reader.theme_follow': 'Follow App',
        'reader.theme_paper': 'Paper',
        'reader.theme_warm': 'Warm',
        'reader.theme_green': 'Green',
        'reader.theme_dark': 'Dark',
        'reader.download_md': 'Download Markdown',
        'reader.mark_read': 'Mark as Read',
        'reader.mark_unread': 'Mark as Unread',
        'reader.close': 'Close Reader',
        'reader.toc': 'Outline',
        'reader.toc_label': 'Table of Contents',
        'reader.progress': 'Reading Progress',
        'reader.progress_val': 'Progress {0}%',
        'reader.jump_start': 'Jump to Top',
        'reader.jump_end': 'Jump to Bottom',
        'reader.initial_state': 'Select a completed manuscript to start reading.',
        'reader.words_wan': '{0}k words',
        'reader.words': '{0} words',
        'reader.characters_large': '{0}k characters',
        'reader.characters': '{0} characters',
        'reader.word_count_large': '{0}k words',
        'reader.word_count': '{0} words',
        'reader.est_time': '~{0} min',
        'reader.bar_appearance': 'Typography',
        'reader.toolbar_label': 'Reading toolbar',
        'reader.progress_initial': 'Progress 0%',
        'reader.theme_picker_label': 'Reader theme',
        'reader.font_preset_label': 'Font preset',
        'reader.sheet_label': 'Reading progress adjustment',
        'reader.sheet_progress_label': 'Mobile reading progress',
        'reader.close_progress': 'Close progress panel',
        'reader.loading': 'Opening manuscript…',
        'reader.empty_content': 'Manuscript content is empty.',
        'reader.close_toc': 'Close Outline',

        'concepts.title': 'Key Concepts',
        'concepts.extracting': 'Extracting key concepts…',
        'concepts.reading': 'Loading key concepts…',
        'concepts.empty': 'No Wikipedia concepts found.',
        'concepts.failed': 'Failed to extract: ',
        'concepts.retry': 'Retry',
        'concepts.wiki_title': 'Wikipedia',

        'settings.title': 'Settings',
        'settings.desc': 'Adjust appearance and text refinement.',
        'settings.close': 'Close settings',
        'settings.cancel': 'Cancel',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.saved': 'Saved successfully',
        'settings.save_failed': 'Failed to save: ',
        'settings.testing': 'Testing…',
        'settings.test_success': 'Connection OK.',
        'settings.test_failed': 'Test failed: ',
        'settings.lang': 'Language',
        'settings.lang_desc': 'Choose interface and concept verification language.',
        'settings.lang_zh': '中文',
        'settings.lang_en': 'English',
        'settings.loading': 'Loading settings…',

        'drawer.title': 'Add Subscription',
        'drawer.desc': 'Search podcast or enter RSS feed URL',
        'drawer.search_placeholder': 'Search podcast or enter RSS feed URL',
        'drawer.close': 'Close Add Subscription',
        'drawer.subscribe': 'Subscribe',
        'drawer.subscribed': 'Subscribed',
        'drawer.subscribing': 'Subscribing…',
        'drawer.searching': 'Searching…',
        'drawer.identifying': 'Identifying RSS feed…',
        'drawer.rss_feed': 'RSS Feed URL',
        'drawer.no_matches': 'No matching podcasts found',
        'drawer.no_matches_hint': 'Try shorter keywords.',
        'drawer.episodes_count': ' episodes',

        'common.unknown_error': 'Unknown error',
        'toast.close': 'Close notification',

        'read_state.save_failed': 'Failed to save read state: ',
        'episode.mark_read_title': 'Mark this episode as read',
        'episode.mark_unread_title': 'Mark this episode as unread',

        'custom.untitled_template': 'Untitled template',
        'custom.templates_load_failed': 'Failed to load templates',
        'custom.file_size_exceeded': 'File size exceeds 200 MiB limit',
        'custom.file_size_hint': 'File exceeds 200 MiB limit (~{0} MiB). Please compress or trim and try again.',
        'custom.upload_success': 'File uploaded successfully: {0}',
        'custom.upload_failed': 'Upload failed',
        'custom.upload_failed_msg': 'File upload failed: {0}',
        'subscription.unsubscribed': 'Unsubscribed from "{0}"',
        'subscription.timeline_desc': 'Showing all subscriptions chronologically',
        'subscription.delete_failed': 'Failed to unsubscribe: ',
        'subscription.untitled': 'Untitled podcast',
        'subscription.unsubscribe': 'Unsubscribe',
        'subscription.unsubscribe_aria': 'Unsubscribe from {0}',
        'subscription.confirm_delete': 'Confirm delete',
        'subscription.confirm_delete_aria': 'Click again to confirm unsubscribe from {0}',
        'subscription.timeline_browse': 'Browse chronologically',
        'subscription.empty_shows': 'No subscriptions yet',
        'cover.collection': 'Subscription Collection',
        'subscription.load_failed': 'Failed to load subscriptions: ',
        'subscription.timeline': 'Chronological',
        'subscription.episodes_count': '{0} episodes',
        'subscription.shows_episodes_count': '{0} shows · {1} episodes',
        'subscription.loading': 'Loading subscriptions…',
        'subscription.add_first_hint': 'Add a podcast first; your timeline will start here.',

        'episode.this_episode': 'this episode',
        'episode.regenerate_aria': 'Regenerate "{0}"',
        'inspector.generating_head': 'Generating manuscript',
        'inspector.failed_head': 'Generation failed',
        'episode.opening': 'Opening episode…',
        'content.stale_warning': 'Some podcasts could not be refreshed. Showing existing episodes.',
        'content.load_failed': 'Failed to load episodes: {0}',
        'episode.view_desc_aria': 'View description for "{0}"',
        'episode.subscription_show': 'Subscription podcast',
        'episode.filter_by_show_aria': 'Show only episodes from "{0}"',

        'tasks.no_source': 'Error: podcast source not found',
        'tasks.generating_progress': 'Manuscript generation in progress; opened task tracker.',
        'tasks.already_generated': 'Manuscript already generated. You can regenerate from the menu.',
        'tasks.completed_badge': 'Completed',
        'tasks.already_generated_log': 'Manuscript already generated',
        'tasks.failed_retry_msg': 'Generation failed. Please try again later.',
        'tasks.failed_badge': 'Failed',
        'tasks.need_audio_file': 'Please choose an audio file first.',
        'tasks.step_missing_badge': 'Action required',
        'tasks.failed_prefix': 'Generation failed: ',
        'tasks.retry_hint': 'please try again later',
        'tasks.success_log': 'Task completed successfully',
        'tasks.failed_log': 'Task processing failed',

        'drawer.untitled_podcast': 'Untitled podcast',
        'drawer.invalid_rss': 'Please enter a valid RSS feed URL.',
        'drawer.subscribed_log': 'Subscribed to "{0}"',
        'drawer.new_podcast': 'New podcast',
        'drawer.add_failed': 'Failed to add: ',

        'reader.load_failed': 'Failed to load manuscript: ',

        'settings.read_failed': 'Failed to read configuration: ',
        'settings.configured': 'Configured',
        'settings.not_configured': 'Not configured',
        'settings.not_editable': 'This item cannot be edited here',
        'settings.empty': 'No editable configuration items.',
        'settings.refinement': 'Editorial Refinement',
        'settings.test': 'Test',
        'settings.advanced': 'Advanced',
        'settings.quality_hint': 'Manuscripts that are significantly too short will not be published.',
        'setting.refiner.model.label': 'Model',
        'setting.refiner.model.placeholder': 'Model ID provided by service provider',
        'setting.refiner.api_base.label': 'Endpoint URL',
        'setting.refiner.api_base.placeholder': 'https://api.example.com/v1',
        'setting.refiner.temperature.label': 'Temperature',
        'setting.refiner.temperature.placeholder': '0.3',
        'setting.refiner.max_tokens.label': 'Max Tokens',
        'setting.refiner.max_tokens.placeholder': '65536',
        'setting.refiner.min_output_ratio.label': 'Length Quality Gate',
        'setting.refiner.min_output_ratio.placeholder': '0.7',
        'setting.refiner.min_output_ratio.hint': 'Hard lower bound for publishing. Default prompt targets ~75–85% of transcript length.',
        'template.magazine.name': 'Magazine Refinement',
        'template.magazine.desc': 'Magazine-style interview transcript preserving all substantive dialogue and nuances, sectioned by topic with outline and timeline.',
        'template.clean_verbatim.name': 'Clean Verbatim',
        'template.clean_verbatim.desc': 'High-fidelity verbatim transcript, removing filler words while strictly preserving speech order and complete statements.',
        'template.structured_interview.name': 'Structured Interview',
        'template.structured_interview.desc': 'Emphasizes Q&A structure and key arguments, organized by in-depth topics.',
        'appearance.summary_title': 'Appearance: {0}',
        'appearance.summary_aria': 'Select appearance, current {0}'
      }
    };

    var _currentLocale = 'zh';

    function initLocale() {
      var loc = 'zh';
      try {
        var savedLoc = localStorage.getItem('app_locale');
        if (savedLoc === 'zh' || savedLoc === 'en') {
          loc = savedLoc;
        } else {
          var navLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
          loc = navLang.startsWith('zh') ? 'zh' : 'en';
        }
      } catch (e) {}
      _currentLocale = loc;
      return loc;
    }

    _currentLocale = initLocale();

    function getLocale() {
      return _currentLocale;
    }

    function t(key, arg0, arg1) {
      var dict = TRANSLATIONS[_currentLocale] || TRANSLATIONS.zh;
      var str = dict[key] || TRANSLATIONS.zh[key] || key;
      if (arg0 !== undefined) str = str.replace('{0}', String(arg0));
      if (arg1 !== undefined) str = str.replace('{1}', String(arg1));
      return str;
    }

    function applyLocale(locale) {
      _currentLocale = locale === 'en' ? 'en' : 'zh';
      document.documentElement.lang = _currentLocale === 'en' ? 'en' : 'zh-CN';
      document.documentElement.dataset.locale = _currentLocale;

      document.querySelectorAll('[data-i18n]').forEach(function (el) {
        var key = el.getAttribute('data-i18n');
        if (key) el.textContent = t(key);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
        var key = el.getAttribute('data-i18n-placeholder');
        if (key) el.placeholder = t(key);
      });
      document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
        var key = el.getAttribute('data-i18n-title');
        if (key) el.title = t(key);
      });
      document.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
        var key = el.getAttribute('data-i18n-aria-label');
        if (key) el.setAttribute('aria-label', t(key));
      });

      var toggleBtn = document.getElementById('lang-toggle-btn');
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-label', t('lang.toggle_label'));
        toggleBtn.title = t('lang.toggle_label');
      }
      var readerToggleBtn = document.getElementById('reader-lang-toggle-btn');
      if (readerToggleBtn) {
        readerToggleBtn.setAttribute('aria-label', t('lang.toggle_label'));
        readerToggleBtn.title = t('lang.toggle_label');
      }

      if (typeof updatePublicThemeSummary === 'function') updatePublicThemeSummary();
      if (typeof renderTaskQueue === 'function') renderTaskQueue();
      if (typeof renderEpisodeList === 'function' && typeof pageEpisodes !== 'undefined' && pageEpisodes.length) renderEpisodeList();
      if (typeof renderLibrary === 'function' && typeof _libraryArticles !== 'undefined') renderLibrary(_libraryArticles);
      if (typeof selectedEpisode !== 'undefined' && selectedEpisode && typeof renderEpisodeInspector === 'function') renderEpisodeInspector(selectedEpisode);
      if (typeof reloadReaderConcepts === 'function') reloadReaderConcepts();
      if (typeof renderPromptTemplateOptions === 'function') renderPromptTemplateOptions();
      if (typeof _lastSettingsData !== 'undefined' && _lastSettingsData && typeof renderSettings === 'function') renderSettings(_lastSettingsData);
      if (typeof updateReaderStats === 'function') updateReaderStats();
    }

    function setLocale(locale, persist) {
      if (locale !== 'zh' && locale !== 'en') return;
      applyLocale(locale);
      if (persist !== false && typeof savePreference === 'function') {
        savePreference('locale', locale);
      }
    }

    function toggleLocale() {
      var next = _currentLocale === 'zh' ? 'en' : 'zh';
      setLocale(next, true);
    }
    // WebUI 既可部署在域名根路径，也可挂在 /podcast 一类子路径。
    // 同一套工作区两种能力：<base>/ 是公开浏览（Public Browse Mode，只读、不执行），
    // <base>/manage 是控制模式（Authenticated Control Mode，由 Cloudflare Access 保护）。应用本身不做任何认证。
    var APP_LOCATION = (function detectLocation() {
      var path = String(window.location.pathname || '/').replace(/\/+$/, '');
      var manage = path.match(/^(.*?)\/manage(?:\/.*)?$/);
      if (manage) return { base: manage[1], surface: 'manage' };
      return { base: path && path !== '/' ? path : '', surface: 'public' };
    }());
    var APP_BASE_PATH = APP_LOCATION.base;
    var IS_MANAGE = APP_LOCATION.surface === 'manage';

    function appUrl(path) {
      var normalized = String(path || '');
      if (!normalized.startsWith('/')) normalized = '/' + normalized;
      return APP_BASE_PATH + normalized;
    }

    // 浏览类读取在两种模式下形状一致：公开浏览走 /api/public/*（严格只读），控制模式走 /api/control/*。
    function browseApi(path) {
      return appUrl((IS_MANAGE ? '/api/control' : '/api/public') + path);
    }

    // 有副作用的操作（写入、删除、触发执行、刷新外部状态、读写读者状态）只属于控制模式。
    // 公开浏览中控件照常显示；点击时跳到受 Access 保护的 /manage，由 Cloudflare Access 负责认证，
    // intent 让控制模式打开后回到对应位置。返回 false 表示调用方应就此停止。
    function requireControl(intent, params) {
      if (IS_MANAGE) return true;
      var query = new URLSearchParams(Object.assign({ intent: String(intent || '') }, params || {}));
      enterControlMode(appUrl('/manage') + '?' + query.toString());
      return false;
    }
    function enterControlMode(url) { window.location.assign(url); }

    // 公开阅读只调用 /api/public/*（严格只读）；控制模式调用 /api/control/*。
    function articleUrl(taskId, suffix) {
      var id = encodeURIComponent(String(taskId || ''));
      return IS_MANAGE ? appUrl('/api/control/tasks/' + id + suffix) : appUrl('/api/public/articles/' + id + suffix);
    }

    var selectedPodcast = null;
    // 单集列表只持有当前一页；筛选、搜索、计数与分页都在服务端（GET …/episodes/page）。
    var pageEpisodes = [];
    var _episodeTotal = 0;
    var _episodeCounts = { all: 0, readable: 0, unread: 0, read: 0 };
    var currentMode = 'podcast';
    var _uploadedAudioPath = null;
    var _uploadedAudioTitle = null;
    var _promptTemplates = [];
    var _pollTimer = null;
    var _drawerSearchTimer = null;
    var _drawerSearchSeq = 0;
    var _taskHistory = [];
    var _currentTaskId = null;
    var _taskCards = {};
    var _taskStartedAt = {};
    var _libraryArticles = [];
    var _libraryFilter = 'all';
    var _currentReadingTaskId = null;
    var currentFilter = 'all';
    var currentPage = 1;
    var selectedEpisode = null;
    var PAGE_SIZE = 10;
    var _currentFontSize = 19;
    var _currentTheme = 'follow';
    var _currentFontPreset = 'classical';
    var _currentLineHeight = 'normal';
    var _savedScrollY = 0;
    var _lastReaderScrollTop = 0;
    var _subscriptions = [];
    var _timelineRequestToken = 0;
    var _readEpisodes = {};
    var _currentReadingRef = null;
    var _currentTaskPodcastName = null;

    var _cloudPrefs = {
      app_theme: 'auto',
      reader_theme: 'follow',
      font_preset: 'classical',
      font_size: 19,
      line_height: 'normal'
    };
    var _prefSyncTimer = null;
    var _pendingPrefChanges = {};

    function loadLocalPreferences() {
      if (IS_MANAGE) return;
      try {
        var appTheme = localStorage.getItem('app_theme');
        if (appTheme) _cloudPrefs.app_theme = appTheme;
        var rTheme = localStorage.getItem('reader_theme');
        if (rTheme) _cloudPrefs.reader_theme = rTheme;
        var preset = localStorage.getItem('reader_font_preset');
        if (preset) _cloudPrefs.font_preset = preset;
        var rawSize = localStorage.getItem('reader_font_size');
        if (rawSize) {
          var sz = parseInt(rawSize, 10);
          if (sz >= 12 && sz <= 36) _cloudPrefs.font_size = sz;
        }
        var leading = localStorage.getItem('reader_line_height');
        if (leading) _cloudPrefs.line_height = leading;
        var loc = localStorage.getItem('app_locale');
        if (loc === 'zh' || loc === 'en') _cloudPrefs.locale = loc;
      } catch (ignore) {}
    }
    loadLocalPreferences();

    function syncCloudPreferences(patch) {
      if (!IS_MANAGE || !patch) return;
      Object.assign(_pendingPrefChanges, patch);
      if (_prefSyncTimer) clearTimeout(_prefSyncTimer);
      _prefSyncTimer = setTimeout(function () {
        var toSend = Object.assign({}, _pendingPrefChanges);
        _pendingPrefChanges = {};
        fetch(appUrl('/api/control/preferences'), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toSend)
        }).catch(function (err) {
          console.warn('Failed to sync preferences to cloud:', err);
        });
      }, 250);
    }

    function savePreference(key, value) {
      _cloudPrefs[key] = value;
      if (IS_MANAGE) {
        var patch = {};
        patch[key] = value;
        syncCloudPreferences(patch);
      } else {
        try {
          var map = {
            app_theme: 'app_theme',
            reader_theme: 'reader_theme',
            font_preset: 'reader_font_preset',
            font_size: 'reader_font_size',
            line_height: 'reader_line_height',
            locale: 'app_locale'
          };
          var localKey = map[key] || key;
          localStorage.setItem(localKey, String(value));
        } catch (ignore) {}
      }
    }

    function loadCloudPreferences(onLoaded) {
      return fetch(browseApi('/preferences'))
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data) return null;
          if (IS_MANAGE) {
            Object.assign(_cloudPrefs, data);
            if (data.locale && (data.locale === 'zh' || data.locale === 'en') && typeof setLocale === 'function') {
              setLocale(data.locale, false);
            }
          } else {
            // 未登录态：若本地未自定义过，则继承站长云端外观/排版默认值；
            // 访客语言遵循浏览器首选语言自适应（由 08-i18n.js 初始化），不从 data.locale 覆盖！
            try {
              if (!localStorage.getItem('app_theme') && data.app_theme) _cloudPrefs.app_theme = data.app_theme;
              if (!localStorage.getItem('reader_theme') && data.reader_theme) _cloudPrefs.reader_theme = data.reader_theme;
              if (!localStorage.getItem('reader_font_preset') && data.font_preset) _cloudPrefs.font_preset = data.font_preset;
              if (!localStorage.getItem('reader_font_size') && data.font_size) _cloudPrefs.font_size = data.font_size;
              if (!localStorage.getItem('reader_line_height') && data.line_height) _cloudPrefs.line_height = data.line_height;
            } catch (ignore) {
              Object.assign(_cloudPrefs, data);
            }
          }
          if (_cloudPrefs.app_theme && typeof applyAppTheme === 'function') {
            applyAppTheme(_cloudPrefs.app_theme);
          }
          if (typeof renderPublicThemeButton === 'function') {
            renderPublicThemeButton();
          }
          if (typeof applyReaderPreferences === 'function') {
            applyReaderPreferences(_cloudPrefs);
          }
          if (typeof onLoaded === 'function') onLoaded(_cloudPrefs);
          return _cloudPrefs;
        })
        .catch(function (err) {
          console.warn('Failed to load cloud preferences:', err);
          return null;
        });
    }

    function byId(id) { return document.getElementById(id); }
    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    function errorMessage(error) { return error && error.message ? error.message : String(error || t('common.unknown_error')); }
    // 统一解析 API 响应：成功返回 JSON（空 body，如 204，返回 null）；失败抛出带 status 的 Error，
    // 文案取服务端错误协议 {error: {code, message}}（见 src/http.ts）。
    function readApiResponse(response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (ignore) { data = null; }
        if (!response.ok) {
          var failure = new Error((data && data.error && data.error.message) || ('HTTP ' + response.status));
          failure.status = response.status;
          throw failure;
        }
        return data;
      });
    }
    function safeTaskUrl(taskId, suffix) {
      return appUrl('/api/control/tasks/' + encodeURIComponent(String(taskId || '')) + suffix);
    }
    function setHidden(element, hidden) { if (element) element.hidden = hidden; }

    function fetchAllPages(path) {
      var items = [];
      var pageSize = 500;
      function fetchPage(offset) {
        var separator = path.includes('?') ? '&' : '?';
        return fetch(appUrl(path + separator + 'limit=' + pageSize + '&offset=' + offset))
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then(function (payload) {
            // 兼容前后端滚动更新期间仍返回旧数组格式的服务端。
            if (Array.isArray(payload)) return payload;
            var pageItems = payload && Array.isArray(payload.items) ? payload.items : [];
            items.push.apply(items, pageItems);
            var nextOffset = payload ? Number(payload.next_offset) : NaN;
            if (Number.isInteger(nextOffset) && nextOffset > offset) return fetchPage(nextOffset);
            return items;
          });
      }
      return fetchPage(0);
    }

    function loadReadEpisodes() {
      return fetchAllPages('/api/control/episodes/read')
        .then(function (keys) {
          _readEpisodes = {};
          (Array.isArray(keys) ? keys : []).forEach(function (ref) { var key = readKey(ref); if (key) _readEpisodes[key] = true; });
          refreshReadViews();
          return _readEpisodes;
        })
        .catch(function () { return _readEpisodes; });
    }

    // 已读按稿件的稳定身份记：RSS 单集用 episode_id（重新生成也不变），导入音频用稿件的 task_id。
    function readKey(ref) {
      if (!ref) return '';
      if (ref.episode_id) return 'episode:' + ref.episode_id;
      if (ref.task_id) return 'task:' + ref.task_id;
      return '';
    }

    function episodeReadRef(episode) {
      return episode && episode.id ? { episode_id: String(episode.id) } : null;
    }

    function isRead(ref) {
      var key = readKey(ref);
      return Boolean(key && _readEpisodes[key]);
    }

    function isEpisodeRead(episode) {
      return isRead(episodeReadRef(episode));
    }

    function setRead(ref, read) {
      // 已读状态属于控制模式；公开浏览不读取、也不写入任何读者状态。
      if (!IS_MANAGE) return;
      var key = readKey(ref);
      if (!key) return;
      var wasRead = Boolean(_readEpisodes[key]);
      if (wasRead === read) return;
      // 乐观更新：先改本地状态刷新界面，服务端保存失败再回滚。
      if (read) _readEpisodes[key] = true;
      else delete _readEpisodes[key];
      refreshReadViews();
      var body = ref.episode_id ? { episode_id: String(ref.episode_id), read: read } : { task_id: String(ref.task_id), read: read };
      fetch(appUrl('/api/control/episodes/read'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          // 已读会改变「待读 / 已读」筛选与计数：静默重取当前页
          reloadEpisodePage();
        })
        .catch(function (error) {
          if (read) delete _readEpisodes[key];
          else _readEpisodes[key] = true;
          refreshReadViews();
          addLog(t('read_state.save_failed') + errorMessage(error), 'error');
        });
    }

    function refreshReadViews() {
      updateReaderReadState();
      if (pageEpisodes.length) renderEpisodeList();
    }

    function updateReaderReadState() {
      var button = byId('reader-read-toggle');
      if (!button) return;
      var hasEpisode = IS_MANAGE && Boolean(readKey(_currentReadingRef));
      var read = hasEpisode && isRead(_currentReadingRef);
      setHidden(button, !hasEpisode);
      button.textContent = read ? t('episode.mark_unread') : t('episode.mark_read');
      button.title = read ? t('episode.mark_unread_title') : t('episode.mark_read_title');
      button.setAttribute('aria-pressed', String(read));
      button.classList.toggle('is-read', read);
    }
    function switchMode(mode) {
      currentMode = mode;
      document.body.dataset.mode = mode;
      var podcastMode = mode === 'podcast';
      var customMode = mode === 'custom';
      var libraryMode = mode === 'library';
      byId('podcast-panel').classList.toggle('is-active', podcastMode);
      byId('custom-panel').classList.toggle('is-active', customMode);
      byId('library-panel').classList.toggle('is-active', libraryMode);
      byId('tab-podcast').classList.toggle('active', podcastMode);
      byId('tab-custom').classList.toggle('active', customMode);
      byId('tab-library').classList.toggle('active', libraryMode);
      byId('tab-podcast').setAttribute('aria-selected', String(podcastMode));
      byId('tab-custom').setAttribute('aria-selected', String(customMode));
      byId('tab-library').setAttribute('aria-selected', String(libraryMode));
      document.querySelectorAll('.mobile-nav [data-mode]').forEach(function (button) {
        button.classList.toggle('active', button.dataset.mode === mode);
      });
      if (libraryMode) {
        loadLibrary();
      } else if (selectedEpisode) {
        renderEpisodeInspector(selectedEpisode);
      } else {
        resetEpisodeInspector();
      }
      // 稿件风格模板属于控制面配置；公开浏览只展示导入界面本身。
      if (customMode && IS_MANAGE && _promptTemplates.length === 0) loadPromptTemplates();
    }

    function loadPromptTemplates() {
      fetch(appUrl('/api/control/prompt-templates'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (templates) {
          _promptTemplates = Array.isArray(templates) ? templates : [];
          renderPromptTemplateOptions();
        })
        .catch(function () { addLog(t('custom.templates_load_failed'), 'warning'); });
    }

    function renderPromptTemplateOptions() {
      var select = byId('prompt-template-select');
      if (!select) return;
      var currentVal = select.value;
      if (select.options.length > 0) {
        select.options[0].textContent = t('custom.template_standard');
      }
      while (select.options.length > 1) select.remove(1);
      _promptTemplates.forEach(function (template) {
        var option = document.createElement('option');
        option.value = String(template.content || '');
        var labelKey = 'template.' + template.id + '.name';
        var translated = t(labelKey);
        option.textContent = translated !== labelKey ? translated : String(template.name || t('custom.untitled_template'));
        var descKey = 'template.' + template.id + '.desc';
        var localizedDesc = t(descKey);
        option.title = localizedDesc !== descKey ? localizedDesc : String(template.description || '');
        select.appendChild(option);
      });
      if (currentVal) {
        select.value = currentVal;
      }
    }

    function applyPromptTemplate(content) {
      byId('custom-prompt').value = content || '';
    }

    function handleAudioDrop(event) {
      event.preventDefault();
      byId('upload-drop-zone').classList.remove('is-dragging');
      if (!requireControl('import')) return;
      if (event.dataTransfer.files.length > 0) doUploadAudio(event.dataTransfer.files[0]);
    }

    function handleAudioFileChange(input) {
      if (input.files.length > 0) doUploadAudio(input.files[0]);
    }

    function doUploadAudio(file) {
      if (!requireControl('import')) return;
      _uploadedAudioPath = null;
      _uploadedAudioTitle = null;

      // 产品硬上限 200 MiB（= 209,715,200 字节）；Cloudflare 才是权威校验方，这里只是让用户立即得到反馈、不进入上传流程。
      var MAX_SIZE = 200 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        addLog(t('custom.file_size_exceeded'), 'error');
        byId('upload-status').textContent = t('custom.file_size_hint', (Math.round(file.size / 1024 / 1024 * 10) / 10));
        setHidden(byId('upload-progress-wrap'), false);
        setHidden(byId('upload-success-info'), true);
        setHidden(byId('upload-hint'), false);
        byId('upload-progress-inner').style.width = '0%';
        return;
      }

      setHidden(byId('upload-progress-wrap'), false);
      setHidden(byId('upload-success-info'), true);
      setHidden(byId('upload-hint'), true);
      byId('upload-status').textContent = t('custom.upload_ready');
      byId('upload-progress-inner').style.width = '0%';

      var CHUNK_SIZE = 10 * 1024 * 1024; // 10 MiB 分片（200 MiB 上限 → 至多 20 片）
      var totalParts = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
      var uploadId = null;
      var r2UploadId = null;
      var key = null;
      var uploadedParts = [];
      var uploadedBytes = 0;

      // 1. 初始化分片上传
      fetch(appUrl('/api/control/uploads/multipart/start?filename=' + encodeURIComponent(file.name) + '&size=' + file.size), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' }
      })
        .then(readApiResponse)
        .then(function (initData) {
          uploadId = initData.upload_id;
          r2UploadId = initData.r2_upload_id;
          key = initData.key;

          // 2. 串行顺序上传分片（带重试机制）
          function uploadChunk(partIndex) {
            if (partIndex >= totalParts) {
              // 3. 完成合并
              byId('upload-status').textContent = t('custom.upload_merging');
              return fetch(appUrl('/api/control/uploads/multipart/' + encodeURIComponent(uploadId) + '/complete'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ r2_upload_id: r2UploadId, key: key, parts: uploadedParts })
              }).then(readApiResponse).then(function () {
                _uploadedAudioPath = uploadId;
                _uploadedAudioTitle = file.name.replace(/\.[^/.]+$/, "");
                byId('upload-status').textContent = t('custom.upload_complete');
                byId('upload-progress-inner').style.width = '100%';
                setHidden(byId('upload-success-info'), false);
                byId('upload-success-info').textContent = '✓ ' + file.name + ' (' + Math.round(file.size / 1024 / 1024 * 10) / 10 + ' MiB)';
                addLog(t('custom.upload_success', file.name), 'success');
              });
            }

            var partNumber = partIndex + 1;
            var start = partIndex * CHUNK_SIZE;
            var end = Math.min(file.size, start + CHUNK_SIZE);
            var chunk = file.slice(start, end);
            var chunkSize = end - start;

            function doUploadPart(attempt) {
              return fetch(appUrl('/api/control/uploads/multipart/' + encodeURIComponent(uploadId) + '/parts/' + partNumber), {
                method: 'PUT',
                headers: {
                  'x-r2-upload-id': r2UploadId,
                  'x-upload-key': key,
                  'Content-Type': 'application/octet-stream'
                },
                body: chunk
              }).then(readApiResponse).catch(function (err) {
                if (attempt < 3) {
                  return new Promise(function (resolve) { setTimeout(resolve, 1000); }).then(function () {
                    return doUploadPart(attempt + 1);
                  });
                }
                throw err;
              });
            }

            byId('upload-status').textContent = t('custom.upload_progress', 0);
            return doUploadPart(1).then(function (partResult) {
              uploadedParts.push({ partNumber: partNumber, etag: partResult.etag });
              uploadedBytes += chunkSize;
              var percent = Math.min(99, Math.round((uploadedBytes / file.size) * 100));
              byId('upload-progress-inner').style.width = percent + '%';
              byId('upload-status').textContent = t('custom.upload_progress', percent);
              return uploadChunk(partIndex + 1);
            });
          }

          return uploadChunk(0);
        })
        .catch(function (err) {
          var message = (err && err.message) || t('custom.upload_failed');
          byId('upload-status').textContent = message;
          setHidden(byId('upload-hint'), false);
          addLog(t('custom.upload_failed_msg', message), 'error');
          if (uploadId && r2UploadId && key) {
            fetch(appUrl('/api/control/uploads/multipart/' + encodeURIComponent(uploadId) + '/abort'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ r2_upload_id: r2UploadId, key: key })
            }).catch(function () {});
          }
        });
    }

    function doDeleteSubscription(name) {
      if (!name || !requireControl('unsubscribe')) return;
      fetch(appUrl('/api/control/subscriptions/' + encodeURIComponent(name)), { method: 'DELETE' })
        .then(readApiResponse)
        .then(function () {
          addLog(t('subscription.unsubscribed', name), 'info');
          if (selectedPodcast === name) {
            selectedPodcast = null;
            pageEpisodes = [];
            currentPage = 1;
            resetEpisodeInspector();
            byId('center-title').textContent = t('content.all_subscriptions');
            byId('center-sub').textContent = t('subscription.timeline_desc');
            byId('episode-list').replaceChildren();
            setHidden(byId('episode-list'), true);
            setHidden(byId('episode-pagination'), true);
            setHidden(byId('episode-empty'), false);
          }
          loadSubscriptions();
        })
        .catch(function (err) { addLog(t('subscription.delete_failed') + errorMessage(err), 'error'); });
    }

    function createPodcastItem(podcast, index) {
      var item = document.createElement('div');
      item.className = 'podcast-item';
      item.dataset.name = String(podcast.name || '');
      item.style.setProperty('--item-index', index);

      var selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'pod-select-btn';

      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      item._statusDot = dot;

      var copy = document.createElement('span');
      copy.style.minWidth = '0';
      var name = document.createElement('span');
      name.className = 'pod-name';
      name.style.display = 'block';
      name.textContent = String(podcast.name || t('subscription.untitled'));
      var meta = document.createElement('span');
      meta.className = 'pod-meta';
      meta.style.display = 'block';
      // 公开浏览只拿到脱敏后的 source_host；控制模式从完整 RSS 地址取域名。
      var host = String(podcast.source_host || '');
      if (!host && podcast.rss_url) { try { host = new URL(podcast.rss_url).hostname; } catch (error) { host = ''; } }
      meta.textContent = host || t('drawer.rss_feed');
      copy.append(name, meta);
      selectBtn.append(dot, copy);
      selectBtn.addEventListener('click', function () { selectPodcast(String(podcast.name || '')); });

      if (!IS_MANAGE) {
        item.appendChild(selectBtn);
        return item;
      }

      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'pod-delete-btn';
      deleteBtn.title = t('subscription.unsubscribe');
      deleteBtn.setAttribute('aria-label', t('subscription.unsubscribe_aria', (podcast.name || t('subscription.untitled'))));
      deleteBtn.innerHTML = uiIcon('trash');

      var confirmTimer = null;
      function resetDeleteBtn() {
        if (confirmTimer) {
          clearTimeout(confirmTimer);
          confirmTimer = null;
        }
        deleteBtn.dataset.confirming = 'false';
        deleteBtn.innerHTML = uiIcon('trash');
        deleteBtn.setAttribute('aria-label', t('subscription.unsubscribe_aria', (podcast.name || t('subscription.untitled'))));
      }

      deleteBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!requireControl('unsubscribe')) return;
        if (deleteBtn.dataset.confirming === 'true') {
          resetDeleteBtn();
          doDeleteSubscription(String(podcast.name || ''));
          return;
        }
        deleteBtn.dataset.confirming = 'true';
        deleteBtn.textContent = t('subscription.confirm_delete');
        deleteBtn.setAttribute('aria-label', t('subscription.confirm_delete_aria', (podcast.name || t('subscription.untitled'))));
        confirmTimer = setTimeout(resetDeleteBtn, 3000);
      });

      item.append(selectBtn, deleteBtn);
      return item;
    }

    function createAllPodcastsItem() {
      var item = document.createElement('div');
      item.className = 'podcast-item all-podcasts-item';
      item.dataset.name = '';
      item.style.setProperty('--item-index', 0);

      var selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'pod-select-btn';

      var dot = document.createElement('span');
      dot.className = 'dot dot-accent';
      dot.setAttribute('aria-hidden', 'true');
      var copy = document.createElement('span');
      copy.style.minWidth = '0';
      var name = document.createElement('span');
      name.className = 'pod-name';
      name.style.display = 'block';
      name.textContent = t('content.all_subscriptions');
      var meta = document.createElement('span');
      meta.className = 'pod-meta';
      meta.style.display = 'block';
      meta.textContent = t('subscription.timeline_browse');
      copy.append(name, meta);
      selectBtn.append(dot, copy);
      selectBtn.addEventListener('click', selectAllPodcasts);

      item.append(selectBtn);
      return item;
    }

    function selectAllPodcasts() {
      if (currentMode !== 'podcast') switchMode('podcast');
      selectedPodcast = null;
      currentPage = 1;
      resetEpisodeInspector();
      document.querySelectorAll('.podcast-item').forEach(function (item) { item.classList.toggle('active', !item.dataset.name); });
      loadTimelineEpisodes(_subscriptions, false);
    }

    function renderPodcastList(podcasts) {
      var list = byId('podcast-list');
      list.replaceChildren();
      var allItem = createAllPodcastsItem();
      if (!selectedPodcast) allItem.classList.add('active');
      list.appendChild(allItem);
      if (!Array.isArray(podcasts) || podcasts.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.minHeight = '90px';
        var emptyIcon = document.createElement('span');
        emptyIcon.className = 'empty-state-icon';
        emptyIcon.innerHTML = uiIcon('rss');
        empty.appendChild(emptyIcon);
        empty.appendChild(document.createTextNode(t('subscription.empty_shows')));
        list.appendChild(empty);
        return;
      }
      var fragment = document.createDocumentFragment();
      podcasts.forEach(function (podcast, index) {
        var item = createPodcastItem(podcast, index);
        if (selectedPodcast === podcast.name) item.classList.add('active');
        fragment.appendChild(item);
      });
      list.appendChild(fragment);
    }

    // 封面图统一走服务端代理（SSRF 校验 + 体积/类型限制），避免浏览器直连第三方 CDN。
    function artworkUrl(image) {
      return image ? browseApi('/artwork?url=' + encodeURIComponent(image)) : '';
    }

    // 订阅封面：控制模式按原始地址代理；公开浏览拿不到原始地址（可能带凭据），按节目名由服务端代理。
    function subscriptionArtworkUrl(podcast) {
      if (!podcast) return '';
      if (IS_MANAGE) return artworkUrl(podcast.image);
      return podcast.has_artwork ? browseApi('/artwork?podcast=' + encodeURIComponent(String(podcast.name || ''))) : '';
    }

    function makeArtworkTile(src, fallbackText, className) {
      var wrap = document.createElement('span');
      wrap.className = className;
      var mono = document.createElement('span');
      mono.className = 'art-monogram';
      mono.textContent = String(fallbackText || (getLocale() === 'en' ? 'P' : '播')).trim().slice(0, 1) || (getLocale() === 'en' ? 'P' : '播');
      wrap.appendChild(mono);
      if (src) {
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.decoding = 'async';
        img.addEventListener('load', function () { wrap.classList.add('has-art'); });
        img.addEventListener('error', function () { img.remove(); });
        img.src = src;
        wrap.appendChild(img);
      }
      return wrap;
    }

    function renderCoverCollage(podcasts) {
      var section = byId('cover-collage');
      var strip = byId('cover-strip');
      if (!section || !strip) return;
      var withArt = (Array.isArray(podcasts) ? podcasts : []).filter(function (p) { return Boolean(subscriptionArtworkUrl(p)); });
      if (withArt.length < 2) { section.hidden = true; strip.replaceChildren(); return; }
      strip.replaceChildren();
      withArt.slice(0, 8).forEach(function (podcast) {
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'cover-tile';
        tile.title = String(podcast.name || '');
        tile.appendChild(makeArtworkTile(subscriptionArtworkUrl(podcast), podcast.name, 'cover-art'));
        tile.addEventListener('click', function () { selectPodcast(String(podcast.name || '')); });
        strip.appendChild(tile);
      });
      var edition = byId('cover-edition');
      if (edition) {
        edition.textContent = new Date().toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' · ' + t('cover.collection');
      }
      section.hidden = false;
    }

    function loadSubscriptions() {
      return fetch(browseApi('/subscriptions'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (podcasts) {
          _subscriptions = Array.isArray(podcasts) ? podcasts : [];
          if (selectedPodcast && !_subscriptions.some(function (podcast) { return podcast && podcast.name === selectedPodcast; })) {
            selectedPodcast = null;
          }
          renderPodcastList(_subscriptions);
          renderCoverCollage(_subscriptions);
          loadTimelineEpisodes(getScopedSubscriptions(), false);
          return _subscriptions;
        })
        .catch(function (error) { addLog(t('subscription.load_failed') + errorMessage(error), 'error'); });
    }

    function getScopedSubscriptions() {
      if (!selectedPodcast) return _subscriptions.slice();
      return _subscriptions.filter(function (podcast) { return podcast && String(podcast.name || '') === selectedPodcast; });
    }

    function updateTimelineHeading() {
      var scopeCount = getScopedSubscriptions().length;
      var total = Number(_episodeCounts.all) || 0;
      byId('center-title').textContent = selectedPodcast || t('content.all_subscriptions');
      var pieces = [];
      if (getLocale() === 'en') {
        if (total) pieces.push('Chronological');
        if (selectedPodcast) pieces.push(total + ' episode' + (total === 1 ? '' : 's'));
        else if (scopeCount) pieces.push(scopeCount + ' show' + (scopeCount === 1 ? '' : 's') + ' · ' + total + ' episode' + (total === 1 ? '' : 's'));
        byId('center-sub').textContent = pieces.join(' · ') || (scopeCount ? t('subscription.loading') : t('subscription.add_first_hint'));
      } else {
        if (total) pieces.push(t('subscription.timeline'));
        if (selectedPodcast) pieces.push(t('subscription.episodes_count', total));
        else if (scopeCount) pieces.push(t('subscription.shows_episodes_count', scopeCount, total));
        byId('center-sub').textContent = pieces.join(' · ') || (scopeCount ? t('subscription.loading') : t('subscription.add_first_hint'));
      }
    }

    // 切换节目范围（全部订阅 / 某一档）：重置搜索、筛选与页码，再向服务端取第一页。
    function loadTimelineEpisodes(podcasts, force) {
      var scope = (Array.isArray(podcasts) ? podcasts : []).filter(function (podcast) { return podcast && podcast.name; });
      pageEpisodes = [];
      currentPage = 1;
      resetEpisodeInspector();
      byId('episode-search').value = '';
      byId('episode-search').disabled = !scope.length;
      currentFilter = 'all';
      setFilterButtons('all');
      setHidden(byId('refresh-btn'), !scope.length);
      setHidden(byId('episode-empty'), true);
      setHidden(byId('episode-list'), false);
      _episodeTotal = 0;
      _episodeCounts = { all: 0, readable: 0, unread: 0, read: 0 };
      if (!scope.length) {
        _timelineRequestToken += 1;
        updateTimelineHeading();
        renderEpisodeList();
        return Promise.resolve([]);
      }
      updateTimelineHeading();
      return loadEpisodePage(force);
    }

    function resetEpisodeInspector() {
      selectedEpisode = null;
      closeEpisodeSummary();
      setHidden(byId('episode-inspector'), true);
      byId('inspector-title').textContent = '';
      byId('inspector-meta').textContent = '';
      byId('inspector-summary').textContent = '';
      byId('inspector-actions').replaceChildren();
      byId('inspector-progress').replaceChildren();
      setHidden(byId('inspector-progress'), true);
      byId('episode-summary-actions').replaceChildren();
      byId('episode-summary-progress').replaceChildren();
      setHidden(byId('episode-summary-progress'), true);
      document.querySelectorAll('.episode-item').forEach(function (item) { item.classList.remove('is-selected'); });
    }

    function cleanEpisodeSummary(summary) {
      return String(summary || t('inspector.no_desc'))
        .replace(/\s+-\s+/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    // 单集列表不带简介（体积最大、列表里又不显示）；点开单集时按 id 取一次并缓存。
    var _episodeSummaries = {};
    function loadEpisodeSummary(episodeId) {
      var id = String(episodeId || '');
      if (!_episodeSummaries[id]) {
        _episodeSummaries[id] = fetch(browseApi('/episodes/summary?id=' + encodeURIComponent(id)))
          .then(readApiResponse)
          .then(function (data) { return String((data && data.summary) || ''); })
          .catch(function (error) { delete _episodeSummaries[id]; throw error; });
      }
      return _episodeSummaries[id];
    }
    function showEpisodeSummary(text) {
      byId('inspector-summary').textContent = text;
      byId('episode-summary-copy').textContent = text;
    }

    function renderEpisodeInspector(episode) {
      selectedEpisode = episode;
      setHidden(byId('episode-inspector'), false);
      var task = completedTaskForEpisode(episode);
      var activeTask = activeTaskForEpisode(episode);
      var meta = [];
      if (!selectedPodcast && episode.podcast_name) meta.push(String(episode.podcast_name));
      if (episode.published) meta.push(new Date(episode.published).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }));
      var duration = formatDuration(episode.duration_seconds);
      if (duration) meta.push(duration);
      meta.push(episodeStatusLabel(episode, task, activeTask, failedTaskForEpisode(episode)));
      byId('inspector-title').textContent = String(episode.title || t('episode.untitled'));
      byId('inspector-meta').textContent = meta.join(' · ');
      byId('episode-summary-title').textContent = String(episode.title || t('episode.untitled'));
      byId('episode-summary-meta').textContent = meta.join(' · ');
      showEpisodeSummary(t('inspector.loading_desc'));
      loadEpisodeSummary(episode.id)
        .then(function (summary) { if (selectedEpisode === episode) showEpisodeSummary(cleanEpisodeSummary(summary)); })
        .catch(function () { if (selectedEpisode === episode) showEpisodeSummary(t('inspector.load_failed')); });
      renderInspectorAction(episode, task, activeTask);
      document.querySelectorAll('.episode-item').forEach(function (item) {
        item.classList.toggle('is-selected', item.dataset.episodeKey === String(episode.id));
      });
      if (!hasPersistentInspector()) openEpisodeSummary();
    }

    // 公开浏览只区分「可阅读 / 未生成」：任务进度、失败与已读都属于控制模式的状态。
    function episodeStatusLabel(episode, task, activeTask, failedTask) {
      if (!IS_MANAGE) return task ? t('episode.status_readable') : t('episode.status_unread');
      return activeTask ? (t('episode.status_generating') + activeTask.progress + '%') : failedTask ? t('episode.status_failed') : isEpisodeRead(episode) ? t('episode.status_read') : task ? t('filter.readable') : t('episode.status_unread');
    }

    function activeTaskForEpisode(episode) {
      var key = episode && episode.id ? String(episode.id) : '';
      if (!key) return null;
      var match = null;
      Object.keys(_taskCards).some(function (id) {
        var task = _taskCards[id];
        if (task.isCustomUpload) return false;
        var active = task.status === 'running' || task.status === 'pending';
        if (active && task.episodeId === key) { match = task; match.id = id; return true; }
        return false;
      });
      return match;
    }

    function failedTaskForEpisode(episode) {
      var key = episode && episode.id ? String(episode.id) : '';
      if (!key) return null;
      var match = null;
      Object.keys(_taskCards).some(function (id) {
        var task = _taskCards[id];
        if (task.isCustomUpload) return false;
        var failed = task.status === 'failed' || task.status === 'cancelled';
        if (failed && task.episodeId === key) { match = task; match.id = id; return true; }
        return false;
      });
      return match;
    }

    function createEpisodeDownloadAction(taskId, label) {
      var link = document.createElement('a');
      link.className = 'episode-action episode-download-action';
      link.href = articleUrl(taskId, '/download');
      link.download = '';
      link.innerHTML = uiIcon('download');
      link.appendChild(document.createTextNode(label || t('library.download')));
      link.addEventListener('click', function (event) { event.stopPropagation(); });
      return link;
    }

    function createEpisodeRerunAction(episode) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'episode-action rerun owner-state-only';
      button.textContent = t('episode.regenerate');
      button.setAttribute('aria-label', t('episode.regenerate_aria', String(episode.title || t('episode.this_episode'))));
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        renderEpisodeInspector(episode);
        triggerEpisode(episode, event, true);
      });
      return button;
    }

    function renderInspectorAction(episode, completed, active) {
      var failed = failedTaskForEpisode(episode);
      ['inspector', 'episode-summary'].forEach(function (prefix) {
        var actions = byId(prefix + '-actions');
        var progress = byId(prefix + '-progress');
        actions.replaceChildren(); progress.replaceChildren();
        setHidden(progress, !active && !failed);
        if (active) {
          var stageIndex = Object.prototype.hasOwnProperty.call(STAGE_STEP_INDEX, active.stage) ? STAGE_STEP_INDEX[active.stage] : 0;
          var stageLabels = [t('stage.step_audio'), t('stage.step_transcribe'), t('stage.step_refine'), t('stage.step_save')];
          var activeMsg = (active.stage && t('stage.' + active.stage)) || active.message || t('custom.processing');
          progress.innerHTML = '<div class="inspector-progress-head"><span>' + escapeHtml(t('inspector.generating_head')) + '</span><span>' + active.progress + '%</span></div><div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + active.progress + '"><div class="progress-inner" style="width:' + active.progress + '%"></div></div><div class="progress-stage-row">' + stageLabels.map(function (label, index) { return '<span class="' + (index < stageIndex ? 'done' : index === stageIndex ? 'active' : '') + '">' + (index < stageIndex ? '✓ ' : index === stageIndex ? '● ' : '○ ') + label + '</span>'; }).join('') + '</div><div class="progress-message">' + escapeHtml(activeMsg) + '</div>';
        } else if (failed) {
          progress.innerHTML = '<div class="inspector-progress-head text-danger"><span>' + escapeHtml(t('inspector.failed_head')) + '</span></div><div class="progress-message text-danger">' + escapeHtml(resolveTaskFailureMessage(failed)) + '</div>';
        }
        var primary = document.createElement('button');
        primary.type = 'button';
        primary.className = completed ? 'episode-action' : 'solid-btn';
        primary.textContent = active ? (t('episode.status_generating') + active.progress + '%') : completed ? t('library.read') : failed ? t('tasks.retry') : t('episode.generate');
        primary.disabled = Boolean(active);
        primary.addEventListener('click', function (event) {
          if (completed) openManuscript(completed.id, episode);
          else if (failed) retryTask(failed.id, primary);
          else triggerEpisode(episode, event, false);
        });
        actions.appendChild(primary);
        if (completed) {
          actions.appendChild(createEpisodeDownloadAction(completed.id, t('episode.download_md')));
          if (IS_MANAGE) actions.appendChild(createEpisodeRerunAction(episode));
        }
      });
    }

    function hasPersistentInspector() {
      var rail = document.querySelector('.right-rail');
      if (!rail) return false;
      if (typeof window !== 'undefined' && window.matchMedia) {
        if (window.matchMedia('(max-width: 1180px)').matches) return false;
      }
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        if (window.getComputedStyle(rail).display === 'none') return false;
      }
      return true;
    }

    function openEpisodeSummary() {
      var drawer = byId('episode-summary-drawer');
      setHidden(drawer, false);
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
      byId('episode-summary-overlay').classList.add('is-open');
    }

    function closeEpisodeSummary() {
      var drawer = byId('episode-summary-drawer');
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      byId('episode-summary-overlay').classList.remove('is-open');
      window.setTimeout(function () {
        if (!drawer.classList.contains('is-open')) setHidden(drawer, true);
      }, 340);
    }

    function selectPodcast(name) {
      if (currentMode !== 'podcast') switchMode('podcast');
      selectedPodcast = name;
      currentPage = 1;
      resetEpisodeInspector();
      document.querySelectorAll('.podcast-item').forEach(function (item) { item.classList.toggle('active', item.dataset.name === name); });
      byId('center-title').textContent = name;
      byId('center-sub').textContent = t('episode.opening');
      byId('episode-search').disabled = false;
      loadEpisodes(name, false);
    }

    function setFilter(filter) {
      currentFilter = filter;
      currentPage = 1;
      setFilterButtons(filter);
      loadEpisodePage(false);
    }

    function setFilterButtons(filter) {
      ['all', 'readable', 'unread', 'read'].forEach(function (name) {
        var button = byId('filter-' + name);
        if (!button) return;
        button.classList.toggle('active', filter === name);
        button.setAttribute('aria-selected', String(filter === name));
      });
    }

    function updateFilterCounts() {
      [['all', 'filter-all-count'], ['readable', 'filter-readable-count'], ['unread', 'filter-unread-count'], ['read', 'filter-read-count']].forEach(function (pair) {
        var node = byId(pair[1]);
        if (node) node.textContent = String(Number(_episodeCounts[pair[0]]) || 0);
      });
    }

    function episodePageCount() {
      return Math.max(1, Math.ceil(_episodeTotal / PAGE_SIZE));
    }

    /**
     * 取当前范围（节目 / 全部订阅）、筛选、搜索下的第 currentPage 页。只有这一页进入内存；
     * 过期的响应（期间又切换了范围 / 筛选 / 页码）一律丢弃。quiet = 不显示骨架屏（后台刷新）。
     */
    function loadEpisodePage(force, quiet) {
      var requestToken = ++_timelineRequestToken;
      var params = ['limit=' + PAGE_SIZE, 'offset=' + (currentPage - 1) * PAGE_SIZE, 'filter=' + encodeURIComponent(currentFilter)];
      if (selectedPodcast) params.push('podcast_name=' + encodeURIComponent(selectedPodcast));
      var query = byId('episode-search').value.trim();
      if (query) params.push('q=' + encodeURIComponent(query));
      // 公开浏览只读 D1 快照；只有控制模式会带 force 刷新 RSS。
      if (force && IS_MANAGE) params.push('force=true');
      if (!quiet) renderSkeletons(PAGE_SIZE);
      return fetch(browseApi('/episodes/page?' + params.join('&')))
        .then(readApiResponse)
        .then(function (page) {
          if (requestToken !== _timelineRequestToken) return pageEpisodes;
          pageEpisodes = page && Array.isArray(page.items) ? page.items : [];
          _episodeTotal = Number(page && page.total) || 0;
          _episodeCounts = (page && page.counts) || { all: 0, readable: 0, unread: 0, read: 0 };
          // 筛选 / 已读变化后总数变少、当前页越界：退回最后一页
          if (currentPage > episodePageCount()) {
            currentPage = episodePageCount();
            return loadEpisodePage(false, true);
          }
          updateTimelineHeading();
          renderEpisodeList();
          if (force && page && page.cache_state === 'stale') addLog(t('content.stale_warning'), 'warning');
          return pageEpisodes;
        })
        .catch(function (error) {
          if (requestToken !== _timelineRequestToken) return pageEpisodes;
          pageEpisodes = [];
          _episodeTotal = 0;
          renderEpisodeList();
          addLog(t('content.load_failed', errorMessage(error)), 'error');
          return pageEpisodes;
        });
    }

    /** 状态变化（已读、任务完成）后静默重取当前页，让筛选与计数跟上。 */
    function reloadEpisodePage() {
      if (!_subscriptions.length) return Promise.resolve(pageEpisodes);
      return loadEpisodePage(false, true);
    }

    var _episodeSearchTimer = null;
    function onEpisodeSearch() {
      window.clearTimeout(_episodeSearchTimer);
      _episodeSearchTimer = window.setTimeout(function () {
        currentPage = 1;
        loadEpisodePage(false);
      }, 250);
    }

    function goToEpisodePage(page) {
      var target = Math.min(Math.max(1, page), episodePageCount());
      if (target === currentPage) return;
      currentPage = target;
      loadEpisodePage(false);
    }

    function loadEpisodes(podcastName, force) {
      var scope = _subscriptions.filter(function (podcast) { return podcast && String(podcast.name || '') === String(podcastName || ''); });
      return loadTimelineEpisodes(scope, force);
    }

    function renderSkeletons(count) {
      var container = byId('episode-list');
      container.replaceChildren();
      setHidden(byId('episode-pagination'), true);
      for (var index = 0; index < count; index += 1) {
        var row = document.createElement('div'); row.className = 'episode-item';
        var copy = document.createElement('div'); copy.style.cssText = 'display:grid;gap:8px';
        var line1 = document.createElement('div'); line1.className = 'skeleton'; line1.style.cssText = 'width:' + (62 + index % 3 * 10) + '%;height:16px';
        var line2 = document.createElement('div'); line2.className = 'skeleton'; line2.style.cssText = 'width:30%;height:9px';
        var action = document.createElement('div'); action.className = 'skeleton'; action.style.cssText = 'width:72px;height:36px;border-radius:12px';
        copy.append(line1, line2); row.append(copy, action); container.appendChild(row);
      }
    }

    // 单集是否已有稿件：分页接口的每一项都带 article_task_id（两种模式相同，不再维护一份全量映射）。
    function completedTaskForEpisode(episode) {
      if (!episode || !episode.article_task_id) return null;
      return { id: episode.article_task_id, episode_title: episode.title, podcast_name: episode.podcast_name || selectedPodcast, status: 'success' };
    }

    function formatDuration(seconds) {
      var value = Number(seconds || 0);
      if (!value) return '';
      var hours = Math.floor(value / 3600);
      var minutes = Math.floor((value % 3600) / 60);
      if (hours > 0) return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(Math.floor(value % 60)).padStart(2, '0');
      return String(minutes).padStart(2, '0') + ':' + String(Math.floor(value % 60)).padStart(2, '0');
    }

    function makeEpisodeActions(task, episode) {
      var activeTask = activeTaskForEpisode(episode);
      var failedTask = failedTaskForEpisode(episode);
      var actions = document.createElement('div');
      actions.className = 'episode-actions';
      var primaryButton = document.createElement('button');
      primaryButton.type = 'button';
      primaryButton.className = 'episode-action' + (task ? '' : ' primary');
      primaryButton.textContent = activeTask ? (t('episode.status_generating') + activeTask.progress + '%') : task ? t('library.read') : failedTask ? t('tasks.retry') : t('episode.generate');
      primaryButton.disabled = Boolean(activeTask);
      primaryButton.addEventListener('click', function (event) {
        event.stopPropagation();
        renderEpisodeInspector(episode);
        // 已完成节目的主按钮是「阅读」；只有未转录时才隐式触发转录（force=false）。
        if (task) openManuscript(task.id, episode);
        else if (failedTask) retryTask(failedTask.id, primaryButton);
        else if (!activeTask) triggerEpisode(episode, event, false);
      });
      actions.appendChild(primaryButton);
      if (task) {
        actions.appendChild(createEpisodeDownloadAction(task.id, t('library.download')));
        if (IS_MANAGE) actions.appendChild(createEpisodeRerunAction(episode));
      }
      return actions;
    }

    function renderEpisodeList() {
      var episodes = pageEpisodes;
      var container = byId('episode-list');
      var pagination = byId('episode-pagination');
      container.replaceChildren();
      updateFilterCounts();
      if (!episodes.length) {
        var empty = document.createElement('div'); empty.className = 'empty-state';
        var emptyIcon = document.createElement('span'); emptyIcon.className = 'empty-state-icon'; emptyIcon.innerHTML = uiIcon(_subscriptions.length ? 'search' : 'rss');
        empty.appendChild(emptyIcon);
        var copy = document.createElement('span');
        copy.innerHTML = _subscriptions.length
          ? ('<strong>' + escapeHtml(t('drawer.no_matches')) + '</strong><br>' + escapeHtml(t('drawer.no_matches_hint')))
          : ('<strong>' + escapeHtml(t('empty.no_subscriptions')) + '</strong><br>' + escapeHtml(t('empty.no_subscriptions_desc')));
        empty.appendChild(copy);
        container.appendChild(empty);
        setHidden(pagination, true);
        return;
      }
      var totalPages = episodePageCount();
      var fragment = document.createDocumentFragment();
      episodes.forEach(function (episode, index) {
        var task = completedTaskForEpisode(episode);
        var activeTask = activeTaskForEpisode(episode);
        var row = document.createElement('article');
        row.className = 'episode-item';
        row.tabIndex = 0;
        row.dataset.episodeTitle = String(episode.title || '');
        row.dataset.episodeKey = String(episode.id);
        row.setAttribute('aria-label', t('episode.view_desc_aria', String(episode.title || t('episode.untitled'))));
        row.style.setProperty('--item-index', index);
        if (selectedEpisode && String(selectedEpisode.id) === String(episode.id)) row.classList.add('is-selected');
        var copy = document.createElement('div'); copy.className = 'ep-copy';
        var meta = document.createElement('div'); meta.className = 'ep-meta';
        var source = document.createElement('button');
        source.type = 'button';
        source.className = 'episode-source';
        source.textContent = String(episode.podcast_name || t('episode.subscription_show'));
        source.setAttribute('aria-label', t('episode.filter_by_show_aria', source.textContent));
        source.addEventListener('click', function (event) {
          event.stopPropagation();
          selectPodcast(String(episode.podcast_name || ''));
        });
        var read = isEpisodeRead(episode);
        var failedTask = failedTaskForEpisode(episode);
        var status = document.createElement('span'); status.className = 'status-tag' + (read ? ' read' : task ? ' complete' : failedTask ? ' failed' : ''); status.textContent = episodeStatusLabel(episode, task, activeTask, failedTask);
        if (failedTask) status.title = resolveTaskFailureMessage(failedTask);
        var date = document.createElement('span');
        date.textContent = episode.published ? new Date(episode.published).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit' }) : '--';
        meta.append(source, status, date);
        var duration = formatDuration(episode.duration_seconds);
        if (duration) { var durationNode = document.createElement('span'); durationNode.textContent = duration; meta.appendChild(durationNode); }
        var title = document.createElement('div'); title.className = 'ep-title'; title.textContent = String(episode.title || t('episode.untitled'));
        copy.append(meta, title);
        if (activeTask) { var inlineProgress = document.createElement('div'); inlineProgress.className = 'progress-bar episode-progress'; inlineProgress.innerHTML = '<div class="progress-inner" style="width:' + activeTask.progress + '%"></div>'; copy.appendChild(inlineProgress); }
        var actions = makeEpisodeActions(task, episode);
        row.append(copy, actions);
        row.addEventListener('click', function () { renderEpisodeInspector(episode); });
        row.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); renderEpisodeInspector(episode); }
        });
        fragment.append(row);
      });
      container.appendChild(fragment);
      byId('page-label').textContent = t('pagination.page', currentPage, totalPages);
      byId('page-prev').disabled = currentPage <= 1;
      byId('page-next').disabled = currentPage >= totalPages;
      setHidden(pagination, totalPages <= 1);
    }

    var _submittingEpisodes = {};
    function triggerEpisode(episode, event, force) {
      if (event) event.stopPropagation();
      var sourceName = String(episode.podcast_name || selectedPodcast || '').trim();
      var title = String(episode.title || '');
      if (!sourceName) { addLog(t('tasks.no_source'), 'error'); return; }
      if (!requireControl('generate', { podcast: sourceName })) return;
      var button = event && event.currentTarget && event.currentTarget.tagName === 'BUTTON' ? event.currentTarget : null;
      _currentTaskPodcastName = sourceName;
      var episodeKey = String(episode.id || '');
      // 客户端防抖：同一节目在提交完成前忽略后续点击，避免误触重复入队。
      if (_submittingEpisodes[episodeKey]) return;
      _submittingEpisodes[episodeKey] = true;
      if (button) button.disabled = true;
      setHidden(byId('task-card'), false);
      setTaskStatus(t('inspector.generating_head'), 0);
      var url = appUrl('/api/control/tasks');
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episode_id: String(episode.id || ''), force: !!force }),
      })
        .then(readApiResponse)
        .then(function (data) {
          if (data.status === 'existing') addLog(t('tasks.generating_progress'), 'info');
          watchTask(data.task_id, title, sourceName);
          ensureTaskCard(data.task_id).episodeId = episodeKey;
        })
        .catch(function (error) {
          if (error && error.status === 409) {
            setTaskStatus(error.message || t('tasks.already_generated'), 0);
            setTaskBadge('info', t('tasks.completed_badge'));
            addLog(error.message || t('tasks.already_generated_log'), 'info');
          } else {
            setTaskStatus(t('tasks.failed_retry_msg'), 0);
            setTaskBadge('error', t('tasks.failed_badge'));
          }
        })
        .finally(function () {
          delete _submittingEpisodes[episodeKey];
          if (button) button.disabled = false;
        });
    }

    function submitCustomTask() {
      if (!requireControl('import')) return;
      var uploadId = _uploadedAudioPath;
      var prompt = byId('custom-prompt').value.trim();
      var title = _uploadedAudioTitle || t('custom.custom_audio');
      if (!uploadId) { setHidden(byId('task-card'), false); setTaskStatus(t('tasks.need_audio_file'), 0); setTaskBadge('error', t('tasks.step_missing_badge')); return; }
      var button = byId('custom-submit-btn');
      button.disabled = true; button.textContent = t('custom.generating');
      setHidden(byId('download-result-wrap'), true);
      setHidden(byId('task-card'), false);
      setTaskStatus(t('inspector.generating_head'), 0);
      var payload = { upload_id: uploadId, title: title };
      if (prompt) payload.custom_prompt = prompt;
      fetch(appUrl('/api/control/tasks/custom'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(readApiResponse)
        .then(function (data) { watchTask(data.task_id, title, t('custom.local_audio')); })
        .catch(function (err) {
          setTaskStatus(t('tasks.failed_prefix') + (err.message || t('tasks.retry_hint')), 0);
          setTaskBadge('error', t('tasks.failed_badge'));
        })
        .finally(function () { button.disabled = false; button.textContent = t('custom.submit'); });
    }

    var STAGE_LABELS = { queued: '获取音频', resolving: '获取音频', downloading: '获取音频', transcribing: '转写', refining: '整理', finalizing: '保存', done: '保存', success: '保存', error: '失败', cancelled: '已取消' };
    var STAGE_STEP_INDEX = { queued: 0, resolving: 0, downloading: 0, transcribing: 1, refining: 2, finalizing: 3, done: 3, success: 3 };
    /**
     * 一个轮询器盯住所有进行中的任务：每轮只发一个 GET /tasks?active=true（不是每个任务一个定时器）。
     * 间隔 5 秒起，没有变化就逐步放慢到 15 秒，有变化立刻回到 5 秒；页面不可见时暂停，回到前台立刻补一轮。
     * 盯着的任务从进行中列表里消失 = 已结束：onFinished(id) 各取一次终态。
     */
    function createTaskPoller(options) {
      var MIN_DELAY = 5000;
      var MAX_DELAY = 15000;
      var watched = {};
      var timer = null;
      var inFlight = false;
      var delay = MIN_DELAY;
      function watchedIds() { return Object.keys(watched); }
      function stop() { if (timer !== null) { options.clearTimeout(timer); timer = null; } }
      function schedule(ms) {
        stop();
        if (!watchedIds().length || options.isHidden()) return;
        timer = options.setTimeout(tick, ms);
      }
      function tick() {
        timer = null;
        if (inFlight || !watchedIds().length) return;
        inFlight = true;
        options.fetchActive()
          .then(function (tasks) {
            var active = {};
            var changed = false;
            tasks.forEach(function (task) {
              var id = String(task.id || '');
              active[id] = true;
              if (!Object.prototype.hasOwnProperty.call(watched, id)) return;
              var signature = [task.status, task.stage, task.progress_pct, task.message].join('|');
              if (watched[id] !== signature) { watched[id] = signature; changed = true; options.onUpdate(task); }
            });
            watchedIds().forEach(function (id) {
              if (active[id]) return;
              delete watched[id];
              changed = true;
              options.onFinished(id);
            });
            delay = changed ? MIN_DELAY : Math.min(MAX_DELAY, Math.round(delay * 1.5));
          })
          .catch(function () { delay = Math.min(MAX_DELAY, Math.round(delay * 1.5)); })
          .then(function () { inFlight = false; schedule(delay); });
      }
      return {
        watch: function (taskId) {
          var id = String(taskId || '');
          if (!id || Object.prototype.hasOwnProperty.call(watched, id)) return;
          watched[id] = '';
          delay = MIN_DELAY;
          if (timer === null && !inFlight) schedule(MIN_DELAY);
        },
        unwatch: function (taskId) {
          if (taskId) delete watched[String(taskId)];
          else watched = {};
          if (!watchedIds().length) stop();
        },
        watchedIds: watchedIds,
        wake: function () {
          if (options.isHidden() || inFlight) return;
          stop();
          delay = MIN_DELAY;
          tick();
        }
      };
    }

    var _taskPoller = createTaskPoller({
      fetchActive: function () {
        return fetch(appUrl('/api/control/tasks?active=true')).then(readApiResponse).then(function (tasks) { return Array.isArray(tasks) ? tasks : []; });
      },
      onUpdate: function (task) {
        applyPublicTask(task);
        setTaskStatus(task.stage, task.progress_pct || 0, String(task.id), task.episode_title, task.message);
      },
      onFinished: function (id) {
        fetch(safeTaskUrl(id, ''))
          .then(readApiResponse)
          .then(function (task) {
            if (!task || !task.status) return;
            applyPublicTask(task);
            setTaskStatus(task.stage, task.progress_pct || 0, id, task.episode_title, task.message);
            if (task.status === 'success') handleTaskFinished(id, true, { message: task.message });
            else if (task.status === 'cancelled') handleTaskCancelled(id);
            else if (task.status === 'failed') handleTaskFinished(id, false, { stage: task.stage, progress: task.progress_pct, message: task.message });
          })
          .catch(function () {});
      },
      setTimeout: function (callback, ms) { return window.setTimeout(callback, ms); },
      clearTimeout: function (handle) { window.clearTimeout(handle); },
      isHidden: function () { return document.visibilityState === 'hidden'; }
    });
    document.addEventListener('visibilitychange', function () { _taskPoller.wake(); });

    function clearPolling(taskId) {
      _taskPoller.unwatch(taskId);
    }
    function closeActiveStream() {
      clearPolling();
    }
    function taskElapsed(startedAt) {
      var seconds = Math.max(0, Math.floor((Date.now() - (startedAt || Date.now())) / 1000));
      return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }
    function resolveTaskFailureMessage(task) {
      if (!task) return t('fail.default');
      var stage = String(task.stage || '');
      if (getLocale() === 'en') {
        if (stage === 'downloading' || stage === 'queued' || stage === 'resolving') {
          return t('fail.audio');
        }
        if (stage === 'transcribing') {
          return t('fail.transcribe');
        }
        if (stage === 'refining') {
          return t('fail.refine');
        }
        if (stage === 'finalizing') {
          return t('fail.finalize');
        }
        if (task.status === 'cancelled') {
          return t('fail.cancelled');
        }
        return t('fail.default');
      }
      var msg = String(task.message || '').trim();
      var isChinese = /[\u4e00-\u9fa5]/.test(msg);
      if (msg && !/^([a-z0-9_]+|error|\[object.*\])$/i.test(msg) && (getLocale() !== 'en' || !isChinese)) {
        return msg;
      }
      if (stage === 'downloading' || stage === 'queued' || stage === 'resolving') {
        return t('fail.audio');
      }
      if (stage === 'transcribing') {
        return t('fail.transcribe');
      }
      if (stage === 'refining') {
        return t('fail.refine');
      }
      if (stage === 'finalizing') {
        return t('fail.finalize');
      }
      if (task.status === 'cancelled') {
        return t('fail.cancelled');
      }
      return t('fail.default');
    }

    function renderTaskQueue() {
      var list = byId('task-list');
      var ids = Object.keys(_taskCards).filter(function (id) {
        var s = _taskCards[id].status;
        return s === 'running' || s === 'pending' || s === 'failed' || s === 'cancelled';
      });
      var runningCount = ids.filter(function (id) { return _taskCards[id].status === 'running' || _taskCards[id].status === 'pending'; }).length;
      var attentionCount = ids.filter(function (id) { return _taskCards[id].status === 'failed' || _taskCards[id].status === 'cancelled'; }).length;

      setHidden(byId('task-card'), !ids.length);
      byId('task-queue-count').textContent = runningCount ? '（' + runningCount + '）' : (attentionCount ? '（' + attentionCount + '）' : '');

      var triggerBtn = byId('task-panel-btn');
      var triggerLabel = byId('task-trigger-label');
      var triggerDot = triggerBtn ? triggerBtn.querySelector('.task-trigger-dot') : null;

      if (runningCount > 0) {
        setHidden(triggerBtn, false);
        if (triggerLabel) triggerLabel.textContent = t('tasks.processing_count', runningCount);
        if (triggerDot) triggerDot.style.display = '';
      } else if (attentionCount > 0) {
        setHidden(triggerBtn, false);
        if (triggerLabel) triggerLabel.textContent = t('tasks.attention_count', attentionCount);
        if (triggerDot) triggerDot.style.display = 'none';
      } else {
        setHidden(triggerBtn, true);
      }

      list.replaceChildren();
      ids.reverse().forEach(function (id, index) {
        var task = _taskCards[id];
        var card = document.createElement('article'); card.className = 'task-queue-item'; card.style.setProperty('--item-index', index);
        var top = document.createElement('div'); top.className = 'task-topline';
        var title = document.createElement('h2'); title.textContent = task.title || t('tasks.default_title');
        var badge = document.createElement('span'); badge.className = 'badge ' + (task.status === 'success' ? 'badge-success' : (task.status === 'failed' || task.status === 'cancelled') ? 'badge-error' : 'badge-accent'); badge.textContent = task.status === 'success' ? t('stage.success') : task.status === 'cancelled' ? t('stage.cancelled') : task.status === 'failed' ? t('stage.failed') : task.progress + '%';
        top.append(title, badge);
        var stageLabel = t('stage.' + (task.stage || 'queued'));
        var meta = document.createElement('div'); meta.className = 'task-meta'; meta.innerHTML = '<span>' + escapeHtml(stageLabel) + '</span><span>' + task.progress + '%</span>';
        var status = document.createElement('h3'); status.className = 'task-stage'; status.setAttribute('aria-live', 'polite');
        if (task.status === 'failed' || task.status === 'cancelled') {
          status.textContent = resolveTaskFailureMessage(task);
        } else if (getLocale() === 'en') {
          status.textContent = stageLabel;
        } else {
          status.textContent = task.message || stageLabel;
        }
        var progress = document.createElement('div'); progress.className = 'progress-bar'; progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100'); progress.setAttribute('aria-valuenow', String(task.progress));
        var inner = document.createElement('div'); inner.className = 'progress-inner'; inner.style.width = task.progress + '%'; progress.appendChild(inner);
        var steps = document.createElement('div'); steps.className = 'task-steps';
        var activeStep = Object.prototype.hasOwnProperty.call(STAGE_STEP_INDEX, task.stage) ? STAGE_STEP_INDEX[task.stage] : -1;
        [t('stage.step_audio'), t('stage.step_transcribe'), t('stage.step_refine'), t('stage.step_save')].forEach(function (label, stepIndex) { var step = document.createElement('span'); step.textContent = label; step.className = stepIndex <= activeStep ? 'is-active' : ''; if (stepIndex < activeStep) { step.classList.add('is-done'); step.insertAdjacentHTML('afterbegin', uiIcon('check')); } steps.appendChild(step); });
        card.append(top, meta, status, progress, steps);
        if (task.status === 'running' || task.status === 'pending') {
          var cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'task-cancel';
          cancelBtn.textContent = t('tasks.cancel');
          cancelBtn.setAttribute('aria-label', t('tasks.cancel_aria', String(task.title || t('tasks.default_title'))));
          cancelBtn.addEventListener('click', function () { cancelTask(id, cancelBtn); });
          card.appendChild(cancelBtn);
        } else if (task.status === 'failed' || task.status === 'cancelled') {
          var actions = document.createElement('div'); actions.className = 'task-actions';
          if (id !== 'local') {
            var retryBtn = document.createElement('button'); retryBtn.type = 'button'; retryBtn.className = 'task-action task-action-primary'; retryBtn.textContent = t('tasks.retry'); retryBtn.addEventListener('click', function () { retryTask(id, retryBtn); });
            actions.appendChild(retryBtn);
          }
          var clearBtn = document.createElement('button'); clearBtn.type = 'button'; clearBtn.className = 'task-action'; clearBtn.textContent = t('tasks.delete'); clearBtn.addEventListener('click', function () { clearTask(id, clearBtn); });
          actions.appendChild(clearBtn); card.appendChild(actions);
        }
        list.appendChild(card);
      });
    }
    function clearTask(taskId, button) {
      var id = String(taskId || '');
      if (!id || !requireControl('tasks')) return;
      if (id === 'local') { delete _taskCards[id]; renderTaskQueue(); return; }
      if (button) { button.disabled = true; button.textContent = t('tasks.deleting'); }
      fetch(safeTaskUrl(id, ''), { method: 'DELETE' })
        .then(readApiResponse)
        .then(function () { delete _taskCards[id]; clearPolling(id); renderTaskQueue(); loadHistory(); addLog(t('tasks.dismissed'), 'info'); })
        .catch(function (error) { if (button) { button.disabled = false; button.textContent = t('tasks.delete'); } addLog(errorMessage(error), 'warning'); });
    }
    function retryTask(taskId, button) {
      if (!requireControl('tasks')) return;
      var id = String(taskId || '');
      var oldTask = _taskCards[id];
      if (!id || !oldTask) return;
      if (button) { button.disabled = true; button.textContent = t('tasks.retrying'); }
      fetch(safeTaskUrl(id, '/retry'), { method: 'POST' })
        .then(readApiResponse)
        .then(function (data) {
          delete _taskCards[id]; clearPolling(id);
          watchTask(data.task_id, oldTask.title);
          loadHistory(); addLog(t('tasks.restarted'), 'info');
        })
        .catch(function (error) { if (button) { button.disabled = false; button.textContent = t('tasks.retry'); } addLog(errorMessage(error), 'warning'); });
    }
    function cancelTask(taskId, button) {
      var id = String(taskId || '');
      if (!id || !requireControl('tasks')) return;
      if (button) { button.disabled = true; button.textContent = t('tasks.cancelling'); }
      fetch(safeTaskUrl(id, ''), { method: 'DELETE' })
        .then(readApiResponse)
        .then(function () {
          addLog(t('tasks.cancelling_msg'), 'info');
          if (_taskCards[id]) { _taskCards[id].message = t('tasks.cancelling'); renderTaskQueue(); }
        })
        .catch(function (error) {
          addLog(error && error.message ? error.message : t('fail.default'), 'warning');
          if (button) { button.disabled = false; button.textContent = t('tasks.cancel_task'); }
        });
    }
    function ensureTaskCard(taskId, title, podcastName) {
      var id = String(taskId || 'local');
      if (!_taskCards[id]) _taskCards[id] = { stage: 'queued', progress: 0, status: 'running', startedAt: Date.now(), message: t('stage.queued') };
      var card = _taskCards[id];
      if (podcastName !== undefined && podcastName !== null && podcastName !== '') card.podcastName = String(podcastName).trim();
      if (title !== undefined && title !== null && title !== '') card.episodeTitle = String(title).trim();
      card.title = card.episodeTitle || card.title || t('tasks.default_title');
      card.isCustomUpload = (card.podcastName === '本地音频' || card.podcastName === '自定义音频' || card.podcastName === t('custom.local_audio') || card.podcastName === t('custom.custom_audio') || id === 'local');
      _taskStartedAt[id] = card.startedAt;
      return card;
    }
    function applyPublicTask(task) {
      var id = String(task.id || ''); if (!id) return null;
      if (task.podcast_name) _currentTaskPodcastName = String(task.podcast_name);
      var card = ensureTaskCard(id, task.episode_title, task.podcast_name);
      if (task.episode_id) card.episodeId = String(task.episode_id);
      card.status = String(task.status || 'pending');
      card.stage = String(task.stage || 'queued');
      card.progress = Math.max(0, Math.min(100, Number(task.progress_pct) || 0));
      if (card.status === 'failed' || card.status === 'cancelled') {
        card.message = resolveTaskFailureMessage(task);
      } else if (getLocale() === 'en') {
        card.message = t('stage.' + card.stage);
      } else {
        card.message = String(task.message || t('stage.' + card.stage));
      }
      card.startedAt = new Date(task.created_at || Date.now()).getTime();
      return card;
    }
    function handleTaskFinished(taskId, succeeded, details) {
      var task = ensureTaskCard(taskId);
      details = details || {};
      task.status = succeeded ? 'success' : 'failed';
      if (succeeded) {
        task.stage = 'done';
        task.progress = 100;
        task.message = details.message || t('tasks.success_msg');
      } else {
        if (details.stage) task.stage = details.stage;
        task.progress = Math.max(task.progress || 0, Number(details.progress) || 0);
        task.message = details.message ? resolveTaskFailureMessage({ stage: task.stage, message: details.message }) : resolveTaskFailureMessage(task);
      }
      renderTaskQueue();
      loadHistory();
      if (succeeded) {
        loadLibrary();
        byId('download-result-btn').href = safeTaskUrl(taskId, '/download');
        byId('read-result-btn').onclick = function () { openManuscript(taskId); };
        setHidden(byId('download-result-wrap'), false);
        addLog(t('tasks.success_log'), 'success');
      } else {
        addLog(task.message || t('tasks.failed_log'), 'error');
      }
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, succeeded ? 'var(--success)' : 'var(--error)', false);
    }
    function handleTaskCancelled(taskId) {
      var task = ensureTaskCard(taskId);
      task.status = 'cancelled';
      task.message = task.message || t('fail.cancelled');
      clearPolling(String(taskId || ''));
      renderTaskQueue();
      loadHistory();
      addLog(t('tasks.cancelled_msg'), 'info');
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, 'var(--error)', false);
    }
    function startPolling(taskId) {
      _taskPoller.watch(taskId);
    }
    function watchTask(taskId, title, podcastName) {
      _currentTaskId = String(taskId || '');
      if (_currentTaskId !== 'local' && _taskCards.local && !_taskCards[_currentTaskId]) {
        _taskCards[_currentTaskId] = _taskCards.local; delete _taskCards.local;
      }
      ensureTaskCard(_currentTaskId, title, podcastName);
      renderTaskQueue();
      startPolling(_currentTaskId);
      setPodcastDot(_currentTaskPodcastName || podcastName || selectedPodcast, 'var(--rust)', true);
    }

    function setPodcastDot(name, color, pulsing) {
      if (!name) return;
      document.querySelectorAll('.podcast-item').forEach(function (item) {
        if (item.dataset.name === name && item._statusDot) { item._statusDot.style.background = color; item._statusDot.classList.toggle('dot-pulse', Boolean(pulsing)); }
      });
    }

    function loadHistory() {
      return fetch(appUrl('/api/control/tasks'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (tasks) {
          _taskHistory = Array.isArray(tasks) ? tasks : [];
          var visibleTaskIds = {};
          var activeTaskIds = {};
          _taskHistory.forEach(function (task) {
            if (task.status === 'pending' || task.status === 'running') {
              visibleTaskIds[String(task.id)] = true;
              activeTaskIds[String(task.id)] = true;
              applyPublicTask(task);
              startPolling(task.id);
            } else if (task.status === 'failed' || task.status === 'cancelled') {
              visibleTaskIds[String(task.id)] = true;
              applyPublicTask(task);
            }
          });
          _taskPoller.watchedIds().forEach(function (id) {
            if (!activeTaskIds[id]) clearPolling(id);
          });
          Object.keys(_taskCards).forEach(function (id) {
            if (id !== 'local' && !visibleTaskIds[id] && _taskCards[id].status !== 'success') delete _taskCards[id];
          });
          renderTaskQueue();
          if (pageEpisodes.length) {
            // 任务结束会改变「未生成 / 待读」筛选与计数：静默重取当前页
            reloadEpisodePage();
            if (selectedEpisode) renderEpisodeInspector(selectedEpisode);
          }
        })
        .catch(function () {});
    }

    function renderLibrary(articles) {
      var list = byId('library-list');
      var query = String(byId('library-search').value || '').trim().toLowerCase();
      list.replaceChildren();
      var visible = (Array.isArray(articles) ? articles : []).filter(function (article) {
        var matchesQuery = !query || String(article.title || article.episode_title || '').toLowerCase().includes(query) || String(article.podcast_name || '').toLowerCase().includes(query);
        var read = isRead({ episode_id: article.episode_id, task_id: article.task_id });
        var matchesState = _libraryFilter === 'all' || (_libraryFilter === 'read' ? read : !read);
        return matchesQuery && matchesState;
      });
      if (!visible.length && query) {
        list.innerHTML = '<div class="library-empty">' + uiIcon('book-open') + '<strong>' + escapeHtml(t('library.empty_query')) + '</strong><span>' + escapeHtml(t('library.empty_query_hint')) + '</span></div>';
        return;
      }
      if (!visible.length) {
        list.innerHTML = '<div class="library-empty">' + uiIcon('book-open') + '<strong>' + escapeHtml(t('library.empty')) + '</strong><span>' + escapeHtml(t('library.empty_hint')) + '</span><div class="button-row"><button type="button" data-empty-mode="podcast">' + escapeHtml(t('library.view_subscriptions')) + '</button><button type="button" data-empty-mode="custom">' + escapeHtml(t('library.import_audio')) + '</button></div></div>';
        list.querySelectorAll('[data-empty-mode]').forEach(function (button) { button.addEventListener('click', function () { switchMode(button.dataset.emptyMode); }); });
        return;
      }
      visible.forEach(function (article, index) {
        var taskId = String(article.task_id || article.id || '');
        var item = document.createElement('article'); item.className = 'library-item'; item.style.setProperty('--item-index', index);
        var copy = document.createElement('div');
        var source = document.createElement('span'); source.className = 'library-source'; source.textContent = String(article.podcast_name || t('custom.local_audio'));
        var title = document.createElement('strong'); title.textContent = String(article.title || article.episode_title || t('episode.untitled'));
        var meta = document.createElement('span'); meta.textContent = new Date(article.updated_at || article.created_at).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
        copy.append(source, title, meta);
        var actions = document.createElement('div'); actions.className = 'library-actions';
        var read = document.createElement('button'); read.type = 'button'; read.className = 'episode-action'; read.textContent = t('library.read'); read.addEventListener('click', function () { openManuscript(taskId, null, article); });
        var download = document.createElement('a'); download.className = 'download-btn'; download.href = articleUrl(taskId, '/download'); download.download = ''; download.innerHTML = uiIcon('download');
        var dlText = document.createTextNode(t('library.download'));
        download.appendChild(dlText);
        actions.append(read, download); item.append(copy, actions); list.appendChild(item);
      });
    }

    function loadLibrary(articles) {
      if (Array.isArray(articles) && articles.length) { _libraryArticles = articles; renderLibrary(_libraryArticles); return Promise.resolve(_libraryArticles); }
      return fetch(browseApi('/articles?limit=200'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (data) { _libraryArticles = Array.isArray(data) ? data : []; renderLibrary(_libraryArticles); return _libraryArticles; })
        .catch(function (error) { addLog(t('library.load_failed') + errorMessage(error), 'warning'); });
    }

    var _toastState = {};
    function addLog(message, level) {
      var allowed = ['info', 'running', 'success', 'error', 'warning'];
      var safeLevel = allowed.indexOf(level) >= 0 ? level : 'info';
      var text = String(message == null ? '' : message);
      var key = safeLevel + '|' + text;
      var now = Date.now();
      if (_toastState[key] && now - _toastState[key].time < 2000) { _toastState[key].count += 1; _toastState[key].node.querySelector('.toast-copy').textContent = text + ' ×' + _toastState[key].count; _toastState[key].time = now; return; }
      var toast = document.createElement('div'); toast.className = 'toast toast-' + safeLevel; toast.setAttribute('role', safeLevel === 'error' ? 'alert' : 'status');
      var icon = document.createElement('span'); icon.className = 'toast-icon'; icon.innerHTML = uiIcon(safeLevel === 'success' ? 'check-circle' : (safeLevel === 'error' || safeLevel === 'warning') ? 'alert-circle' : 'info');
      var copy = document.createElement('span'); copy.className = 'toast-copy'; copy.textContent = text;
      var close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', t('toast.close')); close.innerHTML = uiIcon('close');
      close.addEventListener('click', function () { toast.remove(); delete _toastState[key]; }); toast.append(icon, copy, close); byId('toast-container').appendChild(toast);
      _toastState[key] = { node: toast, time: now, count: 1 };
      if (safeLevel === 'info' || safeLevel === 'running' || safeLevel === 'success') setTimeout(function () { if (toast.isConnected) toast.remove(); delete _toastState[key]; }, 4000);
    }

    function setTaskStatus(stage, progress, taskId, title, message) {
      var id = String(taskId || _currentTaskId || 'local');
      var task = ensureTaskCard(id, title);
      var normalizedStage = String(stage || 'queued').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(STAGE_LABELS, normalizedStage)) task.stage = normalizedStage;
      else if (!message) message = String(stage || '');
      task.progress = Math.max(0, Math.min(100, Number(progress) || 0));
      task.message = message || (task.progress >= 100 ? t('tasks.success_msg') : t('stage.' + task.stage));
      renderTaskQueue();
      if (pageEpisodes.length) renderEpisodeList();
      if (selectedEpisode) renderEpisodeInspector(selectedEpisode);
    }

    function setTaskBadge(type, text) {
      var task = ensureTaskCard(_currentTaskId || 'local'); task.status = type === 'success' ? 'success' : type === 'error' ? 'failed' : 'running'; task.message = text; renderTaskQueue();
    }
    function openDrawer() {
      _savedScrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + _savedScrollY + 'px';
      document.body.style.width = '100%';
      byId('drawer').classList.add('is-open'); byId('drawer-overlay').classList.add('is-open'); byId('drawer').setAttribute('aria-hidden', 'false'); document.body.classList.add('overlay-open');
      setTimeout(function () { byId('drawer-search').focus(); }, 180);
    }
    function closeDrawer() {
      byId('drawer').classList.remove('is-open'); byId('drawer-overlay').classList.remove('is-open'); byId('drawer').setAttribute('aria-hidden', 'true'); document.body.classList.remove('overlay-open'); clearDrawerState();
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _savedScrollY);
    }
    function clearDrawerState() {
      clearTimeout(_drawerSearchTimer);
      _drawerSearchSeq += 1;
      byId('drawer-search').value = '';
      byId('drawer-results').replaceChildren();
    }
    function onDrawerSearch(value) {
      clearTimeout(_drawerSearchTimer);
      var seq = ++_drawerSearchSeq;
      var query = value.trim();
      if (!query) { byId('drawer-results').replaceChildren(); return; }
      byId('drawer-results').textContent = /^https?:\/\//i.test(query) ? t('drawer.identifying') : t('drawer.searching');
      // 200ms debounce：比原来的 420ms 明显更快给出结果，同时保留防抖语义。
      _drawerSearchTimer = setTimeout(function () {
        if (seq !== _drawerSearchSeq) return;
        if (/^https?:\/\//i.test(query)) renderRssCandidate(query);
        else fetchSearchResults(query, seq);
      }, 200);
    }
    function renderRssCandidate(url) {
      var results = byId('drawer-results'); results.replaceChildren();
      var item = document.createElement('div'); item.className = 'search-result rss-candidate';
      var copy = document.createElement('span'); copy.style.minWidth = '0';
      var name = document.createElement('span'); name.className = 'result-name'; name.textContent = t('drawer.rss_feed');
      var meta = document.createElement('span'); meta.className = 'result-meta'; meta.textContent = url;
      copy.append(name, meta);
      var subscribe = document.createElement('button'); subscribe.type = 'button'; subscribe.className = 'solid-btn'; subscribe.textContent = t('drawer.subscribe');
      subscribe.addEventListener('click', function () { confirmAddPodcast('', url, '', subscribe); });
      item.append(copy, subscribe); results.appendChild(item);
    }
    function fetchSearchResults(query, seq) {
      // stale-result 保护：输入变化、切换 RSS 候选或关闭抽屉都会推进序号，
      // 只有当前输入对应的请求允许渲染结果。
      var requestSeq = seq == null ? ++_drawerSearchSeq : seq;
      fetch(browseApi('/search/podcast?q=' + encodeURIComponent(query)))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (items) { if (requestSeq !== _drawerSearchSeq) return; renderSearchResults(Array.isArray(items) ? items : []); })
        .catch(function () { if (requestSeq !== _drawerSearchSeq) return; renderSearchResults([]); });
    }
    function renderSearchResults(items) {
      var results = byId('drawer-results'); results.replaceChildren();
      if (!items.length) {
        var empty = document.createElement('div'); empty.className = 'empty-state'; empty.style.minHeight = '180px';
        var emptyIcon = document.createElement('span'); emptyIcon.className = 'empty-state-icon'; emptyIcon.innerHTML = uiIcon('search'); empty.appendChild(emptyIcon);
        var message = document.createElement('div'); message.innerHTML = '<strong>' + escapeHtml(t('drawer.no_matches')) + '</strong><br><span>' + escapeHtml(t('drawer.no_matches_hint')) + '</span>';
        empty.appendChild(message); results.appendChild(empty); return;
      }
      items.forEach(function (podcast, index) {
        var item = document.createElement('div'); item.className = 'search-result'; item.style.setProperty('--item-index', index);
        var monogram = makeArtworkTile(artworkUrl(podcast.image), podcast.name, 'result-monogram');
        var copy = document.createElement('span'); copy.style.minWidth = '0';
        var name = document.createElement('span'); name.className = 'result-name'; name.style.display = 'block'; name.textContent = String(podcast.name || t('drawer.untitled_podcast'));
        var meta = document.createElement('span'); meta.className = 'result-meta'; meta.style.display = 'block'; meta.textContent = [podcast.artist, podcast.genre, podcast.track_count ? podcast.track_count + t('drawer.episodes_count') : ''].filter(Boolean).join(' · ');
        copy.append(name, meta);
        var subscribe = document.createElement('button'); subscribe.type = 'button'; subscribe.className = 'solid-btn'; subscribe.textContent = t('drawer.subscribe');
        subscribe.addEventListener('click', function () { confirmAddPodcast(String(podcast.name || ''), String(podcast.rss_url || ''), String(podcast.image || ''), subscribe); });
        item.append(monogram, copy, subscribe); results.appendChild(item);
      });
    }
    function confirmAddPodcast(name, rssUrl, image, sourceButton) {
      var cleanName = String(name || '').trim(); var cleanUrl = String(rssUrl || '').trim();
      if (!cleanUrl) { addLog(t('drawer.invalid_rss'), 'error'); return; }
      if (!requireControl('subscribe')) return;
      if (sourceButton) sourceButton.disabled = true;
      addLog(t('drawer.subscribing'), 'running');
      fetch(appUrl('/api/control/subscriptions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cleanName, rss_url: cleanUrl, image: String(image || '') }) })
        .then(readApiResponse)
        .then(function (data) { addLog(t('drawer.subscribed_log', String(data.name || cleanName || t('drawer.new_podcast'))), 'success'); closeDrawer(); loadSubscriptions(); })
        .catch(function (error) { addLog(t('drawer.add_failed') + errorMessage(error), 'error'); })
        .finally(function () { if (sourceButton) sourceButton.disabled = false; });
    }

    var _tocObserver = null;
    var _lastReaderText = '';

    function updateReaderStats(rawText) {
      if (rawText !== undefined) _lastReaderText = rawText;
      var textToUse = rawText !== undefined ? rawText : _lastReaderText;
      var withoutFrontmatter = String(textToUse || '').replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, '');
      var statsEl = byId('reader-meta-stats');
      if (!statsEl) return;
      var clean = withoutFrontmatter.trim();
      if (!clean) { statsEl.textContent = ''; return; }

      // 按稿件内容本身判定中文字符计数还是西文词数，而非按 UI 语言
      var sample = clean.slice(0, 20000);
      var cjkMatches = sample.match(/[\u4e00-\u9fa5\u3400-\u4dbf\uf900-\ufaff]/g);
      var cjkCount = cjkMatches ? cjkMatches.length : 0;
      var latinMatches = sample.match(/[a-zA-Z]/g);
      var latinCount = latinMatches ? latinMatches.length : 0;
      var isCJK = cjkCount >= 20 || (cjkCount > 0 && cjkCount >= latinCount * 0.1);

      if (isCJK) {
        var charCount = clean.replace(/\s+/g, '').length;
        var minutes = Math.max(1, Math.round(charCount / 750));
        var countStr = (getLocale() === 'en')
          ? (charCount >= 1000 ? t('reader.characters_large', (charCount / 1000).toFixed(1)) : t('reader.characters', charCount))
          : (charCount >= 10000 ? t('reader.characters_large', (charCount / 10000).toFixed(1)) : t('reader.characters', charCount));
        statsEl.textContent = charCount ? (countStr + ' · ' + t('reader.est_time', minutes)) : '';
      } else {
        var words = clean.split(/\s+/).filter(Boolean).length;
        var minutes = Math.max(1, Math.round(words / 220));
        var countStr = words >= 1000
          ? t('reader.word_count_large', (words / 1000).toFixed(1))
          : t('reader.word_count', words);
        statsEl.textContent = words ? (countStr + ' · ' + t('reader.est_time', minutes)) : '';
      }
    }

    function updateReaderProgress(percent) {
      var bounded = Math.min(100, Math.max(0, Number(percent) || 0));
      var rounded = Math.round(bounded);
      var progressRange = byId('reader-progress-range');
      var progressValue = byId('reader-progress-value');
      if (progressRange) progressRange.value = String(bounded);
      if (progressValue) progressValue.textContent = rounded + '%';

      var sheetProgressRange = byId('reader-sheet-progress-range');
      var sheetProgressVal = byId('reader-sheet-progress-val');
      if (sheetProgressRange) sheetProgressRange.value = String(bounded);
      if (sheetProgressVal) sheetProgressVal.textContent = rounded + '%';

      var barProgressLabel = byId('reader-bar-progress-label');
      if (barProgressLabel) barProgressLabel.textContent = t('reader.progress_val', rounded);

      if (bounded >= 99.5 && _currentReadingRef && !isRead(_currentReadingRef)) {
        setRead(_currentReadingRef, true);
      }
    }

    function setupTocScrollSpy(headings, tocLinks) {
      if (_tocObserver) {
        _tocObserver.disconnect();
        _tocObserver = null;
      }
      if (!('IntersectionObserver' in window) || !headings.length) return;

      _tocObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var id = entry.target.id;
            tocLinks.forEach(function (link) {
              var isMatch = link.getAttribute('data-target-id') === id;
              link.classList.toggle('active', isMatch);
              if (isMatch) {
                link.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }
            });
          }
        });
      }, {
        root: byId('manuscript-body'),
        rootMargin: '-5% 0px -75% 0px',
        threshold: 0
      });

      headings.forEach(function (heading) {
        _tocObserver.observe(heading);
      });
    }

    function stripOpeningOutline(markdown) {
      if (markdown == null) return '';
      var raw = String(markdown).replace(/\r\n?/g, '\n');
      var frontmatter = '';
      var body = raw;
      var fmMatch = raw.match(/^(\s*---\s*\n[\s\S]*?\n---\s*\n*)/);
      if (fmMatch) {
        frontmatter = fmMatch[1];
        body = raw.slice(frontmatter.length);
      }

      var leadingWsMatch = body.match(/^\s*/);
      var leadingWs = leadingWsMatch ? leadingWsMatch[0] : '';
      var content = body.slice(leadingWs.length);

      var headingMatch = content.match(/^#{1,6}\s+(?:[📌⏱️🕒]\s*)?(?:节目大纲与时间线|(?:Episode\s+)?Outline\s*(?:&|and)\s*Timeline|Timeline\s*(?:&|and)\s*Outline)\s*[:：]?[^\S\n]*(?:\n|$)/iu);
      if (!headingMatch) return raw;

      var rest = content.slice(headingMatch[0].length);

      var nextHeadingMatch = rest.match(/(?:^|\n)(#{1,6}\s+[^\n]+)/);
      if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
        var nextHeadingIndex = nextHeadingMatch.index === 0 ? 0 : nextHeadingMatch.index + 1;
        return frontmatter + rest.slice(nextHeadingIndex);
      }

      var hrMatch = rest.match(/(?:^|\n)\s*(?:---|\*\*\*|___)\s*\n*/);
      if (hrMatch && hrMatch.index !== undefined) {
        var afterHr = hrMatch.index + hrMatch[0].length;
        return frontmatter + rest.slice(afterHr);
      }

      var lines = rest.split('\n');
      var firstNonListIndex = -1;
      for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (/^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed) || /^>\s*/.test(trimmed)) continue;
        firstNonListIndex = i;
        break;
      }
      if (firstNonListIndex !== -1) {
        return frontmatter + lines.slice(firstNonListIndex).join('\n');
      }

      return frontmatter;
    }

    function renderBasicMarkdown(markdown) {
      if (markdown == null) return '';
      var raw = stripOpeningOutline(markdown);
      raw = String(raw).replace(/\r\n?/g, '\n');
      raw = raw.replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, '');
      var codeBlocks = [];
      raw = raw.replace(/```(\w*)\n([\s\S]*?)```/g, function (match, lang, code) {
        var placeholder = '<!--CODEBLOCK' + codeBlocks.length + '-->';
        codeBlocks.push({ lang: lang, code: code });
        return placeholder;
      });
      var lines = raw.split('\n');
      var html = [];
      var paragraph = [];
      var listType = null;
      function flushParagraph() {
        if (paragraph.length) {
          var text = paragraph.join('\n');
          text = parseInline(text);
          html.push('<p>' + text + '</p>');
          paragraph = [];
        }
      }
      function closeList() {
        if (listType) {
          html.push('</' + listType + '>');
          listType = null;
        }
      }
      function parseInline(text) {
        var escaped = escapeHtml(text);
        escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        escaped = escaped.replace(/_([^_]+)_/g, '<em>$1</em>');
        escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
        var SAFE_LINK = /^(?:https?:|mailto:|#|\/)/i;
        escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (match, text, url) {
          var target = url.trim();
          return SAFE_LINK.test(target)
            ? '<a href="' + target + '" target="_blank" rel="noopener">' + text + '</a>'
            : text;
        });
        // 说话人 Pill Badge 微勋章美化转换
        escaped = escaped.replace(/<strong>([^<]+)<\/strong>(\s*[:：])/g, '<span class="speaker-tag">$1</span>$2');
        escaped = escaped.replace(/\n/g, '<br>');
        return escaped;
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmed = line.trim();
        if (trimmed.indexOf('<!--CODEBLOCK') === 0 && trimmed.indexOf('-->') > 0) {
          flushParagraph();
          closeList();
          var idx = parseInt(trimmed.match(/\d+/)[0], 10);
          var block = codeBlocks[idx];
          if (!block) {
            paragraph.push(line);
            continue;
          }
          html.push('<pre><code class="language-' + escapeHtml(block.lang) + '">' + escapeHtml(block.code) + '</code></pre>');
          continue;
        }
        var heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
          flushParagraph();
          closeList();
          var level = heading[1].length;
          html.push('<h' + level + '>' + parseInline(heading[2]) + '</h' + level + '>');
          continue;
        }
        var hr = /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line);
        if (hr) {
          flushParagraph();
          closeList();
          html.push('<hr>');
          continue;
        }
        var quote = line.match(/^\s*>\s?(.*)$/);
        if (quote) {
          flushParagraph();
          closeList();
          html.push('<blockquote>' + parseInline(quote[1]) + '</blockquote>');
          continue;
        }
        var unordered = line.match(/^\s*[-*+]\s+(.+)$/);
        var ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
        if (unordered || ordered) {
          flushParagraph();
          var requiredType = unordered ? 'ul' : 'ol';
          if (listType !== requiredType) {
            closeList();
            listType = requiredType;
            html.push('<' + listType + '>');
          }
          if (unordered) {
            html.push('<li>' + parseInline(unordered[1]) + '</li>');
          } else {
            html.push('<li value="' + ordered[1] + '">' + parseInline(ordered[2]) + '</li>');
          }
          continue;
        }
        if (!trimmed) {
          flushParagraph();
          closeList();
          continue;
        }
        closeList();
        paragraph.push(line);
      }
      flushParagraph();
      closeList();
      var finalHtml = html.join('\n');
      for (var k = 0; k < codeBlocks.length; k++) {
        var placeholderPattern = new RegExp('<!--CODEBLOCK' + k + '-->', 'g');
        finalHtml = finalHtml.replace(placeholderPattern, '<pre><code class="language-' + escapeHtml(codeBlocks[k].lang) + '">' + escapeHtml(codeBlocks[k].code) + '</code></pre>');
      }
      return finalHtml;
    }

    function setFontSize(size, skipSave) {
      _currentFontSize = Math.max(14, Math.min(28, size));
      var body = byId('manuscript-body');
      if (body) body.style.fontSize = _currentFontSize + 'px';
      var indicator = byId('font-size-val');
      if (indicator) indicator.textContent = String(_currentFontSize);
      if (!skipSave) savePreference('font_size', _currentFontSize);
    }

    function setTheme(theme, skipSave) {
      _currentTheme = theme;
      var normalizedTheme = theme === 'light' ? 'paper' : theme;
      var reader = document.getElementById('manuscript-reader');
      if (reader) reader.dataset.readerTheme = normalizedTheme;
      document.querySelectorAll('.theme-picker [data-theme]').forEach(function (btn) {
        var isMatch = btn.dataset.theme === normalizedTheme || (normalizedTheme === 'paper' && btn.id === 'theme-light-btn');
        btn.classList.toggle('active', isMatch);
      });
      if (!skipSave) savePreference('reader_theme', theme);
    }

    function setFontPreset(preset, skipSave) {
      _currentFontPreset = preset === 'modern' ? 'modern' : 'classical';
      var reader = document.getElementById('manuscript-reader');
      if (reader) reader.dataset.readerFont = _currentFontPreset;
      document.querySelectorAll('[data-preset]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.preset === _currentFontPreset);
      });
      if (!skipSave) savePreference('font_preset', _currentFontPreset);
    }

    function setLineHeight(leading, skipSave) {
      _currentLineHeight = (leading === 'compact' || leading === 'relaxed') ? leading : 'normal';
      var reader = document.getElementById('manuscript-reader');
      if (reader) reader.dataset.readerLeading = _currentLineHeight;
      document.querySelectorAll('[data-leading]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.leading === _currentLineHeight);
      });
      if (!skipSave) savePreference('line_height', _currentLineHeight);
    }

    function applyReaderPreferences(prefs) {
      var source = prefs || _cloudPrefs || {};
      if (source.reader_theme) setTheme(source.reader_theme, true);
      else if (source.readerTheme) setTheme(source.readerTheme, true);
      if (source.font_preset) setFontPreset(source.font_preset, true);
      else if (source.fontPreset) setFontPreset(source.fontPreset, true);
      if (source.font_size) setFontSize(source.font_size, true);
      else if (source.fontSize) setFontSize(source.fontSize, true);
      if (source.line_height) setLineHeight(source.line_height, true);
      else if (source.lineHeight) setLineHeight(source.lineHeight, true);
    }

    function closeReaderSheets() {
      var toc = byId('reader-toc');
      if (toc) toc.classList.remove('is-open');
      var progressSheet = byId('reader-progress-sheet');
      if (progressSheet) progressSheet.classList.remove('is-open');
      var backdrop = byId('reader-sheet-backdrop');
      if (backdrop) backdrop.classList.remove('is-open');
      var appearanceMenu = byId('reader-appearance-menu');
      if (appearanceMenu) appearanceMenu.removeAttribute('open');
      document.querySelectorAll('.reader-bar-btn').forEach(function (btn) {
        btn.classList.remove('active');
      });
    }

    function restoreScroll(element, targetScrollTop, retries) {
      if (retries <= 0) return;
      element.scrollTop = targetScrollTop;
      if (Math.abs(element.scrollTop - targetScrollTop) > 2) {
        setTimeout(function() {
          restoreScroll(element, targetScrollTop, retries - 1);
        }, 50);
      }
    }

    function openManuscript(taskId, episode, article) {
      var cleanId = String(taskId || '').trim();
      if (!cleanId) return;
      closeEpisodeSummary();
      closeReaderSheets();
      _currentReadingTaskId = cleanId;
      var task = _taskHistory.find(function (item) { return String(item.id) === cleanId; });
      // 已读身份：来自单集用 episode_id；来自任务 / 稿件时优先其 episode_id，导入音频则用稿件的 task_id
      var source = task || article;
      _currentReadingRef = episode ? episodeReadRef(episode) : { episode_id: source && source.episode_id ? String(source.episode_id) : null, task_id: cleanId };
      var title = (task && task.episode_title) || (article && article.title) || '';
      byId('reader-title').textContent = title ? String(title) : t('reader.title');
      byId('reader-download').href = articleUrl(cleanId, '/download');
      updateReaderReadState();
      
      var tocContainer = byId('reader-toc');
      setHidden(tocContainer, true);
      tocContainer.replaceChildren();
      byId('manuscript-body').innerHTML = '<div class="reader-state reader-loading">' + escapeHtml(t('reader.loading')) + '</div>';
      
      var progressRange = byId('reader-progress-range');
      var progressValue = byId('reader-progress-value');
      if (progressRange) progressRange.value = '0';
      if (progressValue) progressValue.textContent = '0%';
      _lastReaderScrollTop = 0;
      document.querySelector('.reader-sheet').classList.remove('reader-head-collapsed');
      
      _savedScrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + _savedScrollY + 'px';
      document.body.style.width = '100%';
      
      byId('manuscript-reader').classList.add('is-open'); 
      byId('reader-overlay').classList.add('is-open'); 
      byId('manuscript-reader').setAttribute('aria-hidden', 'false'); 
      document.body.classList.add('overlay-open');
      
      applyReaderPreferences();

      fetch(articleUrl(cleanId, '/content'))
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            var contentType = response.headers.get('content-type') || '';
            if (contentType.indexOf('application/json') >= 0) {
              var data = JSON.parse(raw);
              return { content: data.content || data.markdown || data.text || '', title: data.title || '' };
            }
            return { content: raw, title: '' };
          });
        })
        .then(function (result) {
          if (result.title) byId('reader-title').textContent = String(result.title);
          if (!result.content) { 
            byId('manuscript-body').innerHTML = '<div class="reader-state">' + escapeHtml(t('reader.empty_content')) + '</div>'; 
            updateReaderStats('');
            return; 
          }
          
          var presentationContent = stripOpeningOutline(result.content);
          updateReaderStats(presentationContent);
          var renderedHtml = renderBasicMarkdown(presentationContent);
          byId('manuscript-body').innerHTML = renderedHtml;
          
          var headings = byId('manuscript-body').querySelectorAll('h1, h2, h3');
          var tocLinks = [];
          if (headings.length > 0) {
            var tocHead = document.createElement('div');
            tocHead.className = 'reader-sheet-head reader-toc-sheet-head';
            var tocTitle = document.createElement('h3');
            tocTitle.textContent = t('reader.toc_label');
            tocHead.appendChild(tocTitle);
            var tocCloseBtn = document.createElement('button');
            tocCloseBtn.className = 'close-btn reader-sheet-close';
            tocCloseBtn.type = 'button';
            tocCloseBtn.setAttribute('aria-label', t('reader.close_toc'));
            tocCloseBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
            tocCloseBtn.addEventListener('click', closeReaderSheets);
            tocHead.appendChild(tocCloseBtn);
            tocContainer.appendChild(tocHead);
            
            var tocList = document.createElement('ul');
            tocList.className = 'toc-list';
            
            headings.forEach(function (heading, idx) {
              var id = 'heading-' + idx;
              heading.id = id;
              
              var li = document.createElement('li');
              var a = document.createElement('a');
              a.className = 'toc-item level-' + heading.tagName.substring(1);
              a.textContent = heading.textContent;
              a.setAttribute('data-target-id', id);
              a.addEventListener('click', function () {
                if (window.innerWidth <= 780) closeReaderSheets();
                heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
              });
              tocLinks.push(a);
              li.appendChild(a);
              tocList.appendChild(li);
            });
            tocContainer.appendChild(tocList);
            setupTocScrollSpy(headings, tocLinks);
          }
          // 侧栏同时承载大纲与关键概念，任一存在就展开。
          renderConceptsSection(cleanId, tocContainer);
          setHidden(tocContainer, false);

          // 阅读位置只在控制模式记忆；公开浏览每次从头开始，不保存任何读者状态。
          var saved = IS_MANAGE ? localStorage.getItem('scroll_pos_' + cleanId) : null;
          if (saved) {
            var savedTop = parseInt(saved, 10) || 0;
            restoreScroll(byId('manuscript-body'), savedTop, 10);
            var savedTotal = Math.max(0, byId('manuscript-body').scrollHeight - byId('manuscript-body').clientHeight);
            updateReaderProgress(savedTotal > 0 ? savedTop / savedTotal * 100 : 100);
          } else {
            byId('manuscript-body').scrollTop = 0;
            var initialTotal = Math.max(0, byId('manuscript-body').scrollHeight - byId('manuscript-body').clientHeight);
            updateReaderProgress(initialTotal > 0 ? 0 : 100);
          }
        })
        .catch(function (error) { 
          byId('manuscript-body').replaceChildren(); 
          var state = document.createElement('div'); 
          state.className = 'reader-state'; 
          state.textContent = t('reader.load_failed') + errorMessage(error); 
          byId('manuscript-body').appendChild(state); 
          updateReaderStats('');
        });
    }

    // ── 关键概念 → 维基百科 ────────────────────────────────
    // 打开稿件即自动抽取一次（结果由后端按稿件缓存，重复打开不重算）；
    // 侧栏列出完整清单，同时把每个概念在正文中的首次出现原地变成可点的维基百科链接。

    function renderConceptsSection(taskId, container) {

      var section = document.createElement('div');
      section.className = 'concepts-section';

      var title = document.createElement('h3');
      title.textContent = t('concepts.title');
      section.appendChild(title);

      var body = document.createElement('div');
      body.className = 'concepts-body';
      section.appendChild(body);

      container.appendChild(section);
      loadConcepts(taskId, body);
    }

    // 公开浏览没有可展示的概念时不留空壳：移除整个区块，侧栏空了就一并收起。
    function removeConceptsSection(body) {
      var section = body.closest('.concepts-section');
      var sidebar = section && section.parentElement;
      if (section) section.remove();
      if (sidebar && !sidebar.children.length) setHidden(sidebar, true);
    }

    function loadConcepts(taskId, body) {
      body.replaceChildren();
      var loading = document.createElement('div');
      loading.className = 'concepts-empty';
      loading.textContent = IS_MANAGE ? t('concepts.extracting') : t('concepts.reading');
      body.appendChild(loading);

      // 控制模式按需抽取（会调用模型并写缓存）；公开浏览只读取已缓存的结果。
      var lang = getLocale() === 'en' ? 'en' : 'zh';
      var suffix = lang === 'en' ? '/concepts?lang=en' : '/concepts';
      var request = IS_MANAGE
        ? fetch(safeTaskUrl(taskId, suffix), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
        : fetch(articleUrl(taskId, suffix));
      request
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) {
              var detail = raw;
              try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {}
              throw new Error(detail || 'HTTP ' + response.status);
            }
            return JSON.parse(raw);
          });
        })
        .then(function (data) {
          var concepts = (data && data.concepts) || [];
          body.replaceChildren();
          if (!concepts.length && !IS_MANAGE) {
            removeConceptsSection(body);
            return;
          }
          if (!concepts.length) {
            var empty = document.createElement('div');
            empty.className = 'concepts-empty';
            empty.textContent = t('concepts.empty');
            body.appendChild(empty);
            return;
          }
          var list = document.createElement('ul');
          list.className = 'concepts-list';
          concepts.forEach(function (concept) {
            var li = document.createElement('li');

            var link = document.createElement('a');
            link.className = 'concept-link';
            link.href = String(concept.url || '');
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = String(concept.term || '');
            // 词条标题与提名词不同时（重定向/异语言）标出来，避免读者以为点错了。
            var resolved = String(concept.wikipedia_title || '');
            if (resolved && resolved !== String(concept.term || '')) {
              var alias = document.createElement('span');
              alias.className = 'concept-alias';
              alias.textContent = '· ' + resolved;
              link.appendChild(alias);
            }
            li.appendChild(link);

            var summary = String(concept.summary || '');
            if (summary) {
              var desc = document.createElement('div');
              desc.className = 'concept-summary';
              desc.textContent = summary;
              li.appendChild(desc);
            }
            list.appendChild(li);
          });
          body.appendChild(list);

          linkifyManuscriptConcepts(concepts);
        })
        .catch(function (error) {
          body.replaceChildren();
          if (!IS_MANAGE) {
            removeConceptsSection(body);
            return;
          }
          var failed = document.createElement('div');
          failed.className = 'concepts-empty';
          failed.textContent = t('concepts.failed') + errorMessage(error);
          body.appendChild(failed);
          var retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'concepts-load-btn';
          retry.textContent = t('concepts.retry');
          retry.addEventListener('click', function () { loadConcepts(taskId, body); });
          body.appendChild(retry);
        });
    }

    // 把已核对的关键概念在正文里原地变成可点的维基百科链接：每个概念只链接
    // 第一次出现（避免满屏都是下划线），按词长降序处理，防止短词（如「AI」）
    // 抢在长词（如「OpenAI」）前面把它从中间截断。
    function linkifyManuscriptConcepts(concepts) {
      var root = byId('manuscript-body');
      if (!root) return;
      (concepts || [])
        .map(function (c) { return { term: String(c.term || '').trim(), url: String(c.url || '').trim() }; })
        .filter(function (c) { return c.term && c.url; })
        .sort(function (a, b) { return b.term.length - a.term.length; })
        .forEach(function (c) { linkifyFirstOccurrence(root, c.term, c.url); });
    }

    function isAsciiAlnum(ch) {
      return !!ch && /[A-Za-z0-9]/.test(ch);
    }

    // 只在词边界处匹配：纯子串查找会把「OpenAI」里的「AI」错误地单独截出来。
    function findTermStart(text, term) {
      var from = 0;
      while (true) {
        var idx = text.indexOf(term, from);
        if (idx === -1) return -1;
        var before = idx > 0 ? text[idx - 1] : '';
        var after = idx + term.length < text.length ? text[idx + term.length] : '';
        var okBefore = !isAsciiAlnum(term[0]) || !isAsciiAlnum(before);
        var okAfter = !isAsciiAlnum(term[term.length - 1]) || !isAsciiAlnum(after);
        if (okBefore && okAfter) return idx;
        from = idx + 1;
      }
    }

    function linkifyFirstOccurrence(root, term, url) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.nodeValue || findTermStart(node.nodeValue, term) === -1) return NodeFilter.FILTER_SKIP;
          if (node.parentElement && node.parentElement.closest('a')) return NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var node = walker.nextNode();
      if (!node) return;
      var idx = findTermStart(node.nodeValue, term);
      var match = node.splitText(idx);
      match.splitText(term.length);
      var link = document.createElement('a');
      link.className = 'concept-inline-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = t('concepts.wiki_title');
      link.textContent = match.nodeValue;
      match.parentNode.replaceChild(link, match);
    }

    function closeManuscript() {
      _currentReadingTaskId = null;
      _currentReadingRef = null;
      updateReaderReadState();
      if (_tocObserver) {
        _tocObserver.disconnect();
        _tocObserver = null;
      }
      closeReaderSheets();
      byId('manuscript-reader').classList.remove('is-open'); 
      byId('reader-overlay').classList.remove('is-open'); 
      byId('manuscript-reader').setAttribute('aria-hidden', 'true'); 
      document.body.classList.remove('overlay-open');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _savedScrollY);
    }

    byId('tab-podcast').addEventListener('click', function () { switchMode('podcast'); });
    byId('tab-custom').addEventListener('click', function () { switchMode('custom'); });
    byId('tab-library').addEventListener('click', function () { switchMode('library'); });
    byId('prompt-template-select').addEventListener('change', function () { applyPromptTemplate(this.value); });
    byId('custom-submit-btn').addEventListener('click', submitCustomTask);
    byId('episode-search').addEventListener('input', onEpisodeSearch);
    byId('library-search').addEventListener('input', function () { renderLibrary(_libraryArticles); });
    document.querySelectorAll('[data-library-filter]').forEach(function (button) {
      button.addEventListener('click', function () {
        _libraryFilter = button.dataset.libraryFilter || 'all';
        document.querySelectorAll('[data-library-filter]').forEach(function (item) { item.classList.toggle('active', item === button); });
        renderLibrary(_libraryArticles);
      });
    });
    document.querySelectorAll('.mobile-nav [data-mode]').forEach(function (button) { button.addEventListener('click', function () { switchMode(button.dataset.mode); }); });
    function setTaskPanel(open) {
      byId('task-panel').classList.toggle('is-open', open);
      byId('task-panel-overlay').classList.toggle('is-open', open);
      byId('task-panel').setAttribute('aria-hidden', String(!open));
      document.body.classList.toggle('overlay-open', open);
    }
    byId('task-panel-btn').addEventListener('click', function () { setTaskPanel(true); });
    byId('task-panel-close').addEventListener('click', function () { setTaskPanel(false); });
    byId('task-panel-overlay').addEventListener('click', function () { setTaskPanel(false); });
    byId('filter-all').addEventListener('click', function () { setFilter('all'); });
    byId('filter-readable').addEventListener('click', function () { setFilter('readable'); });
    byId('filter-unread').addEventListener('click', function () { setFilter('unread'); });
    byId('filter-read').addEventListener('click', function () { setFilter('read'); });
    byId('page-prev').addEventListener('click', function () { goToEpisodePage(currentPage - 1); });
    byId('page-next').addEventListener('click', function () { goToEpisodePage(currentPage + 1); });
    
    // Font controls
    byId('font-dec-btn').addEventListener('click', function () { setFontSize(_currentFontSize - 1); });
    byId('font-inc-btn').addEventListener('click', function () { setFontSize(_currentFontSize + 1); });
    byId('font-preset-classical').addEventListener('click', function () { setFontPreset('classical'); });
    byId('font-preset-modern').addEventListener('click', function () { setFontPreset('modern'); });
    
    // Theme controls
    byId('theme-follow-btn').addEventListener('click', function () { setTheme('follow'); });
    byId('theme-light-btn').addEventListener('click', function () { setTheme('paper'); });
    byId('theme-warm-btn').addEventListener('click', function () { setTheme('warm'); });
    byId('theme-green-btn').addEventListener('click', function () { setTheme('green'); });
    byId('theme-dark-btn').addEventListener('click', function () { setTheme('dark'); });

    // Leading controls
    byId('leading-compact-btn').addEventListener('click', function () { setLineHeight('compact'); });
    byId('leading-normal-btn').addEventListener('click', function () { setLineHeight('normal'); });
    byId('leading-relaxed-btn').addEventListener('click', function () { setLineHeight('relaxed'); });

    // Reader TOC toggle
    byId('reader-toc-toggle-btn').addEventListener('click', function () {
      var toc = byId('reader-toc');
      if (window.innerWidth <= 780) {
        var isOpen = toc.classList.toggle('is-open');
        byId('reader-sheet-backdrop').classList.toggle('is-open', isOpen);
      } else {
        var isHidden = toc.hasAttribute('hidden');
        setHidden(toc, !isHidden);
        this.classList.toggle('active', isHidden);
      }
    });

    // Mobile bottom bar
    byId('reader-bar-toc-btn').addEventListener('click', function () {
      var toc = byId('reader-toc');
      var willOpen = !toc.classList.contains('is-open');
      closeReaderSheets();
      if (willOpen) {
        toc.classList.add('is-open');
        byId('reader-sheet-backdrop').classList.add('is-open');
        this.classList.add('active');
      }
    });
    byId('reader-bar-progress-btn').addEventListener('click', function () {
      var sheet = byId('reader-progress-sheet');
      var willOpen = !sheet.classList.contains('is-open');
      closeReaderSheets();
      if (willOpen) {
        sheet.classList.add('is-open');
        byId('reader-sheet-backdrop').classList.add('is-open');
        this.classList.add('active');
      }
    });
    byId('reader-bar-appearance-btn').addEventListener('click', function () {
      var menu = byId('reader-appearance-menu');
      var willOpen = !menu.hasAttribute('open');
      closeReaderSheets();
      if (willOpen) {
        menu.setAttribute('open', '');
        byId('reader-sheet-backdrop').classList.add('is-open');
        this.classList.add('active');
      }
    });

    // Mobile sheet controls
    byId('reader-sheet-backdrop').addEventListener('click', closeReaderSheets);
    byId('reader-progress-sheet-close').addEventListener('click', closeReaderSheets);
    byId('reader-sheet-progress-range').addEventListener('input', function () {
      var body = byId('manuscript-body');
      var totalScroll = Math.max(0, body.scrollHeight - body.clientHeight);
      var percent = Math.min(100, Math.max(0, Number(this.value) || 0));
      body.scrollTop = totalScroll * percent / 100;
      updateReaderProgress(percent);
    });
    byId('reader-jump-start-btn').addEventListener('click', function () {
      byId('manuscript-body').scrollTop = 0;
      updateReaderProgress(0);
    });
    byId('reader-jump-end-btn').addEventListener('click', function () {
      var body = byId('manuscript-body');
      body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
      updateReaderProgress(100);
    });

    // 滚动热路径：用单个 requestAnimationFrame 每帧合并一次视觉更新，
    // 并缓存静态 DOM 引用（.reader-sheet 不随滚动变化）；帧内先读布局再写样式，
    // 避免写后读造成强制重排。持久化（控制模式）保持独立的 150ms 节流，语义不变。
    var _readerSheetEl = document.querySelector('.reader-sheet');
    var _readerScrollFrame = 0;
    var _scrollThrottleTimer = null;
    byId('manuscript-body').addEventListener('scroll', function () {
      var self = this;
      if (_readerScrollFrame) return;
      _readerScrollFrame = requestAnimationFrame(function () {
        _readerScrollFrame = 0;
        var top = self.scrollTop;
        var delta = top - _lastReaderScrollTop;
        if (top <= 12 || delta < -8) _readerSheetEl.classList.remove('reader-head-collapsed');
        else if (delta > 8 && top > 56) _readerSheetEl.classList.add('reader-head-collapsed');
        _lastReaderScrollTop = top;

        var totalScroll = self.scrollHeight - self.clientHeight;
        var percent = totalScroll > 0 ? (top / totalScroll * 100) : (self.scrollHeight > 0 ? 100 : 0);
        updateReaderProgress(percent);

        if (!_currentReadingTaskId || !IS_MANAGE) return;
        if (_scrollThrottleTimer) return;
        _scrollThrottleTimer = setTimeout(function () {
          localStorage.setItem('scroll_pos_' + _currentReadingTaskId, self.scrollTop);
          _scrollThrottleTimer = null;
        }, 150);
      });
    });
    byId('reader-progress-range').addEventListener('input', function () {
      var body = byId('manuscript-body');
      var totalScroll = Math.max(0, body.scrollHeight - body.clientHeight);
      var percent = Math.min(100, Math.max(0, Number(this.value) || 0));
      body.scrollTop = totalScroll * percent / 100;
      updateReaderProgress(percent);
    });
    byId('reader-read-toggle').addEventListener('click', function () {
      if (_currentReadingRef) setRead(_currentReadingRef, !isRead(_currentReadingRef));
    });
    byId('episode-summary-close-btn').addEventListener('click', closeEpisodeSummary);
    byId('episode-summary-overlay').addEventListener('click', closeEpisodeSummary);
    byId('refresh-btn').addEventListener('click', function () {
      // 强制刷新会拉 RSS 并写 D1，属于控制模式。
      if (!requireControl('refresh', selectedPodcast ? { podcast: selectedPodcast } : null)) return;
      loadTimelineEpisodes(getScopedSubscriptions(), true);
    });
    byId('add-podcast-btn').addEventListener('click', openDrawer);
    byId('drawer-close-btn').addEventListener('click', closeDrawer);
    byId('drawer-overlay').addEventListener('click', closeDrawer);
    byId('drawer-search').addEventListener('input', function () { onDrawerSearch(this.value); });
    byId('reader-close-btn').addEventListener('click', closeManuscript);
    byId('reader-overlay').addEventListener('click', closeManuscript);
    // 选择文件之前就进入 Access：公开浏览不打开文件选择器，也不发起任何上传请求。
    function chooseAudioFile() { if (requireControl('import')) byId('audio-file-input').click(); }
    byId('upload-drop-zone').addEventListener('click', chooseAudioFile);
    byId('upload-drop-zone').addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseAudioFile(); } });
    byId('upload-drop-zone').addEventListener('dragover', function (event) { event.preventDefault(); this.classList.add('is-dragging'); });
    byId('upload-drop-zone').addEventListener('dragleave', function () { this.classList.remove('is-dragging'); });
    byId('upload-drop-zone').addEventListener('drop', handleAudioDrop);
    byId('audio-file-input').addEventListener('change', function () { handleAudioFileChange(this); });
    function trapOverlayFocus(event, container) {
      if (event.key !== 'Tab' || !container || !container.classList.contains('is-open')) return;
      var focusable = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      var first = focusable[0]; var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', function (event) {
      trapOverlayFocus(event, byId('drawer'));
      trapOverlayFocus(event, byId('manuscript-reader'));
      trapOverlayFocus(event, byId('settings-drawer'));
      if (event.key !== 'Escape') return;
      var toc = byId('reader-toc');
      var sheet = byId('reader-progress-sheet');
      var menu = byId('reader-appearance-menu');
      if ((toc && toc.classList.contains('is-open')) || (sheet && sheet.classList.contains('is-open')) || (menu && menu.hasAttribute('open'))) {
        closeReaderSheets();
      }
      else if (byId('manuscript-reader').classList.contains('is-open')) closeManuscript();
      else if (byId('settings-drawer').classList.contains('is-open')) closeSettings();
      else if (byId('drawer').classList.contains('is-open')) closeDrawer();
      else if (byId('task-panel').classList.contains('is-open')) setTaskPanel(false);
      else if (byId('episode-summary-drawer').classList.contains('is-open')) closeEpisodeSummary();
    });

    function reloadReaderConcepts() {
      if (!_currentReadingTaskId) return;
      var tocContainer = byId('reader-toc');
      if (!tocContainer) return;
      var existingSection = tocContainer.querySelector('.concepts-section');
      if (existingSection) existingSection.remove();
      var root = byId('manuscript-body');
      if (root) {
        var inlineLinks = root.querySelectorAll('a.concept-inline-link');
        inlineLinks.forEach(function (link) {
          var textNode = document.createTextNode(link.textContent);
          link.parentNode.replaceChild(textNode, link);
        });
        root.normalize();
      }
      renderConceptsSection(_currentReadingTaskId, tocContainer);
      setHidden(tocContainer, false);
    }

    byId('lang-toggle-btn').addEventListener('click', toggleLocale);
    byId('reader-lang-toggle-btn').addEventListener('click', toggleLocale);

    // 两种模式进入同一个工作区。
    switchMode('podcast');

    // ── 个人配置面板（服务商地址、模型、密钥与文件位置）────────
    var _settingsEntries = [];
    var _settingsBusy = false;
    var _lastSettingsData = null;

    // ── 外观（应用主题：浅色 / 深色 / 自动）────────────────
    var _appearanceMedia = null;

    function applyAppTheme(theme) {
      var dark = theme === 'dark' || (theme !== 'light' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
      document.documentElement.dataset.appTheme = dark ? 'dark' : 'light';
      var meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) meta.setAttribute('content', dark ? 'dark' : 'light');
    }

    function watchSystemTheme() {
      if (!window.matchMedia || _appearanceMedia) return;
      _appearanceMedia = window.matchMedia('(prefers-color-scheme: dark)');
      var handler = function () {
        if (_cloudPrefs.app_theme !== 'auto') return;
        applyAppTheme('auto');
      };
      if (_appearanceMedia.addEventListener) _appearanceMedia.addEventListener('change', handler);
      else if (_appearanceMedia.addListener) _appearanceMedia.addListener(handler);
    }

    function buildLanguageGroup() {
      var section = document.createElement('section');
      section.className = 'settings-group';
      var head = document.createElement('div');
      head.className = 'settings-group-head';
      var title = document.createElement('h3');
      title.textContent = t('settings.lang');
      head.appendChild(title);
      section.appendChild(head);
      var desc = document.createElement('p');
      desc.className = 'settings-group-desc';
      desc.textContent = t('settings.lang_desc');
      section.appendChild(desc);

      var segmented = document.createElement('div');
      segmented.className = 'appearance-segmented';
      segmented.setAttribute('role', 'group');
      segmented.setAttribute('aria-label', t('settings.lang'));
      var current = getLocale();
      [
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' }
      ].forEach(function (option) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'appearance-btn' + (current === option.value ? ' active' : '');
        btn.dataset.langValue = option.value;
        btn.setAttribute('aria-pressed', current === option.value ? 'true' : 'false');
        btn.textContent = option.label;
        btn.addEventListener('click', function () {
          setLocale(option.value, true);
          segmented.querySelectorAll('.appearance-btn').forEach(function (b) {
            var active = b.dataset.langValue === option.value;
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', active ? 'true' : 'false');
          });
          loadSettings();
        });
        segmented.appendChild(btn);
      });
      section.appendChild(segmented);
      return section;
    }

    function buildAppearanceGroup() {
      var section = document.createElement('section');
      section.className = 'settings-group';
      var head = document.createElement('div');
      head.className = 'settings-group-head';
      var title = document.createElement('h3');
      title.textContent = t('appearance.theme');
      head.appendChild(title);
      section.appendChild(head);
      var desc = document.createElement('p');
      desc.className = 'settings-group-desc';
      desc.textContent = t('appearance.desc');
      section.appendChild(desc);

      var segmented = document.createElement('div');
      segmented.className = 'appearance-segmented';
      segmented.setAttribute('role', 'group');
      segmented.setAttribute('aria-label', t('appearance.group'));
      var stored = _cloudPrefs.app_theme || 'auto';
      [
        { value: 'light', label: t('appearance.light'), icon: 'sun' },
        { value: 'dark', label: t('appearance.dark'), icon: 'moon' },
        { value: 'auto', label: t('appearance.auto'), icon: 'auto' }
      ].forEach(function (option) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'appearance-btn' + (stored === option.value ? ' active' : '');
        btn.dataset.themeValue = option.value;
        btn.setAttribute('aria-pressed', stored === option.value ? 'true' : 'false');
        btn.innerHTML = uiIcon(option.icon);
        btn.appendChild(document.createTextNode(option.label));
        btn.addEventListener('click', function () { selectAppTheme(option.value, segmented); });
        segmented.appendChild(btn);
      });
      section.appendChild(segmented);
      return section;
    }

    function selectAppTheme(value, segmented) {
      applyAppTheme(value);
      if (segmented) {
        segmented.querySelectorAll('.appearance-btn').forEach(function (btn) {
          var active = btn.dataset.themeValue === value;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      }
      savePreference('app_theme', value);
    }

    function openSettings() {
      if (!requireControl('settings')) return;
      _savedScrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + _savedScrollY + 'px';
      document.body.style.width = '100%';
      byId('settings-drawer').classList.add('is-open');
      byId('settings-overlay').classList.add('is-open');
      byId('settings-drawer').setAttribute('aria-hidden', 'false');
      document.body.classList.add('overlay-open');
      loadSettings();
      setTimeout(function () { byId('settings-close-btn').focus(); }, 180);
    }

    function closeSettings() {
      byId('settings-drawer').classList.remove('is-open');
      byId('settings-overlay').classList.remove('is-open');
      byId('settings-drawer').setAttribute('aria-hidden', 'true');
      document.body.classList.remove('overlay-open');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _savedScrollY);
      byId('settings-btn').focus();
    }

    function loadSettings() {
      var body = byId('settings-body');
      body.replaceChildren();
      var state = document.createElement('p');
      state.className = 'settings-state';
      state.textContent = t('settings.loading');
      body.appendChild(state);
      fetch(appUrl('/api/control/settings'))
        .then(readApiResponse)
        .then(function (data) {
          _lastSettingsData = data;
          renderSettings(data);
        })
        .catch(function (error) { state.textContent = t('settings.read_failed') + errorMessage(error); });
    }

    function buildSettingsField(field) {
      var wrap = document.createElement('div');
      wrap.className = 'settings-field';
      var fieldKey = String(field.key || '');
      var inputId = 'setting-' + fieldKey.replace(/[^a-zA-Z0-9]+/g, '-');
      var isSecret = field.type === 'secret';

      var labelKey = 'setting.' + fieldKey + '.label';
      var phKey = 'setting.' + fieldKey + '.placeholder';
      var hintKey = 'setting.' + fieldKey + '.hint';

      var label = document.createElement('label');
      label.className = 'form-label';
      label.setAttribute('for', inputId);
      var labelText = document.createElement('span');
      var localizedLabel = t(labelKey);
      labelText.textContent = localizedLabel !== labelKey ? localizedLabel : String(field.label || fieldKey || '');
      label.appendChild(labelText);
      if (isSecret) {
        var badge = document.createElement('span');
        badge.className = 'settings-badge' + (field.configured ? ' is-set' : '');
        badge.textContent = field.configured ? t('settings.configured') : t('settings.not_configured');
        label.appendChild(badge);
      }
      wrap.appendChild(label);

      var entry = { key: fieldKey, type: field.type, locked: !!field.locked || isSecret };

      if (isSecret) {
        // 不可编辑项不展示输入框。
        var hintP = document.createElement('p');
        hintP.className = 'settings-field-hint settings-field-locked';
        var secretHint = t(hintKey);
        hintP.textContent = secretHint !== hintKey ? secretHint : String(field.hint || t('settings.not_editable'));
        wrap.appendChild(hintP);
        _settingsEntries.push(entry);
        return wrap;
      }

      var control;
      if (field.type === 'select') {
        control = document.createElement('select');
        (field.options || []).forEach(function (option) {
          var node = document.createElement('option');
          node.value = String(option.value == null ? '' : option.value);
          var optKey = 'setting.' + fieldKey + '.option.' + option.value;
          var localizedOpt = t(optKey);
          node.textContent = localizedOpt !== optKey ? localizedOpt : String(option.label || option.value || '');
          control.appendChild(node);
        });
        control.value = String(field.value == null ? '' : field.value);
      } else {
        control = document.createElement('input');
        control.type = 'text';
        control.autocomplete = 'off';
        control.spellcheck = false;
        var localizedPh = t(phKey);
        control.placeholder = localizedPh !== phKey ? localizedPh : String(field.placeholder || '');
        control.value = String(field.value == null ? '' : field.value);
      }
      control.className = 'form-input';
      control.id = inputId;
      if (field.locked) control.disabled = true;
      entry.input = control;
      entry.initial = control.value;

      wrap.appendChild(control);

      var hints = [];
      if (field.locked && field.locked_reason) {
        var lockedKey = 'setting.' + fieldKey + '.locked';
        var localizedLocked = t(lockedKey);
        hints.push(localizedLocked !== lockedKey ? localizedLocked : String(field.locked_reason));
      }
      var localizedHint = t(hintKey);
      if (localizedHint !== hintKey) {
        hints.push(localizedHint);
      } else if (field.hint) {
        hints.push(String(field.hint));
      }
      if (hints.length) {
        var hint = document.createElement('p');
        hint.className = 'settings-field-hint' + (field.locked ? ' settings-field-locked' : '');
        hint.textContent = hints.join(' ');
        wrap.appendChild(hint);
      }

      _settingsEntries.push(entry);
      return wrap;
    }

    function renderSettings(data) {
      var body = byId('settings-body');
      body.replaceChildren();
      _settingsEntries = [];
      _lastSettingsData = data;
      body.appendChild(buildLanguageGroup());
      body.appendChild(buildAppearanceGroup());
      var groups = data && Array.isArray(data.groups) ? data.groups : [];
      if (!groups.length) {
        var empty = document.createElement('p');
        empty.className = 'settings-state';
        empty.textContent = t('settings.empty');
        body.appendChild(empty);
        return;
      }
      var refiner = groups.find(function (group) { return group.key === 'refiner'; });
      var quality = groups.find(function (group) { return group.key === 'quality'; });
      if (refiner) {
        var section = document.createElement('section'); section.className = 'settings-group';
        var head = document.createElement('div'); head.className = 'settings-group-head';
        var title = document.createElement('h3'); title.textContent = t('settings.refinement'); head.appendChild(title);
        var testBtn = document.createElement('button'); testBtn.type = 'button'; testBtn.className = 'ghost-btn settings-test-btn'; testBtn.textContent = t('settings.test'); testBtn.addEventListener('click', function () { testSettings('refiner', testBtn); }); head.appendChild(testBtn);
        section.appendChild(head);
        var fields = refiner.fields || [];
        fields.filter(function (field) { return field.key === 'refiner.model'; }).forEach(function (field) { section.appendChild(buildSettingsField(field)); });
        body.appendChild(section);
        var advanced = document.createElement('details'); advanced.className = 'settings-group settings-advanced';
        var summary = document.createElement('summary'); summary.textContent = t('settings.advanced'); advanced.appendChild(summary);
        fields.filter(function (field) { return field.key !== 'refiner.model'; }).forEach(function (field) { advanced.appendChild(buildSettingsField(field)); });
        if (quality) {
          (quality.fields || []).forEach(function (field) { advanced.appendChild(buildSettingsField(field)); });
          var hint = document.createElement('p'); hint.className = 'settings-group-desc'; hint.textContent = t('settings.quality_hint'); advanced.appendChild(hint);
        }
        body.appendChild(advanced);
      }
      var writable = !(data && data.writable === false);
      byId('settings-save-btn').disabled = !writable;
      byId('settings-note').textContent = '';
    }

    function collectSettingsPayload() {
      var payload = { values: {} };
      _settingsEntries.forEach(function (entry) {
        if (entry.locked || entry.type === 'secret' || !entry.input) return;
        if (entry.input.value === entry.initial) return;
        payload.values[entry.key] = entry.input.value;
      });
      return payload;
    }

    function saveSettings() {
      if (_settingsBusy) return;
      var saveBtn = byId('settings-save-btn');
      _settingsBusy = true;
      saveBtn.disabled = true;
      saveBtn.textContent = t('settings.saving');
      fetch(appUrl('/api/control/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectSettingsPayload())
      })
        .then(readApiResponse)
        .then(function (data) {
          renderSettings(data);
          addLog(t('settings.saved'), 'success');
        })
        .catch(function (error) { addLog(t('settings.save_failed') + errorMessage(error), 'error'); })
        .then(function () {
          _settingsBusy = false;
          saveBtn.textContent = t('settings.save');
          saveBtn.disabled = false;
        });
    }

    function testSettings(target, button) {
      var original = button.textContent;
      button.disabled = true;
      button.textContent = t('settings.testing');
      fetch(appUrl('/api/control/settings/test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: target })
      })
        .then(readApiResponse)
        .then(function (data) { addLog((data && data.detail) || t('settings.test_success'), 'success'); })
        .catch(function (error) { addLog(t('settings.test_failed') + errorMessage(error), 'error'); })
        .then(function () { button.disabled = false; button.textContent = original; });
    }

    function initSettings() {
      byId('settings-btn').addEventListener('click', openSettings);
      byId('settings-close-btn').addEventListener('click', closeSettings);
      byId('settings-overlay').addEventListener('click', closeSettings);
      byId('settings-reload-btn').addEventListener('click', closeSettings);
      byId('settings-save-btn').addEventListener('click', saveSettings);
    }

    // 公开浏览的外观选择：显式选择自动 / 浅色 / 深色，仅存本机。
    function renderPublicThemeChooser() {
      var stored = _cloudPrefs.app_theme || 'auto';
      document.querySelectorAll('[data-public-theme]').forEach(function (button) {
        var active = button.dataset.publicTheme === stored;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      var summary = byId('public-theme-btn');
      if (summary) {
        var themeLabel = t('appearance.' + stored) || t('appearance.auto');
        summary.title = t('appearance.summary_title', themeLabel);
        summary.setAttribute('aria-label', t('appearance.summary_aria', themeLabel));
      }
    }

    function selectPublicTheme(value) {
      if (value !== 'auto' && value !== 'light' && value !== 'dark') return;
      applyAppTheme(value);
      savePreference('app_theme', value);
      renderPublicThemeChooser();
      var menu = byId('public-theme-menu');
      if (menu) menu.removeAttribute('open');
    }

    function initPublicBrowse() {
      byId('manage-link').href = appUrl('/manage');
      document.querySelectorAll('[data-public-theme]').forEach(function (button) {
        button.addEventListener('click', function () { selectPublicTheme(button.dataset.publicTheme || 'auto'); });
      });
      renderPublicThemeChooser();
    }

    // 公开浏览里点击受保护操作会带着 intent 进入 /manage（见 requireControl）；
    // Access 认证后在这里回到对应位置，并清掉查询串，刷新页面不会重复触发。
    function applyControlIntent(subscriptionsReady) {
      var params = new URLSearchParams(window.location.search);
      var intent = params.get('intent');
      if (!intent) return;
      var podcast = params.get('podcast');
      if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      if (intent === 'settings') openSettings();
      else if (intent === 'subscribe') openDrawer();
      else if (intent === 'import') switchMode('custom');
      else if (podcast) {
        Promise.resolve(subscriptionsReady).then(function () {
          if (_subscriptions.some(function (item) { return item && item.name === podcast; })) selectPodcast(podcast);
        });
      }
    }

    watchSystemTheme();
    initSettings();
    applyLocale(getLocale());
    loadCloudPreferences();
    // 订阅、单集快照与稿件在两种模式下都可浏览（browseApi 决定走 public 还是 control）。
    var subscriptionsReady = loadSubscriptions();
    if (IS_MANAGE) {
      // 控制模式：/manage 由 Cloudflare Access 保护；任务队列与已读状态只在这里加载。
      loadHistory();
      loadReadEpisodes();
      applyControlIntent(subscriptionsReady);
    } else {
      // 公开浏览：不读取任务、已读、设置等任何控制面状态。
      initPublicBrowse();
    }
