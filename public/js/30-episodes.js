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
