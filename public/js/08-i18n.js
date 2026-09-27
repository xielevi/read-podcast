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

        'nav.podcast': '订阅',
        'nav.custom': '导入',
        'nav.library': '稿件',
        'nav.add_podcast': '添加订阅',

        'cover.kicker': '播客电子杂志',
        'content.latest_episodes': '最新单集',
        'content.all_subscriptions': '全部订阅',
        'content.search_placeholder': '搜索单集…',
        'content.refresh': '刷新',
        'filter.all': '全部',
        'filter.readable': '可读',
        'filter.unread': '未读',
        'filter.read': '已读',
        'filter.label': '阅读状态过滤',
        'pagination.prev': '上一页',
        'pagination.next': '下一页',
        'pagination.page': '第 {0} / {1} 页',
        'empty.no_episodes': '暂无单集',
        'empty.no_episodes_found': '没有找到匹配的单集。',
        'empty.no_subscriptions': '尚未添加任何播客订阅。',

        'custom.title': '导入本地音频',
        'custom.desc': '上传音频生成精修稿件',
        'custom.drop_hint': '拖拽音频到这里，或点击选择文件',
        'custom.formats': '支持 MP3, M4A, WAV, AAC, OGG 等格式',
        'custom.podcast_name': '节目名称',
        'custom.podcast_placeholder': '例如：忽左忽右',
        'custom.episode_title': '单集标题',
        'custom.episode_placeholder': '例如：漫谈欧洲历史',
        'custom.prompt': '自定义 Prompt（可选）',
        'custom.prompt_placeholder': '可在此处输入个性化的编辑或精修指令…',
        'custom.prompt_template': 'Prompt 模板',
        'custom.submit': '开始处理',
        'custom.uploading': '正在上传…',
        'custom.processing': '处理中…',

        'library.title': '已发布稿件',
        'library.search_placeholder': '搜索稿件…',
        'library.filter_all': '全部',
        'library.filter_subscription': '订阅单集',
        'library.filter_custom': '导入音频',
        'library.read': '阅读',
        'library.download': '下载',
        'library.empty': '暂无已发布稿件',

        'tasks.title': '任务',
        'tasks.close': '关闭任务面板',
        'tasks.empty': '暂无任务',
        'tasks.retry': '重试',
        'tasks.cancel': '取消',
        'tasks.delete': '删除',
        'tasks.processing_count': '处理中 {0}',
        'tasks.attention_count': '{0} 个任务需要处理',
        'stage.queued': '排队中',
        'stage.downloading': '下载音频中',
        'stage.resolving': '解析中',
        'stage.transcribing': '转写中',
        'stage.refining': '整理中',
        'stage.finalizing': '保存中',
        'stage.success': '已完成',
        'stage.failed': '失败',
        'stage.cancelled': '已取消',

        'episode.generate': '生成稿件',
        'episode.regenerate': '重新生成',
        'episode.read': '阅读稿件',
        'episode.download_md': '下载 Markdown',
        'episode.download_audio': '下载音频',
        'episode.no_audio': '无音频',
        'episode.duration_min': '{0} 分钟',
        'episode.duration_hour_min': '{0} 小时 {1} 分钟',
        'episode.no_desc': '无节目说明',

        'reader.appearance': '排版与主题',
        'reader.preset': '版式预设',
        'reader.preset_classical': '文雅经典',
        'reader.preset_modern': '现代清晰',
        'reader.font_size': '字号',
        'reader.font_dec': '减小字号',
        'reader.font_inc': '增大字号',
        'reader.line_height': '行距',
        'reader.leading_compact': '紧凑',
        'reader.leading_normal': '舒适',
        'reader.leading_relaxed': '宽松',
        'reader.theme': '主题',
        'reader.theme_follow': '跟随系统',
        'reader.theme_paper': '纸质',
        'reader.theme_warm': '温润',
        'reader.theme_green': '护眼',
        'reader.theme_dark': '深色',
        'reader.download_md': '下载 Markdown',
        'reader.mark_read': '标记为已读',
        'reader.mark_unread': '标记为未读',
        'reader.close': '关闭阅读',
        'reader.toc': '目录',
        'reader.toc_label': '大纲目录',
        'reader.progress': '阅读进度',
        'reader.progress_val': '进度 {0}%',
        'reader.jump_start': '跳至开头',
        'reader.jump_end': '跳至结尾',
        'reader.initial_state': '选择一份已完成稿件开始阅读。',
        'reader.words_wan': '{0} 万字',
        'reader.words': '{0} 字',
        'reader.est_time': '约 {0} 分钟',

        'concepts.title': '关键概念',
        'concepts.extracting': '正在抽取关键概念…',
        'concepts.reading': '正在读取关键概念…',
        'concepts.empty': '没有找到可链接到维基百科的概念。',
        'concepts.failed': '抽取失败：',
        'concepts.retry': '重试',
        'concepts.wiki_title': '维基百科',

        'settings.title': '设置',
        'settings.close': '关闭设置',
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

        'drawer.title': '添加播客订阅',
        'drawer.desc': '搜索或输入 RSS 地址',
        'drawer.search_placeholder': '搜索播客或输入 RSS Feed…',
        'drawer.close': '关闭',
        'drawer.subscribe': '订阅',
        'drawer.subscribed': '已订阅',
        'drawer.subscribing': '正在订阅…'
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

        'nav.podcast': 'Subscriptions',
        'nav.custom': 'Import',
        'nav.library': 'Articles',
        'nav.add_podcast': 'Add Show',

        'cover.kicker': 'Podcast Magazine',
        'content.latest_episodes': 'Latest Episodes',
        'content.all_subscriptions': 'All Subscriptions',
        'content.search_placeholder': 'Search episodes…',
        'content.refresh': 'Refresh',
        'filter.all': 'All',
        'filter.readable': 'Readable',
        'filter.unread': 'Unread',
        'filter.read': 'Read',
        'filter.label': 'Filter by reading status',
        'pagination.prev': 'Previous',
        'pagination.next': 'Next',
        'pagination.page': 'Page {0} of {1}',
        'empty.no_episodes': 'No episodes',
        'empty.no_episodes_found': 'No matching episodes found.',
        'empty.no_subscriptions': 'No podcast subscriptions added yet.',

        'custom.title': 'Import Audio',
        'custom.desc': 'Upload audio to generate refined manuscript',
        'custom.drop_hint': 'Drag & drop audio here, or click to choose file',
        'custom.formats': 'Supports MP3, M4A, WAV, AAC, OGG formats',
        'custom.podcast_name': 'Show Name',
        'custom.podcast_placeholder': 'e.g., Hardcore History',
        'custom.episode_title': 'Episode Title',
        'custom.episode_placeholder': 'e.g., Episode 1: The Beginning',
        'custom.prompt': 'Custom Prompt (Optional)',
        'custom.prompt_placeholder': 'Enter custom editorial or refinement instructions…',
        'custom.prompt_template': 'Prompt Template',
        'custom.submit': 'Start Processing',
        'custom.uploading': 'Uploading…',
        'custom.processing': 'Processing…',

        'library.title': 'Published Manuscripts',
        'library.search_placeholder': 'Search manuscripts…',
        'library.filter_all': 'All',
        'library.filter_subscription': 'Subscriptions',
        'library.filter_custom': 'Imported Audio',
        'library.read': 'Read',
        'library.download': 'Download',
        'library.empty': 'No published manuscripts yet',

        'tasks.title': 'Tasks',
        'tasks.close': 'Close task panel',
        'tasks.empty': 'No tasks',
        'tasks.retry': 'Retry',
        'tasks.cancel': 'Cancel',
        'tasks.delete': 'Delete',
        'tasks.processing_count': 'Processing {0}',
        'tasks.attention_count': '{0} task(s) require attention',
        'stage.queued': 'Queued',
        'stage.downloading': 'Downloading audio',
        'stage.resolving': 'Resolving',
        'stage.transcribing': 'Transcribing',
        'stage.refining': 'Refining',
        'stage.finalizing': 'Finalizing',
        'stage.success': 'Completed',
        'stage.failed': 'Failed',
        'stage.cancelled': 'Cancelled',

        'episode.generate': 'Generate Manuscript',
        'episode.regenerate': 'Regenerate',
        'episode.read': 'Read Manuscript',
        'episode.download_md': 'Download Markdown',
        'episode.download_audio': 'Download Audio',
        'episode.no_audio': 'No audio',
        'episode.duration_min': '{0} min',
        'episode.duration_hour_min': '{0}h {1}m',
        'episode.no_desc': 'No description available',

        'reader.appearance': 'Typography & Theme',
        'reader.preset': 'Preset',
        'reader.preset_classical': 'Classical',
        'reader.preset_modern': 'Modern',
        'reader.font_size': 'Font Size',
        'reader.font_dec': 'Decrease font size',
        'reader.font_inc': 'Increase font size',
        'reader.line_height': 'Line Spacing',
        'reader.leading_compact': 'Compact',
        'reader.leading_normal': 'Normal',
        'reader.leading_relaxed': 'Relaxed',
        'reader.theme': 'Theme',
        'reader.theme_follow': 'Follow System',
        'reader.theme_paper': 'Paper',
        'reader.theme_warm': 'Warm',
        'reader.theme_green': 'Green',
        'reader.theme_dark': 'Dark',
        'reader.download_md': 'Download Markdown',
        'reader.mark_read': 'Mark as Read',
        'reader.mark_unread': 'Mark as Unread',
        'reader.close': 'Close Reader',
        'reader.toc': 'TOC',
        'reader.toc_label': 'Table of Contents',
        'reader.progress': 'Reading Progress',
        'reader.progress_val': 'Progress {0}%',
        'reader.jump_start': 'Jump to top',
        'reader.jump_end': 'Jump to end',
        'reader.initial_state': 'Select a completed manuscript to start reading.',
        'reader.words_wan': '{0}k words',
        'reader.words': '{0} words',
        'reader.est_time': '~{0} min',

        'concepts.title': 'Key Concepts',
        'concepts.extracting': 'Extracting key concepts…',
        'concepts.reading': 'Loading key concepts…',
        'concepts.empty': 'No Wikipedia concepts found.',
        'concepts.failed': 'Failed to extract: ',
        'concepts.retry': 'Retry',
        'concepts.wiki_title': 'Wikipedia',

        'settings.title': 'Settings',
        'settings.close': 'Close settings',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.saved': 'Saved successfully',
        'settings.save_failed': 'Failed to save: ',
        'settings.testing': 'Testing…',
        'settings.test_success': 'Connection OK.',
        'settings.test_failed': 'Test failed: ',
        'settings.lang': 'Language',
        'settings.lang_desc': 'Choose interface and concept verification language.',
        'settings.lang_zh': 'Chinese',
        'settings.lang_en': 'English',

        'drawer.title': 'Add Podcast Subscription',
        'drawer.desc': 'Search or enter RSS feed URL',
        'drawer.search_placeholder': 'Search podcast or enter RSS feed…',
        'drawer.close': 'Close',
        'drawer.subscribe': 'Subscribe',
        'drawer.subscribed': 'Subscribed',
        'drawer.subscribing': 'Subscribing…'
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
      if (typeof reloadReaderConcepts === 'function') reloadReaderConcepts();
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
