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
