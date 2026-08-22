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

    function loadReadEpisodes() {
      return fetch(appUrl('/api/read-podcast/episodes/read'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
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

    function switchMode(mode) {
      currentMode = mode;
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
      if (customMode) {
        setHidden(byId('episode-inspector'), false);
        byId('inspector-title').textContent = '本地音频';
        byId('inspector-meta').textContent = '选择音频后开始转录';
        byId('inspector-summary').textContent = '从声音到可以慢慢阅读的文字，只需要一次转录。';
      } else if (libraryMode) {
        setHidden(byId('episode-inspector'), false);
        byId('inspector-title').textContent = '稿件库';
        byId('inspector-meta').textContent = '所有已经生成的稿件';
        byId('inspector-summary').textContent = '可以按标题搜索，并直接阅读或下载。';
        loadLibrary();
      } else if (selectedEpisode) {
        renderEpisodeInspector(selectedEpisode);
      } else {
        resetEpisodeInspector();
      }
      if (customMode && _promptTemplates.length === 0) loadPromptTemplates();
    }

    function loadPromptTemplates() {
      fetch(appUrl('/api/read-podcast/prompt-templates'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (templates) {
          _promptTemplates = Array.isArray(templates) ? templates : [];
          var select = byId('prompt-template-select');
          while (select.options.length > 1) select.remove(1);
          _promptTemplates.forEach(function (template) {
            var option = document.createElement('option');
            option.value = String(template.content || '');
            option.textContent = String(template.name || '未命名模板');
            select.appendChild(option);
          });
        })
        .catch(function () { addLog('Prompt 模板加载失败', 'warning'); });
    }

    function applyPromptTemplate(content) {
      if (!content) return;
      byId('custom-prompt').value = content;
    }

    function handleAudioDrop(event) {
      event.preventDefault();
      byId('upload-drop-zone').classList.remove('is-dragging');
      if (event.dataTransfer.files.length > 0) doUploadAudio(event.dataTransfer.files[0]);
    }

    function handleAudioFileChange(input) {
      if (input.files.length > 0) doUploadAudio(input.files[0]);
    }

    function doUploadAudio(file) {
      _uploadedAudioPath = null;
      setHidden(byId('upload-progress-wrap'), false);
      setHidden(byId('upload-success-info'), true);
      setHidden(byId('upload-hint'), true);
      byId('upload-status').textContent = '上传中……';
      byId('upload-progress-inner').style.width = '0%';
      var formData = new FormData();
      formData.append('file', file);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', appUrl('/api/read-podcast/upload/audio'));
      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) return;
        var percent = Math.round(event.loaded / event.total * 100);
        byId('upload-progress-inner').style.width = percent + '%';
        byId('upload-status').textContent = '上传中…… ' + percent + '%';
      };
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var result = JSON.parse(xhr.responseText);
            _uploadedAudioPath = result.server_path;
            byId('upload-status').textContent = '上传完成';
            byId('upload-progress-inner').style.width = '100%';
            setHidden(byId('upload-success-info'), false);
            byId('upload-success-info').textContent = '✓ ' + String(result.original_name || file.name) + ' (' + Math.round(Number(result.size || file.size) / 1024 / 1024 * 10) / 10 + ' MB)';
            addLog('文件上传成功：' + String(result.filename || file.name), 'success');
          } catch (error) { addLog('上传响应无法解析', 'error'); }
        } else {
          var message = '上传失败';
          try { message = JSON.parse(xhr.responseText).detail || message; } catch (ignore) {}
          byId('upload-status').textContent = message;
          setHidden(byId('upload-hint'), false);
          addLog('文件上传失败：' + message, 'error');
        }
      };
      xhr.onerror = function () { byId('upload-status').textContent = '网络错误，上传失败'; setHidden(byId('upload-hint'), false); addLog('文件上传网络错误', 'error'); };
      xhr.send(formData);
    }

    function doDeleteSubscription(name) {
      if (!name) return;
      fetch(appUrl('/api/read-podcast/subscriptions/' + encodeURIComponent(name)), { method: 'DELETE' })
        .then(function (res) { return res.json().then(function (data) { if (!res.ok) throw new Error(data.detail || 'HTTP ' + res.status); return data; }); })
        .then(function () {
          addLog('已取消订阅节目「' + name + '」', 'info');
          if (selectedPodcast === name) {
            selectedPodcast = null;
            allEpisodes = [];
            currentPage = 1;
            resetEpisodeInspector();
            byId('center-title').textContent = '全部订阅';
            byId('center-sub').textContent = '按时间线展示所有订阅';
            byId('episode-list').replaceChildren();
            setHidden(byId('episode-list'), true);
            setHidden(byId('episode-pagination'), true);
            setHidden(byId('episode-empty'), false);
          }
          loadSubscriptions();
        })
        .catch(function (err) { addLog('删除订阅失败：' + errorMessage(err), 'error'); });
    }

    function createPodcastItem(podcast, index) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'podcast-item';
      item.dataset.name = String(podcast.name || '');
      item.style.setProperty('--item-index', index);
      var dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      item._statusDot = dot;
      var copy = document.createElement('span');
      copy.style.minWidth = '0';
      var name = document.createElement('span');
      name.className = 'pod-name';
      name.style.display = 'block';
      name.textContent = String(podcast.name || '未命名节目');
      var meta = document.createElement('span');
      meta.className = 'pod-meta';
      meta.style.display = 'block';
      try { meta.textContent = podcast.rss_url ? new URL(podcast.rss_url).hostname : 'RSS feed'; }
      catch (error) { meta.textContent = 'RSS feed'; }
      copy.append(name, meta);

      var deleteBtn = document.createElement('span');
      deleteBtn.className = 'pod-delete-btn';
      deleteBtn.title = '取消订阅';
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (deleteBtn.dataset.confirming === 'true') {
          doDeleteSubscription(String(podcast.name || ''));
          return;
        }
        deleteBtn.dataset.confirming = 'true';
        deleteBtn.textContent = '再按一次';
        deleteBtn.setAttribute('aria-label', '再次点击确认取消订阅');
        setTimeout(function () { deleteBtn.dataset.confirming = 'false'; deleteBtn.textContent = '✕'; deleteBtn.removeAttribute('aria-label'); }, 3000);
      });

      item.append(dot, copy, deleteBtn);
      item.addEventListener('click', function () { selectPodcast(String(podcast.name || '')); });
      return item;
    }

    function createAllPodcastsItem() {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'podcast-item all-podcasts-item';
      item.dataset.name = '';
      item.style.setProperty('--item-index', 0);
      var dot = document.createElement('span');
      dot.className = 'dot dot-accent';
      dot.setAttribute('aria-hidden', 'true');
      var copy = document.createElement('span');
      copy.style.minWidth = '0';
      var name = document.createElement('span');
      name.className = 'pod-name';
      name.style.display = 'block';
      name.textContent = '全部订阅';
      var meta = document.createElement('span');
      meta.className = 'pod-meta';
      meta.style.display = 'block';
      meta.textContent = '按时间线浏览';
      copy.append(name, meta);
      item.append(dot, copy);
      item.addEventListener('click', selectAllPodcasts);
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
        empty.textContent = '暂无订阅节目';
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
      return image ? appUrl('/api/read-podcast/artwork?url=' + encodeURIComponent(image)) : '';
    }

    function makeArtworkTile(image, fallbackText, className) {
      var wrap = document.createElement('span');
      wrap.className = className;
      var mono = document.createElement('span');
      mono.className = 'art-monogram';
      mono.textContent = String(fallbackText || '播').trim().slice(0, 1) || '播';
      wrap.appendChild(mono);
      if (image) {
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.decoding = 'async';
        img.addEventListener('load', function () { wrap.classList.add('has-art'); });
        img.addEventListener('error', function () { img.remove(); });
        img.src = artworkUrl(image);
        wrap.appendChild(img);
      }
      return wrap;
    }

    function renderCoverCollage(podcasts) {
      var section = byId('cover-collage');
      var strip = byId('cover-strip');
      if (!section || !strip) return;
      var withArt = (Array.isArray(podcasts) ? podcasts : []).filter(function (p) { return p && p.image; });
      if (withArt.length < 2) { section.hidden = true; strip.replaceChildren(); return; }
      strip.replaceChildren();
      withArt.slice(0, 8).forEach(function (podcast) {
        var tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'cover-tile';
        tile.title = String(podcast.name || '');
        tile.appendChild(makeArtworkTile(podcast.image, podcast.name, 'cover-art'));
        tile.addEventListener('click', function () { selectPodcast(String(podcast.name || '')); });
        strip.appendChild(tile);
      });
      var edition = byId('cover-edition');
      if (edition) {
        edition.textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' · 订阅合集';
      }
      section.hidden = false;
    }

    function loadSubscriptions() {
      return fetch(appUrl('/api/read-podcast/subscriptions'))
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
        .catch(function () { byId('server-dot').style.background = 'var(--error)'; byId('server-status').textContent = '暂不可用'; });
    }

    function getScopedSubscriptions() {
      if (!selectedPodcast) return _subscriptions.slice();
      return _subscriptions.filter(function (podcast) { return podcast && String(podcast.name || '') === selectedPodcast; });
    }

    function decorateEpisodes(podcastName, episodes) {
      return (Array.isArray(episodes) ? episodes : []).map(function (episode) {
        return Object.assign({}, episode, { podcast_name: String(episode.podcast_name || podcastName || '') });
      });
    }

    function sortEpisodeTimeline(episodes) {
      return episodes.slice().sort(function (left, right) {
        var leftTime = Date.parse(left.published || '') || 0;
        var rightTime = Date.parse(right.published || '') || 0;
        return rightTime - leftTime;
      });
    }

    function updateTimelineHeading(cacheState) {
      var scopeCount = getScopedSubscriptions().length;
      byId('center-title').textContent = selectedPodcast || '全部订阅';
      var pieces = [];
      if (allEpisodes.length) pieces.push('按时间线');
      if (selectedPodcast) pieces.push(allEpisodes.length + ' 期');
      else if (scopeCount) pieces.push(scopeCount + ' 档节目 · ' + allEpisodes.length + ' 期');
      if (cacheState === 'warming') pieces.push('正在补齐历史单集');
      byId('center-sub').textContent = pieces.join(' · ') || (scopeCount ? '正在读取订阅…' : '先添加一档节目，时间线会从这里开始');
    }

    function loadTimelineEpisodes(podcasts, force) {
      var scope = (Array.isArray(podcasts) ? podcasts : []).filter(function (podcast) { return podcast && podcast.name; });
      var requestToken = ++_timelineRequestToken;
      allEpisodes = [];
      currentPage = 1;
      resetEpisodeInspector();
      byId('episode-search').value = '';
      byId('episode-search').disabled = !scope.length;
      currentFilter = 'all';
      setFilterButtons('all');
      setHidden(byId('refresh-btn'), !scope.length);
      setHidden(byId('episode-empty'), true);
      setHidden(byId('episode-list'), false);
      updateTimelineHeading();
      if (!scope.length) {
        renderEpisodeList([]);
        return Promise.resolve([]);
      }

      renderSkeletons(Math.min(12, Math.max(4, scope.length * 3)));
      var previews = Promise.all(scope.map(function (podcast) {
        return fetchEpisodePage(String(podcast.name), force).catch(function () { return { episodes: [], cacheState: 'error' }; });
      }));
      return previews.then(function (previewResults) {
        if (requestToken !== _timelineRequestToken) return [];
        var previewEpisodes = [];
        var warming = false;
        previewResults.forEach(function (result, index) {
          if (result && result.cacheState === 'warming') warming = true;
          previewEpisodes = previewEpisodes.concat(decorateEpisodes(scope[index].name, result && result.episodes));
        });
        allEpisodes = sortEpisodeTimeline(previewEpisodes);
        updateTimelineHeading(warming ? 'warming' : 'complete');
        renderEpisodeList(getFilteredEpisodes());

        return Promise.all(scope.map(function (podcast) {
          return hydrateAllEpisodes(String(podcast.name)).catch(function () { return null; });
        })).then(function (fullResults) {
          if (requestToken !== _timelineRequestToken) return [];
          var merged = [];
          scope.forEach(function (podcast, index) {
            var full = fullResults[index];
            var source = full && Array.isArray(full.episodes) ? full.episodes : (previewResults[index] && previewResults[index].episodes);
            merged = merged.concat(decorateEpisodes(podcast.name, source));
          });
          allEpisodes = sortEpisodeTimeline(merged);
          updateTimelineHeading('complete');
          renderEpisodeList(getFilteredEpisodes());
          return allEpisodes;
        });
      }).catch(function (error) {
        if (requestToken !== _timelineRequestToken) return [];
        allEpisodes = [];
        renderEpisodeList([]);
        addLog('加载节目时间线失败：' + errorMessage(error), 'error');
        return [];
      });
    }

    function resetEpisodeInspector() {
      selectedEpisode = null;
      closeEpisodeSummary();
      setHidden(byId('episode-inspector'), true);
      byId('inspector-title').textContent = '';
      byId('inspector-meta').textContent = '';
      byId('inspector-summary').textContent = '';
      document.querySelectorAll('.episode-item').forEach(function (item) { item.classList.remove('is-selected'); });
    }

    function cleanEpisodeSummary(summary) {
      return String(summary || '这期节目暂时没有介绍。')
        .replace(/\s+-\s+/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function renderEpisodeInspector(episode) {
      selectedEpisode = episode;
      setHidden(byId('episode-inspector'), false);
      var task = completedTaskForEpisode(episode);
      var meta = [];
      if (!selectedPodcast && episode.podcast_name) meta.push(String(episode.podcast_name));
      if (episode.published) meta.push(new Date(episode.published).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }));
      var duration = formatDuration(episode.duration_seconds);
      if (duration) meta.push(duration);
      meta.push(isEpisodeRead(episode) ? '已读' : task ? '未读 · 已转录' : '未读 · 未转录');
      byId('inspector-title').textContent = String(episode.title || '未命名单集');
      byId('inspector-meta').textContent = meta.join(' · ');
      byId('inspector-summary').textContent = cleanEpisodeSummary(episode.summary);
      byId('episode-summary-title').textContent = String(episode.title || '未命名单集');
      byId('episode-summary-meta').textContent = meta.join(' · ');
      byId('episode-summary-copy').textContent = cleanEpisodeSummary(episode.summary);
      document.querySelectorAll('.episode-item').forEach(function (item) {
        item.classList.toggle('is-selected', item.dataset.episodeKey === episodeIdentity(episode));
      });
      if (isMobileViewport()) openEpisodeSummary();
    }

    function isMobileViewport() { return window.matchMedia && window.matchMedia('(max-width: 780px)').matches; }

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
      byId('center-sub').textContent = '正在打开节目…';
      byId('episode-search').disabled = false;
      loadEpisodes(name, false);
    }

    function getScopedEpisodes() {
      if (!selectedPodcast) return allEpisodes.slice();
      return allEpisodes.filter(function (episode) { return String(episode.podcast_name || '') === selectedPodcast; });
    }

    function getFilteredEpisodes() {
      var query = byId('episode-search').value.trim().toLowerCase();
      var filtered = getScopedEpisodes();
      if (currentFilter === 'readable') filtered = filtered.filter(function (episode) { return Boolean(completedTaskForEpisode(episode)); });
      else if (currentFilter === 'unread') filtered = filtered.filter(function (episode) { return !isEpisodeRead(episode); });
      else if (currentFilter === 'read') filtered = filtered.filter(function (episode) { return isEpisodeRead(episode); });
      if (query) {
        filtered = filtered.filter(function (episode) {
          return String(episode.title || '').toLowerCase().includes(query);
        });
      }
      return filtered;
    }

    function setFilter(filter) {
      currentFilter = filter;
      currentPage = 1;
      setFilterButtons(filter);
      renderEpisodeList(getFilteredEpisodes());
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
      var scoped = getScopedEpisodes();
      var readable = scoped.filter(function (episode) { return Boolean(completedTaskForEpisode(episode)); }).length;
      var unread = scoped.filter(function (episode) { return !isEpisodeRead(episode); }).length;
      var read = scoped.length - unread;
      var allCount = byId('filter-all-count');
      var readableCount = byId('filter-readable-count');
      var unreadCount = byId('filter-unread-count');
      var readCount = byId('filter-read-count');
      if (allCount) allCount.textContent = String(scoped.length);
      if (readableCount) readableCount.textContent = String(readable);
      if (unreadCount) unreadCount.textContent = String(unread);
      if (readCount) readCount.textContent = String(read);
    }

    function fetchEpisodePage(podcastName, force) {
      if (!force && _episodeCache[podcastName] && _episodeCache[podcastName].page) {
        return Promise.resolve(_episodeCache[podcastName].page);
      }
      var pageKey = String(podcastName) + '|page';
      if (!force && _episodeRequests.has(pageKey)) return _episodeRequests.get(pageKey);
      var url = appUrl('/api/read-podcast/episodes?podcast_name=' + encodeURIComponent(podcastName) + '&limit=' + PAGE_SIZE + (force ? '&force=true' : ''));
      var request = fetch(url)
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json().then(function (episodes) {
            return { episodes: Array.isArray(episodes) ? episodes : [], cacheState: response.headers.get('X-Read-Podcast-Cache-State') || 'complete' };
          });
        })
        .then(function (result) {
          _episodeCache[podcastName] = _episodeCache[podcastName] || {};
          _episodeCache[podcastName].page = result;
          if (force) delete _episodeCache[podcastName].full;
          return result;
        })
        .finally(function () { _episodeRequests.delete(pageKey); });
      if (!force) _episodeRequests.set(pageKey, request);
      return request;
    }

    function prefetchEpisodePages(podcasts) {
      var queue = (Array.isArray(podcasts) ? podcasts : [])
        .map(function (podcast) { return podcast && podcast.name ? String(podcast.name) : ''; })
        .filter(Boolean);
      if (!queue.length) return;
      var cursor = 0;
      var warm = window.requestIdleCallback || function (callback) { window.setTimeout(callback, 120); };
      function next() {
        if (cursor >= queue.length) return;
        var podcastName = queue[cursor++];
        fetchEpisodePage(podcastName, false).catch(function () {}).finally(next);
      }
      warm(function () { next(); next(); });
    }

    function hydrateAllEpisodes(podcastName) {
      var cached = _episodeCache[podcastName];
      if (cached && cached.full) return Promise.resolve(cached.full);
      var fullKey = String(podcastName) + '|full';
      if (_episodeRequests.has(fullKey)) return _episodeRequests.get(fullKey);
      var url = appUrl('/api/read-podcast/episodes?podcast_name=' + encodeURIComponent(podcastName) + '&limit=0');
      var request = fetch(url)
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json().then(function (episodes) {
            return { episodes: Array.isArray(episodes) ? episodes : [], cacheState: response.headers.get('X-Read-Podcast-Cache-State') || 'complete' };
          });
        })
        .then(function (result) {
          _episodeCache[podcastName] = _episodeCache[podcastName] || {};
          if (result.cacheState === 'warming') return null;
          _episodeCache[podcastName].full = result;
          return result;
        })
        .finally(function () { _episodeRequests.delete(fullKey); });
      _episodeRequests.set(fullKey, request);
      return request;
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

    function completedTaskForEpisode(episode) {
      var podcastName = episode && episode.podcast_name ? episode.podcast_name : selectedPodcast;
      var key = String(podcastName || '') + '::' + (episode ? episode.title : '');
      if (_taskHistoryMap[key]) return _taskHistoryMap[key];
      if (episode && episode.task_id && (episode.status === 'success' || episode.status === 'completed' || episode.completed === true)) return { id: episode.task_id, episode_title: episode.title, podcast_name: podcastName, status: 'success' };
      return null;
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
      var actions = document.createElement('div');
      actions.className = 'episode-actions';
      var primaryButton = document.createElement('button');
      primaryButton.type = 'button';
      primaryButton.className = 'episode-action' + (task ? '' : ' primary');
      primaryButton.textContent = task ? '阅读' : '转录';
      primaryButton.addEventListener('click', function (event) {
        event.stopPropagation();
        renderEpisodeInspector(episode);
        // 已完成节目的主按钮是「阅读」；只有未转录时才隐式触发转录（force=false）。
        if (task) openManuscript(task.id, episode);
        else triggerEpisode(String(episode.podcast_name || selectedPodcast || ''), String(episode.title || ''), event, false);
      });
      actions.appendChild(primaryButton);
      if (task) {
        var rerunButton = document.createElement('button');
        rerunButton.type = 'button';
        rerunButton.className = 'episode-action rerun';
        rerunButton.textContent = '重新转录';
        rerunButton.setAttribute('aria-label', '重新转录「' + String(episode.title || '这期节目') + '」');
        rerunButton.addEventListener('click', function (event) {
          event.stopPropagation();
          renderEpisodeInspector(episode);
          // 重新转录是唯一允许对已完成节目重跑的入口：显式 force=true。
          triggerEpisode(String(episode.podcast_name || selectedPodcast || ''), String(episode.title || ''), event, true);
        });
        actions.appendChild(rerunButton);
      }
      return actions;
    }

    function renderEpisodeList(episodes) {
      var container = byId('episode-list');
      var pagination = byId('episode-pagination');
      container.replaceChildren();
      updateFilterCounts();
      if (!episodes.length) {
        var empty = document.createElement('div'); empty.className = 'empty-state';
        empty.textContent = _subscriptions.length ? '没有符合条件的单集' : '还没有订阅节目，先添加一档播客。';
        container.appendChild(empty);
        setHidden(pagination, true);
        return;
      }
      var totalPages = Math.max(1, Math.ceil(episodes.length / PAGE_SIZE));
      currentPage = Math.min(Math.max(1, currentPage), totalPages);
      var start = (currentPage - 1) * PAGE_SIZE;
      var visibleEpisodes = episodes.slice(start, start + PAGE_SIZE);
      var fragment = document.createDocumentFragment();
      visibleEpisodes.forEach(function (episode, index) {
        var task = completedTaskForEpisode(episode);
        var row = document.createElement('article');
        row.className = 'episode-item';
        row.tabIndex = 0;
        row.dataset.episodeTitle = String(episode.title || '');
        row.dataset.episodeKey = episodeIdentity(episode);
        row.setAttribute('aria-label', '查看「' + String(episode.title || '未命名单集') + '」的介绍');
        row.style.setProperty('--item-index', index);
        if (selectedEpisode && episodeIdentity(selectedEpisode) === episodeIdentity(episode)) row.classList.add('is-selected');
        var copy = document.createElement('div'); copy.className = 'ep-copy';
        var meta = document.createElement('div'); meta.className = 'ep-meta';
        var source = document.createElement('button');
        source.type = 'button';
        source.className = 'episode-source';
        source.textContent = String(episode.podcast_name || '订阅节目');
        source.setAttribute('aria-label', '只看「' + source.textContent + '」的节目');
        source.addEventListener('click', function (event) {
          event.stopPropagation();
          selectPodcast(String(episode.podcast_name || ''));
        });
        var read = isEpisodeRead(episode);
        var status = document.createElement('span'); status.className = 'status-tag' + (read ? ' read' : task ? ' complete' : ''); status.textContent = read ? '已读' : task ? '未读 · 已转录' : '未读 · 未转录';
        var date = document.createElement('span');
        date.textContent = episode.published ? new Date(episode.published).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '--';
        meta.append(source, status, date);
        var duration = formatDuration(episode.duration_seconds);
        if (duration) { var durationNode = document.createElement('span'); durationNode.textContent = duration; meta.appendChild(durationNode); }
        var title = document.createElement('div'); title.className = 'ep-title'; title.textContent = String(episode.title || '未命名单集');
        copy.append(meta, title);
        var actions = makeEpisodeActions(task, episode);
        row.append(copy, actions);
        row.addEventListener('click', function () { renderEpisodeInspector(episode); });
        row.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); renderEpisodeInspector(episode); }
        });
        fragment.append(row);
      });
      container.appendChild(fragment);
      byId('page-label').textContent = '第 ' + currentPage + ' / ' + totalPages + ' 页';
      byId('page-prev').disabled = currentPage <= 1;
      byId('page-next').disabled = currentPage >= totalPages;
      setHidden(pagination, totalPages <= 1);
    }

    var _submittingEpisodes = {};
    function triggerEpisode(podcastName, title, event, force) {
      if (event) event.stopPropagation();
      var sourceName = String(podcastName || selectedPodcast || '').trim();
      if (!sourceName) { addLog('错误：未找到节目来源', 'error'); return; }
      var button = event && event.currentTarget && event.currentTarget.tagName === 'BUTTON' ? event.currentTarget : null;
      _currentTaskPodcastName = sourceName;
      var episodeKey = sourceName + '::' + title;
      // 客户端防抖：同一节目在提交完成前忽略后续点击，避免误触重复入队。
      if (_submittingEpisodes[episodeKey]) return;
      _submittingEpisodes[episodeKey] = true;
      if (button) button.disabled = true;
      setHidden(byId('task-card'), false);
      setTaskStatus('正在转录', 0);
      var url = appUrl('/api/read-podcast/tasks?podcast_name=' + encodeURIComponent(sourceName)
        + '&episode_title=' + encodeURIComponent(title)
        + (force ? '&force=true' : ''));
      fetch(url, { method: 'POST' })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) { var err = new Error(data.detail || ('HTTP ' + response.status)); err.status = response.status; throw err; }
            return data;
          });
        })
        .then(function (data) {
          if (data.status === 'existing') addLog('该节目已在转录队列中，已切换到进行中的任务。', 'info');
          subscribeSSE(data.task_id, title);
        })
        .catch(function (error) {
          if (error && error.status === 409) {
            setTaskStatus(error.message || '该节目已转录完成，如需重做请点击「重新转录」。', 0);
            setTaskBadge('info', '已完成');
            addLog(error.message || '节目已转录完成', 'info');
          } else {
            setTaskStatus('这次没有转录成功，请稍后再试。', 0);
            setTaskBadge('error', '未成功');
          }
        })
        .finally(function () {
          delete _submittingEpisodes[episodeKey];
          if (button) button.disabled = false;
        });
    }

    function submitCustomTask() {
      var audioPath = _uploadedAudioPath;
      var prompt = byId('custom-prompt').value.trim();
      if (!audioPath) { setHidden(byId('task-card'), false); setTaskStatus('请先选择音频文件。', 0); setTaskBadge('error', '还差一步'); return; }
      if (!prompt) { setHidden(byId('task-card'), false); setTaskStatus('请选择一种文字样式。', 0); setTaskBadge('error', '还差一步'); return; }
      var button = byId('custom-submit-btn');
      button.disabled = true; button.textContent = '转录中…';
      setHidden(byId('download-result-wrap'), true);
      setHidden(byId('task-card'), false);
      setTaskStatus('正在转录', 0);
      fetch(appUrl('/api/read-podcast/tasks/custom'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_filename: audioPath, custom_prompt: prompt }) })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok || data.detail) throw new Error(data.detail || 'HTTP ' + response.status); return data; }); })
        .then(function (data) { subscribeSSE(data.task_id, audioPath); })
        .catch(function () { setTaskStatus('这次没有转录成功，请稍后再试。', 0); setTaskBadge('error', '未成功'); })
        .finally(function () { button.disabled = false; button.textContent = '转录'; });
    }

    var _pollTimers = {};
    var STAGE_LABELS = { queued: '准备', resolving: '准备', downloading: '下载', transcribing: '转录', refining: '精修', finalizing: '生成', done: '完成', error: '失败', cancelled: '已取消' };
    var STAGE_STEP_INDEX = { queued: 0, resolving: 0, downloading: 1, transcribing: 2, refining: 3, finalizing: 4, done: 4 };
    function clearPolling(taskId) {
      if (taskId) {
        if (_pollTimers[taskId]) { clearInterval(_pollTimers[taskId]); delete _pollTimers[taskId]; }
        return;
      }
      Object.keys(_pollTimers).forEach(function (id) { clearPolling(id); });
    }
    function closeActiveStream() {
      clearPolling();
      if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
      if (globalEventSource) { globalEventSource.close(); globalEventSource = null; }
    }
    function taskElapsed(startedAt) {
      var seconds = Math.max(0, Math.floor((Date.now() - (startedAt || Date.now())) / 1000));
      return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }
    function renderTaskQueue() {
      var list = byId('task-list');
      var ids = Object.keys(_taskCards);
      setHidden(byId('task-card'), !ids.length);
      byId('task-queue-count').textContent = ids.length ? ids.length + ' 项' : '';
      list.replaceChildren();
      ids.reverse().forEach(function (id, index) {
        var task = _taskCards[id];
        var card = document.createElement('article'); card.className = 'task-queue-item'; card.style.setProperty('--item-index', index);
        var top = document.createElement('div'); top.className = 'task-topline';
        var title = document.createElement('h2'); title.textContent = task.title || '转录任务';
        var badge = document.createElement('span'); badge.className = 'badge ' + (task.status === 'success' ? 'badge-success' : (task.status === 'failed' || task.status === 'cancelled') ? 'badge-error' : 'badge-accent'); badge.textContent = task.status === 'success' ? '已完成' : task.status === 'cancelled' ? '已取消' : task.status === 'failed' ? '未成功' : '转录中';
        top.append(title, badge);
        var meta = document.createElement('div'); meta.className = 'task-meta'; meta.innerHTML = '<span>' + escapeHtml(STAGE_LABELS[task.stage] || '处理中') + ' · ' + escapeHtml(taskElapsed(task.startedAt)) + '</span><span>' + task.progress + '%</span>';
        var status = document.createElement('h3'); status.className = 'task-stage'; status.setAttribute('aria-live', 'polite'); status.textContent = task.message || ('正在' + (STAGE_LABELS[task.stage] || '处理') + '…');
        var progress = document.createElement('div'); progress.className = 'progress-bar'; progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100'); progress.setAttribute('aria-valuenow', String(task.progress));
        var inner = document.createElement('div'); inner.className = 'progress-inner'; inner.style.width = task.progress + '%'; progress.appendChild(inner);
        var steps = document.createElement('div'); steps.className = 'task-steps';
        var activeStep = Object.prototype.hasOwnProperty.call(STAGE_STEP_INDEX, task.stage) ? STAGE_STEP_INDEX[task.stage] : -1;
        ['准备', '下载', '转录', '精修', '生成'].forEach(function (label, stepIndex) { var step = document.createElement('span'); step.textContent = label; step.className = stepIndex <= activeStep ? 'is-active' : ''; steps.appendChild(step); });
        card.append(top, meta, status, progress, steps);
        if (task.status === 'running' || task.status === 'pending') {
          var cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'task-cancel';
          cancelBtn.textContent = '取消任务';
          cancelBtn.setAttribute('aria-label', '取消「' + String(task.title || '转录任务') + '」');
          cancelBtn.addEventListener('click', function () { cancelTask(id, cancelBtn); });
          card.appendChild(cancelBtn);
        } else if (task.status === 'failed' || task.status === 'cancelled') {
          var actions = document.createElement('div'); actions.className = 'task-actions';
          if (id !== 'local') {
            var retryBtn = document.createElement('button'); retryBtn.type = 'button'; retryBtn.className = 'task-action task-action-primary'; retryBtn.textContent = '重试'; retryBtn.addEventListener('click', function () { retryTask(id, retryBtn); });
            actions.appendChild(retryBtn);
          }
          var clearBtn = document.createElement('button'); clearBtn.type = 'button'; clearBtn.className = 'task-action'; clearBtn.textContent = '清理'; clearBtn.addEventListener('click', function () { clearTask(id, clearBtn); });
          actions.appendChild(clearBtn); card.appendChild(actions);
        }
        list.appendChild(card);
      });
    }
    function clearTask(taskId, button) {
      var id = String(taskId || '');
      if (!id) return;
      if (id === 'local') { delete _taskCards[id]; renderTaskQueue(); return; }
      if (button) { button.disabled = true; button.textContent = '清理中…'; }
      fetch(safeTaskUrl(id, ''), { method: 'DELETE' })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.detail || ('HTTP ' + response.status)); return data; }); })
        .then(function () { delete _taskCards[id]; clearPolling(id); renderTaskQueue(); loadHistory(); addLog('失败记录已清理，原音频仍然保留。', 'info'); })
        .catch(function (error) { if (button) { button.disabled = false; button.textContent = '清理'; } addLog(errorMessage(error), 'warning'); });
    }
    function retryTask(taskId, button) {
      var id = String(taskId || '');
      var oldTask = _taskCards[id];
      if (!id || !oldTask) return;
      if (button) { button.disabled = true; button.textContent = '重试中…'; }
      fetch(safeTaskUrl(id, '/retry'), { method: 'POST' })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.detail || ('HTTP ' + response.status)); return data; }); })
        .then(function (data) {
          delete _taskCards[id]; clearPolling(id);
          subscribeSSE(data.task_id, oldTask.title);
          loadHistory(); addLog('已使用保留的原音频重新排队。', 'info');
        })
        .catch(function (error) { if (button) { button.disabled = false; button.textContent = '重试'; } addLog(errorMessage(error), 'warning'); });
    }
    function cancelTask(taskId, button) {
      var id = String(taskId || '');
      if (!id) return;
      if (button) { button.disabled = true; button.textContent = '取消中…'; }
      fetch(safeTaskUrl(id, ''), { method: 'DELETE' })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) { var err = new Error(data.detail || ('HTTP ' + response.status)); err.status = response.status; throw err; }
            return data;
          });
        })
        .then(function () {
          addLog('已发送取消请求，正在停止任务…', 'info');
          if (_taskCards[id]) { _taskCards[id].message = '正在取消…'; renderTaskQueue(); }
        })
        .catch(function (error) {
          addLog(error && error.message ? error.message : '取消任务失败', 'warning');
          if (button) { button.disabled = false; button.textContent = '取消任务'; }
        });
    }
    function ensureTaskCard(taskId, title) {
      var id = String(taskId || 'local');
      if (!_taskCards[id]) _taskCards[id] = { title: title || '转录任务', stage: 'queued', progress: 0, status: 'running', startedAt: Date.now(), message: '已加入整理流水线…' };
      if (title) _taskCards[id].title = title;
      _taskStartedAt[id] = _taskCards[id].startedAt;
      return _taskCards[id];
    }
    function applyPublicTask(task) {
      var id = String(task.id || ''); if (!id) return null;
      if (task.podcast_name) _currentTaskPodcastName = String(task.podcast_name);
      var card = ensureTaskCard(id, task.episode_title);
      card.status = String(task.status || 'pending');
      card.stage = String(task.stage || 'queued');
      card.progress = Math.max(0, Math.min(100, Number(task.progress_pct) || 0));
      card.message = String(task.message || '');
      card.startedAt = new Date(task.created_at || Date.now()).getTime();
      return card;
    }
    function handleTaskFinished(taskId, succeeded, details) {
      var task = ensureTaskCard(taskId);
      details = details || {};
      task.status = succeeded ? 'success' : 'failed';
      if (succeeded) { task.stage = 'done'; task.progress = 100; }
      else {
        if (details.stage) task.stage = details.stage;
        if (details.progress !== undefined) task.progress = Math.max(0, Math.min(100, Number(details.progress) || 0));
      }
      task.message = details.message || (succeeded ? '文字已经准备好了。' : '转录或整理未成功；原音频已保留，可直接重试。');
      renderTaskQueue();
      loadHistory();
      if (succeeded) {
        byId('download-result-btn').href = safeTaskUrl(taskId, '/download');
        byId('read-result-btn').onclick = function () { openManuscript(taskId); };
        setHidden(byId('download-result-wrap'), false);
        addLog('任务全流程处理成功', 'success');
      } else addLog('任务处理失败', 'error');
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, succeeded ? 'var(--success)' : 'var(--error)', false);
    }
    function handleTaskCancelled(taskId) {
      var task = ensureTaskCard(taskId);
      task.status = 'cancelled'; task.message = task.message || '任务已取消；原音频已保留，可直接重试。';
      clearPolling(String(taskId || ''));
      renderTaskQueue();
      loadHistory();
      addLog('任务已取消', 'info');
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, 'var(--error)', false);
    }
    function startPolling(taskId) {
      var id = String(taskId || '');
      if (!id || _pollTimers[id]) return;
      _pollTimers[id] = setInterval(function () {
        fetch(safeTaskUrl(id, ''))
          .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
          .then(function (task) {
            if (!task || !task.status) return;
            applyPublicTask(task);
            setTaskStatus(task.stage, task.progress_pct || 0, id, task.episode_title, task.message);
            if (task.status === 'success') { clearPolling(id); handleTaskFinished(id, true, { message: task.message }); }
            else if (task.status === 'cancelled') { clearPolling(id); handleTaskCancelled(id); }
            else if (task.status === 'failed') { clearPolling(id); handleTaskFinished(id, false, { stage: task.stage, progress: task.progress_pct, message: task.message }); }
          })
          .catch(function () {});
      }, 3000);
    }
    function ensureGlobalSSE() {
      if (globalEventSource) return;
      globalEventSource = new EventSource(appUrl('/api/read-podcast/tasks/stream'));
      globalEventSource.onmessage = function (event) {
        var data;
        try { data = JSON.parse(event.data); } catch (error) { addLog('收到无法解析的日志事件', 'warning'); return; }
        var id = String(data.task_id || _currentTaskId || ''); if (!id) return;
        ensureTaskCard(id);
        var level = data.level === 'done' ? 'success' : (data.progress > 0 && data.progress < 100 ? 'running' : data.level);
        addLog(data.message, level);
        if (data.progress !== undefined) setTaskStatus(data.stage, data.progress, id, null, data.message);
        if (data.status === 'cancelled' || data.stage === 'cancelled') handleTaskCancelled(id);
        else if (data.level === 'done' || data.level === 'error') handleTaskFinished(id, data.level === 'done', data);
        else { _taskCards[id].status = 'running'; setPodcastDot(_currentTaskPodcastName || selectedPodcast, 'var(--rust)', true); }
      };
      globalEventSource.onerror = function () {
        if (globalEventSource) { globalEventSource.close(); globalEventSource = null; }
        addLog('日志流已断开，切换至轮询模式……', 'info');
        Object.keys(_taskCards).filter(function (id) { return _taskCards[id].status === 'running'; }).forEach(startPolling);
      };
    }
    function subscribeSSE(taskId, title) {
      _currentTaskId = String(taskId || '');
      if (_currentTaskId !== 'local' && _taskCards.local && !_taskCards[_currentTaskId]) {
        _taskCards[_currentTaskId] = _taskCards.local; delete _taskCards.local;
      }
      ensureTaskCard(_currentTaskId, title);
      renderTaskQueue();
      ensureGlobalSSE();
      setPodcastDot(_currentTaskPodcastName || selectedPodcast, 'var(--rust)', true);
    }

    function setPodcastDot(name, color, pulsing) {
      if (!name) return;
      document.querySelectorAll('.podcast-item').forEach(function (item) {
        if (item.dataset.name === name && item._statusDot) { item._statusDot.style.background = color; item._statusDot.classList.toggle('dot-pulse', Boolean(pulsing)); }
      });
    }

    function loadHistory() {
      return fetch(appUrl('/api/read-podcast/tasks'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (tasks) {
          _taskHistory = Array.isArray(tasks) ? tasks : [];
          _taskHistoryMap = {};
          _taskHistory.forEach(function (task) {
            var key = task.podcast_name + '::' + task.episode_title;
            if (task.status === 'success' && !_taskHistoryMap[key]) {
              _taskHistoryMap[key] = task;
            }
          });
          var visibleTaskIds = {};
          _taskHistory.forEach(function (task) {
            if (task.status === 'pending' || task.status === 'running' || task.status === 'failed' || task.status === 'cancelled') {
              visibleTaskIds[String(task.id)] = true;
              applyPublicTask(task);
              if (task.status === 'pending' || task.status === 'running') startPolling(task.id);
            }
          });
          Object.keys(_taskCards).forEach(function (id) {
            if (id !== 'local' && !visibleTaskIds[id] && _taskCards[id].status !== 'success') delete _taskCards[id];
          });
          renderTaskQueue();
          fetch(appUrl('/api/read-podcast/tasks/completed-keys'))
            .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
            .then(function (completed) {
              _taskHistoryMap = {};
              (Array.isArray(completed) ? completed : []).forEach(function (item) { _taskHistoryMap[item.key] = _taskHistory.find(function (task) { return String(task.id) === String(item.task_id); }) || { id: item.task_id, status: 'success', podcast_name: item.key.split('::')[0], episode_title: item.key.split('::').slice(1).join('::') }; });
            })
            .catch(function () {})
            .finally(function () { renderHistory(_taskHistory.slice(0, 7)); });
          loadLibrary(_taskHistory);
          if (allEpisodes.length) {
            renderEpisodeList(getFilteredEpisodes());
            if (selectedEpisode) renderEpisodeInspector(selectedEpisode);
          }
        })
        .catch(function () {});
    }

    function renderHistory(tasks) {
      var list = byId('history-list');
      list.replaceChildren();
      if (!tasks.length) { list.innerHTML = '<p class="history-empty">完成稿件会出现在这里。</p>'; return; }
      tasks.forEach(function (task, index) {
        var succeeded = task.status === 'success';
        var item = document.createElement('button'); item.type = 'button'; item.className = 'history-item'; item.style.setProperty('--item-index', index);
        var copy = document.createElement('span'); copy.style.minWidth = '0';
        var title = document.createElement('span'); title.className = 'history-title'; title.style.display = 'block'; title.textContent = String(task.episode_title || '未命名任务');
        var source = document.createElement('span'); source.className = 'history-source'; source.style.display = 'block'; source.textContent = String(task.podcast_name || '自定义');
        copy.append(title, source);
        var badge = document.createElement('span'); badge.className = 'badge ' + (succeeded ? 'badge-success' : task.status === 'failed' ? 'badge-error' : 'badge-accent'); badge.textContent = succeeded ? '阅读' : task.status === 'failed' ? '失败' : '进行中';
        item.append(copy, badge);
        item.addEventListener('click', function () { if (succeeded) openManuscript(task.id); else { applyPublicTask(task); renderTaskQueue(); } });
        list.appendChild(item);
      });
    }

    function renderLibrary(tasks) {
      var list = byId('library-list');
      var query = String(byId('library-search').value || '').trim().toLowerCase();
      list.replaceChildren();
      var visible = (Array.isArray(tasks) ? tasks : []).filter(function (task) {
        return task.status === 'success' && (!query || String(task.episode_title || '').toLowerCase().includes(query));
      });
      if (!visible.length) { list.innerHTML = '<p class="library-empty">暂时没有匹配的稿件。</p>'; return; }
      visible.forEach(function (task, index) {
        var item = document.createElement('article'); item.className = 'library-item'; item.style.setProperty('--item-index', index);
        var copy = document.createElement('div');
        var title = document.createElement('strong'); title.textContent = String(task.episode_title || '未命名任务');
        var meta = document.createElement('span'); meta.textContent = String(task.podcast_name || '本地音频') + ' · ' + new Date(task.updated_at || task.created_at).toLocaleString('zh-CN');
        copy.append(title, meta);
        var actions = document.createElement('div'); actions.className = 'library-actions';
        var read = document.createElement('button'); read.type = 'button'; read.className = 'episode-action'; read.textContent = '阅读'; read.addEventListener('click', function () { openManuscript(task.id); });
        var download = document.createElement('a'); download.className = 'download-btn'; download.href = safeTaskUrl(task.id, '/download'); download.download = ''; download.textContent = '下载';
        actions.append(read, download); item.append(copy, actions); list.appendChild(item);
      });
    }

    function loadLibrary(tasks) {
      if (Array.isArray(tasks) && tasks.length) { _libraryTasks = tasks; renderLibrary(_libraryTasks); return Promise.resolve(_libraryTasks); }
      return fetch(appUrl('/api/read-podcast/tasks?limit=200'))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (data) { _libraryTasks = Array.isArray(data) ? data : []; renderLibrary(_libraryTasks); return _libraryTasks; })
        .catch(function (error) { addLog('稿件库加载失败：' + errorMessage(error), 'warning'); });
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
      var copy = document.createElement('span'); copy.className = 'toast-copy'; copy.textContent = text;
      var close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', '关闭提示'); close.textContent = '×';
      close.addEventListener('click', function () { toast.remove(); delete _toastState[key]; }); toast.append(copy, close); byId('toast-container').appendChild(toast);
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
      task.message = message || (task.progress >= 100 ? '文字已经准备好了。' : ('正在' + (STAGE_LABELS[task.stage] || '处理') + '…'));
      renderTaskQueue();
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
      byId('drawer-search').value = ''; byId('drawer-results').replaceChildren(); setHidden(byId('drawer-confirm-footer'), true); byId('manual-rss-url').value = ''; byId('manual-pod-name').value = ''; _drawerSelected = null; setDrawerMode('search');
    }
    function setDrawerMode(mode) {
      _drawerMode = mode;
      var manual = mode === 'manual';
      setHidden(byId('drawer-manual'), !manual); setHidden(byId('drawer-results'), manual);
      byId('mode-search-btn').classList.toggle('active', !manual); byId('mode-manual-btn').classList.toggle('active', manual);
      if (manual) {
        setHidden(byId('drawer-confirm-footer'), true);
      } else if (_drawerSelected) {
        setHidden(byId('drawer-confirm-footer'), false);
      }
    }
    function onDrawerSearch(value) {
      clearTimeout(_drawerSearchTimer);
      var query = value.trim();
      if (!query) { byId('drawer-results').replaceChildren(); return; }
      byId('drawer-results').textContent = '搜索中……';
      _drawerSearchTimer = setTimeout(function () { fetchSearchResults(query); }, 500);
    }
    function fetchSearchResults(query) {
      fetch(appUrl('/api/read-podcast/search/podcast?q=' + encodeURIComponent(query)))
        .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
        .then(function (items) { renderSearchResults(Array.isArray(items) ? items : []); })
        .catch(function () { renderSearchResults([]); });
    }
    function renderSearchResults(items) {
      var results = byId('drawer-results'); results.replaceChildren();
      if (!items.length) {
        var empty = document.createElement('div'); empty.className = 'empty-state'; empty.style.minHeight = '180px';
        var message = document.createElement('div'); message.textContent = '未找到结果，或 iTunes 暂时不可用。';
        var manualButton = document.createElement('button'); manualButton.type = 'button'; manualButton.className = 'ghost-btn'; manualButton.style.marginTop = '12px'; manualButton.textContent = '手动输入 RSS URL'; manualButton.addEventListener('click', function () { setDrawerMode('manual'); });
        message.appendChild(manualButton); empty.appendChild(message); results.appendChild(empty); return;
      }
      items.forEach(function (podcast, index) {
        var item = document.createElement('button'); item.type = 'button'; item.className = 'search-result'; item.style.setProperty('--item-index', index);
        var monogram = makeArtworkTile(podcast.image, podcast.name, 'result-monogram');
        var copy = document.createElement('span'); copy.style.minWidth = '0';
        var name = document.createElement('span'); name.className = 'result-name'; name.style.display = 'block'; name.textContent = String(podcast.name || '未命名播客');
        var meta = document.createElement('span'); meta.className = 'result-meta'; meta.style.display = 'block'; meta.textContent = [podcast.artist, podcast.genre, podcast.track_count ? podcast.track_count + ' 集' : ''].filter(Boolean).join(' · ');
        copy.append(name, meta);
        var arrow = document.createElement('span'); arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
        item.append(monogram, copy, arrow); item.addEventListener('click', function () { selectDrawerCandidate(String(podcast.name || ''), String(podcast.rss_url || ''), String(podcast.image || '')); }); results.appendChild(item);
      });
    }
    function selectDrawerCandidate(name, rssUrl, image) { _drawerSelected = { name: name, rss_url: rssUrl, image: image || '' }; byId('drawer-selected-name').textContent = name; byId('drawer-selected-rss').textContent = rssUrl; setHidden(byId('drawer-confirm-footer'), false); }
    function clearDrawerSelection() { _drawerSelected = null; setHidden(byId('drawer-confirm-footer'), true); }
    function confirmSelectedPodcast() { if (_drawerSelected) confirmAddPodcast(_drawerSelected.name, _drawerSelected.rss_url, _drawerSelected.image); }
    function confirmAddPodcast(name, rssUrl, image) {
      var cleanName = String(name || '').trim(); var cleanUrl = String(rssUrl || '').trim();
      if (!cleanName || !cleanUrl) { addLog('错误：节目名称和 RSS URL 均不能为空', 'error'); return; }
      var buttons = [byId('confirm-add-btn'), byId('manual-add-btn')]; buttons.forEach(function (button) { button.disabled = true; });
      addLog('正在验证 RSS：' + cleanName, 'running');
      fetch(appUrl('/api/read-podcast/subscriptions'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cleanName, rss_url: cleanUrl, image: String(image || '') }) })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.detail || 'HTTP ' + response.status); return data; }); })
        .then(function () { addLog('节目「' + cleanName + '」已成功订阅', 'success'); closeDrawer(); loadSubscriptions(); })
        .catch(function (error) { addLog('添加失败：' + errorMessage(error), 'error'); })
        .finally(function () { buttons.forEach(function (button) { button.disabled = false; }); });
    }

    var _tocObserver = null;

    function updateReaderStats(rawText) {
      var cleanText = String(rawText || '').replace(/^\s*---\s*\n[\s\S]*?\n---\s*\n*/, '').replace(/\s+/g, '');
      var count = cleanText.length;
      var minutes = Math.max(1, Math.round(count / 750));
      var countStr = count >= 10000 ? (count / 10000).toFixed(1) + ' 万字' : count + ' 字';
      var statsEl = byId('reader-meta-stats');
      if (statsEl) {
        statsEl.textContent = count ? (countStr + ' · 预计阅读 ' + minutes + ' 分钟') : '';
      }
    }

    function updateReaderProgress(percent) {
      var bounded = Math.min(100, Math.max(0, Number(percent) || 0));
      var progressRange = byId('reader-progress-range');
      var progressValue = byId('reader-progress-value');
      if (progressRange) progressRange.value = String(bounded);
      if (progressValue) progressValue.textContent = Math.round(bounded) + '%';
      if (bounded >= 99.5 && _currentReadingEpisode && !isEpisodeRead(_currentReadingEpisode)) {
        setEpisodeRead(_currentReadingEpisode, true);
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

    function renderBasicMarkdown(markdown) {
      if (markdown == null) return '';
      var raw = String(markdown).replace(/\r\n?/g, '\n');
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

    function setFontSize(size) {
      _currentFontSize = Math.max(14, Math.min(28, size));
      byId('manuscript-body').style.fontSize = _currentFontSize + 'px';
      localStorage.setItem('reader_font_size', _currentFontSize);
    }

    function setTheme(theme) {
      _currentTheme = theme;
      var normalizedTheme = theme === 'light' ? 'paper' : theme;
      document.documentElement.dataset.theme = normalizedTheme;
      var colorScheme = document.querySelector('meta[name="color-scheme"]');
      if (colorScheme) colorScheme.setAttribute('content', theme === 'dark' ? 'dark' : 'light');
      var sheet = document.querySelector('.reader-sheet');
      if (sheet) {
        sheet.classList.remove('theme-green', 'theme-dark');
        if (theme === 'green') {
          sheet.classList.add('theme-green');
        } else if (theme === 'dark') {
          sheet.classList.add('theme-dark');
        }
      }
      localStorage.setItem('reader_theme', theme);
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

    function openManuscript(taskId, episode) {
      var cleanId = String(taskId || '').trim();
      if (!cleanId) return;
      closeEpisodeSummary();
      _currentReadingTaskId = cleanId;
      resetAssistant();
      var task = _taskHistory.find(function (item) { return String(item.id) === cleanId; });
      _currentReadingEpisode = episode || (task ? { podcast_name: task.podcast_name, title: task.episode_title } : null);
      byId('reader-title').textContent = task && task.episode_title ? String(task.episode_title) : '阅读';
      byId('reader-download').href = safeTaskUrl(cleanId, '/download');
      updateReaderReadState();
      
      var tocContainer = byId('reader-toc');
      setHidden(tocContainer, true);
      tocContainer.replaceChildren();
      byId('manuscript-body').innerHTML = '<div class="reader-state reader-loading">正在展开稿纸</div>';
      
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
      
      var savedFontSize = localStorage.getItem('reader_font_size');
      setFontSize(savedFontSize ? parseInt(savedFontSize, 10) : 19);
      var savedTheme = localStorage.getItem('reader_theme');
      setTheme(savedTheme || 'light');

      fetch(safeTaskUrl(cleanId, '/content'))
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
            byId('manuscript-body').innerHTML = '<div class="reader-state">稿件内容为空。</div>'; 
            updateReaderStats('');
            return; 
          }
          
          updateReaderStats(result.content);
          var renderedHtml = renderBasicMarkdown(result.content);
          byId('manuscript-body').innerHTML = renderedHtml;
          
          var headings = byId('manuscript-body').querySelectorAll('h1, h2, h3');
          var tocLinks = [];
          if (headings.length > 0) {
            var tocTitle = document.createElement('h3');
            tocTitle.textContent = '大纲目录';
            tocContainer.appendChild(tocTitle);
            
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
          setHidden(tocContainer, headings.length === 0 && !_assistantAvailable);

          var saved = localStorage.getItem('scroll_pos_' + cleanId);
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
          state.textContent = '稿件读取失败：' + errorMessage(error); 
          byId('manuscript-body').appendChild(state); 
          updateReaderStats('');
        });
    }

    // ── 关键概念 → 维基百科 ────────────────────────────────
    // 抽取要过一次 AI，默认不自动触发；点一次按钮，结果由后端按稿件缓存。

    function renderConceptsSection(taskId, container) {
      if (!_assistantAvailable) return;

      var section = document.createElement('div');
      section.className = 'concepts-section';

      var title = document.createElement('h3');
      title.textContent = '关键概念';
      section.appendChild(title);

      var body = document.createElement('div');
      body.className = 'concepts-body';
      section.appendChild(body);

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'concepts-load-btn';
      button.textContent = '抓取关键概念';
      button.addEventListener('click', function () {
        loadConcepts(taskId, body, button);
      });
      body.appendChild(button);

      container.appendChild(section);
    }

    function loadConcepts(taskId, body, button) {
      button.disabled = true;
      button.textContent = '正在抽取…';

      fetch(safeTaskUrl(taskId, '/concepts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
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
          if (!concepts.length) {
            var empty = document.createElement('div');
            empty.className = 'concepts-empty';
            empty.textContent = '没有找到可链接到维基百科的概念。';
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
        })
        .catch(function (error) {
          body.replaceChildren();
          var failed = document.createElement('div');
          failed.className = 'concepts-empty';
          failed.textContent = '抽取失败：' + errorMessage(error);
          body.appendChild(failed);
          var retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'concepts-load-btn';
          retry.textContent = '重试';
          retry.addEventListener('click', function () { loadConcepts(taskId, body, retry); });
          body.appendChild(retry);
        });
    }

    function closeManuscript() {
      _currentReadingTaskId = null;
      _currentReadingEpisode = null;
      updateReaderReadState();
      closeAssistantPanel();
      hideLookupPopover();
      hideLookupCard();
      closeExportMenu();
      if (_tocObserver) {
        _tocObserver.disconnect();
        _tocObserver = null;
      }
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
    byId('episode-search').addEventListener('input', function () { currentPage = 1; renderEpisodeList(getFilteredEpisodes()); });
    byId('library-search').addEventListener('input', function () { renderLibrary(_libraryTasks); });
    byId('filter-all').addEventListener('click', function () { setFilter('all'); });
    byId('filter-readable').addEventListener('click', function () { setFilter('readable'); });
    byId('filter-unread').addEventListener('click', function () { setFilter('unread'); });
    byId('filter-read').addEventListener('click', function () { setFilter('read'); });
    byId('page-prev').addEventListener('click', function () { if (currentPage > 1) { currentPage -= 1; renderEpisodeList(getFilteredEpisodes()); } });
    byId('page-next').addEventListener('click', function () {
      var totalPages = Math.ceil(getFilteredEpisodes().length / PAGE_SIZE);
      if (currentPage < totalPages) { currentPage += 1; renderEpisodeList(getFilteredEpisodes()); }
    });
    
    // Font controls
    byId('font-dec-btn').addEventListener('click', function () { setFontSize(_currentFontSize - 1); });
    byId('font-inc-btn').addEventListener('click', function () { setFontSize(_currentFontSize + 1); });
    
    // Theme controls
    byId('theme-light-btn').addEventListener('click', function () { setTheme('light'); });
    byId('theme-green-btn').addEventListener('click', function () { setTheme('green'); });
    byId('theme-dark-btn').addEventListener('click', function () { setTheme('dark'); });

    var _scrollThrottleTimer = null;
    byId('manuscript-body').addEventListener('scroll', function () {
      var self = this;
      var delta = self.scrollTop - _lastReaderScrollTop;
      var readerSheet = document.querySelector('.reader-sheet');
      if (self.scrollTop <= 12 || delta < -8) readerSheet.classList.remove('reader-head-collapsed');
      else if (delta > 8 && self.scrollTop > 56) readerSheet.classList.add('reader-head-collapsed');
      _lastReaderScrollTop = self.scrollTop;
      
      var totalScroll = self.scrollHeight - self.clientHeight;
      var percent = totalScroll > 0 ? (self.scrollTop / totalScroll * 100) : (self.scrollHeight > 0 ? 100 : 0);
      updateReaderProgress(percent);
      
      if (!_currentReadingTaskId) return;
      if (_scrollThrottleTimer) return;
      _scrollThrottleTimer = setTimeout(function () {
        localStorage.setItem('scroll_pos_' + _currentReadingTaskId, self.scrollTop);
        _scrollThrottleTimer = null;
      }, 150);
    });
    byId('reader-progress-range').addEventListener('input', function () {
      var body = byId('manuscript-body');
      var totalScroll = Math.max(0, body.scrollHeight - body.clientHeight);
      var percent = Math.min(100, Math.max(0, Number(this.value) || 0));
      body.scrollTop = totalScroll * percent / 100;
      updateReaderProgress(percent);
    });
    byId('reader-read-toggle').addEventListener('click', function () {
      if (_currentReadingEpisode) setEpisodeRead(_currentReadingEpisode, !isEpisodeRead(_currentReadingEpisode));
    });
    byId('episode-summary-close-btn').addEventListener('click', closeEpisodeSummary);
    byId('episode-summary-overlay').addEventListener('click', closeEpisodeSummary);
    byId('refresh-btn').addEventListener('click', function () {
      loadTimelineEpisodes(getScopedSubscriptions(), true);
    });
    byId('add-podcast-btn').addEventListener('click', openDrawer);
    byId('drawer-close-btn').addEventListener('click', closeDrawer);
    byId('drawer-overlay').addEventListener('click', closeDrawer);
    byId('mode-search-btn').addEventListener('click', function () { setDrawerMode('search'); });
    byId('mode-manual-btn').addEventListener('click', function () { setDrawerMode('manual'); });
    byId('drawer-search').addEventListener('input', function () { onDrawerSearch(this.value); });
    byId('manual-add-btn').addEventListener('click', function () { confirmAddPodcast(byId('manual-pod-name').value, byId('manual-rss-url').value); });
    byId('clear-selection-btn').addEventListener('click', clearDrawerSelection);
    byId('confirm-add-btn').addEventListener('click', confirmSelectedPodcast);
    byId('reader-close-btn').addEventListener('click', closeManuscript);
    byId('reader-overlay').addEventListener('click', closeManuscript);
    byId('upload-drop-zone').addEventListener('click', function () { byId('audio-file-input').click(); });
    byId('upload-drop-zone').addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); byId('audio-file-input').click(); } });
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
      if (byId('manuscript-reader').classList.contains('is-open')) closeManuscript();
      else if (byId('settings-drawer').classList.contains('is-open')) closeSettings();
      else if (byId('drawer').classList.contains('is-open')) closeDrawer();
      else if (byId('episode-summary-drawer').classList.contains('is-open')) closeEpisodeSummary();
    });

    // ── AI 阅读助手（百科查询 + 文字稿问答）──────────────────
    var _assistantAvailable = false;
    var _assistantHistory = [];
    var _assistantBusy = false;
    var _lookupTerm = '';
    var _lookupContext = '';

    function formatAssistantText(text) {
      // 轻量渲染：转义后处理 **加粗** 与换行，避免引入完整 Markdown 解析。
      var safe = escapeHtml(text);
      safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return safe.replace(/\n/g, '<br>');
    }

    function appendAssistantMessage(role, text, options) {
      var opts = options || {};
      var container = opts.container || byId('assistant-messages');
      var hint = container.querySelector('.assistant-hint');
      if (hint) hint.remove();
      var bubble = document.createElement('div');
      bubble.className = 'assistant-msg assistant-msg-' + role + (opts.pending ? ' is-pending' : '') + (opts.error ? ' is-error' : '');
      bubble.innerHTML = opts.pending ? '<span class="assistant-dots"><i></i><i></i><i></i></span>' : formatAssistantText(text);
      container.appendChild(bubble);
      container.scrollTop = container.scrollHeight;
      return bubble;
    }

    function resetAssistant() {
      _assistantHistory = [];
      _assistantBusy = false;
      var container = byId('assistant-messages');
      if (container) {
        container.innerHTML = '<div class="assistant-hint">基于本篇文字稿提问，例如「这期的核心观点是什么？」「嘉宾举了哪些案例？」<br>选中正文里的词，还能一键查百科。</div>';
      }
      var question = byId('assistant-question');
      if (question) question.value = '';
    }

    function openAssistantPanel() {
      if (!_assistantAvailable) return;
      byId('reader-assistant').hidden = false;
      document.querySelector('.reader-layout').classList.add('assistant-open');
      var toggle = byId('assistant-toggle-btn');
      toggle.classList.add('active');
      toggle.setAttribute('aria-pressed', 'true');
      var question = byId('assistant-question');
      if (question) setTimeout(function () { question.focus(); }, 60);
    }

    function closeAssistantPanel() {
      var panel = byId('reader-assistant');
      if (panel) panel.hidden = true;
      var layout = document.querySelector('.reader-layout');
      if (layout) layout.classList.remove('assistant-open');
      var toggle = byId('assistant-toggle-btn');
      if (toggle) { toggle.classList.remove('active'); toggle.setAttribute('aria-pressed', 'false'); }
    }

    function toggleAssistantPanel() {
      if (byId('reader-assistant').hidden) openAssistantPanel();
      else closeAssistantPanel();
    }

    function sendAssistantQuestion() {
      if (_assistantBusy) return;
      var input = byId('assistant-question');
      var question = String(input.value || '').trim();
      if (!question) return;
      if (!_currentReadingTaskId) { addLog('请先打开一篇稿件', 'error'); return; }
      input.value = '';
      _assistantBusy = true;
      byId('assistant-send-btn').disabled = true;
      appendAssistantMessage('user', question);
      var pending = appendAssistantMessage('assistant', '', { pending: true });

      fetch(safeTaskUrl(_currentReadingTaskId, '/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question, history: _assistantHistory.slice(-8) })
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) {
          var answer = String(data.answer || '');
          pending.classList.remove('is-pending');
          pending.innerHTML = formatAssistantText(answer);
          if (data.context_truncated) {
            var note = document.createElement('div');
            note.className = 'assistant-note';
            note.textContent = '（稿件较长，回答基于文字稿前一部分）';
            pending.appendChild(note);
          }
          _assistantHistory.push({ role: 'user', content: question });
          _assistantHistory.push({ role: 'assistant', content: answer });
          byId('assistant-messages').scrollTop = byId('assistant-messages').scrollHeight;
        })
        .catch(function (error) {
          pending.classList.remove('is-pending');
          pending.classList.add('is-error');
          pending.textContent = '助手出错了：' + errorMessage(error);
        })
        .finally(function () {
          _assistantBusy = false;
          byId('assistant-send-btn').disabled = false;
        });
    }

    // ── 划词百科查询 ──
    function hideLookupPopover() { var el = byId('lookup-popover'); if (el) el.hidden = true; }
    function hideLookupCard() { var el = byId('lookup-card'); if (el) el.hidden = true; }

    function onManuscriptSelection() {
      if (!_assistantAvailable) return;
      var selection = window.getSelection();
      var term = selection ? String(selection.toString()).trim() : '';
      var body = byId('manuscript-body');
      if (!term || term.length > 60 || !selection.rangeCount) { hideLookupPopover(); return; }
      var range = selection.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) { hideLookupPopover(); return; }
      _lookupTerm = term;
      var block = range.startContainer.parentElement ? range.startContainer.parentElement.closest('p, li, h1, h2, h3, blockquote') : null;
      _lookupContext = block ? String(block.textContent || '').trim().slice(0, 600) : '';
      byId('lookup-term-label').textContent = term.length > 12 ? term.slice(0, 12) + '…' : term;
      var rect = range.getBoundingClientRect();
      var popover = byId('lookup-popover');
      popover.hidden = false;
      var top = rect.top - popover.offsetHeight - 8;
      if (top < 8) top = rect.bottom + 8;
      var left = rect.left + rect.width / 2 - popover.offsetWidth / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - popover.offsetWidth - 8));
      popover.style.top = top + 'px';
      popover.style.left = left + 'px';
    }

    function runLookup() {
      var term = _lookupTerm;
      if (!term) return;
      hideLookupPopover();
      var card = byId('lookup-card');
      byId('lookup-card-term').textContent = term;
      byId('lookup-card-body').innerHTML = '<span class="assistant-dots"><i></i><i></i><i></i></span>';
      card.hidden = false;

      fetch(appUrl('/api/read-podcast/assistant/lookup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term: term, context: _lookupContext })
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) { byId('lookup-card-body').innerHTML = formatAssistantText(String(data.explanation || '暂无解释')); })
        .catch(function (error) { byId('lookup-card-body').innerHTML = '<span class="lookup-error">查询失败：' + escapeHtml(errorMessage(error)) + '</span>'; });
    }

    // ── 跨节目提问（稿件库） ──
    var _libraryHistory = [];
    var _libraryBusy = false;

    function renderLibrarySources(bubble, sources) {
      if (!sources || !sources.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'assistant-sources';
      var label = document.createElement('span');
      label.className = 'assistant-sources-label';
      label.textContent = '来源：';
      wrap.appendChild(label);
      sources.forEach(function (src) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'source-chip';
        chip.textContent = '【' + src.index + '】' + String(src.title || '未命名');
        chip.title = '打开这篇稿件';
        chip.addEventListener('click', function () { openManuscript(src.task_id); });
        wrap.appendChild(chip);
      });
      bubble.appendChild(wrap);
    }

    function sendLibraryQuestion() {
      if (_libraryBusy) return;
      var input = byId('library-ask-question');
      var question = String(input.value || '').trim();
      if (!question) return;
      input.value = '';
      _libraryBusy = true;
      byId('library-ask-send').disabled = true;
      var container = byId('library-ask-messages');
      appendAssistantMessage('user', question, { container: container });
      var pending = appendAssistantMessage('assistant', '', { container: container, pending: true });

      fetch(appUrl('/api/read-podcast/assistant/library/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question, history: _libraryHistory.slice(-8) })
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) {
          var answer = String(data.answer || '');
          pending.classList.remove('is-pending');
          pending.innerHTML = formatAssistantText(answer);
          renderLibrarySources(pending, data.sources);
          if (data.context_truncated) {
            var note = document.createElement('div');
            note.className = 'assistant-note';
            note.textContent = '（稿件较多，回答基于最相关的部分节目）';
            pending.appendChild(note);
          }
          _libraryHistory.push({ role: 'user', content: question });
          _libraryHistory.push({ role: 'assistant', content: answer });
          container.scrollTop = container.scrollHeight;
        })
        .catch(function (error) {
          pending.classList.remove('is-pending');
          pending.classList.add('is-error');
          pending.textContent = '提问出错了：' + errorMessage(error);
        })
        .finally(function () {
          _libraryBusy = false;
          byId('library-ask-send').disabled = false;
        });
    }

    function refreshAssistantAvailability() {
      return fetch(appUrl('/api/read-podcast/assistant/status'))
        .then(function (r) { return r.ok ? r.json() : { available: false }; })
        .then(function (data) {
          _assistantAvailable = !!(data && data.available);
          setHidden(byId('assistant-toggle-btn'), !_assistantAvailable);
          setHidden(byId('library-ask'), !_assistantAvailable);
        })
        .catch(function () { _assistantAvailable = false; });
    }

    function initAssistant() {
      refreshAssistantAvailability();

      byId('library-ask-form').addEventListener('submit', function (event) { event.preventDefault(); sendLibraryQuestion(); });

      byId('assistant-toggle-btn').addEventListener('click', toggleAssistantPanel);
      byId('assistant-close-btn').addEventListener('click', closeAssistantPanel);
      byId('assistant-form').addEventListener('submit', function (event) { event.preventDefault(); sendAssistantQuestion(); });
      byId('assistant-question').addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendAssistantQuestion(); }
      });
      byId('lookup-trigger').addEventListener('click', runLookup);
      byId('lookup-card-close').addEventListener('click', hideLookupCard);
      byId('manuscript-body').addEventListener('mouseup', function () { setTimeout(onManuscriptSelection, 10); });
      byId('manuscript-body').addEventListener('scroll', function () { hideLookupPopover(); });
      document.addEventListener('mousedown', function (event) {
        if (!byId('lookup-popover').contains(event.target)) hideLookupPopover();
        var card = byId('lookup-card');
        if (!card.hidden && !card.contains(event.target)) hideLookupCard();
      });
    }

    // ── 文件连接器（把成稿发送到外部文档/群机器人） ──
    var _connectors = [];
    var _integrationStatuses = [];
    var _activeIntegration = '';
    var _integrationPopup = null;

    function documentConnector(format) {
      return _connectors.find(function (connector) { return connector && connector.format === format; }) || null;
    }

    function providerForFormat(format) { return format === 'gdrive' ? 'google' : 'feishu'; }

    function integrationStatus(provider) {
      return _integrationStatuses.find(function (item) { return item && item.provider === provider; }) || null;
    }

    function renderDocumentLogins() {
      document.querySelectorAll('.document-login').forEach(function (button) {
        var provider = providerForFormat(button.dataset.format);
        var status = integrationStatus(provider);
        var connected = !!(status && status.connected);
        button.classList.toggle('is-connected', connected);
        button.querySelector('.document-state').textContent = connected ? '已连接' : '登录';
        button.setAttribute('aria-label', button.querySelector('.document-name').textContent + (connected ? '，账号已连接' : '，登录'));
      });
    }

    function loadIntegrationStatuses() {
      return fetch(appUrl('/api/read-podcast/integrations'))
        .then(readJsonResponse)
        .then(function (data) {
          _integrationStatuses = Array.isArray(data) ? data : [];
          renderDocumentLogins();
          if (_activeIntegration) renderIntegrationDrawer();
          return _integrationStatuses;
        })
        .catch(function () { _integrationStatuses = []; renderDocumentLogins(); return []; });
    }

    function renderIntegrationDrawer() {
      var provider = _activeIntegration;
      var status = integrationStatus(provider) || { provider: provider, label: provider === 'google' ? 'Google 文档' : '飞书文档', app_configured: false, connected: false };
      var google = provider === 'google';
      byId('integration-title').textContent = '连接' + status.label;
      byId('integration-provider-name').textContent = status.label;
      var mark = byId('integration-provider-mark');
      mark.textContent = google ? 'G' : 'F';
      mark.className = 'document-mark ' + (google ? 'google-mark' : 'feishu-mark');
      var badge = byId('integration-status-badge');
      badge.textContent = status.connected ? '已连接' : '未连接';
      badge.classList.toggle('is-set', !!status.connected);
      byId('integration-client-id-label').textContent = google ? 'OAuth Client ID' : 'App ID';
      byId('integration-client-secret-label').textContent = google ? 'OAuth Client Secret' : 'App Secret';
      setHidden(byId('integration-app-form'), !!status.app_configured);
      setHidden(byId('integration-account-actions'), !status.app_configured);
      setHidden(byId('integration-test-btn'), !status.connected);
      byId('integration-login-btn').textContent = status.connected ? '重新登录' : '使用' + (google ? ' Google' : '飞书') + '账号登录';
    }

    function openIntegration(provider) {
      _activeIntegration = provider;
      _savedScrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = '-' + _savedScrollY + 'px';
      document.body.style.width = '100%';
      byId('integration-drawer').classList.add('is-open');
      byId('integration-overlay').classList.add('is-open');
      byId('integration-drawer').setAttribute('aria-hidden', 'false');
      document.body.classList.add('overlay-open');
      byId('integration-state').textContent = '';
      byId('integration-client-id').value = '';
      byId('integration-client-secret').value = '';
      renderIntegrationDrawer();
      loadIntegrationStatuses();
      setTimeout(function () { byId('integration-close-btn').focus(); }, 180);
    }

    function closeIntegration() {
      byId('integration-drawer').classList.remove('is-open');
      byId('integration-overlay').classList.remove('is-open');
      byId('integration-drawer').setAttribute('aria-hidden', 'true');
      document.body.classList.remove('overlay-open');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, _savedScrollY);
      var format = _activeIntegration === 'google' ? 'gdrive' : 'feishu-doc';
      var button = document.querySelector('.document-login[data-format="' + format + '"]');
      _activeIntegration = '';
      if (button) button.focus();
    }

    function oauthRedirectUri(provider) {
      return window.location.origin + APP_BASE_PATH + '/api/read-podcast/integrations/' + provider + '/callback';
    }

    function startIntegrationLogin() {
      var provider = _activeIntegration;
      var loginButton = byId('integration-login-btn');
      loginButton.disabled = true;
      byId('integration-state').textContent = '正在打开登录…';
      _integrationPopup = window.open('', 'read-podcast-oauth', 'popup=yes,width=560,height=720');
      fetch(appUrl('/api/read-podcast/integrations/' + provider + '/authorize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uri: oauthRedirectUri(provider) })
      })
        .then(readJsonResponse)
        .then(function (data) {
          if (!_integrationPopup) throw new Error('浏览器拦截了登录窗口');
          _integrationPopup.location.href = data.authorization_url;
          byId('integration-state').textContent = '请在登录窗口完成授权';
        })
        .catch(function (error) {
          if (_integrationPopup) _integrationPopup.close();
          byId('integration-state').textContent = errorMessage(error);
        })
        .then(function () { loginButton.disabled = false; });
    }

    function saveIntegrationApp(event) {
      event.preventDefault();
      var provider = _activeIntegration;
      var button = byId('integration-save-login-btn');
      button.disabled = true;
      button.textContent = '保存中…';
      fetch(appUrl('/api/read-podcast/integrations/' + provider + '/app'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: byId('integration-client-id').value, client_secret: byId('integration-client-secret').value })
      })
        .then(readJsonResponse)
        .then(function (status) {
          _integrationStatuses = _integrationStatuses.filter(function (item) { return item.provider !== provider; });
          _integrationStatuses.push(status);
          renderIntegrationDrawer();
          startIntegrationLogin();
        })
        .catch(function (error) { byId('integration-state').textContent = errorMessage(error); })
        .then(function () { button.disabled = false; button.textContent = '保存并登录'; });
    }

    function testActiveIntegration() {
      var connector = documentConnector(_activeIntegration === 'google' ? 'gdrive' : 'feishu-doc');
      if (connector) testConnector(connector);
    }

    function handleIntegrationMessage(event) {
      if (event.origin !== window.location.origin || !event.data || event.data.type !== 'read-podcast-oauth') return;
      if (_integrationPopup) _integrationPopup.close();
      byId('integration-state').textContent = event.data.detail || (event.data.ok ? '账号已连接' : '账号连接失败');
      loadIntegrationStatuses();
      loadConnectors();
    }

    function initIntegrations() {
      loadIntegrationStatuses();
      document.querySelectorAll('.document-login').forEach(function (button) {
        button.addEventListener('click', function () { openIntegration(providerForFormat(button.dataset.format)); });
      });
      byId('integration-close-btn').addEventListener('click', closeIntegration);
      byId('integration-overlay').addEventListener('click', closeIntegration);
      byId('integration-app-form').addEventListener('submit', saveIntegrationApp);
      byId('integration-login-btn').addEventListener('click', startIntegrationLogin);
      byId('integration-test-btn').addEventListener('click', testActiveIntegration);
      window.addEventListener('message', handleIntegrationMessage);
    }

    function closeExportMenu() {
      var menu = byId('export-menu');
      if (menu) menu.hidden = true;
      var btn = byId('reader-export-btn');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function renderExportMenu() {
      var menu = byId('export-menu');
      menu.replaceChildren();
      if (!_connectors.length) {
        var none = document.createElement('div');
        none.className = 'export-menu-empty';
        none.textContent = '未配置连接器';
        menu.appendChild(none);
        return;
      }
      _connectors.forEach(function (connector) {
        var isDoc = connector.kind === 'doc';
        var item = document.createElement('div');
        item.className = 'export-item' + (connector.configured ? '' : ' is-disabled');

        var head = document.createElement('div');
        head.className = 'export-item-head';
        var nameEl = document.createElement('span');
        nameEl.className = 'export-item-name';
        nameEl.textContent = String(connector.name || '');
        var badge = document.createElement('span');
        badge.className = 'export-item-badge';
        badge.textContent = isDoc ? '📄 云文档' : '🤖 群消息';
        head.append(nameEl, badge);
        item.appendChild(head);

        if (!connector.configured) {
          var hint = document.createElement('div');
          hint.className = 'export-item-hint';
          hint.textContent = '未配置（在 .env 填凭据）';
          item.appendChild(hint);
        } else {
          var actions = document.createElement('div');
          actions.className = 'export-item-actions';
          var full = document.createElement('button');
          full.type = 'button'; full.className = 'export-action';
          full.textContent = '整篇';
          full.addEventListener('click', function () { exportToConnector(connector, 'manuscript'); });
          var summary = document.createElement('button');
          summary.type = 'button'; summary.className = 'export-action';
          summary.textContent = '知识摘要';
          summary.title = '用 AI 提炼核心观点/案例/知识点后再发送';
          summary.addEventListener('click', function () { exportToConnector(connector, 'summary'); });
          var test = document.createElement('button');
          test.type = 'button'; test.className = 'export-action ghost';
          test.textContent = '测试';
          test.addEventListener('click', function () { testConnector(connector); });
          actions.append(full, summary, test);
          item.appendChild(actions);
        }
        menu.appendChild(item);
      });
    }

    function openExportMenu() {
      renderExportMenu();
      var btn = byId('reader-export-btn');
      var menu = byId('export-menu');
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      var rect = btn.getBoundingClientRect();
      var top = rect.bottom + 6;
      var left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8));
      menu.style.top = top + 'px';
      menu.style.left = left + 'px';
    }

    function toggleExportMenu() {
      if (byId('export-menu').hidden) openExportMenu();
      else closeExportMenu();
    }

    function exportToConnector(connector, mode) {
      var name = connector && connector.name ? connector.name : String(connector || '');
      if (!_currentReadingTaskId) { addLog('请先打开一篇稿件', 'error'); return; }
      closeExportMenu();
      var modeLabel = mode === 'summary' ? '知识摘要' : '整篇';
      addLog('正在发送' + modeLabel + '到「' + name + '」…', 'running');
      fetch(safeTaskUrl(_currentReadingTaskId, '/export'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connector: name, mode: mode || 'manuscript' })
      })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) {
          var extra = '';
          if (data && data.document_url) extra = ' · 已创建文档';
          else if (data && data.document_id) extra = ' · 文档已创建';
          if (data && data.truncated) extra += '（内容较长已截断）';
          addLog('已发送' + modeLabel + '到「' + name + '」' + extra, 'success');
          if (data && data.document_url) addLog('文档链接：' + data.document_url, 'info');
        })
        .catch(function (error) { addLog('发送失败：' + errorMessage(error), 'error'); });
    }

    function testConnector(connector) {
      var name = connector && connector.name ? connector.name : String(connector || '');
      closeExportMenu();
      addLog('正在测试「' + name + '」…', 'running');
      fetch(appUrl('/api/read-podcast/connectors/' + encodeURIComponent(name) + '/test'), { method: 'POST' })
        .then(function (response) {
          return response.text().then(function (raw) {
            if (!response.ok) { var detail = raw; try { detail = JSON.parse(raw).detail || detail; } catch (ignore) {} throw new Error(detail || 'HTTP ' + response.status); }
            return JSON.parse(raw);
          });
        })
        .then(function (data) { addLog('「' + name + '」' + (data && data.detail ? data.detail : '连接正常'), 'success'); })
        .catch(function (error) { addLog('测试失败：' + errorMessage(error), 'error'); });
    }

    function loadConnectors() {
      return fetch(appUrl('/api/read-podcast/connectors'))
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) {
          _connectors = Array.isArray(data) ? data : [];
          // 至少配置好一个连接器时才显示导出入口。
          var anyConfigured = _connectors.some(function (c) { return c.configured; });
          setHidden(byId('reader-export-btn'), !anyConfigured);
          return _connectors;
        })
        .catch(function () { _connectors = []; return []; });
    }

    function initConnectors() {
      loadConnectors();
      byId('reader-export-btn').addEventListener('click', function (event) { event.stopPropagation(); toggleExportMenu(); });
      document.addEventListener('mousedown', function (event) {
        var menu = byId('export-menu');
        if (menu.hidden) return;
        if (!menu.contains(event.target) && event.target !== byId('reader-export-btn')) closeExportMenu();
      });
      window.addEventListener('resize', closeExportMenu);
    }

    // ── 个人配置面板（服务商地址、模型、密钥与文件位置）────────
    var _settingsEntries = [];
    var _settingsBusy = false;

    function readJsonResponse(response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (ignore) { data = null; }
        if (!response.ok) {
          var detail = data && data.detail ? data.detail : ('HTTP ' + response.status);
          throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        return data;
      });
    }

    function openSettings() {
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
      state.textContent = '正在读取配置…';
      body.appendChild(state);
      fetch(appUrl('/api/read-podcast/settings'))
        .then(readJsonResponse)
        .then(function (data) { renderSettings(data); })
        .catch(function (error) { state.textContent = '配置读取失败：' + errorMessage(error); });
    }

    function buildSettingsField(field) {
      var wrap = document.createElement('div');
      wrap.className = 'settings-field';
      var inputId = 'setting-' + String(field.key || '').replace(/[^a-zA-Z0-9]+/g, '-');
      var isSecret = field.type === 'secret';

      var label = document.createElement('label');
      label.className = 'form-label';
      label.setAttribute('for', inputId);
      var labelText = document.createElement('span');
      labelText.textContent = String(field.label || field.key || '');
      label.appendChild(labelText);
      if (isSecret) {
        var badge = document.createElement('span');
        badge.className = 'settings-badge' + (field.configured ? ' is-set' : '');
        badge.textContent = field.configured ? '已配置' : '未配置';
        label.appendChild(badge);
      }
      wrap.appendChild(label);

      var entry = { key: String(field.key || ''), type: field.type, locked: !!field.locked, cleared: false };
      var control;
      if (field.type === 'select') {
        control = document.createElement('select');
        (field.options || []).forEach(function (option) {
          var node = document.createElement('option');
          node.value = String(option.value == null ? '' : option.value);
          node.textContent = String(option.label || option.value || '');
          control.appendChild(node);
        });
        control.value = String(field.value == null ? '' : field.value);
      } else {
        control = document.createElement('input');
        control.type = isSecret ? 'password' : 'text';
        control.autocomplete = isSecret ? 'new-password' : 'off';
        control.spellcheck = false;
        if (isSecret) control.placeholder = field.configured ? '已配置，留空表示不修改' : '尚未配置';
        else {
          control.placeholder = String(field.placeholder || '');
          control.value = String(field.value == null ? '' : field.value);
        }
      }
      control.className = 'form-input';
      control.id = inputId;
      if (field.locked) control.disabled = true;
      entry.input = control;
      // 只提交真正改动过的字段，避免把内置默认值固化进 config.yaml。
      entry.initial = isSecret ? '' : control.value;

      if (isSecret && field.configured && !field.locked) {
        var row = document.createElement('div');
        row.className = 'settings-secret-row';
        var clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'ghost-btn settings-secret-clear';
        clearBtn.textContent = '清除';
        clearBtn.addEventListener('click', function () {
          entry.cleared = !entry.cleared;
          clearBtn.textContent = entry.cleared ? '撤销' : '清除';
          control.value = '';
          control.disabled = entry.cleared;
          control.placeholder = entry.cleared ? '保存后清除' : '已配置，留空表示不修改';
        });
        row.append(control, clearBtn);
        wrap.appendChild(row);
      } else {
        wrap.appendChild(control);
      }

      var hints = [];
      if (field.locked && field.locked_reason) hints.push(String(field.locked_reason));
      if (field.hint) hints.push(String(field.hint));
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
      var groups = data && Array.isArray(data.groups) ? data.groups : [];
      if (!groups.length) {
        var empty = document.createElement('p');
        empty.className = 'settings-state';
        empty.textContent = '没有可编辑的配置项。';
        body.appendChild(empty);
        return;
      }
      groups.forEach(function (group) {
        var section = document.createElement('section');
        section.className = 'settings-group';
        var head = document.createElement('div');
        head.className = 'settings-group-head';
        var title = document.createElement('h3');
        title.textContent = String(group.title || '');
        head.appendChild(title);
        if (group.key === 'refiner' || group.key === 'transcription') {
          var testBtn = document.createElement('button');
          testBtn.type = 'button';
          testBtn.className = 'ghost-btn settings-test-btn';
          testBtn.textContent = '测试连接';
          testBtn.addEventListener('click', function () { testSettings(group.key, testBtn); });
          head.appendChild(testBtn);
        }
        section.appendChild(head);
        if (group.description) {
          var desc = document.createElement('p');
          desc.className = 'settings-group-desc';
          desc.textContent = String(group.description);
          section.appendChild(desc);
        }
        (group.fields || []).forEach(function (field) { section.appendChild(buildSettingsField(field)); });
        body.appendChild(section);
      });
      var writable = !(data && data.writable === false);
      byId('settings-save-btn').disabled = !writable;
      byId('settings-note').textContent = writable
        ? '密钥只写入这台机器上的 config/secrets.env，页面不会回显内容。「测试连接」使用已保存的配置。'
        : '配置目录不可写，无法保存。请检查 config 目录权限或 Docker 挂载。';
    }

    function collectSettingsPayload() {
      var payload = { values: {}, secrets: {} };
      _settingsEntries.forEach(function (entry) {
        if (entry.locked) return;
        if (entry.type === 'secret') {
          var envName = entry.key.replace(/^secret\./, '');
          if (entry.cleared) payload.secrets[envName] = '';
          else if (entry.input.value) payload.secrets[envName] = entry.input.value;
          return;
        }
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
      saveBtn.textContent = '保存中…';
      fetch(appUrl('/api/read-podcast/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectSettingsPayload())
      })
        .then(readJsonResponse)
        .then(function (data) {
          renderSettings(data);
          addLog('配置已保存，立即生效。', 'success');
          refreshAssistantAvailability();
        })
        .catch(function (error) { addLog('保存失败：' + errorMessage(error), 'error'); })
        .then(function () {
          _settingsBusy = false;
          saveBtn.textContent = '保存配置';
          saveBtn.disabled = false;
        });
    }

    function testSettings(target, button) {
      var original = button.textContent;
      button.disabled = true;
      button.textContent = '测试中…';
      fetch(appUrl('/api/read-podcast/settings/test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: target })
      })
        .then(readJsonResponse)
        .then(function (data) { addLog((data && data.detail) || '连接正常。', 'success'); })
        .catch(function (error) { addLog('测试失败：' + errorMessage(error), 'error'); })
        .then(function () { button.disabled = false; button.textContent = original; });
    }

    function initSettings() {
      byId('settings-btn').addEventListener('click', openSettings);
      byId('settings-close-btn').addEventListener('click', closeSettings);
      byId('settings-overlay').addEventListener('click', closeSettings);
      byId('settings-reload-btn').addEventListener('click', loadSettings);
      byId('settings-save-btn').addEventListener('click', saveSettings);
    }

    initAssistant();
    initConnectors();
    initIntegrations();
    initSettings();
    loadSubscriptions();
    loadHistory();
    loadReadEpisodes();
