    'use strict';

    // WebUI 既可部署在域名根路径，也可挂在 /podcast 一类子路径。
    var APP_BASE_PATH = (function detectBasePath() {
      var path = String(window.location.pathname || '/').replace(/\/+$/, '');
      return path && path !== '/' ? path : '';
    }());

    function appUrl(path) {
      var normalized = String(path || '');
      if (!normalized.startsWith('/')) normalized = '/' + normalized;
      return APP_BASE_PATH + normalized;
    }

    var selectedPodcast = null;
    var allEpisodes = [];
    var activeEventSource = null;
    var globalEventSource = null;
    var currentMode = 'podcast';
    var _uploadedAudioPath = null;
    var _promptTemplates = [];
    var _pollTimer = null;
    var _drawerSearchTimer = null;
    var _drawerSelected = null;
    var _drawerMode = 'search';
    var _taskHistory = [];
    var _taskHistoryMap = {};
    var _currentTaskId = null;
    var _taskCards = {};
    var _taskStartedAt = {};
    var _libraryTasks = [];
    var _currentReadingTaskId = null;
    var currentFilter = 'all';
    var currentPage = 1;
    var selectedEpisode = null;
    var PAGE_SIZE = 10;
    var _currentFontSize = 19;
    var _currentTheme = 'light';
    var _savedScrollY = 0;
    var _episodeCache = {};
    var _episodeRequests = new Map();
    var _lastReaderScrollTop = 0;
    var _subscriptions = [];
    var _timelineRequestToken = 0;
    var _readEpisodes = {};
    var _currentReadingEpisode = null;
    var _currentTaskPodcastName = null;

    function byId(id) { return document.getElementById(id); }
    function nowTime() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }
    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    function errorMessage(error) { return error && error.message ? error.message : String(error || '未知错误'); }
    function safeTaskUrl(taskId, suffix) {
      return appUrl('/api/read-podcast/tasks/' + encodeURIComponent(String(taskId || '')) + suffix);
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
      return fetchAllPages('/api/read-podcast/episodes/read')
        .then(function (keys) {
          _readEpisodes = {};
          (Array.isArray(keys) ? keys : []).forEach(function (key) { _readEpisodes[String(key)] = true; });
          updateReaderReadState();
          updateFilterCounts();
          if (allEpisodes.length) renderEpisodeList(getFilteredEpisodes());
          return _readEpisodes;
        })
        .catch(function () { return _readEpisodes; });
    }

    function episodeParts(episode) {
      if (!episode) return null;
      var podcastName = String(episode.podcast_name || episode.podcast || selectedPodcast || '').trim();
      var title = String(episode.title || episode.episode_title || '').trim();
      return podcastName && title ? { podcastName: podcastName, title: title } : null;
    }

    function episodeIdentity(episode) {
      var parts = episodeParts(episode);
      return parts ? parts.podcastName + '::' + parts.title : '';
    }

    function isEpisodeRead(episode) {
      var key = episodeIdentity(episode);
      return Boolean(key && _readEpisodes[key]);
    }

    function setEpisodeRead(episode, read) {
      var parts = episodeParts(episode);
      if (!parts) return;
      var key = parts.podcastName + '::' + parts.title;
      var wasRead = Boolean(_readEpisodes[key]);
      if (wasRead === read) return;
      // 乐观更新：先改本地状态刷新界面，服务端保存失败再回滚。
      if (read) _readEpisodes[key] = true;
      else delete _readEpisodes[key];
      updateReaderReadState();
      updateFilterCounts();
      if (allEpisodes.length) renderEpisodeList(getFilteredEpisodes());
      fetch(appUrl('/api/read-podcast/episodes/read'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ podcast_name: parts.podcastName, episode_title: parts.title, read: read }),
      })
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); })
        .catch(function (error) {
          if (read) delete _readEpisodes[key];
          else _readEpisodes[key] = true;
          updateReaderReadState();
          updateFilterCounts();
          if (allEpisodes.length) renderEpisodeList(getFilteredEpisodes());
          addLog('保存已读状态失败：' + errorMessage(error), 'error');
        });
    }

    function updateReaderReadState() {
      var button = byId('reader-read-toggle');
      if (!button) return;
      var hasEpisode = Boolean(episodeIdentity(_currentReadingEpisode));
      var read = hasEpisode && isEpisodeRead(_currentReadingEpisode);
      setHidden(button, !hasEpisode);
      button.textContent = read ? '已读 · 改为未读' : '标记为已读';
      button.title = read ? '将这期改回未读' : '标记这期已经读完';
      button.setAttribute('aria-pressed', String(read));
      button.classList.toggle('is-read', read);
    }

    byId('clock').textContent = nowTime();
    setInterval(function () { byId('clock').textContent = nowTime(); }, 1000);
    (function setEditionDate() {
      var date = new Date();
      byId('edition-date').textContent = date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }) + ' · 编辑室';
    }());
