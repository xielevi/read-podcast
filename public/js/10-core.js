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
